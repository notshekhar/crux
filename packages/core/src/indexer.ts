/**
 * Commit a parse result into the index — see 04-storage.md and 05-index-tiers.md.
 *
 * Everything here runs in one short transaction. The parse itself happens
 * *before* this is called and never inside it: a transaction held open across
 * slow work starves every reader (01-architecture.md:96).
 */

import type { Database } from "bun:sqlite";
import type { ParseResult, ParsedSymbol } from "./parse.ts";
import { hashBytes } from "./hash.ts";
import { tokenColumn, normalizeName } from "./tokens.ts";

export interface IndexInput {
    workspace: string;
    /** Path as stored — relative to the workspace root. */
    path: string;
    source: string;
    parsed: ParseResult;
}

/**
 * The synthesized header, prepended before embedding (05-index-tiers.md:150).
 *
 * Without it an embedding sees an anonymous block of tokens; with it, it sees
 * what the code *is* and where it lives. Worth ~10 points of recall for about a
 * day of work — the highest-leverage single change in the retrieval stack.
 *
 * It is part of the hashed content, so changing this format correctly
 * invalidates the cache.
 */
export function synthesizeHeader(args: { path: string; symbol: ParsedSymbol | null; lang: string }): string {
    const lines = [`file: ${args.path}`];

    const moduleName = args.path.split("/").slice(-2, -1)[0];
    if (moduleName) lines.push(`module: ${moduleName}`);

    if (args.symbol) {
        if (args.symbol.parent) lines.push(`enclosing: ${args.symbol.parent}`);
        lines.push(`signature: ${args.symbol.signature}`);
        if (args.symbol.doc) lines.push(`doc: ${args.symbol.doc.replace(/\s+/g, " ").slice(0, 300)}`);
    }
    lines.push(`lang: ${args.lang}`);
    return lines.join("\n");
}

/** `path#name` — the fallback edge identifier until SCIP supplies stable ids. */
const localId = (path: string, name: string) => `${path}#${name}`;

/**
 * Callees that carry no graph signal.
 *
 * Recording every call site sounds right and is ruinous in practice: measured
 * on a 469-file repo it produced 37,046 edges — 36% of the entire index —
 * almost all of them `console.log`, `expect`, and `JSON.stringify`. Extrapolated
 * to a 200k-file monorepo that is ~15M rows of noise.
 *
 * Nobody asks "who calls push?", so these are dropped before they are stored.
 * The cost of being slightly too aggressive is one missing heuristic edge; the
 * cost of being too permissive is an index nobody can afford to keep.
 */
const UNINTERESTING_CALLEES = new Set([
    // JS/TS globals and ubiquitous methods
    "log",
    "warn",
    "error",
    "info",
    "debug",
    "trace",
    "assert",
    "stringify",
    "parse",
    "push",
    "pop",
    "shift",
    "unshift",
    "slice",
    "splice",
    "map",
    "filter",
    "reduce",
    "forEach",
    "find",
    "some",
    "every",
    "join",
    "split",
    "concat",
    "indexOf",
    "includes",
    "keys",
    "values",
    "entries",
    "then",
    "catch",
    "finally",
    "resolve",
    "reject",
    "all",
    "race",
    "toString",
    "valueOf",
    "test",
    "exec",
    "match",
    "replace",
    "trim",
    "startsWith",
    "endsWith",
    "padStart",
    "padEnd",
    "get",
    "set",
    "has",
    "add",
    "delete",
    "call",
    "apply",
    "bind",
    "require",
    "length",
    "max",
    "min",
    "floor",
    "ceil",
    "round",
    "abs",
    "now",
    "from",
    "of",
    "isArray",
    // Test-framework globals
    "describe",
    "it",
    "expect",
    "beforeEach",
    "afterEach",
    "beforeAll",
    "afterAll",
    "toBe",
    "toEqual",
    "mock",
    "spyOn",
    // Python / Go / Rust equivalents
    "print",
    "len",
    "str",
    "int",
    "float",
    "list",
    "dict",
    "append",
    "format",
    "println",
    "printf",
    "sprintf",
    "panic",
    "make",
    "new",
    "unwrap",
    "expect_err",
    "clone",
    "into",
    "to_string",
    "push_str",
    "iter",
    "collect",
    "ok",
    "err",
]);

/** Calls worth an edge: named, non-trivial, and not a ubiquitous builtin. */
const isInterestingCallee = (name: string) => name.length > 2 && !UNINTERESTING_CALLEES.has(name);

export interface IndexStats {
    chunks: number;
    /** Chunks whose content was already stored — the content-addressing win. */
    chunksReused: number;
    symbols: number;
    edges: number;
}

/**
 * Replace everything the index knows about one file.
 *
 * Chunks are content-addressed and shared across files, so they are inserted
 * with OR IGNORE and never deleted here — a chunk this file no longer
 * references may still belong to another file, or to the same file on another
 * branch. Reclaiming them is GC's job (04-storage.md:121).
 */
export function indexFile(db: Database, input: IndexInput): IndexStats {
    const { workspace, path, source, parsed } = input;
    const lines = source.split("\n");
    const stats: IndexStats = { chunks: 0, chunksReused: 0, symbols: 0, edges: 0 };

    const symbolAt = new Map<number, ParsedSymbol>();
    for (const s of parsed.symbols) symbolAt.set(s.startLine, s);

    db.transaction(() => {
        // The mapping is path-addressed, so it is rebuilt wholesale.
        db.run("DELETE FROM file_chunks WHERE workspace = ? AND path = ?", [workspace, path]);
        db.run("DELETE FROM symbols WHERE workspace = ? AND path = ?", [workspace, path]);
        db.run("DELETE FROM edges WHERE workspace = ? AND path = ?", [workspace, path]);

        const insertChunk = db.prepare(
            `INSERT OR IGNORE INTO chunks (content_hash, header, body, tokens, kind, lang, n_tokens)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        const mapChunk = db.prepare(
            `INSERT INTO file_chunks (workspace, path, content_hash, ord, start_line, end_line)
             VALUES (?, ?, ?, ?, ?, ?)`,
        );

        parsed.chunks.forEach((chunk, ord) => {
            const body = lines.slice(chunk.startLine - 1, chunk.endLine).join("\n");
            if (body.trim().length === 0) return;

            const symbol = symbolAt.get(chunk.startLine) ?? null;
            const header = synthesizeHeader({ path, symbol, lang: parsed.lang });
            const contentHash = hashBytes(`${header}\n---\n${body}`);

            const changes = insertChunk.run(
                contentHash,
                header,
                body,
                tokenColumn(`${header}\n${body}`),
                symbol?.kind ?? "block",
                parsed.lang,
                Math.ceil(body.length / 4), // rough token estimate; good enough for packing
            );
            if (changes.changes === 0) stats.chunksReused++;

            mapChunk.run(workspace, path, contentHash, ord, chunk.startLine, chunk.endLine);
            stats.chunks++;
        });

        const insertSymbol = db.prepare(
            `INSERT INTO symbols (workspace, path, name, kind, signature, doc, parent, start_line, end_line, exported, name_norm)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const s of parsed.symbols) {
            insertSymbol.run(
                workspace,
                path,
                s.name,
                s.kind,
                s.signature,
                s.doc,
                s.parent,
                s.startLine,
                s.endLine,
                s.exported ? 1 : 0,
                normalizeName(s.name),
            );
            stats.symbols++;
        }

        // Tier 1 edges are heuristic by construction: the callee is a name, not
        // a resolved symbol. They are marked as such so `crux.refs` can say
        // "probably calls this" rather than presenting a guess as a fact.
        const insertEdge = db.prepare(
            "INSERT INTO edges (workspace, src, dst, kind, path, line, precision) VALUES (?, ?, ?, ?, ?, ?, 'heuristic')",
        );
        for (const imp of parsed.imports) {
            insertEdge.run(workspace, path, imp.specifier, "imports", path, imp.line);
            stats.edges++;
        }
        const seen = new Set<string>();
        for (const call of parsed.calls) {
            if (!isInterestingCallee(call.name)) continue;
            // One edge per (caller, callee) pair, not per call site: a loop body
            // calling the same helper twenty times is still one relationship.
            const pair = `${call.from ?? ""}->${call.name}`;
            if (seen.has(pair)) continue;
            seen.add(pair);

            insertEdge.run(workspace, call.from ? localId(path, call.from) : path, call.name, "calls", path, call.line);
            stats.edges++;
        }
    })();

    return stats;
}

/**
 * Drop a file from the index.
 *
 * Chunks are left for GC: another file may share the hash, and keeping them is
 * what makes a revert or a branch switch back nearly free.
 */
export function removeFile(db: Database, workspace: string, path: string): void {
    db.transaction(() => {
        db.run("DELETE FROM file_chunks WHERE workspace = ? AND path = ?", [workspace, path]);
        db.run("DELETE FROM symbols WHERE workspace = ? AND path = ?", [workspace, path]);
        db.run("DELETE FROM edges WHERE workspace = ? AND path = ?", [workspace, path]);
        db.run("DELETE FROM files WHERE workspace = ? AND path = ?", [workspace, path]);
    })();
}

/**
 * Delete chunks nothing references any more.
 *
 * Deleting immediately would defeat the branch-switch cache, so callers pass a
 * grace period (default 7 days in the plan). Returns the number reclaimed.
 */
export function collectGarbage(db: Database): number {
    const result = db.run(`DELETE FROM chunks WHERE content_hash NOT IN (SELECT content_hash FROM file_chunks)`);
    return result.changes;
}
