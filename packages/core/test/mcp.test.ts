import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { Workspace } from "../src/workspace.ts";
import { createMcpServer } from "../src/mcp.ts";

let dir: string;
let ws: Workspace;
let client: Client;

/** Tool results come back as a JSON text block. */
async function call(name: string, args: Record<string, unknown> = {}) {
    const result = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[] };
    return JSON.parse(result.content[0]!.text);
}

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crux-mcp-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
        join(dir, "src", "retry.ts"),
        [
            "/** Retries a failed webhook delivery with exponential backoff. */",
            "export class RetryPolicy {",
            "    async execute(op: () => Promise<void>) {",
            "        return flushBuffer(op);",
            "    }",
            "}",
            "",
            'export const ERR_SOCK_TIMEOUT = "socket timed out";',
        ].join("\n"),
    );

    ws = new Workspace({ root: dir, memory: true });
    await ws.coldIndex();
    await ws.drain();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([createMcpServer(ws).connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
    await client.close();
    ws.close();
    await rm(dir, { recursive: true, force: true });
});

describe("the tool surface", () => {
    test("stays under the eight-tool cap", async () => {
        const { tools } = await client.listTools();
        expect(tools.length).toBeLessThanOrEqual(8);
    });

    test("every tool has a description — the description is the prompt", async () => {
        const { tools } = await client.listTools();
        for (const tool of tools) {
            expect(tool.description ?? "").not.toBe("");
            // Long enough to actually steer tool selection.
            expect((tool.description ?? "").length).toBeGreaterThan(120);
        }
    });

    test("exposes the Phase 1 tools", async () => {
        const names = (await client.listTools()).tools.map((t) => t.name).sort();
        expect(names).toEqual(["expand", "find", "outline", "status", "symbol"]);
    });
});

describe("find", () => {
    test("answers a natural-language question with located spans", async () => {
        const result = await call("find", { query: "retry a failed webhook" });

        expect(result.spans.length).toBeGreaterThan(0);
        expect(result.spans[0].path).toBe("src/retry.ts");
        expect(result.spans[0].lines).toHaveLength(2);
        expect(result.spans[0].id).toMatch(/^sp_/);
    });

    test("every returned span is verified against disk", async () => {
        const result = await call("find", { query: "RetryPolicy" });
        for (const span of result.spans) expect(span.trust).toBe("verified");
    });

    test("the response carries index freshness so an agent can qualify its answer", async () => {
        const result = await call("find", { query: "webhook" });
        expect(result.index).toMatchObject({ fresh: true, queue_depth: 0 });
        expect(result.index.vector_coverage).toBe(0);
    });

    test("respects a token budget", async () => {
        const result = await call("find", { query: "webhook retry socket", max_tokens: 60 });
        const spent = result.spans.reduce((n: number, s: any) => n + Math.ceil((s.text?.length ?? 0) / 4) + 32, 0);
        expect(spent).toBeLessThanOrEqual(60);
    });

    test("a query matching nothing returns empty rather than erroring", async () => {
        const result = await call("find", { query: "zzzznotpresentanywhere" });
        expect(result.spans).toEqual([]);
    });
});

describe("symbol", () => {
    test("returns the definition with its contract", async () => {
        const result = await call("symbol", { name: "RetryPolicy" });

        expect(result.symbols[0]).toMatchObject({
            name: "RetryPolicy",
            kind: "class",
            location: "src/retry.ts:2",
            exported: true,
        });
        expect(result.symbols[0].doc).toContain("exponential backoff");
    });

    test("filters by kind", async () => {
        const result = await call("symbol", { name: "execute", kind: "method" });
        expect(result.symbols.every((s: any) => s.kind === "method")).toBe(true);
    });

    test("an unknown name hints at the alternative rather than failing", async () => {
        const result = await call("symbol", { name: "NoSuchSymbol" });
        expect(result.symbols).toEqual([]);
        expect(result.hint).toContain("crux.find");
    });
});

describe("outline", () => {
    test("returns a file's structure with bodies elided", async () => {
        const result = await call("outline", { path: "src/retry.ts" });

        expect(result.files).toHaveLength(1);
        const names = result.files[0].symbols.map((s: any) => s.name);
        expect(names).toContain("RetryPolicy");
        expect(names).toContain("execute");
        // Signatures, not bodies — that is the point.
        expect(JSON.stringify(result)).not.toContain("flushBuffer");
    });

    test("works on a directory", async () => {
        const result = await call("outline", { path: "src" });
        expect(result.files.length).toBeGreaterThan(0);
    });
});

describe("expand", () => {
    test("widens context around a span id from an earlier call", async () => {
        const found = await call("find", { query: "RetryPolicy" });
        const id = found.spans[0].id;

        const expanded = await call("expand", { span_id: id, before: 5, after: 5 });

        expect(expanded.path).toBe("src/retry.ts");
        expect(expanded.text.length).toBeGreaterThan(0);
        expect(expanded.trust).toBe("verified");
    });

    test("an unknown span id explains itself instead of throwing", async () => {
        const result = await call("expand", { span_id: "sp_deadbeef" });
        expect(result.error).toContain("Unknown span id");
    });
});

describe("status", () => {
    test("reports coverage honestly, including what has not run", async () => {
        const result = await call("status");

        expect(result.indexed.files).toBe(1);
        expect(result.indexed.symbols).toBeGreaterThan(0);
        expect(result.fresh).toBe(true);
        // The tiers that do not exist yet must say so rather than implying 100%.
        expect(result.coverage.precise).toContain("Phase 2");
        expect(result.coverage.vectors).toContain("Phase 3");
    });

    test("states plainly that nothing leaves the machine", async () => {
        const result = await call("status");
        expect(result.network).toContain("none");
    });
});

describe("freshness", () => {
    test("an edit made behind the index is served live, not stale", async () => {
        await writeFile(
            join(dir, "src", "retry.ts"),
            "/** Rewritten. */\nexport class RetryPolicy {\n    async execute() { return newBehaviour(); }\n}\n",
        );

        const result = await call("find", { query: "RetryPolicy" });

        // The index still holds the old bytes, so the span must be refreshed
        // from disk and flagged rather than returned as verified.
        const refreshed = result.spans.find((s: any) => s.trust === "stale-refreshed");
        expect(refreshed).toBeDefined();
        expect(refreshed.text).toContain("newBehaviour");

        // And the file is queued so the next query is clean.
        expect(ws.queue.depth().pending).toBeGreaterThan(0);
    });

    test("a span from a deleted file is never returned", async () => {
        await rm(join(dir, "src", "retry.ts"));
        const result = await call("find", { query: "RetryPolicy" });
        expect(result.spans).toEqual([]);
    });
});
