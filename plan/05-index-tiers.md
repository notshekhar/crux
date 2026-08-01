# 05 — Index Tiers

Four tiers plus two orthogonal signals. Each tier is optional and degrades independently —
a query works even if only Tier 0 has run.

```
Tier 0  Lexical      FTS5 + trigram + path        instant, every file, every language
Tier 1  Syntactic    tree-sitter (WASM)           seconds, ~15 languages
Tier 2  Precise      SCIP indexers                background, opt-in per language
Tier 3  Live LSP     language servers             DEFERRED to Phase 5+

  ⊥     Vectors      AST-aware chunks + ONNX      background, slow lane
  ⊥     Temporal     git history + PR links       incremental
```

---

## Tier 0 — Lexical

Always on, no configuration, works on any file type including ones with no grammar.

- **FTS5** over chunk bodies + headers with the `crux_code` tokenizer
  (see [04-storage](04-storage.md)). BM25 ranking.
- **Trigram** table for substring matching — `sock_time` finds `ERR_SOCK_TIMEOUT`.
- **Path index** with fuzzy subsequence matching, so `usr/ctrl` finds
  `src/user/controller.ts`. Weighted by path depth and how recently the file changed.

This tier alone, kept live by the watcher, is already more useful than most "AI code
context" products. It ships in Phase 1 and nothing depends on it being clever.

---

## Tier 1 — Syntactic (tree-sitter)

**Use `web-tree-sitter` (WASM), not native bindings.** This is load-bearing for the whole
distribution story:

- No `node-gyp`, no compilers on the user's machine, no prebuild matrix.
- Grammars are plain `.wasm` files — lazy-downloadable per language into
  `~/.cache/crux/grammars`, so the binary doesn't carry 40 MB of grammars for languages you
  don't use.
- Same code path on every platform, including Windows, which is where native bindings
  reliably go wrong.

The cost is roughly 2–3× slower parsing than native. Irrelevant — parsing is not the
bottleneck, and it's parallel across workers.

### What gets extracted

Per file, via tree-sitter **queries** (`.scm` tag files — start from upstream
`tree-sitter-<lang>/queries/tags.scm` and `nvim-treesitter`, then extend):

- **Symbols**: functions, methods, classes, interfaces, types, enums, top-level consts.
  With name, kind, full signature, leading doc comment, byte + line span, enclosing scope,
  and whether it's exported.
- **Imports / requires**, with the raw specifier.
- **Call sites**: the callee name and its enclosing symbol. Unresolved at this tier — just
  `name`, not "which `flush` this is" — but enough for heuristic edges.
- **Chunk boundaries**: where a function or class starts and ends, so chunking never cuts a
  body in half.

### Heuristic import resolution

Resolve specifiers to files using per-language rules: `tsconfig.json` paths + `package.json`
exports for TS/JS, `go.mod` for Go, `Cargo.toml` for Rust, `sys.path`-ish conventions for
Python, plus relative resolution everywhere. Produces a **file-level import graph**.

Good enough for ~90% of graph expansion, and it exists for every language the moment the
grammar does. Edges from this tier are marked `precision='heuristic'`.

### Not every call site deserves an edge

Storing one edge per call site sounds obviously correct and does not survive contact with a
real repo. Measured on 469 files it produced **37,046 edges — 36% of the entire index** —
overwhelmingly `console.log`, `expect`, `JSON.stringify`, and `push`. Extrapolated to the
200k-file monorepo in [09-operations](09-operations.md), that is ~15M rows of noise.

Two filters, applied before the edge is stored:

1. **Drop ubiquitous callees.** Nobody asks "who calls `push`?". A denylist of language
   builtins, collection methods, and test-framework globals covers almost all of it.
2. **One edge per (caller, callee) pair**, not per call site. A loop calling the same helper
   twenty times is still one relationship.

Together these cut edges by 72% (37,046 → 10,340) and the whole index by 24%, with no loss
of anything an agent would ask about. Being slightly too aggressive costs one heuristic edge;
being too permissive costs an index nobody can afford to keep.

**Still oversized:** `edges` stores the full file path in `src`, `dst`, and `path` on every
row. Interning paths into an integer-keyed table is the obvious next win and is not done yet.

### Phase 1 language set

TypeScript/JavaScript (incl. TSX), Python, Go, Rust. Four languages, done properly — good
tag queries and real import resolution — beats fifteen with generic queries and no
resolution. Markdown and JSON get lightweight structural handling for prose chunking.

---

## Tier 2 — Precise cross-file (SCIP)

This is the tier competitors don't ship, and it's what makes `crux.refs` trustworthy.

**SCIP** is Sourcegraph's code-intelligence format. Language-specific indexers do a full
type-resolved compilation pass and emit a protobuf containing precise definitions,
references, implementations, and documentation — with globally stable symbol identifiers.

| Language | Indexer |
|---|---|
| TypeScript/JS | `scip-typescript` |
| Python | `scip-python` |
| Rust | `rust-analyzer scip` |
| Go | `scip-go` |
| Java/Kotlin | `scip-java` |
| Ruby | `scip-ruby` |

Ingestion: run the indexer as a `kind='scip'` job at priority 30, parse the protobuf,
upsert `symbols.scip_id` and `edges` with `precision='precise'`. Heuristic edges for the
same file are then superseded.

Why this instead of running language servers:

- **No persistent process.** Run it, ingest it, exit. No server lifecycle, no crash
  recovery, no memory ballooning on a monorepo.
- **Precise across files**, including through re-exports, generics, and interface
  implementations — exactly what heuristics get wrong.
- **Batch-friendly.** It's a background job; nothing waits on it.

Constraints to design around: indexers can be slow (minutes on a large repo), require the
project to actually build, and are per-language. So: strictly optional, strictly background,
strictly best-effort. Tier 1 heuristics remain the floor, and `crux.status()` reports which
languages have precise coverage so answers can be qualified honestly.

Re-run policy: not per-save. Trigger on branch switch, on dependency-manifest change, or
after N accumulated file changes — with a debounce measured in minutes.

---

## Tier 3 — Live LSP (deferred to Phase 5+)

Deliberately not in the early plan.

Tier 2 already gives precise cross-file resolution. Live LSP only adds value for the
**dirty working tree** — code edited but not yet re-indexed — and the price is steep: per-
language server installation, version management, startup latency (seconds for `tsserver`
on a large project), crash handling, and memory.

The `loop` repo already solved language-server auto-installation (v0.15.8), so this is a
port when the time comes rather than new research. But it should come after the graph, the
vectors, and the connectors are proven — not before.

If a query touches a file with pending queue work, the honest answer is to enqueue it at
priority 0, wait up to 300 ms, and re-read the file from disk. That covers most of what
live LSP would buy, for none of the cost.

---

## Vectors (orthogonal)

### AST-aware chunking

Chunk boundaries come from Tier 1, never from a character count.

- One chunk per function / method / class body, up to a size limit.
- Bodies over the limit split at **statement boundaries** with ~15% overlap.
- Small adjacent symbols (a cluster of one-line getters, a group of constants) merge into
  one chunk so you don't embed twenty near-identical fragments.
- Prose (Markdown, PDF, Notion) chunks on **heading hierarchy**, with the breadcrumb trail
  as the header.

### Synthesized headers

Every chunk gets a header prepended *before* embedding:

```
file: src/billing/retry.ts
module: billing
enclosing: class RetryPolicy
signature: async execute<T>(op: () => Promise<T>, opts?: RetryOpts): Promise<T>
doc: Runs `op`, retrying on transient failures with exponential backoff.
---
<body>
```

Without this the embedding sees an anonymous block of tokens. With it, the embedding sees
what the code *is* and where it lives. This is worth roughly 10 points of recall for about
a day of implementation work — the highest-leverage single change in the retrieval stack.

The header is part of the hashed content, so changing the header format invalidates the
cache correctly.

### Models

Pluggable, with an honest default:

- **Default**: `bge-small-en-v1.5` (384d) via ONNX Runtime, downloaded on first use to
  `~/.cache/crux/models` (~130 MB). Never bundled in the binary.
- **Code-tuned option**: `jina-embeddings-v2-base-code`.
- **API option**: `voyage-code-3` or OpenAI `text-embedding-3-large`, for users who want
  maximum quality and accept the network call. Explicit opt-in, surfaced in
  `crux.status()`.

Batch 64–256 chunks. Normalize, quantize to int8, store with the model id.

---

## Temporal (git)

Incremental, cheap, and badly underused by everything in this space.

- Walk new commits since the last indexed sha; store subject, body, author, timestamp, and
  any PR/issue reference parsed out of the message.
- Per-file churn and last-modified, used as a **ranking prior** — recently and frequently
  changed code is disproportionately what people ask about.
- **Co-change pairs**: files that change together in the same commit more often than chance.
  A surprisingly strong signal for graph expansion when static analysis has nothing (config
  ↔ code, schema ↔ migration, implementation ↔ its test).
- Blame → commit → PR body → linked issue is what makes `crux.history` answer "why is this
  like this", which no embedding can.
