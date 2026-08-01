/**
 * The `crux_code` tokenizer — see 04-storage.md.
 *
 * This is deliberately NOT an FTS5 tokenizer. Registering one needs the
 * `fts5_api` C interface, which bun:sqlite does not expose (verified in
 * spikes/sqlite-capability.ts). Instead it runs at write time and its output is
 * stored in a companion `tokens` column indexed with stock `unicode61`, and the
 * same function expands queries before matching.
 */

/** Characters that hold an identifier together: everything else is a separator. */
const NOT_TOKEN = /[^A-Za-z0-9_.$/-]+/;
const SEPARATORS = /[_\-./]+/;
/** camelCase, PascalCase, and acronym→word boundaries (HTTPServer → HTTP, Server). */
const CASE_BOUNDARY = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;

/**
 * Expand text into the token set stored in the index.
 *
 * Emits the full original token, each separator-delimited part, each
 * case-boundary word, and the separator-stripped concatenation — so
 * `getUserById`, `get_user_by_id`, and `GetUserByID` all share a token.
 *
 * Length-1 tokens are kept: single-letter generics and loop variables matter in
 * code. Nothing is stemmed — `Users` and `User` are usually both real types.
 */
export function tokenize(text: string): string[] {
    const out = new Set<string>();
    for (const raw of text.split(NOT_TOKEN)) {
        if (!raw) continue;
        out.add(raw.toLowerCase());
        const words: string[] = [];
        for (const part of raw.split(SEPARATORS)) {
            if (!part) continue;
            out.add(part.toLowerCase());
            for (const word of part.split(CASE_BOUNDARY)) {
                if (!word) continue;
                out.add(word.toLowerCase());
                words.push(word.toLowerCase());
            }
        }
        if (words.length > 1) out.add(words.join(""));
    }
    return [...out];
}

/**
 * Collapse an identifier to its convention-free form.
 *
 * `get_user_by_id`, `getUserById`, and `GetUserByID` all become `getuserbyid`,
 * which is what lets a query written in one language's convention find a
 * definition written in another's. Stored in `symbols.name_norm`.
 */
export function normalizeName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The value stored in the indexed `tokens` column. */
export function tokenColumn(text: string): string {
    return tokenize(text).join(" ");
}

/**
 * Words that carry no retrieval signal.
 *
 * Leaving them in an OR-ed MATCH expression is actively harmful: "how does
 * leader election avoid two writers" ranked a stopword array above leader.ts,
 * because `how`, `does`, and `two` match nearly every chunk and drown the two
 * words that meant anything.
 */
const QUERY_STOPWORDS = new Set([
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
    "did",
    "do",
    "does",
    "for",
    "from",
    "had",
    "has",
    "have",
    "how",
    "i",
    "if",
    "in",
    "into",
    "is",
    "it",
    "its",
    "me",
    "of",
    "on",
    "or",
    "our",
    "out",
    "should",
    "that",
    "the",
    "their",
    "then",
    "there",
    "these",
    "they",
    "this",
    "to",
    "up",
    "us",
    "was",
    "we",
    "were",
    "what",
    "when",
    "where",
    "which",
    "who",
    "why",
    "will",
    "with",
    "would",
    "you",
    "your",
]);

/**
 * Turn a user query into an FTS5 MATCH expression.
 *
 * Every token is quoted, because FTS5 treats bare `-`, `*`, `:`, `(`, and `"`
 * as syntax — an unescaped identifier from a real query is a syntax error, not
 * a bad result. Tokens are OR-ed; ranking sorts out relevance.
 */
export function toMatchExpression(query: string): string {
    const tokens = tokenize(query);
    if (tokens.length === 0) return "";

    // Drop stopwords — unless that would leave nothing, in which case the user
    // really is searching for the word "this" and should get results.
    const meaningful = tokens.filter((t) => !QUERY_STOPWORDS.has(t));
    const used = meaningful.length > 0 ? meaningful : tokens;

    return used.map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ");
}
