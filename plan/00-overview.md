# 00 — Overview

## The problem

Coding agents are bottlenecked on context, not intelligence. The dominant approach —
embed every chunk, cosine-similarity search, dump the top 20 into the prompt — fails on
most of what an agent actually needs to know.

| Agent's real question | Embeddings | What actually answers it |
|---|---|---|
| "Where is `RetryPolicy` defined?" | mediocre | symbol table (exact) |
| "Who calls `flushBuffer`?" | useless | reference graph |
| "What breaks if I change this signature?" | useless | reverse call graph |
| "Where do we handle rate limiting?" | good | embeddings |
| "What is `ERR_SOCK_TIMEOUT`?" | bad | BM25 / trigram exact match |
| "Why was this written this way?" | useless | git history + linked PR |
| "What's our auth convention?" | ok | docs / Notion embeddings |

Half those rows have no similarity signal whatsoever. They're graph traversals or exact
lookups. An embedding-only tool answers them with plausible-looking garbage, which is worse
than answering nothing.

## The thesis

**Five retrievers, fused, then a graph-expansion pass.**

1. BM25 (full-text, code-aware tokenizer)
2. Trigram (substring / partial identifiers)
3. Vector (semantic)
4. Symbol table (exact + fuzzy)
5. Path fuzzy match

Fuse with Reciprocal Rank Fusion, then expand each anchor along the code graph — pull in
the definitions it references, its callers, the interface it implements, the test that
exercises it. Then pack to a token budget.

Embeddings contribute maybe 20% of final quality. The graph is the differentiator, and it's
the part that's genuinely hard to copy.

## The second thesis: freshness is a feature

A stale index is worse than no index, because the agent cannot tell the difference. It will
cite a function that was deleted an hour ago with total confidence.

So `crux` is built around a live pipeline: filesystem watcher → durable SQLite queue →
workers → index, with **content-hash-based** deduplication and a **freshness verification**
step on every query that re-hashes the file before returning a span.

## Goals

- **Live.** Save a file, and symbols are queryable within ~50 ms.
- **Correct.** Never return a span that doesn't match the bytes on disk.
- **Local-first.** Zero network by default. No account required. Works on a plane.
- **Universal.** Plain MCP over stdio. Works with any agent, not just ours.
- **Quiet.** Doesn't spin your fans. This is a retention feature, not a nicety.
- **Honest about coverage.** `crux.status()` always tells you what's indexed and how fresh.

## Non-goals (for v1)

- Not a code search UI. No web app, no browser extension. MCP and CLI only.
- Not a hosted service. Team sync is a later, optional, encrypted add-on.
- Not an agent. It retrieves; it doesn't plan, edit, or call models to reason.
- Not a language server. See the deliberate LSP deferral in [05-index-tiers](05-index-tiers.md).
- No LLM-based reranking or summarization at index time. Too slow, too expensive, too
  lossy, and it makes the index non-reproducible.

## Decisions already made

| Decision | Choice | Rationale |
|---|---|---|
| Index location | Local-first, single binary | Privacy is the pitch; no auth/billing burden in v1 |
| Repo | Standalone, not inside `loop` | Positions it for any agent; `loop` consumes it like everyone else |
| Sources | Code + local docs + team knowledge + web | Code first; connectors in Phase 4 |
| Structure extraction | tree-sitter (WASM) + SCIP | Precision without running language servers |
| LSP | Deferred to Phase 5+ | SCIP covers precision statically at a fraction of the cost |
| Dedupe key | **Content hash, never timestamps** | Timestamps have a silent lost-update race — see [02-queue](02-queue.md) |
| Queue | Durable, in SQLite | Survives crashes; doubles as IPC between processes |
| Process model | Leader election, no separate daemon | One binary, no service install, readers never blocked |
| Implementation language | **Bun / TypeScript** | `web-tree-sitter` makes Tier 1 tractable; iteration speed on ranking; the queue schema keeps a native sidecar open later |
| Name | **`crux`** | The MCP prefix is part of the prompt — `crux.pack` tells the agent what it gets; `cx` told it nothing |

### On Bun/TypeScript over Go

Three reasons, in order of weight:

1. **Tier 1 ships in Phase 1, and `web-tree-sitter` only exists in the JS world.** The
   lazy-downloaded `.wasm` grammar story in [05-index-tiers](05-index-tiers.md) is a
   maintained package here. In Go it's either cgo bindings — which compile grammars in as C
   and kill both the lazy-download and the clean cross-compile — or hand-written wazero host
   bindings, a multi-week project on the critical path.
2. **The risk in this project is ranking quality, not throughput.** Five arms, fusion
   weights, expansion budgets, packing levels, all tuned against an eval harness. That's
   iteration-speed work. Parse is ~2 ms and parallel; embed is I/O-bound. Neither is where
   Go's advantage lands.
3. **[02-queue](02-queue.md) was designed so this isn't a one-way door.** Jobs are durable
   rows with a schema contract, not in-process channels. If the parse lane or the vector scan
   becomes the bottleneck, that worker gets swapped for a Rust/Go sidecar against the same
   table.

What we're accepting: ~50 MB RSS per reader process against Go's ~15 (real, given three
concurrent MCP hosts is the design point in [01-architecture](01-architecture.md)), and
clunkier worker-thread concurrency.

The third cost we expected — a slow scalar vector scan — **did not materialise**. Measured at
14 ms for 100k×384 int8 and 131 ms at 1M ([the vector spike](../spikes/vector-scan.ts)), comfortably
inside the budget in [04-storage](04-storage.md) even though that budget assumed SIMD. The
scan is memory-bandwidth-bound, not compute-bound, so the absence of SIMD costs far less than
predicted.

## Open questions

- **Language breadth in Phase 1** — 5 languages deep, or 15 shallow? Leaning 5 deep
  (TS/JS, Python, Go, Rust), because tag queries and import resolution are where quality
  actually comes from and both are per-language work.
