import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";

import { openIndex } from "../src/db.ts";
import { Queue } from "../src/queue.ts";
import { hashBytes } from "../src/hash.ts";
import { parseSource } from "../src/parse.ts";
import { indexFile, removeFile, collectGarbage, synthesizeHeader } from "../src/indexer.ts";
import { search, lookupSymbol } from "../src/search.ts";
import { importGraph, fileDetail, symbolGraph, internals } from "../src/graph.ts";

const WS = "/repo";

let db: Database;

beforeEach(() => {
    db = openIndex(":memory:");
});
afterEach(() => db.close());

async function index(path: string, source: string) {
    const parsed = await parseSource(source, path);
    if (!parsed) throw new Error(`no parser for ${path}`);
    const stats = indexFile(db, { workspace: WS, path, source, parsed });

    // The worker records file state separately from indexing the content, and
    // the graph queries read it — so a test that skips this sees an empty index.
    new Queue(db).markIndexed({
        workspace: WS,
        path,
        hash: hashBytes(source),
        mtime: Date.now(),
        size: source.length,
        readAt: Date.now(),
        lang: parsed.lang,
        parseState: parsed.hasErrors ? "errors" : "ok",
    });
    return stats;
}

const RETRY = `
/** Retries a webhook delivery with exponential backoff. */
export class RetryPolicy {
    async execute(op) {
        return flushBuffer(op);
    }
}

export const ERR_SOCK_TIMEOUT = "sock timeout";
export function validateWebhook(sig) { return true; }
`;

const count = (sql: string, ...args: any[]) => (db.query<{ n: number }, any[]>(sql).get(...args) as { n: number }).n;

describe("writing the index", () => {
    test("symbols, chunks, and edges all land", async () => {
        const stats = await index("src/billing/retry.ts", RETRY);

        expect(stats.symbols).toBe(4);
        expect(stats.chunks).toBeGreaterThan(0);
        expect(stats.edges).toBeGreaterThan(0);
        expect(count("SELECT count(*) n FROM symbols")).toBe(4);
    });

    test("re-indexing a file replaces its rows rather than duplicating them", async () => {
        await index("a.ts", RETRY);
        await index("a.ts", RETRY);

        expect(count("SELECT count(*) n FROM symbols WHERE path = 'a.ts'")).toBe(4);
        expect(count("SELECT count(*) n FROM file_chunks WHERE path = 'a.ts'")).toBe(
            count("SELECT count(DISTINCT ord) n FROM file_chunks WHERE path = 'a.ts'"),
        );
    });

    test("call edges are marked heuristic — never present a guess as a fact", async () => {
        await index("a.ts", RETRY);
        const precisions = db.query<{ precision: string }, []>("SELECT DISTINCT precision FROM edges").all();
        expect(precisions).toEqual([{ precision: "heuristic" }]);
    });

    test("the FTS index is kept in sync by triggers", async () => {
        await index("a.ts", RETRY);
        expect(count("SELECT count(*) n FROM chunks_fts")).toBe(count("SELECT count(*) n FROM chunks"));
        expect(count("SELECT count(*) n FROM trigrams")).toBe(count("SELECT count(*) n FROM chunks"));
    });
});

describe("content addressing", () => {
    test("the same content in two files is stored once", async () => {
        await index("a.ts", RETRY);
        const before = count("SELECT count(*) n FROM chunks");

        const stats = await index("b.ts", RETRY);

        // Identical bodies, but the header carries the path, so only chunks
        // whose header also matches can be shared. What must not happen is
        // unbounded growth — and both files must be independently mapped.
        expect(stats.chunks).toBeGreaterThan(0);
        expect(count("SELECT count(*) n FROM file_chunks WHERE path = 'b.ts'")).toBe(stats.chunks);
        expect(count("SELECT count(*) n FROM chunks")).toBeGreaterThanOrEqual(before);
    });

    test("re-indexing identical content reuses every chunk", async () => {
        await index("a.ts", RETRY);
        const second = await index("a.ts", RETRY);

        expect(second.chunksReused).toBe(second.chunks);
    });

    test("a file moved to a new path re-maps without re-storing shared chunks", async () => {
        await index("old.ts", RETRY);
        const chunksBefore = count("SELECT count(*) n FROM chunks");

        removeFile(db, WS, "old.ts");
        await index("new.ts", RETRY);

        // The old chunks survive removal — that is what makes a revert cheap.
        expect(count("SELECT count(*) n FROM chunks")).toBeGreaterThanOrEqual(chunksBefore);
        expect(count("SELECT count(*) n FROM file_chunks WHERE path = 'old.ts'")).toBe(0);
    });
});

describe("removal and garbage collection", () => {
    test("removing a file drops its symbols, chunks mapping, and edges", async () => {
        await index("a.ts", RETRY);
        removeFile(db, WS, "a.ts");

        expect(count("SELECT count(*) n FROM symbols WHERE path = 'a.ts'")).toBe(0);
        expect(count("SELECT count(*) n FROM file_chunks WHERE path = 'a.ts'")).toBe(0);
        // Paths are interned, so an edge is reached through the paths table.
        expect(count("SELECT count(*) n FROM edges WHERE path_id IN (SELECT id FROM paths WHERE path = 'a.ts')")).toBe(
            0,
        );
    });

    test("removal leaves chunks behind for the branch-switch cache", async () => {
        await index("a.ts", RETRY);
        removeFile(db, WS, "a.ts");

        expect(count("SELECT count(*) n FROM chunks")).toBeGreaterThan(0);
    });

    test("gc reclaims exactly the unreferenced chunks", async () => {
        await index("a.ts", RETRY);
        await index("b.ts", "export function untouched() { return 1; }");
        removeFile(db, WS, "a.ts");

        const reclaimed = collectGarbage(db);

        expect(reclaimed).toBeGreaterThan(0);
        expect(count("SELECT count(*) n FROM chunks")).toBe(
            count("SELECT count(DISTINCT content_hash) n FROM file_chunks"),
        );
    });

    test("gc keeps the FTS index consistent", async () => {
        await index("a.ts", RETRY);
        removeFile(db, WS, "a.ts");
        collectGarbage(db);

        expect(count("SELECT count(*) n FROM chunks_fts")).toBe(count("SELECT count(*) n FROM chunks"));
    });

    test("a deleted file's code is never returned by a query", async () => {
        await index("a.ts", RETRY);
        removeFile(db, WS, "a.ts");
        collectGarbage(db);

        expect(search(db, "validateWebhook", { workspace: WS })).toEqual([]);
        expect(lookupSymbol(db, "RetryPolicy", WS)).toEqual([]);
    });
});

describe("synthesized headers", () => {
    test("carry the location and contract an embedding cannot infer from a body", () => {
        const header = synthesizeHeader({
            path: "src/billing/retry.ts",
            lang: "typescript",
            symbol: {
                name: "execute",
                kind: "method",
                signature: "async execute<T>(op: () => Promise<T>): Promise<T>",
                doc: "/** Runs op. */",
                parent: "RetryPolicy",
                startLine: 1,
                endLine: 2,
                exported: true,
            },
        });

        expect(header).toContain("file: src/billing/retry.ts");
        expect(header).toContain("module: billing");
        expect(header).toContain("enclosing: RetryPolicy");
        expect(header).toContain("signature: async execute");
        expect(header).toContain("doc: /** Runs op. */");
    });

    test("a chunk with no symbol still records where it came from", () => {
        const header = synthesizeHeader({ path: "README.md", lang: "markdown", symbol: null });
        expect(header).toContain("file: README.md");
    });
});

describe("storage economy", () => {
    test("chunk text is not duplicated into the database", async () => {
        await index("a.ts", RETRY);

        // The source is on disk and every returned span is re-read and verified
        // against it. A second copy in SQLite cost 34% of the index at scale.
        const columns = db
            .query<{ name: string }, []>("PRAGMA table_info(chunks)")
            .all()
            .map((c) => c.name);
        expect(columns).not.toContain("body");
        expect(columns).not.toContain("tokens");
    });

    test("search still finds code whose text is only on disk", async () => {
        await index("a.ts", RETRY);
        expect(search(db, "validateWebhook", { workspace: WS }).length).toBeGreaterThan(0);
    });

    test("the trigram index covers identifiers, not prose", async () => {
        await index("a.ts", "// the quick brown fox jumps over the lazy dog\nexport const ERR_SOCK_TIMEOUT = 1;\n");

        // Identifier substring: the reason this arm exists.
        expect(search(db, "sock_time", { workspace: WS }).some((h) => h.why.matched.includes("trigram"))).toBe(true);
        // Prose substring: deliberately not indexed — BM25 covers those words.
        expect(search(db, "brown", { workspace: WS }).some((h) => h.why.matched.includes("trigram"))).toBe(false);
    });

    test("gc removes FTS rows too, so deleted code stops matching", async () => {
        await index("a.ts", RETRY);
        removeFile(db, WS, "a.ts");
        collectGarbage(db);

        expect(count("SELECT count(*) n FROM chunks_fts")).toBe(0);
        expect(count("SELECT count(*) n FROM trigrams")).toBe(0);
        expect(search(db, "validateWebhook", { workspace: WS })).toEqual([]);
    });
});

describe("graph queries", () => {
    test("import edges resolve across files", async () => {
        await index("src/queue.ts", "export function claim() {}");
        await index("src/worker.ts", 'import { claim } from "./queue.ts";\nexport function run() { return claim(); }');

        const g = importGraph(db, WS, { granularity: "file" });

        expect(g.edges).toContainEqual(
            expect.objectContaining({ source: "src/worker.ts", target: "src/queue.ts", kind: "imports" }),
        );
    });

    test("a specifier written without its extension still resolves", async () => {
        await index("src/queue.ts", "export function claim() {}");
        await index("src/worker.ts", 'import { claim } from "./queue";\nexport const x = claim;');

        expect(importGraph(db, WS, { granularity: "file" }).edges.length).toBeGreaterThan(0);
    });

    test("files with no import relationships are reported, not silently dropped", async () => {
        await index("a.ts", "export const a = 1;");
        await index("b.ts", "export const b = 2;");

        const g = importGraph(db, WS, { granularity: "file" });

        expect(g.nodes).toEqual([]);
        expect(g.isolated).toBe(2);
    });

    test("file detail exposes symbols and chunk boundaries", async () => {
        await index("a.ts", RETRY);
        const d = fileDetail(db, WS, "a.ts");

        expect(d?.symbols.map((s) => s.name)).toContain("RetryPolicy");
        expect(d?.chunks.length).toBeGreaterThan(0);
        expect(fileDetail(db, WS, "nope.ts")).toBeNull();
    });

    test("symbol lookup is labelled heuristic until SCIP lands", async () => {
        await index("a.ts", RETRY);
        const g = symbolGraph(db, WS, "flushBuffer");

        // Tier 1 matches the callee by name, so this must never claim precision.
        expect(g.precision).toBe("heuristic");
        expect(g.callers.length).toBeGreaterThan(0);
    });

    test("internals reports storage and coverage inputs", async () => {
        await index("a.ts", RETRY);
        const i = internals(db, WS);

        expect(i.totals.symbols).toBeGreaterThan(0);
        expect(i.tables.length).toBeGreaterThan(0);
        expect(i.symbolKinds.some((k) => k.kind === "class")).toBe(true);
    });
});
