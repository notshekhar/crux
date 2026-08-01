# 10 — Roadmap, Evaluation, Risks

## Phases

Each phase ends with something shippable. No phase is a prerequisite refactor for the next.

### Phase 1 — Live index that's already useful (2–3 weeks)

The whole freshness machine, plus the cheapest retrieval that works.

- SQLite schema, `jobs` queue with coalescing unique index, leases, dead-lettering.
- Leader election with heartbeat + fencing.
- Watcher: ignore-before-enqueue, 200 ms debounce, temp-file handling, git-aware branch
  switching, inotify fallback.
- **Hash-based skip rule** with mtime/size pre-filter.
- Parse worker: tree-sitter WASM for TS/JS, Python, Go, Rust. Symbols, imports, chunk
  boundaries.
- FTS5 with the `crux_code` tokenizer, trigram table, fuzzy path index.
- MCP stdio server: `find`, `symbol`, `outline`, `expand`, `status`.
- `crux init` printing host configs; `crux doctor`.
- Eval harness (below) wired from day one.

**No embeddings in Phase 1.** Live lexical + symbols already beats most tools, and forcing
the freshness machinery to be correct before layering anything on it is the right order.

**Status: Phase 1 is complete.** Everything above is built and under test (156 tests).

Measured on `loop` itself (469 files, 3.9 MB of source): cold index 3.4 s at 138 files/s,
13,455 symbols, query p50 2.1 ms / p95 3.2 ms. `crux init` on a fresh repo finishes in well
under the 60-second time-to-first-value requirement.

`bun build --compile` produces a 56 MB standalone binary that runs with no node_modules and
bootstraps its own grammars via `crux doctor --fetch`.

Five MCP tools ship rather than eight: `find`, `symbol`, `outline`, `expand`, `status`.
`pack`, `refs`, and `history` need the graph, and shipping them as stubs would spend host
context on a promise.

### Phase 2 — The graph (2–3 weeks)

- Import graph + call-site extraction → heuristic `edges`.
- SCIP ingestion for TypeScript and Python; `scip` job kind.
- `crux.refs` with precise/heuristic labelling.
- Graph expansion in the retrieval pipeline.
- `crux.pack`.

This is the version people recommend to other people.

### Phase 3 — Semantics (2 weeks)

- AST-aware chunking with synthesized headers.
- Content-addressed chunk store + GC.
- Local ONNX embeddings, embed lane, batching, battery pausing.
- RRF fusion, priors, packing with skeleton detail levels.
- Optional API embedding backends.

### Phase 4 — Beyond the repo (3–4 weeks)

- Connector framework + `source_sync` jobs.
- Local folders/PDF, then GitHub issues+PRs, then web crawler.
- Git/temporal indexing and `crux.history`.
- Cross-source reference linking.

### Phase 5 — Depth and distribution

- Live LSP tier for dirty working-tree files.
- Cross-encoder reranking.
- `crux daemon` mode.
- `bun build --compile` binaries for the five targets `loop` already ships.
- Published benchmarks against grep, embedding-only tools, and native agent search.
- Then, as the commercial wedge: encrypted team index sync.

## Evaluation — build it in Phase 1

You cannot tune a five-arm hybrid ranker by vibes. Without an eval harness every ranking
change is a coin flip, and you will spend weeks moving numbers you can't see.

**Ground truth, cheaply.** Mine merged PRs from a handful of real open-source repos:
the PR title (or issue text) is the query; the changed hunks are the correct spans. A few
hours of scripting yields ~200 labelled pairs per repo, with no manual annotation.

Supplement with ~50 hand-written queries covering the failure classes that matter: exact
error strings, "who calls X", "why is this like this", cross-file type resolution.

**Metrics:**

| Metric | Why |
|---|---|
| recall@k | Did the right span appear at all |
| MRR | Was it near the top |
| **token-cost-to-first-correct-span** | **The one that actually matters for agents** |
| p50 / p95 latency | Agents call this on every turn |
| freshness lag | Time from `write()` to queryable |

Token-cost-to-first-correct-span is the headline number. Recall inside 4k tokens is worth
far more than recall inside 40k, because the agent pays for every token and its attention
degrades across a long context. Optimizing plain recall@20 will lead you astray.

**Per-arm ablations.** Run with each retriever disabled so you always know what each one
contributes. This is how you find out that trigram is carrying more weight than vectors on
code queries — which it probably is.

**Correctness tests, not just quality:**

- **Freshness test.** Write a file, assert it's queryable within N ms.
- **Lost-update test.** Modify a file *while* its parse job is running; assert the final
  index matches the final bytes. This is the exact race the hash rule exists to prevent, and
  it should be in CI forever. It has already earned its keep: it caught the racily-clean hole
  in the stat pre-filter ([02-queue](02-queue.md)) the day the queue was written.
- **Racy-clean test.** Edit a file to a *same-size* different content within the mtime
  granularity; assert the change is still indexed.
- **Chaos test.** Kill the leader mid-drain repeatedly; assert the index converges to the
  correct state.
- **Storm test.** `git checkout` between two distant branches; assert bounded queue depth,
  bounded CPU, and correct final state.
- **Staleness test.** Delete a file behind the watcher's back; assert no span from it is
  ever returned.

Run the quality metrics on every PR. Regressions in ranking should be as visible as a
failing unit test.

## Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Lost updates from time-based dedupe | **Critical** | Hash-based skip; store the hash actually read; permanent CI test |
| Lost updates from the stat pre-filter (racily clean) | **Critical** | Full-precision mtime + `read_at`; skip only outside the 1 s race window; permanent CI test |
| Stale index → agent hallucination | **Critical** | Freshness verification on every returned span |
| Secret leakage into the index | **Critical** | Index-time redaction, bias to over-redact |
| Prompt injection via indexed issues/web | High | Untrusted marking, structural separation, documented |
| Event storms (rebase, `npm install`) | High | Ignore-before-enqueue, coalescing index, git-diff shortcut |
| Poison-pill file blocks the queue | High | Leases + attempts + dead-letter |
| Fan noise → uninstall | High | Battery pausing, nice, idle shutdown, cost always reported |
| Linux inotify limits | Medium | ENOSPC detection, scan-mode fallback, one clear warning |
| Native deps break single-binary story | **Confirmed** | `--compile` will not embed `.node`; use built-in `fs.watch`, WASM tree-sitter, lazy model download, brute-force vectors |
| Grammar `.wasm` ABI drift vs `web-tree-sitter` | Medium | Pin both together; `crux doctor` verifies a grammar loads before trusting Tier 1 |
| macOS SQLite is the host's, not ours | Medium | Assert FTS5 + trigram (≥ 3.34 / macOS 12) at startup; fail loudly |
| An ungated arm scans and dominates latency | **Confirmed** | Gate arms by query shape; trigram never runs on prose. Measured 2.9 s → skipped |
| Edge table dwarfs the index | **Confirmed** | Denylist ubiquitous callees, dedupe (caller, callee). 37k → 10.3k on 469 files |
| Index size grows ~7.5× source | Medium | Path interning in `edges`/`file_chunks` not yet done; measured 29.5 MB for 3.9 MB |
| Two leaders after a process stall | Medium | Heartbeat lease + fencing check before every write batch |
| Too many MCP tools degrade the host | Medium | Eight-tool cap; invest in descriptions; measure |
| SCIP indexers slow, flaky, per-language | Medium | Background, optional, always fall back to Tier 1 |
| Cold index too slow on a monorepo | Medium | Queries work on a partial index; progress in status |
| "Why not just grep?" | Medium | Answer with eval numbers; `crux.refs` and `crux.pack` are the demo |
| Scope creep into connectors before code is great | Medium | Connectors are Phase 4, on purpose |

## What would make this fail

Worth naming plainly, because these are the outcomes to steer away from:

1. **It's slow to set up.** If `crux init` takes ten minutes before the first useful answer,
   nobody gets to the good part. Sixty seconds is the requirement.
2. **It's wrong once.** One confidently-cited deleted function and a user stops trusting
   every answer. This is why freshness verification is not optional.
3. **It's not obviously better than grep.** The agent already has grep and it's free. The
   demo has to be `crux.refs` and `crux.pack` — the things grep structurally cannot do — not
   "search but semantic."
4. **It becomes a platform before it's a good tool.** Connectors, team sync, and a web UI
   are all more fun to build than tag queries for Go. Build the boring thing well first.
