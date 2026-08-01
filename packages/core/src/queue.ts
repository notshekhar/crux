/**
 * The durable job queue — see 02-queue.md.
 *
 * Lives in the index database, which buys durability across crashes, IPC between
 * processes without a socket, and coalescing via a partial unique index.
 *
 * Completed jobs are deleted rather than marked done, so the table stays small
 * and hot. History, if you want it, is `files.indexed_at`.
 */

import type { Database } from "bun:sqlite";
import { hashFile } from "./hash.ts";
import { stat } from "node:fs/promises";

export type JobKind = "parse" | "embed" | "delete" | "scip" | "source_sync";

/** 02-queue.md:174. Lower runs first: an editor save must beat a 5,000-file rebase. */
export const Priority = {
    /** A query touched an unindexed file and is waiting on it. */
    QUERY_BLOCKING: 0,
    /** Saved in the editor — the hot set. */
    EDITOR_SAVE: 1,
    /** Ordinary watcher change. */
    WATCHER: 5,
    /** Branch switch or bulk rescan. */
    BULK: 10,
    /** Initial cold index. */
    COLD_INDEX: 20,
    /** SCIP reindex, connector sync. */
    BACKGROUND: 30,
} as const;

/** 02-queue.md:95 — one file that reliably crashes the parser must not block the queue. */
export const MAX_ATTEMPTS = 5;
export const DEFAULT_LEASE_MS = 30_000;

export interface Job {
    id: number;
    workspace: string;
    path: string;
    kind: JobKind;
    priority: number;
    payload: string | null;
    enqueued_at: number;
    attempts: number;
}

export interface EnqueueInput {
    workspace: string;
    path: string;
    kind: JobKind;
    priority?: number;
    payload?: unknown;
}

export interface FileState {
    disk_mtime: number | null;
    disk_size: number | null;
    read_at: number | null;
    indexed_hash: string | null;
    indexed_at: number | null;
}

/** Why a claimed job needs no work. */
export type SkipReason = "mtime-and-size-unchanged" | "content-hash-unchanged" | "file-gone";

export type WorkDecision =
    { work: false; reason: SkipReason } | { work: true; hash: string; mtime: number; size: number; readAt: number };

/**
 * How long after a file's mtime its cached stat stays untrustworthy.
 *
 * Filesystem mtime granularity varies: nanoseconds on APFS and NTFS, but one
 * full second on ext3 and some NFS mounts. Within that window a
 * same-size modification is invisible to a (mtime, size) comparison, so the
 * cached stat cannot be trusted and the file must be hashed.
 *
 * Hashing runs at ~1.8 GB/s, so the cost of being wrong here is nil and the cost
 * of being right is a permanently stale index.
 */
export const STAT_RACE_WINDOW_MS = 1_000;

export class Queue {
    constructor(
        private readonly db: Database,
        private readonly now: () => number = Date.now,
    ) {}

    /**
     * Enqueue, coalescing against any existing PENDING job for the same
     * (workspace, path, kind).
     *
     * Queue depth becomes distinct dirty files rather than event count: a rebase
     * emitting 50,000 events leaves ~800 rows. A re-enqueue keeps the more urgent
     * of the two priorities and refreshes the timestamp.
     */
    enqueue(input: EnqueueInput): void {
        this.db.run(
            `INSERT INTO jobs (workspace, path, kind, priority, enqueued_at, payload, state)
             VALUES (?, ?, ?, ?, ?, ?, 'pending')
             ON CONFLICT (workspace, path, kind) WHERE state = 'pending'
             DO UPDATE SET
               enqueued_at = excluded.enqueued_at,
               priority    = MIN(jobs.priority, excluded.priority),
               payload     = COALESCE(excluded.payload, jobs.payload)`,
            [
                input.workspace,
                input.path,
                input.kind,
                input.priority ?? Priority.WATCHER,
                this.now(),
                input.payload === undefined ? null : JSON.stringify(input.payload),
            ],
        );
    }

    enqueueMany(inputs: EnqueueInput[]): void {
        this.db.transaction(() => {
            for (const i of inputs) this.enqueue(i);
        })();
    }

    /**
     * Atomically claim the highest-priority pending job for these lanes.
     *
     * Single statement, so two workers can never take the same row.
     */
    claim(worker: string, kinds: JobKind[], leaseMs = DEFAULT_LEASE_MS): Job | null {
        if (kinds.length === 0) return null;
        const placeholders = kinds.map(() => "?").join(", ");
        return (
            this.db
                .query<Job, any[]>(
                    `UPDATE jobs
                        SET state = 'running', worker = ?, lease_until = ?, attempts = attempts + 1
                      WHERE id = (
                        SELECT id FROM jobs
                         WHERE state = 'pending' AND kind IN (${placeholders})
                         ORDER BY priority, enqueued_at
                         LIMIT 1
                      )
                  RETURNING id, workspace, path, kind, priority, payload, enqueued_at, attempts`,
                )
                .get(worker, this.now() + leaseMs, ...kinds) ?? null
        );
    }

    /** Job succeeded. The row is deleted; the outcome lives in `files`. */
    complete(id: number): void {
        this.db.run("DELETE FROM jobs WHERE id = ?", [id]);
    }

    /**
     * Job failed. Retried until MAX_ATTEMPTS, then dead-lettered with its error
     * so `crux status` can report it and `crux retry --dead` can reset it.
     */
    fail(id: number, error: string): void {
        this.db.run(
            `UPDATE jobs
                SET state = CASE WHEN attempts >= ? THEN 'dead' ELSE 'pending' END,
                    last_error = ?, worker = NULL, lease_until = NULL
              WHERE id = ?`,
            [MAX_ATTEMPTS, error.slice(0, 2000), id],
        );
    }

    /**
     * Return jobs whose lease expired to the pending pool.
     *
     * Covers a crashed leader, a killed process, or a laptop that slept mid-job.
     * Runs every 10 s in the real loop.
     *
     * A dedupe collision here means a newer pending row already exists for that
     * path, so this row is redundant and is dropped rather than resurrected.
     */
    sweepExpired(): number {
        const expired = this.db
            .query<{ id: number }, [number]>("SELECT id FROM jobs WHERE state = 'running' AND lease_until < ?")
            .all(this.now());

        let recovered = 0;
        this.db.transaction(() => {
            for (const { id } of expired) {
                try {
                    this.db.run("UPDATE jobs SET state = 'pending', worker = NULL, lease_until = NULL WHERE id = ?", [
                        id,
                    ]);
                    recovered++;
                } catch {
                    this.db.run("DELETE FROM jobs WHERE id = ?", [id]);
                }
            }
        })();
        return recovered;
    }

    depth(): { pending: number; running: number; dead: number } {
        const rows = this.db
            .query<{ state: string; n: number }, []>("SELECT state, count(*) n FROM jobs GROUP BY state")
            .all();
        const out = { pending: 0, running: 0, dead: 0 };
        for (const r of rows) if (r.state in out) out[r.state as keyof typeof out] = r.n;
        return out;
    }

    /** Reset dead-lettered jobs. Backs `crux retry --dead`. */
    retryDead(): number {
        const dead = this.db.query<{ id: number }, []>("SELECT id FROM jobs WHERE state = 'dead'").all();
        let reset = 0;
        this.db.transaction(() => {
            for (const { id } of dead) {
                try {
                    this.db.run("UPDATE jobs SET state = 'pending', attempts = 0, last_error = NULL WHERE id = ?", [
                        id,
                    ]);
                    reset++;
                } catch {
                    this.db.run("DELETE FROM jobs WHERE id = ?", [id]); // superseded
                }
            }
        })();
        return reset;
    }

    // ── File state ──────────────────────────────────────────────────────────

    fileState(workspace: string, path: string): FileState | null {
        return (
            this.db
                .query<FileState, [string, string]>(
                    `SELECT disk_mtime, disk_size, read_at, indexed_hash, indexed_at
                       FROM files WHERE workspace = ? AND path = ?`,
                )
                .get(workspace, path) ?? null
        );
    }

    /**
     * Record a successful index.
     *
     * `hash` MUST be the hash of the bytes actually read and parsed, not a
     * re-hash of the file now — that is the whole point of the skip rule.
     */
    markIndexed(args: {
        workspace: string;
        path: string;
        hash: string;
        mtime: number;
        size: number;
        /** When the bytes were read — from the same WorkDecision, never Date.now(). */
        readAt: number;
        lang?: string | null;
        parseState?: string;
    }): void {
        this.db.run(
            `INSERT INTO files (workspace, path, disk_mtime, disk_size, read_at, indexed_hash, indexed_at, lang, parse_state)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (workspace, path) DO UPDATE SET
               disk_mtime = excluded.disk_mtime, disk_size = excluded.disk_size,
               read_at = excluded.read_at,
               indexed_hash = excluded.indexed_hash, indexed_at = excluded.indexed_at,
               lang = excluded.lang, parse_state = excluded.parse_state`,
            [
                args.workspace,
                args.path,
                args.mtime,
                args.size,
                args.readAt,
                args.hash,
                this.now(),
                args.lang ?? null,
                args.parseState ?? "ok",
            ],
        );
    }

    markSkipped(workspace: string, path: string, reason: string): void {
        this.db.run(
            `INSERT INTO files (workspace, path, parse_state, skip_reason, indexed_at)
             VALUES (?, ?, 'skipped', ?, ?)
             ON CONFLICT (workspace, path) DO UPDATE SET
               parse_state = 'skipped', skip_reason = excluded.skip_reason, indexed_at = excluded.indexed_at`,
            [workspace, path, reason, this.now()],
        );
    }

    forgetFile(workspace: string, path: string): void {
        this.db.transaction(() => {
            this.db.run("DELETE FROM files WHERE workspace = ? AND path = ?", [workspace, path]);
            this.db.run("DELETE FROM file_chunks WHERE workspace = ? AND path = ?", [workspace, path]);
            this.db.run("DELETE FROM symbols WHERE workspace = ? AND path = ?", [workspace, path]);
            this.db.run("DELETE FROM edges WHERE path_id = (SELECT id FROM paths WHERE workspace = ? AND path = ?)", [
                workspace,
                path,
            ]);
            this.db.run("DELETE FROM paths WHERE workspace = ? AND path = ?", [workspace, path]);
        })();
    }
}

/**
 * The skip rule — 02-queue.md:99. The single most important correctness
 * decision in the system.
 *
 *   stat → if (mtime, size) unchanged, done          (cheap pre-filter)
 *   hash → if hash == indexed_hash, done             (content genuinely same)
 *   otherwise parse, and store THE HASH JUST READ
 *
 * Never `skip if last_indexed > enqueued_at`. That looks equivalent and silently
 * drops writes: a file edited while its own job is running gets skipped, and
 * nothing re-enqueues it until it happens to change again. It is also vulnerable
 * to clock skew, 1-second mtime granularity, and NTP steps. Hash comparison is
 * immune to all of it.
 *
 * The bonus: `git checkout` touches thousands of files whose content is
 * identical on both branches. The mtime pre-filter fails but the hash check
 * succeeds, so they cost a stat and a hash with zero parse and zero embed work.
 *
 * ── The racy-clean guard ────────────────────────────────────────────────────
 *
 * The pre-filter has a hole the plan did not account for, and it reintroduces
 * the very lost-update race the hash rule exists to close:
 *
 *   T0.000  index v1 — store (mtime=T0, size=N)
 *   T0.400  write v2, SAME SIZE, within the filesystem's mtime granularity
 *   T1.000  job runs: stat says (T0, N) — unchanged! → skip
 *           ✗ v2 is permanently missing from the index
 *
 * This is git's "racily clean" problem and it takes git's fix: a cached stat is
 * only trustworthy if, at the moment we recorded it, the file's mtime was
 * already comfortably in the past. If we read a file while its mtime was still
 * inside the granularity window, that stat proves nothing and we must hash.
 */
export async function decideWork(prior: FileState | null, absolutePath: string): Promise<WorkDecision> {
    let st: { mtimeMs: number; size: number };
    const readAt = Date.now();
    try {
        st = await stat(absolutePath);
    } catch {
        return { work: false, reason: "file-gone" };
    }

    // Full precision. Truncating to integer milliseconds manufactures collisions
    // on APFS and NTFS, which is what makes the race above reachable at all.
    const mtime = st.mtimeMs;

    const statLooksUnchanged =
        prior !== null && prior.indexed_hash !== null && prior.disk_mtime === mtime && prior.disk_size === st.size;

    // Was the file already settled when we last read it?
    const priorReadWasStable =
        prior?.read_at != null && prior.disk_mtime != null && prior.read_at - prior.disk_mtime > STAT_RACE_WINDOW_MS;

    if (statLooksUnchanged && priorReadWasStable) {
        return { work: false, reason: "mtime-and-size-unchanged" };
    }

    const hash = await hashFile(absolutePath);
    if (hash === null) return { work: false, reason: "file-gone" };
    if (prior && prior.indexed_hash === hash) return { work: false, reason: "content-hash-unchanged" };

    return { work: true, hash, mtime, size: st.size, readAt };
}
