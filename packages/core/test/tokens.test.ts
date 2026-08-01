import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { tokenize, toMatchExpression } from "../src/tokens.ts";

const has = (text: string, ...expected: string[]) => {
    const got = tokenize(text);
    for (const e of expected) expect(got).toContain(e);
};

describe("splitting", () => {
    test("camelCase", () => has("getUserById", "getuserbyid", "get", "user", "by", "id"));
    test("SCREAMING_SNAKE", () => has("MAX_RETRY_MS", "max_retry_ms", "max", "retry", "ms"));
    test("dotted paths", () => has("http.Client", "http.client", "http", "client"));
    test("acronym boundaries", () => has("HTTPServerConfig", "http", "server", "config"));
    test("kebab-case", () => has("retry-policy", "retry", "policy"));

    test("single-character tokens survive — generics and loop vars matter in code", () => {
        expect(tokenize("Promise<T>")).toContain("t");
    });

    test("nothing is stemmed — Users and User are usually both real types", () => {
        expect(tokenize("Users")).not.toContain("user");
        expect(tokenize("Users")).toContain("users");
    });
});

describe("cross-convention matching", () => {
    test("the same identifier in four conventions shares a token", () => {
        const forms = ["getUserById", "get_user_by_id", "GetUserByID", "get-user-by-id"];
        const shared = forms.map((f) => new Set(tokenize(f))).reduce((a, b) => new Set([...a].filter((t) => b.has(t))));

        expect(shared).toContain("getuserbyid");
    });
});

describe("query expressions", () => {
    /**
     * FTS5 treats `-`, `:`, `*`, `(`, `"`, and `^` as operators, so an unquoted
     * identifier pasted from real code is a syntax error rather than a bad
     * result. Assert against a real FTS5 table — hand-checking the grammar is
     * how this bug ships.
     */
    test("hostile queries run against real FTS5 without throwing", () => {
        const db = new Database(":memory:");
        db.run("CREATE VIRTUAL TABLE t USING fts5(body, tokenize = 'unicode61')");
        db.run("INSERT INTO t(body) VALUES (?)", [tokenize("const retryPolicy = ERR_SOCK_TIMEOUT").join(" ")]);

        const hostile = [
            "retry-policy",
            "foo:bar",
            'say "hi"',
            "a*b",
            "(x)",
            "^anchor",
            "NOT gonna",
            "a OR b AND c",
            "src/**/*.ts",
            "-flag",
            "user's",
        ];

        for (const q of hostile) {
            const expr = toMatchExpression(q);
            expect(() => db.query("SELECT rowid FROM t WHERE t MATCH ?").all(expr)).not.toThrow();
        }
        db.close();
    });

    test("a real identifier still matches after escaping", () => {
        const db = new Database(":memory:");
        db.run("CREATE VIRTUAL TABLE t USING fts5(body, tokenize = 'unicode61')");
        db.run("INSERT INTO t(body) VALUES (?)", [tokenize("const retryPolicy = ERR_SOCK_TIMEOUT").join(" ")]);

        const hits = db.query("SELECT rowid FROM t WHERE t MATCH ?").all(toMatchExpression("retry-policy"));
        expect(hits).toHaveLength(1);
        db.close();
    });

    test("an empty query yields an empty expression rather than invalid syntax", () => {
        expect(toMatchExpression("   ")).toBe("");
    });
});
