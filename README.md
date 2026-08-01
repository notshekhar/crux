# crux

A local-first context engine for coding agents.

`crux` watches folders, keeps a live index of your code (plus docs, tickets, and web pages),
and serves it over **MCP** so any agent — loop, Claude Code, Cursor, Windsurf, Zed — can
ask precise questions about your codebase instead of grepping blindly.

**Status:** Phase 1. The live index works end-to-end and serves MCP.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/notshekhar/crux/main/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/notshekhar/crux/main/install.ps1 | iex
```

No runtime needed — it's a single static binary. Language grammars are fetched on
first `crux init` rather than bundled, so the download stays small.

```
crux init .                 # index a repo, print agent config
crux search "retry webhooks"
crux symbol RetryPolicy
crux status                 # what's indexed, how fresh
crux list                   # every workspace you've indexed
crux mcp .                  # what your agent runs
crux upgrade                # update in place
```

Uninstall with `CRUX_UNINSTALL=1 bash install.sh`.

## Where it keeps things

Everything lives under `~/.crux` — **nothing is written into the repos you index**:

```
~/.crux/
  ├── config.json      settings
  ├── grammars/        tree-sitter parsers, fetched on first init
  └── index/
       ├── registry.json
       └── <project>-<hash>.db
```

`crux list` shows every index and its size; `crux forget <path>` deletes one.

## Indexing many repos at once

Point it at a folder of projects and it indexes all of them into one searchable
index, applying each repo's own `.gitignore`:

```
crux init ~/code            # 20 repos, 21,415 files, 106s, 588 MB
crux search "leader election heartbeat" ~/code
```

Measured on the `loop` repo (469 files, 3.9 MB of TypeScript): cold index 3.4 s at
138 files/s, 13,455 symbols, query p50 2.1 ms / p95 3.2 ms.

Built: the durable queue, leader election, tree-sitter extraction for
TS/TSX/JS/Python/Go/Rust, content-addressed storage, FTS5 + trigram, three-arm
fused search, the filesystem watcher, five MCP tools, and the CLI.
Not yet: the code graph (`refs`, `pack`), embeddings, and connectors.

---

## Why

Every "context for AI" tool today does the same thing: chunk the repo, embed it, run cosine
similarity, dump twenty chunks into the prompt. That approach cannot answer the questions
agents actually ask — "who calls this?", "what breaks if I change this signature?" — because
those are *graph* queries with no similarity signal at all.

`crux` runs five retrievers (BM25, trigram, vector, symbol table, path fuzzy), fuses them,
and then expands along the code graph. Embeddings are roughly 20% of the answer quality.
The graph is the moat.

The second half of the thesis is **freshness**. A stale index is worse than no index,
because the agent can't tell the difference. `crux` watches the filesystem, queues work
durably in SQLite, and verifies every returned span against the file on disk before
handing it to an agent.

## Read the plan

| Doc | What's in it |
|---|---|
| [00-overview](plan/00-overview.md) | Thesis, goals, non-goals, decisions already made |
| [01-architecture](plan/01-architecture.md) | Process model, leader election, why no daemon |
| [02-queue](plan/02-queue.md) | The durable job queue — schema, claiming, the hash skip rule |
| [03-watcher](plan/03-watcher.md) | Filesystem watching, event storms, git-aware shortcuts |
| [04-storage](plan/04-storage.md) | Content-addressed schema, why branch switches are free |
| [05-index-tiers](plan/05-index-tiers.md) | Lexical → tree-sitter → SCIP → vectors → git |
| [06-retrieval](plan/06-retrieval.md) | Query pipeline, fusion, graph expansion, context packing |
| [07-mcp](plan/07-mcp.md) | The eight tools and why the cap matters |
| [08-sources](plan/08-sources.md) | Connectors for docs, tickets, web |
| [09-operations](plan/09-operations.md) | Resource discipline, privacy, prompt-injection safety |
| [10-roadmap](plan/10-roadmap.md) | Phases, evaluation, risk register |

## Shape of it

```
  Claude Code      Cursor        loop          ← MCP hosts (stdio)
       └──────────────┼─────────────┘
                crux mcp × N                   ← thin readers
                      │
               .crux/index.db                  ← SQLite (WAL) + durable job queue
                      │
              one elected leader               ← watcher + parse worker + embed worker
```
