/**
 * The parse worker — the fast lane from 02-queue.md:158.
 *
 * Claim a job, read the file, decide whether it needs work, parse, commit.
 * The transaction opens only at the commit step: holding one across parse work
 * starves every reader (01-architecture.md:96).
 */

import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { Queue, decideWork, type Job } from "./queue.ts";
import { parseSource, type ParseResult } from "./parse.ts";
import { indexFile, removeFile } from "./indexer.ts";
import { loadIgnoreRules, type IgnoreRules } from "./ignore.ts";
import { detectLang } from "./lang.ts";

export interface WorkerOptions {
    db: Database;
    workspace: string;
    queue?: Queue;
    ignore?: IgnoreRules;
    /** Identifies this worker in the jobs table. */
    name?: string;
    /** Called for every job outcome — drives progress reporting. */
    onJob?: (job: Job, outcome: JobOutcome) => void;
}

export type JobOutcome =
    | { status: "indexed"; symbols: number; chunks: number }
    | { status: "skipped"; reason: string }
    | { status: "removed" }
    | { status: "failed"; error: string };

/** Lines per chunk for files with no grammar. Matches the AST chunk ceiling. */
const PROSE_CHUNK_LINES = 120;

/**
 * Tier 0 for files with no parser: no symbols, no edges, just chunk boundaries
 * so the text is reachable by BM25 and trigram.
 */
function lexicalOnly(source: string): ParseResult {
    const lines = source.split("\n");
    const chunks: ParseResult["chunks"] = [];

    for (let start = 1; start <= lines.length; start += PROSE_CHUNK_LINES) {
        const end = Math.min(start + PROSE_CHUNK_LINES - 1, lines.length);
        if (lines.slice(start - 1, end).some((l) => l.trim().length > 0)) {
            chunks.push({ startLine: start, endLine: end, symbol: null });
        }
    }

    return { lang: "text", symbols: [], imports: [], calls: [], chunks, hasErrors: false };
}

export class ParseWorker {
    private readonly db: Database;
    private readonly workspace: string;
    private readonly queue: Queue;
    private readonly ignore: IgnoreRules;
    private readonly name: string;
    private readonly onJob?: (job: Job, outcome: JobOutcome) => void;

    private running = false;

    constructor(opts: WorkerOptions) {
        this.db = opts.db;
        this.workspace = opts.workspace;
        this.queue = opts.queue ?? new Queue(opts.db);
        this.ignore = opts.ignore ?? loadIgnoreRules(opts.workspace);
        this.name = opts.name ?? `parse-${process.pid}`;
        this.onJob = opts.onJob;
    }

    /** Process one job. Returns false when the lane is empty. */
    async step(): Promise<boolean> {
        const job = this.queue.claim(this.name, ["parse", "delete"]);
        if (!job) return false;

        try {
            const outcome = await this.run(job);
            this.queue.complete(job.id);
            this.onJob?.(job, outcome);
        } catch (err) {
            const message = (err as Error).message ?? String(err);
            this.queue.fail(job.id, message);
            this.onJob?.(job, { status: "failed", error: message });
        }
        return true;
    }

    private async run(job: Job): Promise<JobOutcome> {
        const absolute = join(this.workspace, job.path);

        if (job.kind === "delete") {
            removeFile(this.db, this.workspace, job.path);
            return { status: "removed" };
        }

        const skip = this.ignore.shouldSkip(job.path);
        if (skip) {
            this.queue.markSkipped(this.workspace, job.path, skip);
            return { status: "skipped", reason: skip };
        }

        const prior = this.queue.fileState(this.workspace, job.path);
        const decision = await decideWork(prior, absolute);

        if (!decision.work) {
            // A file that vanished is a delete, not an error (06-retrieval.md:119).
            if (decision.reason === "file-gone") {
                removeFile(this.db, this.workspace, job.path);
                return { status: "removed" };
            }
            return { status: "skipped", reason: decision.reason };
        }

        // Everything below runs OUTSIDE any transaction.
        const source = await Bun.file(absolute).text();

        const contentSkip = this.ignore.shouldSkipContent(source, decision.size);
        if (contentSkip) {
            this.queue.markSkipped(this.workspace, job.path, contentSkip);
            return { status: "skipped", reason: contentSkip };
        }

        // Tier 0 is always on and needs no grammar: Markdown, JSON, config, and
        // anything else with no parser is still chunked and full-text indexed.
        // Without this a repo's documentation is invisible to search, which is
        // exactly what people ask about most.
        const spec = detectLang(job.path);
        const parsed = spec ? await parseSource(source, job.path) : lexicalOnly(source);
        if (!parsed) return { status: "skipped", reason: "parse-returned-nothing" };

        const stats = indexFile(this.db, {
            workspace: this.workspace,
            path: job.path,
            source,
            parsed,
        });

        // The hash stored is the one we actually read, not a re-hash of the file
        // now — the file may have changed again while we were parsing.
        this.queue.markIndexed({
            workspace: this.workspace,
            path: job.path,
            hash: decision.hash,
            mtime: decision.mtime,
            size: decision.size,
            readAt: decision.readAt,
            lang: parsed.lang,
            parseState: parsed.hasErrors ? "errors" : "ok",
        });

        return { status: "indexed", symbols: stats.symbols, chunks: stats.chunks };
    }

    /** Drain the lane. Returns how many jobs ran. */
    async drain(max = Infinity): Promise<number> {
        let done = 0;
        while (done < max && (await this.step())) done++;
        return done;
    }

    /** Run until stopped, sleeping when the queue is empty. */
    async run_forever(idleMs = 100): Promise<void> {
        this.running = true;
        while (this.running) {
            const did = await this.step();
            if (!did) await Bun.sleep(idleMs);
        }
    }

    stop(): void {
        this.running = false;
    }
}
