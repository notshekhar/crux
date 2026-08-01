/**
 * Can bun:sqlite do what 04-storage.md assumes?
 *
 * Gates: 04-storage.md (FTS5 + trigram + the crux_code tokenizer)
 *
 * Questions:
 *   a. Is FTS5 compiled into the SQLite Bun uses?
 *   b. Is the trigram tokenizer available? (needs >= 3.34)
 *   c. Do external-content FTS tables work?
 *   d. Can we register a custom tokenizer from JS? (expected: no)
 *   e. Does the pre-tokenization workaround give the same recall?
 */

import { Database } from "bun:sqlite";

const results: { q: string; ok: boolean; note: string }[] = [];
const check = (q: string, fn: () => string) => {
    try {
        results.push({ q, ok: true, note: fn() });
    } catch (e) {
        results.push({ q, ok: false, note: (e as Error).message });
    }
};

const db = new Database(":memory:");

check("sqlite build", () => {
    const v = db.query<{ v: string; s: string }, []>("select sqlite_version() v, sqlite_source_id() s").get()!;
    return `${v.v} ${v.s.includes("apl") ? "(Apple system build)" : "(bundled)"}`;
});

check("compile options", () => {
    const rows = db.query<{ o: string }, []>("pragma compile_options").all();
    const interesting = rows.map((r) => r.o).filter((o) => /FTS|THREADSAFE|ENABLE/.test(o));
    return interesting.join(", ") || "(none reported)";
});

check("a. FTS5 available", () => {
    db.run("CREATE VIRTUAL TABLE t_fts USING fts5(body)");
    return "yes";
});

check("b. trigram tokenizer", () => {
    db.run("CREATE VIRTUAL TABLE t_tri USING fts5(body, tokenize = 'trigram')");
    db.run("INSERT INTO t_tri(body) VALUES ('const ERR_SOCK_TIMEOUT = 4001')");
    const hit = db.query<{ body: string }, [string]>("SELECT body FROM t_tri WHERE t_tri MATCH ?").all("sock_time");
    return hit.length === 1 ? "yes — substring 'sock_time' matched ERR_SOCK_TIMEOUT" : "table created but no match";
});

check("c. external content table", () => {
    db.run("CREATE TABLE chunks (content_hash TEXT PRIMARY KEY, header TEXT, body TEXT)");
    db.run("CREATE VIRTUAL TABLE c_fts USING fts5(body, header, content='chunks', content_rowid='rowid')");
    db.run("INSERT INTO chunks VALUES ('h1','file: a.ts','function retryWebhook() {}')");
    // External-content tables are not auto-populated; 'rebuild' is the correct
    // way to sync. (Passing empty values to the 'delete' command corrupts the
    // index — that is what "disk image is malformed" meant on the first run.)
    db.run("INSERT INTO c_fts(c_fts) VALUES ('rebuild')");
    const n = db.query<{ n: number }, []>("SELECT count(*) n FROM c_fts WHERE c_fts MATCH 'retryWebhook'").get()!;
    return n.n === 1 ? "yes — content= + content_rowid= works" : `matched ${n.n}`;
});

check("d. custom tokenizer registration", () => {
    // The C API is fts5_api / xCreateTokenizer, reachable only through
    // sqlite3_db_config + a struct pointer. bun:sqlite exposes no handle for it.
    const anyDb = db as unknown as Record<string, unknown>;
    const surfaces = ["fts5", "createTokenizer", "createFunction", "handle", "ptr"].filter((k) => k in anyDb);
    throw new Error(`no fts5_api surface on Database (found only: ${surfaces.join(", ") || "nothing"})`);
});

// ---------------------------------------------------------------------------
// e. The workaround: pre-tokenize in app code, store the expansion, use unicode61.
// ---------------------------------------------------------------------------

/** Split an identifier the way 04-storage.md's crux_code tokenizer specifies. */
function cruxTokens(text: string): string[] {
    const out = new Set<string>();
    for (const raw of text.split(/[^A-Za-z0-9_.$/-]+/)) {
        if (!raw) continue;
        out.add(raw.toLowerCase()); // preserve the full original token
        const words: string[] = [];
        for (const part of raw.split(/[_\-./]+/)) {
            if (!part) continue;
            out.add(part.toLowerCase());
            // camelCase / PascalCase / acronym boundaries
            for (const w of part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) {
                if (w) {
                    out.add(w.toLowerCase());
                    words.push(w.toLowerCase());
                }
            }
        }
        // Separator-stripped form, so the same identifier matches across naming
        // conventions: getUserById / get_user_by_id / GetUserByID all share
        // "getuserbyid". Not in the 04-storage spec; it is free here and it is
        // exactly how people half-remember a name from another language.
        if (words.length > 1) out.add(words.join(""));
    }
    return [...out];
}

check("e. pre-tokenization workaround", () => {
    db.run("CREATE VIRTUAL TABLE w_fts USING fts5(body, tokens, tokenize = 'unicode61')");
    const corpus = [
        "async execute<T>(op: () => Promise<T>, opts?: RetryOpts): Promise<T>",
        "const MAX_RETRY_MS = 30_000",
        "http.Client{Timeout: 5 * time.Second}",
        "def get_user_by_id(user_id): ...",
    ];
    const ins = db.prepare("INSERT INTO w_fts(body, tokens) VALUES (?, ?)");
    for (const c of corpus) ins.run(c, cruxTokens(c).join(" "));

    const probe = (q: string) =>
        db.query<{ body: string }, [string]>("SELECT body FROM w_fts WHERE w_fts MATCH ?").all(q).length;

    const cases: [string, number][] = [
        ["retry", 2], // MAX_RETRY_MS + RetryOpts — subword hit
        ["user", 1], // get_user_by_id — snake_case split
        ["getuserbyid", 1], // cross-convention: camelCase query, snake_case source
        ["client", 1], // http.Client — dotted split
        ["max_retry_ms", 1], // exact original
    ];
    const failed = cases.filter(([q, want]) => probe(q) !== want);
    if (failed.length) throw new Error(`recall mismatch on: ${failed.map(([q]) => q).join(", ")}`);
    return `yes — ${cases.length}/${cases.length} recall cases pass without a custom tokenizer`;
});

// ---------------------------------------------------------------------------

console.log("\n  sqlite capability\n");
for (const r of results) {
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.q}`);
    console.log(`        ${r.note}\n`);
}
console.log(`  tokenizer sample: getUserById -> [${cruxTokens("getUserById").join(", ")}]`);
console.log(`                    MAX_RETRY_MS -> [${cruxTokens("MAX_RETRY_MS").join(", ")}]`);
console.log(`                    http.Client  -> [${cruxTokens("http.Client").join(", ")}]\n`);
