/**
 * A live workspace — leader election, watcher, and workers wired together.
 *
 * Every process opens the index and serves reads. Exactly one becomes leader
 * and additionally runs the watcher and workers; the rest are pure readers.
 * Search keeps working even when indexing is completely down — it just returns
 * slightly older data, and status() says so (01-architecture.md).
 */

import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { openIndex } from "./db.ts";
import { Queue, Priority } from "./queue.ts";
import { Leader } from "./leader.ts";
import { Watcher, walkWorkspace } from "./watcher.ts";
import { ParseWorker } from "./worker.ts";
import { loadIgnoreRules, type IgnoreRules } from "./ignore.ts";
import { search, lookupSymbol, type SearchOptions, type Span, type SymbolHit } from "./search.ts";

export const INDEX_RELATIVE_PATH = join(".crux", "index.db");

export interface WorkspaceOptions {
    root: string;
    /** Skip leader election and indexing — a pure reader. */
    readonly?: boolean;
    /** In-memory index, for tests. */
    memory?: boolean;
    onProgress?: (done: number, total: number) => void;
}

export interface Status {
    workspace: string;
    isLeader: boolean;
    files: number;
    symbols: number;
    chunks: number;
    queue: { pending: number; running: number; dead: number };
    watcher: { watching: boolean; degraded: string | null };
    /** Per-tier coverage, so an agent can qualify its own answer. */
    coverage: { lexical: number; syntactic: number; precise: number; vectors: number };
    indexBytes: number;
}

export class Workspace {
    readonly root: string;
    readonly db: Database;
    readonly queue: Queue;

    private readonly ignore: IgnoreRules;
    private readonly leader: Leader | null;
    private watcher: Watcher | null = null;
    private worker: ParseWorker | null = null;
    private sweeper: ReturnType<typeof setInterval> | null = null;

    constructor(private readonly opts: WorkspaceOptions) {
        this.root = opts.root;
        this.db = openIndex(opts.memory ? ":memory:" : join(opts.root, INDEX_RELATIVE_PATH), {
            readonly: opts.readonly && !opts.memory,
        });
        this.queue = new Queue(this.db);
        this.ignore = loadIgnoreRules(opts.root);
        this.leader = opts.readonly ? null : new Leader(this.db, opts.root);
    }

    /**
     * Try to take over indexing. Returns whether this process is the leader —
     * losing is normal and not an error.
     */
    async start(): Promise<boolean> {
        if (!this.leader) return false;

        this.leader.start();
        if (!this.leader.isLeader) return false;

        this.worker = new ParseWorker({ db: this.db, workspace: this.root, queue: this.queue, ignore: this.ignore });

        this.watcher = new Watcher({ workspace: this.root, queue: this.queue, ignore: this.ignore });
        this.watcher.start();

        // Requeue jobs whose lease expired — a crashed leader, or a laptop that
        // slept mid-job.
        this.sweeper = setInterval(() => {
            if (this.leader?.stillLeader()) this.queue.sweepExpired();
        }, 10_000);
        this.sweeper.unref?.();

        return true;
    }

    /**
     * Enqueue everything not yet indexed.
     *
     * Cheap to repeat: files whose content is unchanged cost a stat and a hash
     * and never reach the parser.
     */
    async coldIndex(): Promise<number> {
        const files = await walkWorkspace(this.root, this.ignore);
        this.queue.enqueueMany(
            files.map((path) => ({
                workspace: this.root,
                path,
                kind: "parse" as const,
                priority: Priority.COLD_INDEX,
            })),
        );
        return files.length;
    }

    /** Drain the queue now. Returns the number of jobs processed. */
    async drain(max = Infinity): Promise<number> {
        if (!this.worker) {
            this.worker = new ParseWorker({
                db: this.db,
                workspace: this.root,
                queue: this.queue,
                ignore: this.ignore,
            });
        }

        const total = this.queue.depth().pending;
        let done = 0;
        while (done < max && (await this.worker.step())) {
            done++;
            if (done % 50 === 0) this.opts.onProgress?.(done, total);
        }
        this.opts.onProgress?.(done, total);
        return done;
    }

    search(query: string, opts: Partial<SearchOptions> = {}): Span[] {
        return search(this.db, query, { workspace: this.root, ...opts });
    }

    symbol(name: string, limit?: number): SymbolHit[] {
        return lookupSymbol(this.db, name, this.root, limit);
    }

    /**
     * What is indexed, how fresh it is, and what is missing.
     *
     * Under-rated: it is how the user and the agent decide whether to trust an
     * answer, and the first thing to ask for when debugging someone else's repo.
     */
    status(): Status {
        const one = (sql: string): number =>
            (this.db.query<{ n: number }, [string]>(sql).get(this.root) as { n: number } | null)?.n ?? 0;

        const files = one("SELECT count(*) n FROM files WHERE workspace = ?");
        // Lexical covers everything indexed, including files with no grammar.
        // Syntactic covers only what actually produced a syntax tree — a
        // Markdown file is searchable but has no symbols, and conflating the two
        // would overstate what the index can answer.
        const indexed = one("SELECT count(*) n FROM files WHERE workspace = ? AND parse_state IN ('ok', 'errors')");
        const parsed = one(
            "SELECT count(*) n FROM files WHERE workspace = ? AND parse_state IN ('ok', 'errors') AND lang IS NOT 'text'",
        );
        const size =
            this.db
                .query<{ v: number }, []>(
                    "SELECT page_count * page_size v FROM pragma_page_count(), pragma_page_size()",
                )
                .get()?.v ?? 0;

        return {
            workspace: this.root,
            isLeader: this.leader?.isLeader ?? false,
            files,
            symbols: one("SELECT count(*) n FROM symbols WHERE workspace = ?"),
            chunks: one("SELECT count(*) n FROM file_chunks WHERE workspace = ?"),
            queue: this.queue.depth(),
            watcher: {
                watching: this.watcher?.status().watching ?? false,
                degraded: this.watcher?.status().degraded ?? null,
            },
            coverage: {
                lexical: files === 0 ? 0 : indexed / files,
                syntactic: files === 0 ? 0 : parsed / files,
                precise: 0, // SCIP is Phase 2
                vectors: 0, // embeddings are Phase 3
            },
            indexBytes: size,
        };
    }

    stop(): void {
        if (this.sweeper) clearInterval(this.sweeper);
        this.watcher?.stop();
        this.worker?.stop();
        this.leader?.stop();
    }

    close(): void {
        this.stop();
        this.db.close();
    }
}
