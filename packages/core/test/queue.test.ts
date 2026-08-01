import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

import { openIndex } from "../src/db.ts";
import { Queue, Priority, MAX_ATTEMPTS, decideWork } from "../src/queue.ts";
import { hashBytes, hashFile } from "../src/hash.ts";

const WS = "/repo";

let db: Database;
let q: Queue;
let dir: string;

beforeEach(async () => {
    db = openIndex(":memory:");
    q = new Queue(db);
    dir = await mkdtemp(join(tmpdir(), "crux-test-"));
});

afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
});

/** Index a file the way a parse worker does: read, hash, commit what was read. */
async function indexFile(path: string, workspace = WS) {
    const prior = q.fileState(workspace, path);
    const decision = await decideWork(prior, path);
    if (!decision.work) return decision;
    // The worker reads the file HERE. Anything written after this point is a
    // different generation and must not be attributed to this hash.
    q.markIndexed({
        workspace,
        path,
        hash: decision.hash,
        mtime: decision.mtime,
        size: decision.size,
        readAt: decision.readAt,
    });
    return decision;
}

describe("coalescing", () => {
    test("many events for one path collapse to a single pending row", () => {
        for (let i = 0; i < 50; i++) q.enqueue({ workspace: WS, path: "a.ts", kind: "parse" });
        expect(q.depth().pending).toBe(1);
    });

    test("distinct paths and kinds do not collapse into each other", () => {
        q.enqueue({ workspace: WS, path: "a.ts", kind: "parse" });
        q.enqueue({ workspace: WS, path: "b.ts", kind: "parse" });
        q.enqueue({ workspace: WS, path: "a.ts", kind: "embed" });
        expect(q.depth().pending).toBe(3);
    });

    test("re-enqueue keeps the more urgent priority", () => {
        q.enqueue({ workspace: WS, path: "a.ts", kind: "parse", priority: Priority.COLD_INDEX });
        q.enqueue({ workspace: WS, path: "a.ts", kind: "parse", priority: Priority.EDITOR_SAVE });
        q.enqueue({ workspace: WS, path: "a.ts", kind: "parse", priority: Priority.BULK });

        const job = q.claim("w1", ["parse"]);
        expect(job?.priority).toBe(Priority.EDITOR_SAVE);
    });

    test("an editor save jumps ahead of a bulk backlog", () => {
        for (let i = 0; i < 500; i++) {
            q.enqueue({ workspace: WS, path: `bulk/${i}.ts`, kind: "parse", priority: Priority.COLD_INDEX });
        }
        q.enqueue({ workspace: WS, path: "hot.ts", kind: "parse", priority: Priority.EDITOR_SAVE });

        expect(q.claim("w1", ["parse"])?.path).toBe("hot.ts");
    });
});

describe("claiming", () => {
    test("two workers never claim the same job", () => {
        q.enqueue({ workspace: WS, path: "a.ts", kind: "parse" });

        const first = q.claim("w1", ["parse"]);
        const second = q.claim("w2", ["parse"]);

        expect(first).not.toBeNull();
        expect(second).toBeNull();
    });

    test("a worker only claims its own lanes", () => {
        q.enqueue({ workspace: WS, path: "a.ts", kind: "embed" });

        expect(q.claim("parser", ["parse"])).toBeNull();
        expect(q.claim("embedder", ["embed"])?.kind).toBe("embed");
    });

    test("claiming an empty queue returns null rather than throwing", () => {
        expect(q.claim("w1", ["parse"])).toBeNull();
    });
});

describe("leases", () => {
    test("an expired lease returns the job to the pool", () => {
        let clock = 1_000_000;
        const leased = new Queue(db, () => clock);

        leased.enqueue({ workspace: WS, path: "a.ts", kind: "parse" });
        leased.claim("crashed-worker", ["parse"], 30_000);
        expect(leased.depth()).toMatchObject({ pending: 0, running: 1 });

        clock += 31_000; // worker died holding the job
        expect(leased.sweepExpired()).toBe(1);
        expect(leased.depth()).toMatchObject({ pending: 1, running: 0 });
    });

    test("a live lease is left alone", () => {
        let clock = 1_000_000;
        const leased = new Queue(db, () => clock);

        leased.enqueue({ workspace: WS, path: "a.ts", kind: "parse" });
        leased.claim("w1", ["parse"], 30_000);

        clock += 5_000;
        expect(leased.sweepExpired()).toBe(0);
        expect(leased.depth().running).toBe(1);
    });

    test("a superseded job is dropped rather than resurrected by the sweeper", () => {
        let clock = 1_000_000;
        const leased = new Queue(db, () => clock);

        leased.enqueue({ workspace: WS, path: "a.ts", kind: "parse" });
        leased.claim("crashed", ["parse"], 30_000);
        leased.enqueue({ workspace: WS, path: "a.ts", kind: "parse" }); // newer edit

        clock += 31_000;
        leased.sweepExpired();

        // The newer pending row is the one that survives; no duplicate.
        expect(leased.depth()).toMatchObject({ pending: 1, running: 0 });
    });
});

describe("poison pills", () => {
    test("a job that always fails is dead-lettered, not retried forever", () => {
        q.enqueue({ workspace: WS, path: "crash.ts", kind: "parse" });

        for (let i = 0; i < MAX_ATTEMPTS; i++) {
            const job = q.claim("w1", ["parse"]);
            expect(job).not.toBeNull();
            q.fail(job!.id, "tree-sitter segfault");
        }

        expect(q.depth()).toMatchObject({ pending: 0, dead: 1 });
        expect(q.claim("w1", ["parse"])).toBeNull(); // no longer blocks the lane
    });

    test("retryDead resets them", () => {
        q.enqueue({ workspace: WS, path: "crash.ts", kind: "parse" });
        for (let i = 0; i < MAX_ATTEMPTS; i++) q.fail(q.claim("w1", ["parse"])!.id, "boom");

        expect(q.retryDead()).toBe(1);
        expect(q.depth()).toMatchObject({ pending: 1, dead: 0 });
    });

    test("one poison pill does not block other files", () => {
        q.enqueue({ workspace: WS, path: "crash.ts", kind: "parse", priority: Priority.EDITOR_SAVE });
        q.enqueue({ workspace: WS, path: "fine.ts", kind: "parse", priority: Priority.WATCHER });

        for (let i = 0; i < MAX_ATTEMPTS; i++) {
            const job = q.claim("w1", ["parse"]);
            if (job?.path === "crash.ts") q.fail(job.id, "boom");
            else break;
        }

        expect(q.claim("w1", ["parse"])?.path).toBe("fine.ts");
    });
});

describe("the skip rule", () => {
    test("unchanged mtime and size skips before hashing, once the file has settled", async () => {
        const path = join(dir, "a.ts");
        await writeFile(path, "export const a = 1");
        // Age the file past the racy-clean window so its cached stat is trustworthy.
        const old = new Date(Date.now() - 60_000);
        await utimes(path, old, old);
        await indexFile(path);

        const again = await decideWork(q.fileState(WS, path), path);
        expect(again).toEqual({ work: false, reason: "mtime-and-size-unchanged" });
    });

    test("a freshly written file is never trusted on stat alone", async () => {
        const path = join(dir, "fresh.ts");
        await writeFile(path, "export const a = 1");
        await indexFile(path);

        // Written moments ago, so the cached stat proves nothing and we hash.
        const again = await decideWork(q.fileState(WS, path), path);
        expect(again).toEqual({ work: false, reason: "content-hash-unchanged" });
    });

    test("same content with a new mtime skips on the hash — this is what makes branch switches cheap", async () => {
        const path = join(dir, "a.ts");
        const content = "export const a = 1";
        await writeFile(path, content);
        await indexFile(path);

        // git checkout rewrites the file with identical bytes: mtime moves, content does not.
        await Bun.sleep(10);
        await writeFile(path, content);

        const decision = await decideWork(q.fileState(WS, path), path);
        expect(decision).toEqual({ work: false, reason: "content-hash-unchanged" });
    });

    test("changed content does the work", async () => {
        const path = join(dir, "a.ts");
        await writeFile(path, "export const a = 1");
        await indexFile(path);

        await writeFile(path, "export const a = 2");
        const decision = await decideWork(q.fileState(WS, path), path);

        expect(decision.work).toBe(true);
        if (decision.work) expect(decision.hash).toBe(hashBytes("export const a = 2"));
    });

    test("a deleted file reports file-gone rather than throwing", async () => {
        const decision = await decideWork(null, join(dir, "never-existed.ts"));
        expect(decision).toEqual({ work: false, reason: "file-gone" });
    });

    test("a never-seen file is always work", async () => {
        const path = join(dir, "new.ts");
        await writeFile(path, "export const x = 1");
        expect((await decideWork(null, path)).work).toBe(true);
    });

    /**
     * The racy-clean case. A same-size edit inside the filesystem's mtime
     * granularity is invisible to a (mtime, size) comparison, so trusting the
     * cached stat here would drop the edit permanently — the exact failure the
     * hash rule exists to prevent, sneaking back in through the pre-filter.
     */
    test("a same-size edit within the mtime granularity is still detected", async () => {
        const path = join(dir, "racy.ts");
        await writeFile(path, "export const a = 1");
        await indexFile(path);

        // Same byte count, different content, immediately — on APFS this can
        // land in the same mtime tick, and on ext3 it reliably does.
        await writeFile(path, "export const a = 2");
        await utimes(path, new Date(q.fileState(WS, path)!.disk_mtime!), new Date(q.fileState(WS, path)!.disk_mtime!));

        const decision = await decideWork(q.fileState(WS, path), path);

        expect(decision.work).toBe(true);
        if (decision.work) expect(decision.hash).toBe(hashBytes("export const a = 2"));
    });
});

/**
 * 10-roadmap.md:95 — "Modify a file *while* its parse job is running; assert the
 * final index matches the final bytes. This is the exact race the hash rule
 * exists to prevent, and it should be in CI forever."
 */
describe("the lost-update race", () => {
    test("a file edited while its own job is running is not lost", async () => {
        const path = join(dir, "retry.ts");
        const v1 = "export class RetryPolicy {}";
        const v2 = "export class RetryPolicy { execute() {} }";

        // T1 — file changes, job A enqueued
        await writeFile(path, v1);
        q.enqueue({ workspace: WS, path, kind: "parse" });

        // T3 — worker claims A and READS THE FILE. Snapshot is v1.
        const jobA = q.claim("w1", ["parse"])!;
        const readA = await decideWork(q.fileState(WS, path), path);
        expect(readA.work).toBe(true);

        // T4 — file changes again mid-parse. Job A is 'running', so the partial
        // unique index does NOT swallow this: a new pending row is created.
        await writeFile(path, v2);
        q.enqueue({ workspace: WS, path, kind: "parse" });
        expect(q.depth()).toMatchObject({ pending: 1, running: 1 });

        // T5 — worker finishes A, committing the hash of what it actually read (v1).
        if (readA.work) {
            q.markIndexed({
                workspace: WS,
                path,
                hash: readA.hash,
                mtime: readA.mtime,
                size: readA.size,
                readAt: readA.readAt,
            });
        }
        q.complete(jobA.id);

        // Job B now runs. The naive rule (`skip if last_indexed > enqueued_at`)
        // would skip here, because A committed at T5 > B's enqueue at T4 —
        // and the v2 edit would be permanently missing from the index.
        const jobB = q.claim("w1", ["parse"])!;
        const readB = await decideWork(q.fileState(WS, path), path);

        expect(readB.work).toBe(true);
        if (readB.work) {
            expect(readB.hash).toBe(hashBytes(v2));
            q.markIndexed({
                workspace: WS,
                path,
                hash: readB.hash,
                mtime: readB.mtime,
                size: readB.size,
                readAt: readB.readAt,
            });
        }
        q.complete(jobB.id);

        // The invariant: the index agrees with the bytes on disk.
        expect(q.fileState(WS, path)!.indexed_hash).toBe(await hashFile(path));
        expect(q.depth()).toMatchObject({ pending: 0, running: 0 });
    });

    test("the index converges under repeated writes during processing", async () => {
        const path = join(dir, "churn.ts");
        await writeFile(path, "v0");
        q.enqueue({ workspace: WS, path, kind: "parse" });

        // Interleave 20 writes with worker turns, always writing mid-flight.
        let generation = 0;
        for (let i = 0; i < 20; i++) {
            const job = q.claim("w1", ["parse"]);
            if (!job) {
                await writeFile(path, `v${++generation}`);
                q.enqueue({ workspace: WS, path, kind: "parse" });
                continue;
            }
            const read = await decideWork(q.fileState(WS, path), path);
            await writeFile(path, `v${++generation}`); // write DURING the job
            q.enqueue({ workspace: WS, path, kind: "parse" });
            if (read.work) {
                q.markIndexed({
                    workspace: WS,
                    path,
                    hash: read.hash,
                    mtime: read.mtime,
                    size: read.size,
                    readAt: read.readAt,
                });
            }
            q.complete(job.id);
        }

        // Drain.
        for (let job = q.claim("w1", ["parse"]); job; job = q.claim("w1", ["parse"])) {
            const read = await decideWork(q.fileState(WS, path), path);
            if (read.work) {
                q.markIndexed({
                    workspace: WS,
                    path,
                    hash: read.hash,
                    mtime: read.mtime,
                    size: read.size,
                    readAt: read.readAt,
                });
            }
            q.complete(job.id);
        }

        expect(q.fileState(WS, path)!.indexed_hash).toBe(await hashFile(path));
    });
});

describe("file state", () => {
    test("markIndexed stores the hash that was read, not a re-hash of the file now", async () => {
        const path = join(dir, "a.ts");
        await writeFile(path, "original");
        const read = await decideWork(null, path);
        expect(read.work).toBe(true);

        // File changes before the worker commits.
        await writeFile(path, "changed underneath us");

        if (read.work)
            q.markIndexed({
                workspace: WS,
                path,
                hash: read.hash,
                mtime: read.mtime,
                size: read.size,
                readAt: read.readAt,
            });

        // The stored hash describes what we indexed, so the next pass correctly
        // sees a mismatch and reindexes.
        expect(q.fileState(WS, path)!.indexed_hash).toBe(hashBytes("original"));
        expect((await decideWork(q.fileState(WS, path), path)).work).toBe(true);
    });

    test("forgetFile removes the file's state", async () => {
        const path = join(dir, "a.ts");
        await writeFile(path, "x");
        await indexFile(path);

        q.forgetFile(WS, path);
        expect(q.fileState(WS, path)).toBeNull();
    });

    test("skipped files record why, so status can explain them", () => {
        q.markSkipped(WS, "vendor/big.min.js", "minified");
        const row = db
            .query<{ parse_state: string; skip_reason: string }, [string]>(
                "SELECT parse_state, skip_reason FROM files WHERE path = ?",
            )
            .get("vendor/big.min.js");

        expect(row).toMatchObject({ parse_state: "skipped", skip_reason: "minified" });
    });
});
