/**
 * web-tree-sitter parse throughput on a real tree.
 *
 * Gates: 05-index-tiers.md (Tier 1 is Phase 1) and 02-queue.md:154 ("Parse is ~2 ms")
 *
 * If WASM parsing is far slower than 2 ms/file, the fast-lane latency promise
 * in 02-queue.md ("symbols queryable in ~50 ms") does not hold and the lane
 * split needs rethinking. Corpus is loop's own source — real TypeScript.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, extname } from "node:path";

// web-tree-sitter changed its export shape at 0.25: before that it was a default
// export with Parser.Language nested; after, named exports. Grammar .wasm files
// are ABI-locked to a runtime range, so we have to be able to drive either.
const ts: any = await import("web-tree-sitter");
const runtimeVersion = (await Bun.file("node_modules/web-tree-sitter/package.json").json()).version as string;
const Parser = ts.Parser ?? ts.default;
const makeQuery = (lang: any, src: string) => (ts.Query ? new ts.Query(lang, src) : lang.query(src));

const CORPUS = "/Users/shekhar/Documents/notshekhar/loop/packages";
const GRAMMAR = "node_modules/tree-sitter-wasms/out/tree-sitter-typescript.wasm";

async function walk(dir: string, acc: string[] = []): Promise<string[]> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p, acc);
        else if ([".ts", ".tsx"].includes(extname(e.name))) acc.push(p);
    }
    return acc;
}

// A trimmed tags query — the real one comes from upstream tags.scm per 05-index-tiers.md:50
const TAGS = `
(function_declaration name: (identifier) @name) @def
(class_declaration name: (type_identifier) @name) @def
(interface_declaration name: (type_identifier) @name) @def
(method_definition name: (property_identifier) @name) @def
(export_statement) @export
(import_statement source: (string) @import)
`;

const t0 = performance.now();
await Parser.init();
// Pre-0.25 exposes Language only after init() completes.
const Language = ts.Language ?? Parser.Language;
const lang = await Language.load(GRAMMAR);
const parser = new Parser();
parser.setLanguage(lang);
const loadMs = performance.now() - t0;

let query: any = null;
let queryErr = "";
try {
    query = makeQuery(lang, TAGS);
} catch (e) {
    queryErr = (e as Error).message;
}

const files = await walk(CORPUS);
let bytes = 0;
let symbols = 0;
let imports = 0;
let failures = 0;
const perFile: number[] = [];

const tStart = performance.now();
for (const f of files) {
    const src = await readFile(f, "utf8");
    bytes += src.length;
    const t = performance.now();
    const tree = parser.parse(src);
    if (!tree) {
        failures++;
        continue;
    }
    if (query) {
        for (const m of query.matches(tree.rootNode)) {
            for (const c of m.captures) {
                if (c.name === "name") symbols++;
                else if (c.name === "import") imports++;
            }
        }
    }
    perFile.push(performance.now() - t);
    tree.delete();
}
const totalMs = performance.now() - tStart;

perFile.sort((a, b) => a - b);
const pct = (p: number) => perFile[Math.floor(perFile.length * p)]?.toFixed(2) ?? "-";
const mb = bytes / 1024 / 1024;

console.log(`\n  tree-sitter ${runtimeVersion} (WASM)\n`);
console.log(`  grammar load        ${loadMs.toFixed(0)} ms (one-time)`);
console.log(`  query compile       ${query ? "ok" : `FAILED — ${queryErr}`}`);
console.log(`  corpus              ${files.length} files, ${mb.toFixed(1)} MB of TypeScript`);
console.log(`  parse+extract total ${totalMs.toFixed(0)} ms`);
console.log(
    `  throughput          ${(files.length / (totalMs / 1000)).toFixed(0)} files/s, ${(mb / (totalMs / 1000)).toFixed(1)} MB/s`,
);
console.log(
    `  per file            p50 ${pct(0.5)} ms   p95 ${pct(0.95)} ms   p99 ${pct(0.99)} ms   max ${perFile.at(-1)?.toFixed(1)} ms`,
);
console.log(`  extracted           ${symbols} symbols, ${imports} imports`);
console.log(`  parse failures      ${failures}`);
console.log(`  rss                 ${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)} MB\n`);

const budget = 2.0; // 02-queue.md:154
console.log(
    `  ${Number(pct(0.5)) <= budget ? "PASS" : "OVER"}  p50 ${pct(0.5)} ms vs the ~2 ms claim in 02-queue.md\n`,
);
