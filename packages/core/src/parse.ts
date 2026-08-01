/**
 * Tier 1 — syntactic extraction via tree-sitter WASM. See 05-index-tiers.md.
 *
 * WASM rather than native bindings is load-bearing for distribution: no
 * node-gyp, no prebuild matrix, same code path on every platform, and grammars
 * stay lazily downloadable .wasm files instead of 40 MB compiled into the
 * binary. Measured at 0.57 ms p50 per file (spikes/treesitter-throughput.ts),
 * so the cost of WASM over native is irrelevant here.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { detectLang, type LangSpec, type SymbolKind } from "./lang.ts";

// web-tree-sitter 0.24 exposes Language only after init(), and moved to named
// exports at 0.25. Grammars are ABI-locked to a runtime range, so the version is
// pinned in package.json — see spikes/README.md.
const ts: any = await import("web-tree-sitter");
const TSParser = ts.Parser ?? ts.default;

// The tree-sitter RUNTIME wasm (not a grammar) must be embedded in the binary.
// Emscripten resolves it relative to the script directory, which in a compiled
// binary is the build machine's node_modules — a released binary died with
// `ENOENT: /home/runner/work/crux/crux/node_modules/.../tree-sitter.wasm`.
// `with { type: "file" }` makes Bun embed the bytes and hand back a path that
// resolves inside the binary at runtime.
import TREE_SITTER_WASM from "web-tree-sitter/tree-sitter.wasm" with { type: "file" };

export interface ParsedSymbol {
    name: string;
    kind: SymbolKind;
    signature: string;
    doc: string | null;
    parent: string | null;
    startLine: number;
    endLine: number;
    exported: boolean;
}

export interface ParsedImport {
    /** The raw specifier, unresolved at this tier. */
    specifier: string;
    line: number;
}

export interface ParsedCall {
    /** Callee name only — which `flush` this is stays unknown until SCIP. */
    name: string;
    line: number;
    /** Enclosing symbol, so the edge has a source. */
    from: string | null;
}

export interface ParseResult {
    lang: string;
    symbols: ParsedSymbol[];
    imports: ParsedImport[];
    calls: ParsedCall[];
    /** Chunk boundaries from the AST, never from a character count. */
    chunks: { startLine: number; endLine: number; symbol: string | null }[];
    /** True when tree-sitter reported syntax errors; the file is still indexed. */
    hasErrors: boolean;
}

/**
 * Where grammars live. Downloaded lazily to the cache dir in production; the
 * node_modules copy is the development fallback so a fresh checkout just works.
 */
export function grammarDir(): string {
    const configured = process.env.CRUX_GRAMMAR_DIR;
    if (configured) return configured;

    // The development fallback comes first when it exists, so a source checkout
    // never depends on the network. A compiled binary has no node_modules and
    // falls through to the cache that `crux doctor --fetch` populates.
    const vendored = join(import.meta.dir, "..", "..", "..", "node_modules", "tree-sitter-wasms", "out");
    if (existsSync(vendored)) return vendored;

    return join(homedir(), ".cache", "crux", "grammars");
}

let initialized = false;

/** Lazily loaded per language: grammar + compiled query are both expensive. */
const loaded = new Map<string, { language: unknown; query: any; spec: LangSpec }>();

async function loadLanguage(spec: LangSpec) {
    const cached = loaded.get(spec.lang);
    if (cached) return cached;

    if (!initialized) {
        // locateFile is Emscripten's hook for finding tree-sitter.wasm; without
        // it the runtime looks next to the script, which does not exist once
        // compiled.
        await TSParser.init({ locateFile: () => TREE_SITTER_WASM });
        initialized = true;
    }
    const Language = ts.Language ?? TSParser.Language;

    const path = join(grammarDir(), spec.grammar);
    if (!existsSync(path)) {
        throw new Error(`Grammar not found: ${path}. Run \`crux doctor\` to fetch grammars.`);
    }

    const language = await Language.load(path);
    const query = ts.Query ? new ts.Query(language, spec.tags) : (language as any).query(spec.tags);

    const entry = { language, query, spec };
    loaded.set(spec.lang, entry);
    return entry;
}

/** Grammars disagree: Go/TS say `comment`, Rust says `line_comment`. */
const COMMENT_TYPES = new Set(["comment", "line_comment", "block_comment"]);

/**
 * Python puts documentation *inside* the body as the first string expression,
 * not above the definition, so the comment walk below never finds it.
 */
function docstring(node: any): string | null {
    const body = node.childForFieldName?.("body");
    const first = body?.namedChildren?.[0];
    if (first?.type !== "expression_statement") return null;
    const str = first.namedChildren?.[0];
    return str?.type === "string" ? str.text : null;
}

/** The doc comment attached to a definition: contiguous comment lines above it. */
function leadingDoc(node: any, source: string): string | null {
    const lines: string[] = [];

    // `export class Foo` puts the comment above the export_statement, and the
    // class's own previousSibling is the `export` keyword — not null — so this
    // has to anchor on the outermost node, not fall back when siblings run out.
    const anchor = node.parent?.type === "export_statement" ? node.parent : node;
    let prev = anchor.previousSibling;

    let boundary = anchor.startIndex;
    while (prev && COMMENT_TYPES.has(prev.type)) {
        // Stop if a blank line separates the comment from what it documents.
        const between = source.slice(prev.endIndex, boundary);
        if ((between.match(/\n/g)?.length ?? 0) > 1) break;

        lines.unshift(prev.text);
        boundary = prev.startIndex;
        prev = prev.previousSibling;
    }
    return lines.length > 0 ? lines.join("\n") : docstring(node);
}

/** Signature = the declaration up to the body, so callers see the contract. */
function signatureOf(node: any, source: string): string {
    const body =
        node.childForFieldName?.("body") ??
        node.namedChildren?.find(
            (c: any) => c.type === "statement_block" || c.type === "block" || c.type === "field_declaration_list",
        );

    const end = body ? body.startIndex : node.endIndex;
    return source
        .slice(node.startIndex, Math.min(end, node.startIndex + 400))
        .replace(/\s+/g, " ")
        .trim();
}

/** Nearest enclosing class/module, for `symbols.parent`. */
function enclosingScope(node: any): string | null {
    const CONTAINER =
        /^(class_declaration|abstract_class_declaration|class_definition|class_specifier|impl_item|mod_item|type_declaration)$/;
    for (let p = node.parent; p; p = p.parent) {
        if (CONTAINER.test(p.type)) {
            const name = p.childForFieldName?.("name");
            if (name) return name.text;
        }
    }
    return null;
}

export async function parseSource(source: string, path: string): Promise<ParseResult | null> {
    const spec = detectLang(path);
    if (!spec) return null;

    const { language, query } = await loadLanguage(spec);
    const parser = new TSParser();
    parser.setLanguage(language);

    const tree = parser.parse(source);
    if (!tree) return null;

    try {
        const symbols: ParsedSymbol[] = [];
        const imports: ParsedImport[] = [];
        const calls: ParsedCall[] = [];

        for (const match of query.matches(tree.rootNode)) {
            const byName = new Map<string, any>();
            for (const c of match.captures) byName.set(c.name, c.node);

            const nameNode = byName.get("name");

            // @definition.<kind>
            const defCapture = match.captures.find((c: any) => c.name.startsWith("definition."));
            if (defCapture && nameNode) {
                const node = defCapture.node;
                const kind = defCapture.name.slice("definition.".length) as SymbolKind;
                const parentType = node.parent?.type ?? null;

                symbols.push({
                    name: nameNode.text,
                    kind,
                    signature: signatureOf(node, source),
                    doc: leadingDoc(node, source),
                    parent: enclosingScope(node),
                    startLine: node.startPosition.row + 1,
                    endLine: node.endPosition.row + 1,
                    exported: spec.isExported({
                        type: node.type,
                        parentType,
                        // The node's own text: Rust's `pub` is a child of the
                        // item, so the parent's text would be the whole file.
                        text: node.text,
                        name: nameNode.text,
                    }),
                });
                continue;
            }

            const importNode = byName.get("import.source");
            if (importNode) {
                imports.push({
                    specifier: importNode.text.replace(/^['"`]|['"`]$/g, ""),
                    line: importNode.startPosition.row + 1,
                });
                continue;
            }

            const callNode = byName.get("call.name");
            if (callNode) {
                calls.push({
                    name: callNode.text,
                    line: callNode.startPosition.row + 1,
                    from: enclosingSymbolName(callNode),
                });
            }
        }

        // Chunking must see the deduped list: two identical spans would each
        // count as "contained in another symbol" and both drop out.
        const deduped = dedupeSymbols(symbols);
        return {
            lang: spec.lang,
            symbols: deduped,
            imports,
            calls,
            chunks: chunkBoundaries(deduped, source),
            hasErrors: tree.rootNode.hasError,
        };
    } finally {
        tree.delete();
    }
}

/** The function or method a call site sits inside. */
function enclosingSymbolName(node: any): string | null {
    const DEFN =
        /^(function_declaration|generator_function_declaration|method_definition|function_definition|method_declaration|function_item|arrow_function)$/;
    for (let p = node.parent; p; p = p.parent) {
        if (DEFN.test(p.type)) {
            const name = p.childForFieldName?.("name");
            if (name) return name.text;
        }
    }
    return null;
}

/**
 * Overlapping patterns are deliberate — `const x = () => {}` matches both the
 * arrow-function rule and the generic constant rule. Keep the specific one.
 */
function dedupeSymbols(symbols: ParsedSymbol[]): ParsedSymbol[] {
    const best = new Map<string, ParsedSymbol>();
    for (const s of symbols) {
        const key = `${s.name}:${s.startLine}`;
        const existing = best.get(key);
        if (!existing || (existing.kind === "constant" && s.kind !== "constant")) best.set(key, s);
    }
    return [...best.values()].sort((a, b) => a.startLine - b.startLine);
}

/** Max lines in a chunk before it is split at a statement boundary. */
const MAX_CHUNK_LINES = 120;
/** A symbol this small is a one-liner or a getter — a candidate for merging. */
const MERGE_UNDER_LINES = 3;
/** Blank lines tolerated between merged symbols. */
const MERGE_GAP_LINES = 2;
/** A merged cluster never grows past this. */
const MAX_MERGED_LINES = 40;
/** These name a unit of meaning and always stand alone, however short. */
const CONTAINER_KINDS = new Set(["class", "struct", "interface", "impl", "module", "enum"]);

/**
 * Chunk boundaries come from the AST, never a character count — a chunk must
 * never cut a function body in half (05-index-tiers.md).
 *
 * Only *small adjacent* symbols merge: a cluster of one-line getters or a block
 * of constants. A real class or function is always its own chunk, because
 * bundling it with unrelated neighbours is what makes retrieved context vague.
 */
function chunkBoundaries(symbols: ParsedSymbol[], source: string): ParseResult["chunks"] {
    const totalLines = source.split("\n").length;
    if (symbols.length === 0) {
        return totalLines > 0 ? [{ startLine: 1, endLine: totalLines, symbol: null }] : [];
    }

    // Only top-level spans: a method is already inside its class's span. Strict
    // containment, so two symbols sharing a span do not cancel each other out.
    const top = symbols.filter(
        (s, i) =>
            !symbols.some(
                (o, j) =>
                    j !== i &&
                    o.startLine <= s.startLine &&
                    o.endLine >= s.endLine &&
                    !(o.startLine === s.startLine && o.endLine === s.endLine),
            ),
    );

    const chunks: ParseResult["chunks"] = [];
    let pending: { startLine: number; endLine: number; symbol: string | null } | null = null;
    let pendingIsSmall = false;

    for (const s of top) {
        const lines = s.endLine - s.startLine + 1;
        // A three-line class is still a class: bundling it with the constants
        // that happen to follow it makes the retrieved context vague.
        const small = lines <= MERGE_UNDER_LINES && !CONTAINER_KINDS.has(s.kind);

        const mergeable =
            pending !== null &&
            pendingIsSmall &&
            small &&
            s.startLine - pending.endLine <= MERGE_GAP_LINES + 1 &&
            s.endLine - pending.startLine + 1 <= MAX_MERGED_LINES;

        if (mergeable && pending) {
            pending.endLine = s.endLine;
            pending.symbol = `${pending.symbol}, ${s.name}`;
            continue;
        }

        if (pending) chunks.push(pending);

        if (lines > MAX_CHUNK_LINES) {
            for (let start = s.startLine; start <= s.endLine; start += MAX_CHUNK_LINES) {
                chunks.push({
                    startLine: start,
                    endLine: Math.min(start + MAX_CHUNK_LINES - 1, s.endLine),
                    symbol: s.name,
                });
            }
            pending = null;
            pendingIsSmall = false;
            continue;
        }

        pending = { startLine: s.startLine, endLine: s.endLine, symbol: s.name };
        pendingIsSmall = small;
    }
    if (pending) chunks.push(pending);
    return withGapsFilled(chunks, source);
}

/**
 * Cover the lines no symbol span claims.
 *
 * Without this, anything outside a top-level definition is invisible to search:
 * the module doc comment at the top of a file, imports, top-level configuration
 * objects, and trailing statements. Measured on crux's own source, `leader.ts`
 * chunks began at line 18 — so the header explaining what the file *is*, the
 * best prose summary in the file, could not be found at all.
 */
function withGapsFilled(chunks: ParseResult["chunks"], source: string): ParseResult["chunks"] {
    const lines = source.split("\n");
    const covered = [...chunks].sort((a, b) => a.startLine - b.startLine);
    const filled: ParseResult["chunks"] = [];

    const hasContent = (from: number, to: number) => lines.slice(from - 1, to).some((l) => l.trim().length > 0);

    let cursor = 1;
    for (const chunk of covered) {
        if (chunk.startLine > cursor && hasContent(cursor, chunk.startLine - 1)) {
            for (let start = cursor; start < chunk.startLine; start += MAX_CHUNK_LINES) {
                const end = Math.min(start + MAX_CHUNK_LINES - 1, chunk.startLine - 1);
                if (hasContent(start, end)) filled.push({ startLine: start, endLine: end, symbol: null });
            }
        }
        filled.push(chunk);
        cursor = Math.max(cursor, chunk.endLine + 1);
    }

    if (cursor <= lines.length && hasContent(cursor, lines.length)) {
        for (let start = cursor; start <= lines.length; start += MAX_CHUNK_LINES) {
            const end = Math.min(start + MAX_CHUNK_LINES - 1, lines.length);
            if (hasContent(start, end)) filled.push({ startLine: start, endLine: end, symbol: null });
        }
    }

    return filled;
}

export async function parseFile(path: string): Promise<ParseResult | null> {
    return parseSource(await Bun.file(path).text(), path);
}
