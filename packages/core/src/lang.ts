/**
 * Language registry — see 05-index-tiers.md.
 *
 * Four languages done properly beats fifteen with generic queries: tag queries
 * and import resolution are where quality actually comes from, and both are
 * per-language work.
 *
 * Queries are embedded as strings rather than loaded from .scm files on disk,
 * because `bun build --compile` embeds source but not arbitrary assets. Grammars
 * are a different matter — they are .wasm downloaded at runtime, per the plan.
 */

export type Lang = "typescript" | "tsx" | "javascript" | "python" | "go" | "rust";

/** Capture kinds a tag query may emit, mapped onto `symbols.kind`. */
export type SymbolKind =
    "function" | "method" | "class" | "interface" | "type" | "enum" | "struct" | "constant" | "module" | "impl";

export interface LangSpec {
    lang: Lang;
    /** Grammar file name inside the grammar directory. */
    grammar: string;
    extensions: string[];
    /** tree-sitter tag query; captures are @name, @definition.<kind>, @import.source, @call.name. */
    tags: string;
    /** Node type whose presence around a definition marks it exported. */
    isExported(node: { type: string; parentType: string | null; text: string; name: string }): boolean;
}

// ── TypeScript / JavaScript ─────────────────────────────────────────────────

const TS_TAGS = `
(function_declaration name: (identifier) @name) @definition.function
(generator_function_declaration name: (identifier) @name) @definition.function

(class_declaration name: (type_identifier) @name) @definition.class
(abstract_class_declaration name: (type_identifier) @name) @definition.class

(interface_declaration name: (type_identifier) @name) @definition.interface
(type_alias_declaration name: (type_identifier) @name) @definition.type
(enum_declaration name: (identifier) @name) @definition.enum

(method_definition name: (property_identifier) @name) @definition.method
(abstract_method_signature name: (property_identifier) @name) @definition.method

; const handler = () => {}   and   const handler = function () {}
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)])) @definition.function

; plain top-level constants — MAX_RETRY_MS and friends
(lexical_declaration
  (variable_declarator name: (identifier) @name)) @definition.constant

(import_statement source: (string) @import.source)
(call_expression function: (identifier) @call.name)
(call_expression function: (member_expression property: (property_identifier) @call.name))
`;

const JS_TAGS = `
(function_declaration name: (identifier) @name) @definition.function
(generator_function_declaration name: (identifier) @name) @definition.function
(class_declaration name: (identifier) @name) @definition.class
(method_definition name: (property_identifier) @name) @definition.method

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)])) @definition.function

(lexical_declaration
  (variable_declarator name: (identifier) @name)) @definition.constant

(import_statement source: (string) @import.source)
(call_expression function: (identifier) @call.name)
(call_expression function: (member_expression property: (property_identifier) @call.name))
`;

// ── Python ──────────────────────────────────────────────────────────────────

const PY_TAGS = `
(function_definition name: (identifier) @name) @definition.function
(class_definition name: (identifier) @name) @definition.class

(import_from_statement module_name: (dotted_name) @import.source)
(import_statement name: (dotted_name) @import.source)

(call function: (identifier) @call.name)
(call function: (attribute attribute: (identifier) @call.name))
`;

// ── Go ──────────────────────────────────────────────────────────────────────

const GO_TAGS = `
(function_declaration name: (identifier) @name) @definition.function
(method_declaration name: (field_identifier) @name) @definition.method
(type_declaration (type_spec name: (type_identifier) @name)) @definition.type
(const_declaration (const_spec name: (identifier) @name)) @definition.constant

(import_spec path: (interpreted_string_literal) @import.source)

(call_expression function: (identifier) @call.name)
(call_expression function: (selector_expression field: (field_identifier) @call.name))
`;

// ── Rust ────────────────────────────────────────────────────────────────────

const RS_TAGS = `
(function_item name: (identifier) @name) @definition.function
(struct_item name: (type_identifier) @name) @definition.struct
(enum_item name: (type_identifier) @name) @definition.enum
(trait_item name: (type_identifier) @name) @definition.interface
(mod_item name: (identifier) @name) @definition.module
(const_item name: (identifier) @name) @definition.constant
(static_item name: (identifier) @name) @definition.constant

(use_declaration argument: (scoped_identifier) @import.source)
(use_declaration argument: (identifier) @import.source)

(call_expression function: (identifier) @call.name)
(call_expression function: (field_expression field: (field_identifier) @call.name))
`;

/** TS/JS: exported iff the definition sits under an `export` statement. */
const exportedByStatement = (n: { parentType: string | null }) =>
    n.parentType === "export_statement" || n.parentType === "export_specifier";

export const LANGUAGES: Record<Lang, LangSpec> = {
    typescript: {
        lang: "typescript",
        grammar: "tree-sitter-typescript.wasm",
        extensions: [".ts", ".mts", ".cts"],
        tags: TS_TAGS,
        isExported: exportedByStatement,
    },
    tsx: {
        lang: "tsx",
        grammar: "tree-sitter-tsx.wasm",
        extensions: [".tsx"],
        tags: TS_TAGS,
        isExported: exportedByStatement,
    },
    javascript: {
        lang: "javascript",
        grammar: "tree-sitter-javascript.wasm",
        extensions: [".js", ".mjs", ".cjs", ".jsx"],
        tags: JS_TAGS,
        isExported: exportedByStatement,
    },
    python: {
        lang: "python",
        grammar: "tree-sitter-python.wasm",
        extensions: [".py", ".pyi"],
        tags: PY_TAGS,
        // Convention, not enforcement: a leading underscore means private.
        isExported: (n) => !n.name.startsWith("_"),
    },
    go: {
        lang: "go",
        grammar: "tree-sitter-go.wasm",
        extensions: [".go"],
        tags: GO_TAGS,
        // Go's export rule is literally capitalisation.
        isExported: (n) => /^[A-Z]/.test(n.name),
    },
    rust: {
        lang: "rust",
        grammar: "tree-sitter-rust.wasm",
        extensions: [".rs"],
        tags: RS_TAGS,
        isExported: (n) => n.text.startsWith("pub "),
    },
};

const BY_EXTENSION = new Map<string, LangSpec>();
for (const spec of Object.values(LANGUAGES)) {
    for (const ext of spec.extensions) BY_EXTENSION.set(ext, spec);
}

export function detectLang(path: string): LangSpec | null {
    const dot = path.lastIndexOf(".");
    if (dot < 0) return null;
    return BY_EXTENSION.get(path.slice(dot).toLowerCase()) ?? null;
}
