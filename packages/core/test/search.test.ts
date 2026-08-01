import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";

import { openIndex } from "../src/db.ts";
import { parseSource } from "../src/parse.ts";
import { indexFile } from "../src/indexer.ts";
import { search, lookupSymbol } from "../src/search.ts";

const WS = "/repo";
let db: Database;

beforeEach(async () => {
    db = openIndex(":memory:");
    for (const [path, source] of Object.entries(CORPUS)) {
        const parsed = await parseSource(source, path);
        if (parsed) indexFile(db, { workspace: WS, path, source, parsed });
    }
});
afterEach(() => db.close());

const CORPUS: Record<string, string> = {
    "src/billing/retry.ts": `
/** Retries a failed webhook delivery with exponential backoff. */
export class RetryPolicy {
    async execute(op) {
        return flushBuffer(op);
    }
}
export const ERR_SOCK_TIMEOUT = "socket timed out";
`,
    "src/webhooks/validate.ts": `
/** Validates an inbound webhook signature. */
export function validateWebhook(signature: string): boolean {
    return checkHmac(signature);
}
`,
    "src/user/controller.py": `
class UserController:
    def get_user_by_id(self, user_id):
        return self.db.find(user_id)
`,
};

const paths = (q: string, opts = {}) => search(db, q, { workspace: WS, ...opts }).map((s) => s.path);

describe("the arms", () => {
    test("natural language finds the right file via BM25", () => {
        expect(paths("retry failed webhook delivery")).toContain("src/billing/retry.ts");
    });

    test("an exact identifier finds its definition", () => {
        expect(paths("validateWebhook")).toContain("src/webhooks/validate.ts");
    });

    test("a partial identifier finds it via trigram — how people half-remember names", () => {
        const hits = search(db, "sock_time", { workspace: WS });
        expect(hits.map((h) => h.path)).toContain("src/billing/retry.ts");
        expect(hits[0]?.why.matched).toContain("trigram");
    });

    test("a camelCase query finds a snake_case definition across languages", () => {
        expect(paths("getUserById")).toContain("src/user/controller.py");
    });

    test("results record which arms matched, so an agent can weight them", () => {
        const hits = search(db, "RetryPolicy", { workspace: WS });
        expect(hits[0]?.why.matched.length).toBeGreaterThan(0);
        expect(hits[0]?.why.rank).toBe(1);
    });
});

describe("fusion", () => {
    test("a span found by several arms outranks one found by a single arm", () => {
        const hits = search(db, "RetryPolicy", { workspace: WS });
        const multi = hits.findIndex((h) => h.why.matched.length > 1);
        const single = hits.findIndex((h) => h.why.matched.length === 1);

        if (multi >= 0 && single >= 0) expect(multi).toBeLessThan(single);
    });

    test("the limit is respected", () => {
        expect(search(db, "webhook", { workspace: WS, limit: 1 })).toHaveLength(1);
    });

    test("scope restricts to a subtree", () => {
        const scoped = paths("webhook", { scope: "src/webhooks/" });
        expect(scoped.every((p) => p.startsWith("src/webhooks/"))).toBe(true);
    });
});

describe("resilience", () => {
    test("a query that matches nothing returns empty rather than erroring", () => {
        expect(search(db, "zzzznotpresent", { workspace: WS })).toEqual([]);
    });

    test("FTS5 operator characters in a query do not throw", () => {
        for (const q of ["retry-policy", "foo:bar", "a*b", "(x)", "NOT y", "src/**/*.ts", "-flag"]) {
            expect(() => search(db, q, { workspace: WS })).not.toThrow();
        }
    });

    test("an empty query is handled", () => {
        expect(() => search(db, "   ", { workspace: WS })).not.toThrow();
    });

    test("a one-character query skips the trigram arm rather than failing", () => {
        expect(() => search(db, "a", { workspace: WS })).not.toThrow();
    });

    test("queries are scoped to their workspace", () => {
        expect(search(db, "RetryPolicy", { workspace: "/other-repo" })).toEqual([]);
    });
});

/**
 * These three cost 3.4 s per query and produced junk results on a real 469-file
 * repo before they were fixed. They exist so that never comes back.
 */
describe("behaviour at scale", () => {
    test("prose words are not treated as symbol lookups", () => {
        // No symbol here is named `handle`, `rate`, or `limiting` — and matching
        // those individually is what floated junk to rank 1 on a real repo.
        const hits = search(db, "where do we handle rate limiting", { workspace: WS });
        expect(hits.filter((h) => h.why.matched.includes("symbol"))).toHaveLength(0);
    });

    test("a multi-word query finds an identifier by concatenating every word", () => {
        // "get user by id" -> getuserbyid -> get_user_by_id. `get` and `by` are
        // stopwords but they are half the identifier, so they must survive here.
        const hits = search(db, "get user by id", { workspace: WS });
        expect(hits.some((h) => h.why.matched.includes("symbol"))).toBe(true);
        expect(hits[0]?.path).toBe("src/user/controller.py");
    });

    test("an identifier wrapped in prose is found with the stopwords dropped", () => {
        // "how do we validate the webhook" -> validatewebhook
        const hits = search(db, "how do we validate the webhook", { workspace: WS });
        expect(hits[0]?.path).toBe("src/webhooks/validate.ts");
        expect(hits.some((h) => h.why.matched.includes("symbol"))).toBe(true);
    });

    test("the trigram arm sits out prose queries — it scans and returns nothing", () => {
        const hits = search(db, "where do we handle rate limiting", { workspace: WS });
        expect(hits.every((h) => !h.why.matched.includes("trigram"))).toBe(true);
    });

    test("the trigram arm still runs for identifier-shaped queries", () => {
        const hits = search(db, "sock_time", { workspace: WS });
        expect(hits.some((h) => h.why.matched.includes("trigram"))).toBe(true);
    });

    test("a natural-language question lands in the right file", () => {
        expect(search(db, "retry a failed webhook", { workspace: WS })[0]?.path).toBe("src/billing/retry.ts");
    });
});

describe("symbol lookup", () => {
    test("exact match ranks above substring match", () => {
        const hits = lookupSymbol(db, "execute", WS);
        expect(hits[0]?.name).toBe("execute");
    });

    test("returns the disambiguating context an agent needs", () => {
        const [hit] = lookupSymbol(db, "RetryPolicy", WS);
        expect(hit).toMatchObject({
            name: "RetryPolicy",
            kind: "class",
            path: "src/billing/retry.ts",
            exported: true,
        });
        expect(hit?.doc).toContain("exponential backoff");
    });

    test("a partial name still finds the symbol", () => {
        expect(lookupSymbol(db, "Retry", WS).map((h) => h.name)).toContain("RetryPolicy");
    });

    test("an unknown name returns empty", () => {
        expect(lookupSymbol(db, "NoSuchThing", WS)).toEqual([]);
    });
});
