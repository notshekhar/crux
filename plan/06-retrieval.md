# 06 — Retrieval

```
   query: "where do we retry failed webhook deliveries?"
                              │
   ┌──────────────────────────▼──────────────────────────┐
   │ 1. QUERY UNDERSTANDING                              │
   │    identifiers, quoted literals, paths, error codes │
   │    intent: locate | explain | impact | history      │
   └──────────────────────────┬──────────────────────────┘
                              │
   ┌────────┬────────┬────────┼────────┬────────────┐      run in parallel
   │ BM25   │trigram │ vector │ symbol │ path fuzzy │
   │ top 50 │ top 30 │ top 50 │ top 20 │  top 10    │
   └────────┴────────┴────────┴────────┴────────────┘
                              │
   ┌──────────────────────────▼──────────────────────────┐
   │ 2. FUSION — Reciprocal Rank Fusion → ~30 anchors    │
   │    + priors: git recency, import centrality,        │
   │      session proximity                              │
   └──────────────────────────┬──────────────────────────┘
                              │
   ┌──────────────────────────▼──────────────────────────┐
   │ 3. GRAPH EXPANSION          ← the differentiator     │
   └──────────────────────────┬──────────────────────────┘
                              │
   ┌──────────────────────────▼──────────────────────────┐
   │ 4. Rerank (optional cross-encoder)                  │
   │ 5. FRESHNESS VERIFY  ← non-negotiable                │
   │ 6. PACK to token budget                             │
   └──────────────────────────┬──────────────────────────┘
                              │
                        context pack
```

## 1. Query understanding

Cheap, deterministic, no model call.

- Extract **identifiers**: CamelCase, snake_case, dotted paths, anything in backticks or
  quotes. These go to the lexical and symbol arms with high weight.
- Extract **file paths** and path fragments → path arm.
- Detect **error codes / string literals** (`ERR_*`, all-caps with underscores, quoted
  strings) → exact-match arm, weighted heavily. When someone pastes an error string they
  want the exact line, not something semantically similar.
- Classify **intent** by shallow pattern:
  - `locate` — "where is", "find" → favor symbol + path arms
  - `explain` — "how does", "what does" → favor vector arm, expand to callees
  - `impact` — "what breaks if", "who calls" → favor reverse graph, expand to callers
  - `history` — "why", "when did" → include temporal arm

Intent shifts arm weights and expansion direction. It never *excludes* an arm — misclassified
intent should degrade quality slightly, never break the query.

### Arms must be gated by query shape

Running every arm on every query is wrong, and expensive enough to be
disqualifying. Measured on a real 469-file repo:

| Query | Arm | Before gating | After |
|---|---|---|---|
| "where do we handle rate limiting" | trigram | **2901 ms, 0 rows** | skipped |
| same | whole query | 3367 ms | 2.1 ms |

A trigram MATCH on a multi-word phrase ANDs together dozens of 3-grams and
degenerates into a scan. Substring search over prose is both meaningless and
ruinously expensive, so **the trigram arm only runs on identifier-shaped queries**
— no whitespace, 3–64 characters.

The symbol arm needs the same discipline for a different reason. Matching the
individual words of "parse the catalog" hits every function named `parse`, and
the arm's weight then floats that noise to rank 1. So:

- **Single-token query** — the user is naming something. Every tokenised form matches.
- **Multi-word query** — the user is describing behaviour. Only two things match:
  every word concatenated (`get user by id` → `getuserbyid`), and the same with
  stopwords dropped (`how do we validate the webhook` → `validatewebhook`).

Both forms are needed: `get` and `by` are stopwords but they are half of
`getUserById`.

Matching happens against `symbols.name_norm` — lowercased, separators stripped —
so a query written in one language's convention finds a definition written in
another's. `lower(name)` alone does not work: it preserves the underscores in
`get_user_by_id` and never matches `getuserbyid`.

## 2. Fusion

**Reciprocal Rank Fusion**, because it needs no score calibration across wildly different
scales (BM25 scores, cosine similarities, and fuzzy-match scores are not comparable, and
trying to normalize them is a tuning rabbit hole):

```
score(d) = Σ_arms  w_arm / (k + rank_arm(d))        k = 60
```

Arm weights `w_arm` are set by intent. Then multiply by priors:

- **Git recency** — logarithmic decay on last-modified. Recently touched code is
  disproportionately what people ask about.
- **Import centrality** — PageRank over the import graph. A file that half the codebase
  imports is more likely to be the relevant one.
- **Session proximity** — files the agent already has open or recently read, passed in by
  the host. Strong signal, and it makes follow-up questions much better.
- **Test penalty** — small negative prior on test files unless the query mentions tests,
  since they otherwise dominate lexical matches for any function name.

## 3. Graph expansion

The step that makes this a code-intelligence tool rather than a search box.

For each of the top anchors, pull in structurally related code, budgeted and deduplicated:

| Relation | Why | Source |
|---|---|---|
| Definitions of symbols the anchor references | The agent will need them to understand the code | `edges kind=calls/references` |
| Direct callers | Impact radius — "what depends on this" | reverse `edges` |
| Interface / base class it implements | Contract the code must satisfy | `edges kind=implements` |
| The test that exercises it | Best available spec, and shows intended usage | path heuristics + co-change |
| Config / schema it reads | Where the magic constants live | `edges` + co-change |
| Sibling exports from the same module | Usually the surrounding API | `symbols` by path |

Budget: expansion gets at most ~40% of the token budget, breadth-first, one hop by default
and two hops for `impact` intent. Deduplicate against anchors already selected.

Precise edges (SCIP) are preferred; heuristic edges are used with a score discount and
marked as such in the output, so an agent can tell "definitely calls this" from "probably
calls this."

## 4. Rerank (optional)

A local cross-encoder (`bge-reranker-base`, ONNX) over the top ~50 candidates. Real quality
gain, real latency cost (~100–200 ms).

Off by default in v1. Turn it on when the eval harness shows it's worth the latency, and
make it configurable — some agents care far more about latency than about the last 5% of
precision.

## 5. Freshness verification — non-negotiable

Even with the watcher, there is always a window between a write hitting disk and the queue
draining. And an agent that hallucinates from a stale span poisons trust in the entire tool.

For every span about to be returned:

```
stat + hash the file
  ├─ hash matches files.indexed_hash          → return the indexed span
  ├─ hash differs, file still exists          → re-read the span's line range from disk
  │                                              and return the live bytes (flagged)
  └─ file is gone                             → drop the span, enqueue a delete
```

Also: enqueue a priority-0 job for any file found stale, so the next query is clean.

This costs one stat and one hash per returned file — sub-millisecond, and it means `crux` can
promise something no embedding-only tool can: **every byte it returns is currently on disk.**

## 6. Packing

Where most tools lose. The caller passes `max_tokens`; the packer's job is to spend it well.

**Levels of detail.** Not everything deserves a full body:

```
full        the anchor spans — complete function bodies
skeleton    relevant-but-cold files — imports, signatures, doc comments,
            bodies elided as  { … 34 lines }
reference   one line: path:line + signature, no body
```

A 3,000-line file becomes a 60-line skeleton that tells the agent exactly what's in it and
what to ask for next.

**Rules:**

- Merge overlapping or adjacent spans (within ~5 lines) into one.
- Guarantee **file diversity** — at least N distinct files before spending budget on a
  second span from the same file. Otherwise one large file eats the whole budget.
- Fill greedily by score, but reserve ~20% for graph-expansion results so they aren't
  crowded out by lexical matches.
- Always include `path:line` on every span — it's clickable in most hosts and it lets the
  agent read more with its own tools.

**Stable span ids.** Every returned span carries `sp_<hash>` identifying
`(content_hash, path, line range)`. The agent calls `crux.expand("sp_7f3a…")` instead of
re-running a search. This is what makes multi-turn interaction cheap, and it's a big part of
why the tool feels fast in practice.

**Provenance.** Each span carries why it was selected — `matched: bm25`,
`expanded_from: sp_2b1c (caller)`, `precision: heuristic`. Agents use this to weight what
they trust, and it makes the whole system debuggable when results are bad.
