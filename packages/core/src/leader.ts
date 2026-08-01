/**
 * Leader election — see 01-architecture.md.
 *
 * MCP servers over stdio are spawned per client, so Claude Code, Cursor, and
 * loop open on the same repo means three processes. Indexing must be owned by
 * exactly one of them while any number read.
 *
 * Every process serves MCP by reading SQLite directly and *tries* to become
 * leader. The winner additionally runs the watcher and workers; the losers are
 * pure readers. Nothing about search depends on the leader being alive — it just
 * returns slightly older data, and status() says so.
 */

import type { Database } from "bun:sqlite";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

export const HEARTBEAT_MS = 5_000;
export const LEASE_MS = 15_000;

export interface LeaderOptions {
    heartbeatMs?: number;
    leaseMs?: number;
    now?: () => number;
    /** Called when a stall cost us the lease and we demoted to reader. */
    onDemote?: () => void;
}

export class Leader {
    /** Unique per process. The heartbeat on this id is the only authority. */
    readonly holder = randomUUID();

    private readonly db: Database;
    private readonly workspace: string;
    private readonly heartbeatMs: number;
    private readonly leaseMs: number;
    private readonly now: () => number;
    private readonly onDemote?: () => void;

    private timer: ReturnType<typeof setInterval> | null = null;
    private held = false;

    constructor(db: Database, workspace: string, opts: LeaderOptions = {}) {
        this.db = db;
        this.workspace = workspace;
        this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
        this.leaseMs = opts.leaseMs ?? LEASE_MS;
        this.now = opts.now ?? Date.now;
        this.onDemote = opts.onDemote;
    }

    get isLeader(): boolean {
        return this.held;
    }

    /**
     * Try to become leader: one conditional write, atomic under SQLite's write
     * lock. Takes the row if it is free, or steals it if the lease expired.
     */
    tryAcquire(): boolean {
        const t = this.now();
        const row = this.db
            .query<{ holder: string }, any[]>(
                `INSERT INTO leader (workspace, holder, pid, hostname, acquired_at, heartbeat)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (workspace) DO UPDATE
                   SET holder = excluded.holder, pid = excluded.pid, hostname = excluded.hostname,
                       acquired_at = excluded.acquired_at, heartbeat = excluded.heartbeat
                   WHERE leader.heartbeat < ?
              RETURNING holder`,
            )
            .get(this.workspace, this.holder, process.pid, hostname(), t, t, t - this.leaseMs);

        this.held = row?.holder === this.holder;
        return this.held;
    }

    /**
     * Renew the lease. Returns false if we no longer hold it — a paused process,
     * a machine sleep, or a debugger breakpoint can all cost us the row while we
     * were not looking.
     */
    heartbeat(): boolean {
        const changed = this.db
            .query<{ n: number }, [number, string, string]>(
                `UPDATE leader SET heartbeat = ? WHERE workspace = ? AND holder = ? RETURNING 1 AS n`,
            )
            .get(this.now(), this.workspace, this.holder);

        if (!changed && this.held) {
            this.held = false;
            this.onDemote?.();
        }
        return this.held;
    }

    /**
     * The fencing check. Call before every write batch: if the lease was lost
     * during a stall, stop writing and demote rather than becoming a second
     * writer.
     */
    stillLeader(): boolean {
        if (!this.held) return false;
        const row = this.db
            .query<{ holder: string; heartbeat: number }, [string]>(
                "SELECT holder, heartbeat FROM leader WHERE workspace = ?",
            )
            .get(this.workspace);

        const ok = row?.holder === this.holder && row.heartbeat >= this.now() - this.leaseMs;
        if (!ok) {
            this.held = false;
            this.onDemote?.();
        }
        return ok;
    }

    /** Begin heartbeating. Losers keep retrying, so a dead leader is replaced in ~20 s. */
    start(): void {
        if (this.timer) return;
        this.tryAcquire();
        this.timer = setInterval(() => {
            if (this.held) this.heartbeat();
            else this.tryAcquire();
        }, this.heartbeatMs);
        // Never hold the process open just to heartbeat.
        this.timer.unref?.();
    }

    /** Clean shutdown: drop the row so failover is immediate rather than lease-bound. */
    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.held) {
            this.db.run("DELETE FROM leader WHERE workspace = ? AND holder = ?", [this.workspace, this.holder]);
            this.held = false;
        }
    }
}
