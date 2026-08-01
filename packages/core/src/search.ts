/**
 * Retrieval — see 06-retrieval.md.
 *
 * Phase 1 runs three of the five arms: BM25, trigram, and symbol. Vector and
 * path-fuzzy arrive with Phase 3. The arms are fused with Reciprocal Rank
 * Fusion, which needs no score calibration — BM25 scores, cosine similarities,
 * and fuzzy-match scores are not comparable and normalising them is a tuning
 * rabbit hole.
 *
 * A query never errors because of an incomplete index. Every arm degrades
 * independently and the response says what was missing (09-operations.md).
 */

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toMatchExpression, tokenize, normalizeName } from "./tokens.ts";
import { spanId } from "./hash.ts";

export type Arm = "bm25" | "trigram" | "symbol";

export interface Span {
    id: string;
    path: string;
    startLine: number;
    endLine: number;
    symbol: string | null;
    text: string;
    why: { matched: Arm[]; rank: number };
}

export interface SearchOptions {
    workspace: string;
    limit?: number;
    /** Restrict to a path prefix. */
    scope?: string;
    /**
     * Read each span's text from disk. Off by default so a ranking-only caller
     * pays no I/O; the MCP layer turns it on, and re-reads for freshness
     * anyway.
     */
    withText?: boolean;
}

/** RRF constant. 60 is the value from the original paper and needs no tuning. */
const RRF_K = 60;

/** Per-arm weights. Intent-based adjustment lands with the full pipeline. */
const WEIGHTS: Record<Arm, number> = { bm25: 1.0, trigram: 0.7, symbol: 1.3 };

interface Candidate {
    path: string;
    startLine: number;
    endLine: number;
    symbol: string | null;
    contentHash: string | null;
}

const key = (c: Candidate) => `${c.path}:${c.startLine}-${c.endLine}`;

/**
 * Scope predicate. When no scope is given the clause is omitted entirely rather
 * than passed as LIKE '%', which would defeat every index on the table.
 */
function scopeClause(alias: string, scope: string | undefined): { sql: string; args: string[] } {
    return scope ? { sql: ` AND ${alias}path GLOB ?`, args: [`${scope}*`] } : { sql: "", args: [] };
}

/** Full-text arm. Matches the crux_code expansion stored in `tokens`. */
function bm25Arm(db: Database, query: string, opts: SearchOptions, limit: number): Candidate[] {
    const expr = toMatchExpression(query);
    if (!expr) return [];

    const scope = scopeClause("fc.", opts.scope);
    return db
        .query<Candidate, any[]>(
            `SELECT fc.path, fc.start_line AS startLine, fc.end_line AS endLine,
                    fc.content_hash AS contentHash, NULL AS symbol
               FROM chunks_fts
               JOIN chunks c ON c.rowid = chunks_fts.rowid
               JOIN file_chunks fc ON fc.content_hash = c.content_hash
              WHERE chunks_fts MATCH ? AND fc.workspace = ?${scope.sql}
              ORDER BY bm25(chunks_fts, 1.0, 2.0, 1.5)
              LIMIT ?`,
        )
        .all(expr, opts.workspace, ...scope.args, limit);
}

/**
 * Substring arm — `sock_time` finds ERR_SOCK_TIMEOUT.
 *
 * Restricted to identifier-shaped queries on purpose. A trigram MATCH on a
 * multi-word phrase ANDs together dozens of 3-grams and degenerates into a
 * scan: measured at 2.9 s to return zero rows on a 4k-chunk index, versus 54 ms
 * for the BM25 arm that actually answers such queries. Substring search over
 * natural language is both meaningless and ruinously expensive.
 */
function trigramArm(db: Database, query: string, opts: SearchOptions, limit: number): Candidate[] {
    const probe = query.trim();
    // The tokenizer needs >= 3 characters, and anything with whitespace is prose.
    if (probe.length < 3 || probe.length > 64 || /\s/.test(probe)) return [];

    try {
        const scope = scopeClause("fc.", opts.scope);
        return db
            .query<Candidate, any[]>(
                `SELECT fc.path, fc.start_line AS startLine, fc.end_line AS endLine,
                        fc.content_hash AS contentHash, NULL AS symbol
                   FROM trigrams
                   JOIN chunks c ON c.rowid = trigrams.rowid
                   JOIN file_chunks fc ON fc.content_hash = c.content_hash
                  WHERE trigrams MATCH ? AND fc.workspace = ?${scope.sql}
                  LIMIT ?`,
            )
            .all(`"${probe.replaceAll('"', '""')}"`, opts.workspace, ...scope.args, limit);
    } catch {
        // A malformed trigram probe must not take the whole query down.
        return [];
    }
}

/**
 * Words too common to be a useful symbol lookup.
 *
 * Without this, "where do we handle rate limiting" matches every symbol named
 * `handle`, `do`, or `where`, and the symbol arm's weight pushes that noise
 * above the BM25 hits that actually answer the question.
 */
const STOPWORDS = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "but",
    "by",
    "can",
    "do",
    "does",
    "for",
    "from",
    "get",
    "has",
    "have",
    "how",
    "i",
    "if",
    "in",
    "is",
    "it",
    "its",
    "me",
    "of",
    "on",
    "or",
    "our",
    "out",
    "set",
    "that",
    "the",
    "then",
    "this",
    "to",
    "up",
    "us",
    "use",
    "we",
    "what",
    "when",
    "where",
    "which",
    "who",
    "why",
    "with",
    "you",
    "your",
]);

/**
 * Symbol arm.
 *
 * The distinction that matters is identifier lookup versus prose. For a single
 * token the user is naming something, so every tokenised form is fair game. For
 * a multi-word question they are describing behaviour, and matching the
 * individual words turns "parse the catalog" into every function named `parse`
 * — noise that the arm's weight then floats to rank 1.
 *
 * Multi-word queries therefore match only two things: the exact phrase, and the
 * words concatenated. The second is what lets "get user by id" find
 * `getUserById` and `get_user_by_id` across languages.
 */
function symbolArm(db: Database, query: string, opts: SearchOptions, limit: number): Candidate[] {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];

    const words = trimmed.split(/\s+/);
    const candidates =
        words.length === 1
            ? [trimmed, ...tokenize(trimmed).filter((t) => t.length >= 3 && !STOPWORDS.has(t))]
            : [
                  trimmed,
                  // Every word, in order: "get user by id" -> getuserbyid. Stopwords
                  // must stay in — `get` and `by` are half of that identifier.
                  words.join(""),
                  // And without them, for queries that wrap an identifier in prose:
                  // "how do we validate the webhook" -> validatewebhook.
                  words.filter((w) => !STOPWORDS.has(w.toLowerCase())).join(""),
              ];

    // Match on the normalised form so the query's convention does not have to
    // match the definition's — see normalizeName.
    const names = [...new Set(candidates.map(normalizeName))].filter((n) => n.length > 0);
    if (names.length === 0) return [];
    const placeholders = names.map(() => "?").join(", ");

    const scope = scopeClause("", opts.scope);
    return db
        .query<Candidate, any[]>(
            `SELECT path, start_line AS startLine, end_line AS endLine, name AS symbol,
                    NULL AS contentHash
               FROM symbols
              WHERE workspace = ?${scope.sql}
                AND name_norm IN (${placeholders})
              ORDER BY (lower(name) = ?) DESC, exported DESC, length(name)
              LIMIT ?`,
        )
        .all(opts.workspace, ...scope.args, ...names, trimmed.toLowerCase(), limit);
}

/**
 * Reciprocal Rank Fusion: score(d) = Σ w_arm / (k + rank_arm(d)).
 *
 * Rank-based, so wildly different score scales across arms never need
 * normalising against each other.
 */
export function search(db: Database, query: string, opts: SearchOptions): Span[] {
    const limit = opts.limit ?? 20;
    const perArm = Math.max(limit * 3, 30);

    const arms: [Arm, Candidate[]][] = [
        ["bm25", bm25Arm(db, query, opts, perArm)],
        ["trigram", trigramArm(db, query, opts, perArm)],
        ["symbol", symbolArm(db, query, opts, perArm)],
    ];

    const scores = new Map<string, { score: number; matched: Arm[]; candidate: Candidate }>();
    for (const [arm, results] of arms) {
        results.forEach((candidate, i) => {
            const k = key(candidate);
            const entry = scores.get(k) ?? { score: 0, matched: [], candidate };
            entry.score += WEIGHTS[arm] / (RRF_K + i + 1);
            entry.matched.push(arm);
            // Symbol hits carry the name; keep it when another arm found the span first.
            if (candidate.symbol && !entry.candidate.symbol) entry.candidate.symbol = candidate.symbol;
            scores.set(k, entry);
        });
    }

    const ranked = [...scores.values()].sort((a, b) => b.score - a.score).slice(0, limit);

    // The text is not in the database — it is on disk, which is the only copy
    // worth trusting. Read lazily and only when asked.
    const fileCache = new Map<string, string[] | null>();
    const linesOf = (path: string): string[] | null => {
        if (!fileCache.has(path)) {
            try {
                fileCache.set(path, readFileSync(join(opts.workspace, path), "utf8").split("\n"));
            } catch {
                fileCache.set(path, null); // deleted or unreadable — the caller drops it
            }
        }
        return fileCache.get(path) ?? null;
    };

    return ranked.map((entry, i) => {
        const c = entry.candidate;
        const text = opts.withText
            ? (linesOf(c.path)
                  ?.slice(c.startLine - 1, c.endLine)
                  .join("\n") ?? "")
            : "";
        return {
            id: spanId(c.contentHash ?? c.path, c.path, c.startLine, c.endLine),
            path: c.path,
            startLine: c.startLine,
            endLine: c.endLine,
            symbol: c.symbol,
            text,
            why: { matched: entry.matched, rank: i + 1 },
        };
    });
}

export interface SymbolHit {
    name: string;
    kind: string;
    path: string;
    startLine: number;
    signature: string | null;
    doc: string | null;
    parent: string | null;
    exported: boolean;
}

/**
 * Look up a symbol by name. Exact match first, then fuzzy — in a real repo
 * there are four things called `handler`, so all matches come back with
 * disambiguating context rather than a guess (07-mcp.md:39).
 */
export function lookupSymbol(db: Database, name: string, workspace: string, limit = 20): SymbolHit[] {
    const rows = db
        .query<any, any[]>(
            `SELECT name, kind, path, start_line AS startLine, signature, doc, parent, exported
               FROM symbols
              WHERE workspace = ? AND (name = ? OR name LIKE ?)
              ORDER BY (name = ?) DESC, exported DESC, length(name)
              LIMIT ?`,
        )
        .all(workspace, name, `%${name}%`, name, limit) as any[];

    return rows.map((r) => ({ ...r, exported: r.exported === 1 }));
}
