# 02 — The Job Queue

The queue is the spine of the system. Everything that mutates the index goes through it:
filesystem events, connector polls, manual rescans, SCIP ingestion.

It lives in SQLite (same file as the index) which buys three things at once: **durability**
across crashes, **IPC** between processes without a socket, and **coalescing** via a unique
index.

## Schema

```sql
CREATE TABLE jobs (
  id          INTEGER PRIMARY KEY,
  workspace   TEXT    NOT NULL,
  path        TEXT    NOT NULL,   -- file path, or source:doc-id for connectors
  kind        TEXT    NOT NULL,   -- parse | embed | delete | scip | source_sync
  priority    INTEGER NOT NULL DEFAULT 10,
  state       TEXT    NOT NULL DEFAULT 'pending',  -- pending | running | dead
  payload     TEXT,               -- optional JSON (e.g. chunk hashes for embed jobs)
  enqueued_at INTEGER NOT NULL,
  lease_until INTEGER,
  worker      TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT
);

-- Coalescing: at most one pending job per (workspace, path, kind).
CREATE UNIQUE INDEX jobs_dedupe
  ON jobs (workspace, path, kind) WHERE state = 'pending';

-- The pull path.
CREATE INDEX jobs_pull ON jobs (state, priority, enqueued_at);
```

Completed jobs are **deleted**, not marked done. The table stays small and hot; history
lives in `files.indexed_at` if you want it.

## File state — the authority

```sql
CREATE TABLE files (
  workspace     TEXT NOT NULL,
  path          TEXT NOT NULL,
  disk_mtime    INTEGER,   -- cheap pre-filter ONLY, never authoritative
  disk_size     INTEGER,   -- cheap pre-filter ONLY, never authoritative
  indexed_hash  TEXT,      -- ← THE AUTHORITY: hash of the bytes we actually indexed
  indexed_at    INTEGER,
  lang          TEXT,
  parse_state   TEXT,      -- ok | error | skipped | too_large
  embed_state   TEXT,      -- ok | pending | disabled
  PRIMARY KEY (workspace, path)
);
```

## Enqueue — coalescing

```sql
INSERT INTO jobs (workspace, path, kind, priority, enqueued_at, state)
VALUES (?, ?, ?, ?, ?, 'pending')
ON CONFLICT (workspace, path, kind) WHERE state = 'pending'
DO UPDATE SET
  enqueued_at = excluded.enqueued_at,
  priority    = MIN(jobs.priority, excluded.priority);
```

Queue depth becomes **distinct dirty files**, not event count. A rebase that emits 50,000
filesystem events leaves ~800 rows. `npm install` leaves zero, because ignore rules are
applied *before* enqueue (see [03-watcher](03-watcher.md)).

Note the conflict target only covers `pending` rows. A file edited while its previous job
is `running` correctly gets a *new* pending row rather than being swallowed — which is
exactly the case the naive time-based skip rule got wrong.

## Claim — atomic, leased

```sql
UPDATE jobs
   SET state = 'running', worker = ?, lease_until = ?, attempts = attempts + 1
 WHERE id = (
   SELECT id FROM jobs
    WHERE state = 'pending' AND kind IN (/* this worker's lanes */)
    ORDER BY priority, enqueued_at
    LIMIT 1
 )
RETURNING *;
```

Single statement, so two workers can never claim the same row.

**Lease sweeper**, every 10 s: any row with `state='running'` and `lease_until < now` goes
back to `pending`. That covers a crashed leader, a killed process, or a laptop that slept
mid-job.

**Poison pills:** `attempts > 5` → `state='dead'` with `last_error`. One file that reliably
crashes the tree-sitter parser must never block the queue forever. `crux.status()` reports the
dead count; `crux retry --dead` resets them.

## The skip rule — hash, never clock

This is the single most important correctness decision in the system.

```
claim job
  ├─ stat(path)
  │    └─ if (mtime, size) unchanged AND the cached stat is not racily clean → DONE
  │       (cheap pre-filter — avoids hashing on spurious events; see below)
  ├─ hash = sha256_128(contents)
  │    └─ if hash == files.indexed_hash                                   → DONE
  │       (content genuinely unchanged — e.g. git checkout churn)
  ├─ parse / chunk / index
  └─ commit, storing indexed_hash = THE HASH YOU ACTUALLY READ
```

### Why not `skip if last_indexed > enqueued_at`

It looks equivalent and it isn't. It silently drops writes:

```
T1  file changes                → enqueue A (enqueued_at = T1)
T3  worker claims A, READS FILE   ← the snapshot is content@T3
T4  file changes again          → enqueue B (enqueued_at = T4)
T5  worker finishes A           → last_indexed = T5

    job B evaluates:  last_indexed(T5) > enqueued_at(T4)   →   SKIP
    ✗ the T4 edit is now missing from the index, permanently
```

Nothing will ever re-enqueue that file until it happens to change again. The index quietly
disagrees with disk, and the agent hallucinates from it with full confidence.

Hash comparison is immune to this. It's also immune to:

- **Clock skew** between `Date.now()` at enqueue and filesystem mtime.
- **mtime granularity** — 1 second on some filesystems, so a save-modify-save inside one
  second is indistinguishable by timestamp.
- **Clock adjustments** (NTP steps, timezone changes, VM snapshots).

If you want the lost-update window closed even tighter: stamp `indexed_at` with the time
you *started reading*, not the time you finished. But with hash comparison you don't need
to reason about it at all, which is the point.

### The pre-filter reintroduces the race — the racy-clean guard

Caught by the lost-update test while implementing this, and it invalidates the naive form of
the pre-filter above.

The `(mtime, size)` check is described as a harmless optimisation in front of the hash. It
isn't. It can skip a file whose content genuinely changed:

```
T0.000  index v1        → store (mtime = T0, size = N)
T0.400  write v2        → SAME SIZE, inside the filesystem's mtime granularity
T1.000  job runs: stat = (T0, N) — "unchanged" → SKIP
        ✗ v2 is permanently missing, and nothing will re-enqueue it
```

This is the exact failure the hash rule exists to prevent, sneaking back in through the
optimisation in front of it. Same-size edits are not exotic: `= 1` → `= 2`, a flipped boolean,
a renamed variable of equal length, `sed -i` over a whole tree.

It is precisely git's **racily clean** problem, and it takes git's fix: **a cached stat is
trustworthy only if, at the moment we recorded it, the file's mtime was already comfortably in
the past.** So `files` stores `read_at` alongside the stat, and the pre-filter may only skip
when:

```
stat unchanged  AND  read_at - disk_mtime > STAT_RACE_WINDOW_MS   (1000 ms)
```

A file modified within the window of when we read it gets hashed, always. Two corollaries:

- **Store mtime at full precision.** Truncating to integer milliseconds manufactures exactly
  the collision the pre-filter must detect — APFS and NTFS both carry sub-millisecond mtimes.
  The `files.disk_mtime` column is REAL, not INTEGER.
- **The window is set by the worst filesystem, not the best.** 1 s covers ext3 and NFS mounts;
  APFS and NTFS are far finer. Hashing runs at ~1.8 GB/s, so being conservative here costs
  nothing measurable and being wrong costs a permanently stale index.

The net effect: freshly-saved files are always hashed (cheap, and they're the hot set anyway),
while the cold majority of a repo still skips on stat alone during a rescan.

### The bonus

`git checkout` touches thousands of files, most of which have identical content on both
branches. The mtime pre-filter fails (mtime did change), but the hash check succeeds, so
they collapse to a stat + hash with zero parse and zero embed work.

Combined with content-addressed chunk storage ([04-storage](04-storage.md)), this is what
makes branch switching nearly free.

## Two lanes

Parse is ~2 ms. Embedding is ~100 ms per batch and may hit the network. Putting them in one
job means a slow embed backlog delays symbol freshness, which is the thing users actually
notice.

**Fast lane — `parse`**
tree-sitter, symbol extraction, import edges, chunk boundaries, FTS5 rows.
Concurrency = CPU cores. On completion, computes chunk hashes and enqueues an `embed` job
containing only the hashes **not already in the vector store**.

**Slow lane — `embed`**
Batched (64–256 chunks), throttleable, pausable on battery, retried on network failure.
Concurrency 1–2.

Net effect: you save a file, symbols and full-text are queryable in ~50 ms, vectors catch
up over the next few seconds. Queries work the whole time because the retrieval tiers
degrade independently — a missing vector arm just means slightly worse semantic recall for
a moment, not an error.

## Priorities

| Source | Priority |
|---|---|
| MCP query touching an unindexed file (enqueue + wait ≤ 300 ms) | 0 |
| File saved in the editor (hot set) | 1 |
| Watcher, ordinary change | 5 |
| Branch switch / bulk rescan | 10 |
| Initial cold index | 20 |
| SCIP reindex, connector sync | 30 |

A single editor save must jump ahead of a 5,000-file rebase backlog. Without priorities,
the user saves a file, asks a question, and waits forty seconds — which reads as "this tool
is broken."

## Backpressure

- Queue depth > 10,000 → watcher stops emitting per-file events and switches to periodic
  git-diff scans until drained. Prevents unbounded growth during pathological churn.
- Embed lane paused → `parse` jobs still complete; `embed_state` stays `pending`;
  `crux.status()` reports vector coverage below 100% so answers are correctly discounted.
