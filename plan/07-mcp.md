# 07 — The MCP Surface

This is the product. Everything else is infrastructure that makes these eight tools good.

## Two rules

**1. Eight tools, hard cap.** Every tool definition is injected into the host agent's
context on every turn, and more tools measurably degrade tool-selection accuracy. A context
tool that bloats the context is self-defeating. If a ninth tool seems necessary, it's
probably a parameter on an existing one.

**2. The tool description is the prompt.** More of the final quality lives in the wording of
these descriptions than in the ranking code. The agent decides *which* tool to call and
*what to put in the query* based entirely on this text. Iterate on it with the eval harness
like it's code, because it is.

## The tools

### `crux.pack(task, {max_tokens})` — the headline

> Given a description of the task you are about to do, returns a curated bundle of the most
> relevant code: the functions you'll need to change, their callers, the types they use, and
> the tests that cover them. Call this **once** at the start of a task instead of a dozen
> greps.

Runs the full pipeline including graph expansion and packing. One call and the agent is
oriented. This is the tool that makes people recommend `crux` to their friends, and it's the
one whose description deserves the most attention.

### `crux.find(query, {scope?, kind?, max_tokens?})`

> Hybrid search across the indexed codebase. Works with natural language ("where do we
> validate webhooks"), exact identifiers (`RetryPolicy`), error strings
> (`ERR_SOCK_TIMEOUT`), and path fragments (`src/billing`).

Returns ranked spans with id, `path:line`, a tight excerpt, and why each matched.
`scope` restricts to a subtree or source; `kind` filters to code / docs / tickets.

### `crux.symbol(name, {kind?})`

> Look up a symbol by name. Returns its definition, full signature, doc comment, and
> location. Use this instead of searching when you know the name.

Exact match first, fuzzy fallback. Multiple matches return all of them with disambiguating
context, because in a real repo there are four things called `handler`.

### `crux.refs(symbol, {relation})`

> Find references to a symbol. `relation` is one of `callers`, `callees`,
> `implementations`, `overrides`. Use `callers` before changing a signature to see what
> breaks.

Precise when SCIP has run for that language, heuristic otherwise — and the response says
which, per edge. Never silently present a guess as a fact.

### `crux.outline(path)`

> Returns the structure of a file or directory: imports, signatures, and doc comments,
> with bodies elided. The cheapest way to understand a large file before reading it.

For a directory, returns the file tree with each file's exported symbols. This is how an
agent orients in an unfamiliar area for a few hundred tokens instead of tens of thousands.

### `crux.expand(span_id, {before?, after?, whole_symbol?})`

> Show more code around a span returned by an earlier call. Cheaper and more accurate than
> searching again.

The reason multi-turn stays cheap. Span ids are stable across the session.

### `crux.history(path_or_symbol)`

> Why does this code look like this? Returns the commits that shaped it, their PR
> descriptions, linked issues, and files that habitually change alongside it.

The tool nothing else in this space offers, and the answer to a question agents ask
constantly and badly.

### `crux.status()`

> What is indexed, how fresh it is, and what is missing.

Under-rated. It's how the user and the agent decide whether to trust an answer, and it's
the first thing you'll ask for when debugging someone else's repo remotely. Reports:
workspaces and file counts, queue depth and lag, per-language tier coverage (lexical /
syntactic / precise / vectors), dead jobs, degraded modes (inotify fallback, embeddings
paused), what has left the machine, and index size + CPU time consumed.

## Response envelope

Every span-returning tool uses one shape:

```json
{
  "spans": [{
    "id": "sp_7f3ab21c",
    "path": "src/billing/retry.ts",
    "lines": [42, 78],
    "detail": "full",
    "lang": "typescript",
    "symbol": "RetryPolicy.execute",
    "text": "...",
    "why": { "matched": ["bm25", "vector"], "rank": 1 },
    "trust": "verified"
  }],
  "truncated": false,
  "index": { "fresh": true, "queue_lag_ms": 0, "vector_coverage": 0.98 },
  "hint": "Call crux.expand with a span id for more context."
}
```

- `trust: verified` means the bytes were confirmed against disk at query time.
- `why.matched` and `why.expanded_from` let the agent weight what it trusts.
- `index` travels with every response so the agent can qualify its own answer when the
  index is lagging — better than silently answering from stale data.
- Untrusted sources (see [09-operations](09-operations.md)) carry
  `"untrusted": true`.

## Transport and setup

- **stdio** by default. Zero config, works everywhere, no ports, no auth.
- **Streamable HTTP** later, for remote/team deployments.

`crux init` in a repo does the whole onboarding: creates `.crux/`, starts the cold index, and
prints ready-to-paste config for Claude Code, Cursor, Windsurf, Zed, and loop. The
time-to-first-value target is **under 60 seconds**, including the index. That number is a
product requirement, not an aspiration — it's what determines whether anyone keeps it.

## Also expose

- **MCP resources** for indexed documents, so hosts that support resource attachment can
  reference a design doc directly.
- **An MCP prompt**, `onboard`, that walks a new contributor (or a fresh agent session)
  through a repo's architecture using the outline + import-centrality data.
