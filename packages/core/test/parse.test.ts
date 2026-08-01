import { test, expect, describe } from "bun:test";
import { parseSource } from "../src/parse.ts";
import { detectLang } from "../src/lang.ts";

const parse = async (src: string, path: string) => {
    const r = await parseSource(src, path);
    if (!r) throw new Error(`no parse result for ${path}`);
    return r;
};

const named = (r: Awaited<ReturnType<typeof parse>>, name: string) => r.symbols.find((s) => s.name === name);

describe("language detection", () => {
    test("the Phase 1 set is recognised", () => {
        expect(detectLang("a.ts")?.lang).toBe("typescript");
        expect(detectLang("a.tsx")?.lang).toBe("tsx");
        expect(detectLang("a.mjs")?.lang).toBe("javascript");
        expect(detectLang("a.py")?.lang).toBe("python");
        expect(detectLang("a.go")?.lang).toBe("go");
        expect(detectLang("a.rs")?.lang).toBe("rust");
    });

    test("unknown extensions and extensionless files are not guessed", () => {
        expect(detectLang("a.zig")).toBeNull();
        expect(detectLang("Makefile")).toBeNull();
    });

    test("extension matching is case-insensitive", () => {
        expect(detectLang("A.TS")?.lang).toBe("typescript");
    });
});

describe("typescript", () => {
    const SRC = `
import { Database } from "bun:sqlite";

/** Runs op, retrying on transient failures. */
export class RetryPolicy {
    async execute<T>(op: () => Promise<T>): Promise<T> {
        return flushBuffer(op);
    }
}

export const MAX_RETRY_MS = 30_000;
export const handler = () => { doThing(); };
export function plain(a: number): void {}
interface Opts { x: number }
`;

    test("extracts every definition kind", async () => {
        const r = await parse(SRC, "src/billing/retry.ts");
        expect(r.symbols.map((s) => `${s.kind}:${s.name}`)).toEqual([
            "class:RetryPolicy",
            "method:execute",
            "constant:MAX_RETRY_MS",
            "function:handler",
            "function:plain",
            "interface:Opts",
        ]);
    });

    test("an arrow function assigned to a const is a function, not a constant", async () => {
        const r = await parse(SRC, "a.ts");
        expect(named(r, "handler")?.kind).toBe("function");
    });

    test("signatures stop at the body", async () => {
        const r = await parse(SRC, "a.ts");
        expect(named(r, "execute")?.signature).toBe("async execute<T>(op: () => Promise<T>): Promise<T>");
    });

    test("a doc comment above `export class` is attached to the class", async () => {
        const r = await parse(SRC, "a.ts");
        expect(named(r, "RetryPolicy")?.doc).toBe("/** Runs op, retrying on transient failures. */");
    });

    test("methods record their enclosing class", async () => {
        const r = await parse(SRC, "a.ts");
        expect(named(r, "execute")?.parent).toBe("RetryPolicy");
    });

    test("export status is tracked", async () => {
        const r = await parse(SRC, "a.ts");
        expect(named(r, "plain")?.exported).toBe(true);
        expect(named(r, "Opts")?.exported).toBe(false);
    });

    test("imports and call sites become graph material", async () => {
        const r = await parse(SRC, "a.ts");
        expect(r.imports.map((i) => i.specifier)).toEqual(["bun:sqlite"]);
        expect(r.calls).toContainEqual(expect.objectContaining({ name: "flushBuffer", from: "execute" }));
    });

    test("a comment separated by a blank line is not treated as documentation", async () => {
        const r = await parse("// stray\n\nexport function f() {}", "a.ts");
        expect(named(r, "f")?.doc).toBeNull();
    });
});

describe("python", () => {
    const SRC = `import os
from retry.policy import Backoff

class RetryPolicy:
    """Retries things."""
    def execute(self, op):
        return flush_buffer(op)

def _private(): pass
def public_fn(): pass
`;

    test("classes, methods, and functions", async () => {
        const r = await parse(SRC, "a.py");
        expect(r.symbols.map((s) => s.name)).toEqual(["RetryPolicy", "execute", "_private", "public_fn"]);
        expect(named(r, "execute")?.parent).toBe("RetryPolicy");
    });

    test("a docstring inside the body is found, not just comments above", async () => {
        const r = await parse(SRC, "a.py");
        expect(named(r, "RetryPolicy")?.doc).toBe('"""Retries things."""');
    });

    test("a leading underscore means private", async () => {
        const r = await parse(SRC, "a.py");
        expect(named(r, "_private")?.exported).toBe(false);
        expect(named(r, "public_fn")?.exported).toBe(true);
    });

    test("both import forms are captured", async () => {
        const r = await parse(SRC, "a.py");
        expect(r.imports.map((i) => i.specifier)).toEqual(["os", "retry.policy"]);
    });
});

describe("go", () => {
    const SRC = `package main

import "fmt"

// Execute runs the op.
type RetryPolicy struct { Max int }

func (r *RetryPolicy) Execute(op func()) error {
\treturn flushBuffer(op)
}

func unexported() {}
const MaxRetryMs = 30000
`;

    test("capitalisation is the export rule", async () => {
        const r = await parse(SRC, "a.go");
        expect(named(r, "Execute")?.exported).toBe(true);
        expect(named(r, "unexported")?.exported).toBe(false);
        expect(named(r, "MaxRetryMs")?.exported).toBe(true);
    });

    test("methods are distinguished from functions", async () => {
        const r = await parse(SRC, "a.go");
        expect(named(r, "Execute")?.kind).toBe("method");
        expect(named(r, "unexported")?.kind).toBe("function");
    });

    test("line comments above a declaration are documentation", async () => {
        const r = await parse(SRC, "a.go");
        expect(named(r, "RetryPolicy")?.doc).toBe("// Execute runs the op.");
    });
});

describe("rust", () => {
    const SRC = `use std::collections::HashMap;

/// Retries things.
/// Second line.
pub struct RetryPolicy { max: u32 }

pub trait Backoff { fn next(&self) -> u32; }

pub fn execute(op: fn()) { flush_buffer(op); }
fn private_helper() {}
pub const MAX_RETRY_MS: u32 = 30000;
`;

    test("pub is the export rule — and it is a child of the item, not the parent", async () => {
        const r = await parse(SRC, "a.rs");
        expect(named(r, "RetryPolicy")?.exported).toBe(true);
        expect(named(r, "execute")?.exported).toBe(true);
        expect(named(r, "private_helper")?.exported).toBe(false);
    });

    test("/// doc comments are line_comment nodes, not comment nodes", async () => {
        const r = await parse(SRC, "a.rs");
        expect(named(r, "RetryPolicy")?.doc).toBe("/// Retries things.\n/// Second line.");
    });

    test("traits map onto the interface kind", async () => {
        const r = await parse(SRC, "a.rs");
        expect(named(r, "Backoff")?.kind).toBe("interface");
    });
});

describe("chunking", () => {
    test("a chunk never cuts a function body in half", async () => {
        const src = ["function a() {", "  one();", "  two();", "}", "", "function b() {", "  three();", "}"].join("\n");
        const r = await parse(src, "a.ts");

        for (const chunk of r.chunks) {
            const symbol = r.symbols.find((s) => s.startLine === chunk.startLine);
            if (symbol) expect(chunk.endLine).toBeGreaterThanOrEqual(symbol.endLine);
        }
    });

    test("small adjacent declarations merge into one chunk", async () => {
        const r = await parse("const a = 1;\nconst b = 2;\nconst c = 3;\n", "a.ts");
        expect(r.chunks).toHaveLength(1);
        expect(r.chunks[0]?.symbol).toBe("a, b, c");
    });

    test("a class never merges with its neighbours, however short", async () => {
        const r = await parse("class Tiny {}\nconst a = 1;\nconst b = 2;\n", "a.ts");
        expect(r.chunks[0]?.symbol).toBe("Tiny");
        expect(r.chunks).toHaveLength(2);
    });

    test("a very long function is split rather than becoming one huge chunk", async () => {
        const body = Array.from({ length: 300 }, (_, i) => `  line${i}();`).join("\n");
        const r = await parse(`function big() {\n${body}\n}`, "a.ts");

        expect(r.chunks.length).toBeGreaterThan(1);
        for (const c of r.chunks) expect(c.endLine - c.startLine + 1).toBeLessThanOrEqual(120);
    });

    test("a file with no symbols still produces one chunk", async () => {
        const r = await parse("// just a comment\n", "a.ts");
        expect(r.chunks).toHaveLength(1);
        expect(r.chunks[0]?.symbol).toBeNull();
    });

    /**
     * Regression: chunks used to cover only symbol spans, so a file's module doc
     * comment — often the best prose description of what the file is — was never
     * indexed and could not be found.
     */
    test("the module doc comment above the first symbol is covered", async () => {
        const src = [
            "/**",
            " * Leader election with heartbeat and fencing.",
            " */",
            "",
            'import { x } from "y";',
            "",
            "export function elect() {}",
        ].join("\n");
        const r = await parse(src, "leader.ts");

        expect(r.chunks[0]?.startLine).toBe(1);
        const coversHeader = r.chunks.some((c) => c.startLine <= 2 && c.endLine >= 2);
        expect(coversHeader).toBe(true);
    });

    test("trailing code after the last symbol is covered", async () => {
        const src = "export function f() {}\n\nconst config = { retries: 3 };\nsetup(config);\n";
        const r = await parse(src, "a.ts");
        const lastLine = src.split("\n").length - 1;

        expect(r.chunks.some((c) => c.endLine >= lastLine)).toBe(true);
    });

    test("gaps between symbols are covered", async () => {
        const src = [
            "export function a() {}",
            "",
            "// an important note about the constant below",
            "",
            "export function b() {}",
        ].join("\n");
        const r = await parse(src, "a.ts");

        expect(r.chunks.some((c) => c.startLine <= 3 && c.endLine >= 3)).toBe(true);
    });

    test("blank regions do not become empty chunks", async () => {
        const r = await parse("export function a() {}\n\n\n\n\nexport function b() {}\n", "a.ts");
        for (const c of r.chunks) {
            expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
        }
        // No chunk consists only of blank lines.
        expect(r.chunks.length).toBeLessThanOrEqual(3);
    });
});

describe("robustness", () => {
    test("a syntax error is reported but the file is still indexed", async () => {
        const r = await parse("export function broken( {\n  oops\n", "a.ts");
        expect(r.hasErrors).toBe(true);
        expect(r.chunks.length).toBeGreaterThan(0);
    });

    test("an empty file does not throw", async () => {
        const r = await parse("", "a.ts");
        expect(r.symbols).toEqual([]);
    });

    test("an unknown extension returns null rather than guessing", async () => {
        expect(await parseSource("x", "a.zig")).toBeNull();
    });
});
