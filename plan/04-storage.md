# 04 — Storage

One SQLite database per workspace at `<workspace>/.crux/index.db`. WAL mode,
`busy_timeout=5000`, one write connection owned by the leader.

The central design choice: **chunks and vectors are keyed by content hash, not by file
path.**

## Schema

```sql
-- ── Content-addressed core ────────────────────────────────────────────────

CREATE TABLE chunks (
  content_hash TEXT PRIMARY KEY,   -- sha256(header + body), first 128 bits
  header       TEXT NOT NULL,      -- synthesized context (see 05-index-tiers)
  body         TEXT NOT NULL,
  kind         TEXT NOT NULL,      -- function | class | method | block | prose
  lang         TEXT,
  n_tokens     INTEGER
);

CREATE TABLE vectors (
  content_hash TEXT NOT NULL,
  model_id     TEXT NOT NULL,      -- e.g. bge-small-en-v1.5
  dim          INTEGER NOT NULL,
  vec          BLOB NOT NULL,      -- int8-quantized
  scale        REAL NOT NULL,      -- dequantization scale
  PRIMARY KEY (content_hash, model_id)
);

-- ── Path-addressed mapping ────────────────────────────────────────────────

CREATE TABLE file_chunks (
  workspace    TEXT NOT NULL,
  path         TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  ord          INTEGER NOT NULL,
  start_line   INTEGER NOT NULL,
  end_line     INTEGER NOT NULL,
  PRIMARY KEY (workspace, path, ord)
);
CREATE INDEX file_chunks_by_hash ON file_chunks (content_hash);

-- ── Structure ─────────────────────────────────────────────────────────────

CREATE TABLE symbols (
  id         INTEGER PRIMARY KEY,
  workspace  TEXT NOT NULL,
  path       TEXT NOT NULL,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,       -- function | class | interface | type | const | method
  signature  TEXT,
  doc        TEXT,
  parent     TEXT,                -- enclosing class/module
  start_line INTEGER, end_line INTEGER,
  exported   INTEGER NOT NULL DEFAULT 0,
  scip_id    TEXT                 -- SCIP symbol string, when Tier 2 has run
);
CREATE INDEX symbols_name ON symbols (workspace, name);
CREATE INDEX symbols_path ON symbols (workspace, path);
CREATE INDEX symbols_scip ON symbols (workspace, scip_id) WHERE scip_id IS NOT NULL;

CREATE TABLE edges (
  workspace TEXT NOT NULL,
  src       TEXT NOT NULL,        -- scip_id or  path#name  fallback
  dst       TEXT NOT NULL,
  kind      TEXT NOT NULL,        -- calls | imports | implements | extends | references
  path      TEXT, line INTEGER,   -- where the edge occurs
  precision TEXT NOT NULL         -- 'precise' (SCIP) | 'heuristic' (tree-sitter)
);
CREATE INDEX edges_src ON edges (workspace, src, kind);
CREATE INDEX edges_dst ON edges (workspace, dst, kind);   -- reverse graph: "who calls me"

-- ── Full text ─────────────────────────────────────────────────────────────

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  body, header,
  content = 'chunks', content_rowid = 'rowid',
  tokenize = 'crux_code'             -- custom tokenizer, see below
);

CREATE VIRTUAL TABLE trigrams USING fts5(body, tokenize = 'trigram');

-- ── Git / temporal ────────────────────────────────────────────────────────

CREATE TABLE commits (
  workspace TEXT, sha TEXT, author TEXT, ts INTEGER,
  subject TEXT, body TEXT, pr_ref TEXT,
  PRIMARY KEY (workspace, sha)
);

CREATE TABLE file_commits (
  workspace TEXT, path TEXT, sha TEXT, churn INTEGER,
  PRIMARY KEY (workspace, path, sha)
);
```

Plus `jobs`, `files`, and `leader` from [02-queue](02-queue.md) and
[01-architecture](01-architecture.md).

## Why content addressing pays

Keying chunks and vectors by hash rather than path has four consequences, all good:

**Branch switches are nearly free.** Switch to a branch you've visited before and every
chunk hash is already present. No re-embedding — just rewrite `file_chunks` rows. The
expensive work (embedding) is cached by content, and content is what determines the
embedding.

**Renames and moves cost nothing.** Move a file across the tree: same chunk hashes, new
mapping rows.

**Duplicated code embeds once.** Vendored directories, generated clients, copy-pasted
helpers — one vector each, not N.

**Reverting is instant.** Undo a big refactor and the old chunks are still there.

The cost is one indirection on read (`file_chunks` → `chunks`) and a GC pass.

## Garbage collection

A chunk is dead when no `file_chunks` row references it. Deleting immediately would defeat
the branch-switch cache, so:

- Nightly (or on `crux gc`), delete chunks unreferenced for **> 7 days**, and their vectors.
- Cap total DB size; when exceeded, evict least-recently-referenced dead chunks first.
- `VACUUM` on demand only — it takes an exclusive lock and can stall queries.

## Vectors: keep it boring

Store int8-quantized vectors as blobs and brute-force scan in a worker thread.

Measured in [the vector spike](../spikes/vector-scan.ts), single-threaded, no SIMD:

| Corpus | Size | Scan | Throughput |
|---|---|---|---|
| 100k chunks | 37 MB | **14 ms** | 7.2 M vec/s |
| 500k chunks | 183 MB | 65 ms | 7.6 M vec/s |
| 1M chunks | 366 MB | 131 ms | 7.6 M vec/s |

Better than the SIMD-assuming estimate this section originally carried. The scan is
memory-bandwidth-bound (~2.6 GB/s), so the arithmetic being scalar barely matters. The layout
is what does: **one contiguous `Int8Array` with stride-based indexing**, never an array of
100k small typed arrays — that allocation pattern is what makes naive implementations slow.

Do **not** ship `sqlite-vec` or an HNSW index in v1. Both mean per-platform native binaries
in a project whose entire distribution pitch is "one file, no native deps." Add an ANN index
only when someone actually has a million-chunk index and the profiler says the scan is the
bottleneck.

Quantization: symmetric int8 with a per-vector scale. Recall loss versus fp32 is under 1%
for retrieval-then-rerank, and it's a 4× memory win.

`model_id` in the primary key means switching embedding models doesn't corrupt anything —
old vectors stay, new ones are computed lazily, and queries filter on the active model.

## The code-aware tokenizer

Default FTS5 tokenizers destroy code. `getUserById` becomes one token that never matches a
search for `user`, or gets split so aggressively that searching the exact identifier
matches everything.

`crux_code` emits **both**:

```
getUserById   →  ["getuserbyid", "get", "user", "by", "id"]
MAX_RETRY_MS  →  ["max_retry_ms", "max", "retry", "ms"]
http.Client   →  ["http.client", "http", "client"]
ERR_SOCK_T/O  →  ["err_sock_t/o", "err", "sock", "t", "o"]
```

Rules: split on camelCase boundaries, `_`, `-`, and `.`; preserve the full original token;
lowercase everything; keep tokens of length 1 (single-letter generics and variables matter
in code); don't stem (stemming `Users` → `User` is wrong when both are real types).

Also emit the **separator-stripped concatenation** (`get_user_by_id` → `getuserbyid`), so the
same identifier matches across naming conventions. A TS developer searching `getUserById`
finds the Python `get_user_by_id`, which is exactly how people half-remember a name they saw
in another language. Free, and verified in [the sqlite spike](../spikes/sqlite-capability.ts).

### It cannot be a real FTS5 tokenizer — and doesn't need to be

Registering a tokenizer requires the `fts5_api` C interface via `xCreateTokenizer`.
`bun:sqlite` exposes no handle for it ([the sqlite spike](../spikes/sqlite-capability.ts) confirms: the
`Database` object surfaces nothing usable). `better-sqlite3` doesn't either.

So `crux_code` is **not** a tokenizer registration. It is a pure function applied at write
time whose output is stored in a companion column indexed with stock `unicode61`:

```sql
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  body, header, tokens,            -- `tokens` holds the crux_code expansion
  content = 'chunks', content_rowid = 'rowid',
  tokenize = 'unicode61'
);
```

Queries are expanded with the same function before matching. Spike 01 passes 5/5 recall cases
this way — subword hits, snake_case splits, dotted paths, exact originals, and cross-convention
matches — with no C and no native dependency. The cost is index size, which is cheap.

### SQLite comes from the host on macOS

Bun links Apple's system SQLite on macOS rather than bundling its own — the sqlite spike reads back
`sqlite_source_id()` ending in `apl`. So the available version is whatever the OS ships. On the
current machine that is 3.51.0 with FTS5 and the trigram tokenizer both present and working,
but the floor matters: **trigram needs ≥ 3.34 (macOS 12)**. `crux doctor` must assert both FTS5
and trigram at startup and fail loudly rather than silently losing a retrieval arm. Linux and
Windows builds bundle SQLite, so the exposure is macOS-only.

The trigram table is separate, for substring queries like `sock_time` matching
`ERR_SOCK_TIMEOUT` — FTS5 can't do that, and it's a very common way people half-remember
an identifier.

## Migrations

`meta(key, value)` holds `schema_version`. Migrations are forward-only and, for anything
non-trivial, the honest answer is **drop and reindex** — the index is a derived cache, and
reindexing a repo takes a couple of minutes. Don't build a migration framework for a cache.
The one thing that must survive: user config, which lives in `.crux/config.toml`, never in the
database.
