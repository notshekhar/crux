/**
 * The MCP surface — see 07-mcp.md.
 *
 * This is the product; everything else is infrastructure that makes these tools
 * good. Two rules govern it:
 *
 *   1. Eight tools, hard cap. Every definition is injected into the host agent's
 *      context on every turn, and more tools measurably degrade tool-selection
 *      accuracy. A context tool that bloats the context is self-defeating.
 *   2. The tool description IS the prompt. More of the final quality lives in
 *      this wording than in the ranking code, because the agent decides which
 *      tool to call and what to put in the query based entirely on it.
 *
 * Phase 1 ships five. `pack`, `refs`, and `history` need the graph and land with
 * Phase 2 — shipping them as stubs would spend context on a promise.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { join } from "node:path";
import type { Workspace } from "./workspace.ts";
import { hashFile } from "./hash.ts";
import type { Span } from "./search.ts";

/** Rough token estimate. Good enough for budgeting; exact counting needs the model's tokenizer. */
const estimateTokens = (text: string) => Math.ceil(text.length / 4);

interface VerifiedSpan extends Span {
    /** `verified` means the bytes were confirmed against disk at query time. */
    trust: "verified" | "stale-refreshed" | "unverified";
}

/**
 * Freshness verification — 06-retrieval.md:107, non-negotiable.
 *
 * There is always a window between a write hitting disk and the queue draining,
 * and an agent that hallucinates from a stale span poisons trust in the whole
 * tool. One stat and one hash per returned file buys a promise no
 * embedding-only tool can make: every byte returned is currently on disk.
 */
async function verify(ws: Workspace, spans: Span[]): Promise<VerifiedSpan[]> {
    const out: VerifiedSpan[] = [];
    const checked = new Map<string, string | null>();

    for (const span of spans) {
        const absolute = join(ws.root, span.path);

        if (!checked.has(span.path)) checked.set(span.path, await hashFile(absolute));
        const onDisk = checked.get(span.path) ?? null;

        if (onDisk === null) {
            // The file is gone. Drop the span and schedule its removal rather
            // than handing an agent code that no longer exists.
            ws.queue.enqueue({ workspace: ws.root, path: span.path, kind: "delete", priority: 0 });
            continue;
        }

        const indexed = ws.queue.fileState(ws.root, span.path)?.indexed_hash ?? null;
        if (indexed === onDisk) {
            out.push({ ...span, trust: "verified" });
            continue;
        }

        // Stale: re-read the live bytes for this line range and flag it, then
        // queue the file so the next query is clean.
        try {
            const text = await Bun.file(absolute).text();
            const live = text
                .split("\n")
                .slice(span.startLine - 1, span.endLine)
                .join("\n");
            out.push({ ...span, text: live, trust: "stale-refreshed" });
        } catch {
            out.push({ ...span, trust: "unverified" });
        }
        ws.queue.enqueue({ workspace: ws.root, path: span.path, kind: "parse", priority: 0 });
    }
    return out;
}

/** Pack spans to a token budget, guaranteeing file diversity (06-retrieval.md:128). */
function pack(spans: VerifiedSpan[], maxTokens: number) {
    const perFile = new Map<string, number>();
    const kept: VerifiedSpan[] = [];
    let spent = 0;

    for (const span of spans) {
        const cost = estimateTokens(span.text || "") + 32; // + the path/line header
        if (spent + cost > maxTokens) continue;

        // At least three distinct files before a second span from any one file,
        // so one large file cannot eat the whole budget.
        const already = perFile.get(span.path) ?? 0;
        if (already >= 1 && perFile.size < 3) continue;

        kept.push(span);
        perFile.set(span.path, already + 1);
        spent += cost;
    }
    return { spans: kept, truncated: kept.length < spans.length, tokens: spent };
}

/** The envelope every span-returning tool uses (07-mcp.md:89). */
function envelope(ws: Workspace, packed: ReturnType<typeof pack>) {
    const status = ws.status();
    return {
        spans: packed.spans.map((s) => ({
            id: s.id,
            path: s.path,
            lines: [s.startLine, s.endLine],
            symbol: s.symbol,
            text: s.text,
            why: s.why,
            trust: s.trust,
        })),
        truncated: packed.truncated,
        // Travels with every response so the agent can qualify its own answer
        // when the index is lagging, rather than silently answering from stale data.
        index: {
            fresh: status.queue.pending === 0,
            queue_depth: status.queue.pending,
            vector_coverage: status.coverage.vectors,
            precise_coverage: status.coverage.precise,
        },
        hint: "Call crux.expand with a span id for more context.",
    };
}

const asText = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

export function createMcpServer(ws: Workspace): McpServer {
    const server = new McpServer({ name: "crux", version: "0.1.0" });

    server.registerTool(
        "find",
        {
            title: "Search the codebase",
            description:
                "Hybrid search across the indexed codebase. Works with natural language " +
                '("where do we validate webhooks"), exact identifiers (RetryPolicy), error strings ' +
                "(ERR_SOCK_TIMEOUT), and path fragments (src/billing). Returns ranked code spans with " +
                "their location and why each matched. Prefer this over grep: it understands identifiers " +
                "split across naming conventions and ranks by relevance rather than returning every hit.",
            inputSchema: {
                query: z.string().describe("What you are looking for. Natural language or an exact identifier."),
                scope: z.string().optional().describe("Restrict to a path prefix, e.g. 'src/billing/'."),
                max_tokens: z.number().optional().describe("Token budget for the response. Default 4000."),
            },
        },
        async ({ query, scope, max_tokens }) => {
            const hits = ws.search(query, { scope, limit: 20, withText: true });
            const verified = await verify(ws, hits);
            return asText(envelope(ws, pack(verified, max_tokens ?? 4000)));
        },
    );

    server.registerTool(
        "symbol",
        {
            title: "Look up a symbol by name",
            description:
                "Look up a symbol by name and get its definition, full signature, doc comment, and " +
                "location. Use this instead of searching when you already know the name. Matches across " +
                "naming conventions, so getUserById finds get_user_by_id. In a real repo several things " +
                "share a name, so all matches are returned with disambiguating context.",
            inputSchema: {
                name: z.string().describe("The symbol name. Exact match is preferred; partial works."),
                kind: z
                    .enum(["function", "method", "class", "interface", "type", "enum", "struct", "constant"])
                    .optional()
                    .describe("Filter by kind."),
            },
        },
        async ({ name, kind }) => {
            const hits = ws.symbol(name, 20).filter((h) => !kind || h.kind === kind);
            return asText({
                symbols: hits.map((h) => ({
                    name: h.name,
                    kind: h.kind,
                    location: `${h.path}:${h.startLine}`,
                    signature: h.signature,
                    doc: h.doc,
                    enclosing: h.parent,
                    exported: h.exported,
                })),
                hint: hits.length === 0 ? "No match. Try crux.find for a natural-language search." : undefined,
            });
        },
    );

    server.registerTool(
        "outline",
        {
            title: "Structure of a file or directory",
            description:
                "Returns the structure of a file or directory: its symbols, signatures, and doc comments, " +
                "with bodies elided. The cheapest way to understand a large file before reading it — a " +
                "3,000-line file becomes a 60-line skeleton telling you exactly what is in it and what to " +
                "ask for next. For a directory, returns each file's exported symbols.",
            inputSchema: { path: z.string().describe("File or directory path, relative to the workspace root.") },
        },
        async ({ path }) => {
            const rows = ws.db
                .query<any, [string, string, string]>(
                    `SELECT path, name, kind, signature, doc, parent, start_line, exported
                       FROM symbols
                      WHERE workspace = ? AND (path = ? OR path GLOB ?)
                      ORDER BY path, start_line`,
                )
                .all(ws.root, path, `${path.replace(/\/$/, "")}/*`);

            const byFile = new Map<string, any[]>();
            for (const r of rows) {
                if (!byFile.has(r.path)) byFile.set(r.path, []);
                byFile.get(r.path)!.push({
                    name: r.name,
                    kind: r.kind,
                    line: r.start_line,
                    signature: r.signature,
                    doc: r.doc,
                    enclosing: r.parent,
                    exported: r.exported === 1,
                });
            }

            return asText({
                files: [...byFile.entries()].map(([file, symbols]) => ({ file, symbols })),
                hint: rows.length === 0 ? "Nothing indexed at that path. Check crux.status for coverage." : undefined,
            });
        },
    );

    server.registerTool(
        "expand",
        {
            title: "Show more code around a span",
            description:
                "Show more code around a span returned by an earlier crux call. Cheaper and more accurate " +
                "than searching again — pass the span id you were given. Use this to widen context on a " +
                "result you already have instead of re-running a query.",
            inputSchema: {
                span_id: z.string().describe("The id from an earlier result, e.g. sp_7f3ab21c."),
                before: z.number().optional().describe("Extra lines before. Default 20."),
                after: z.number().optional().describe("Extra lines after. Default 20."),
            },
        },
        async ({ span_id, before, after }) => {
            // Span ids are derived from (content_hash, path, range), so the
            // mapping is recovered by re-deriving ids over the file_chunks rows.
            const { spanId } = await import("./hash.ts");
            const rows = ws.db
                .query<any, [string]>(
                    "SELECT path, content_hash, start_line, end_line FROM file_chunks WHERE workspace = ?",
                )
                .all(ws.root);

            const match = rows.find((r) => spanId(r.content_hash, r.path, r.start_line, r.end_line) === span_id);
            if (!match) {
                return asText({ error: "Unknown span id. Span ids are valid for the current index only." });
            }

            const text = await Bun.file(join(ws.root, match.path)).text();
            const lines = text.split("\n");
            const start = Math.max(1, match.start_line - (before ?? 20));
            const end = Math.min(lines.length, match.end_line + (after ?? 20));

            return asText({
                path: match.path,
                lines: [start, end],
                text: lines.slice(start - 1, end).join("\n"),
                trust: "verified",
            });
        },
    );

    server.registerTool(
        "status",
        {
            title: "What is indexed and how fresh it is",
            description:
                "What is indexed, how fresh it is, and what is missing. Call this when results look wrong " +
                "or incomplete, before concluding that code does not exist. Reports file and symbol counts, " +
                "queue lag, per-tier coverage, and any degraded subsystem.",
            inputSchema: {},
        },
        async () => {
            const s = ws.status();
            return asText({
                workspace: s.workspace,
                indexed: { files: s.files, symbols: s.symbols, chunks: s.chunks },
                queue: s.queue,
                fresh: s.queue.pending === 0,
                watcher: s.watcher,
                coverage: {
                    lexical: `${Math.round(s.coverage.lexical * 100)}%`,
                    syntactic: `${Math.round(s.coverage.syntactic * 100)}%`,
                    precise: "0% (SCIP lands in Phase 2)",
                    vectors: "0% (embeddings land in Phase 3)",
                },
                index_size_mb: +(s.indexBytes / 1e6).toFixed(1),
                // Local-first is the pitch, so honour it precisely.
                network: "none — no telemetry, no cloud embeddings, no phone-home",
            });
        },
    );

    return server;
}

/** Serve MCP over stdio. Zero config, works everywhere, no ports, no auth. */
export async function serveMcp(ws: Workspace): Promise<void> {
    const server = createMcpServer(ws);
    await server.connect(new StdioServerTransport());
}
