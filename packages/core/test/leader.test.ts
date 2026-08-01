import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";

import { openIndex } from "../src/db.ts";
import { Leader } from "../src/leader.ts";

const WS = "/repo";
const LEASE = 15_000;

let db: Database;
let clock: number;

beforeEach(() => {
    db = openIndex(":memory:");
    clock = 1_700_000_000_000;
});

afterEach(() => db.close());

/** A leader driven by the test clock rather than wall time. */
const makeLeader = (onDemote?: () => void) => new Leader(db, WS, { leaseMs: LEASE, now: () => clock, onDemote });

describe("acquisition", () => {
    test("exactly one of several processes wins", () => {
        const contenders = [makeLeader(), makeLeader(), makeLeader(), makeLeader()];
        const winners = contenders.filter((l) => l.tryAcquire());

        expect(winners).toHaveLength(1);
        expect(contenders.filter((l) => l.isLeader)).toHaveLength(1);
    });

    test("a live lease cannot be stolen", () => {
        const a = makeLeader();
        const b = makeLeader();
        expect(a.tryAcquire()).toBe(true);

        clock += LEASE - 1_000; // still inside the lease
        expect(b.tryAcquire()).toBe(false);
        expect(a.isLeader).toBe(true);
    });

    test("an expired lease is stolen, so a dead leader is replaced", () => {
        const dead = makeLeader();
        const fresh = makeLeader();
        expect(dead.tryAcquire()).toBe(true);

        clock += LEASE + 1; // the holder stopped heartbeating
        expect(fresh.tryAcquire()).toBe(true);
    });

    test("the winner keeps it across heartbeats while a loser retries", () => {
        const winner = makeLeader();
        const loser = makeLeader();
        winner.tryAcquire();

        for (let i = 0; i < 10; i++) {
            clock += 5_000;
            expect(winner.heartbeat()).toBe(true);
            expect(loser.tryAcquire()).toBe(false);
        }
    });
});

describe("fencing", () => {
    test("a stalled leader that lost its lease demotes instead of writing", () => {
        let demoted = false;
        const stalled = makeLeader(() => (demoted = true));
        const usurper = makeLeader();

        stalled.tryAcquire();

        // The process is paused — laptop sleep, debugger breakpoint — long
        // enough for the lease to expire and someone else to take over.
        clock += LEASE + 1;
        usurper.tryAcquire();

        // It wakes up and checks before its next write batch.
        expect(stalled.stillLeader()).toBe(false);
        expect(stalled.isLeader).toBe(false);
        expect(demoted).toBe(true);
        expect(usurper.isLeader).toBe(true);
    });

    test("two processes never both believe they are leader", () => {
        const a = makeLeader();
        const b = makeLeader();

        a.tryAcquire();
        clock += LEASE + 1;
        b.tryAcquire();

        const bothLeaders = [a, b].filter((l) => l.stillLeader());
        expect(bothLeaders).toHaveLength(1);
    });

    test("heartbeating after losing the row reports the loss", () => {
        let demoted = false;
        const a = makeLeader(() => (demoted = true));
        const b = makeLeader();

        a.tryAcquire();
        clock += LEASE + 1;
        b.tryAcquire();

        expect(a.heartbeat()).toBe(false);
        expect(demoted).toBe(true);
    });

    test("stillLeader is false for a process that never acquired", () => {
        const a = makeLeader();
        const b = makeLeader();
        a.tryAcquire();

        expect(b.stillLeader()).toBe(false);
    });
});

describe("shutdown", () => {
    test("a clean stop hands over immediately rather than after the lease", () => {
        const outgoing = makeLeader();
        const incoming = makeLeader();
        outgoing.tryAcquire();

        outgoing.stop();

        // No clock advance: failover does not wait for the lease to expire.
        expect(incoming.tryAcquire()).toBe(true);
    });

    test("stopping a non-leader leaves the real leader alone", () => {
        const real = makeLeader();
        const other = makeLeader();
        real.tryAcquire();

        other.stop();

        expect(real.stillLeader()).toBe(true);
    });
});
