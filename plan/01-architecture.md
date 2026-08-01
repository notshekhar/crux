# 01 — Process Architecture

## The constraint

MCP servers over stdio are **spawned per client**. If Claude Code, Cursor, and `loop` are
all open on the same repo, the host applications each launch their own `crux mcp` process.

Naively, that gives you three filesystem watchers on one folder, three writers on one
SQLite file, and three processes embedding the same bytes. Write contention, triple CPU,
triple battery drain.

So the watcher and the MCP server cannot be the same thing. Indexing must be owned by
exactly one process at a time, while any number of processes read.

## The shape

```
   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
   │ Claude Code  │   │    Cursor    │   │     loop     │     MCP hosts (stdio)
   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
          │  crux mcp        │  crux mcp        │  crux mcp   thin, stateless readers
          └──────────────────┼──────────────────┘
                             │
                    ┌────────▼─────────┐
                    │  .crux/index.db  │  SQLite, WAL mode
                    │  ┌────────────┐  │
                    │  │ jobs queue │  │  durable — also the IPC layer
                    │  └────────────┘  │
                    └────────▲─────────┘
                             │
          ┌──────────────────┴──────────────────┐
          │  ONE leader process (elected)        │
          │  ├── fs watcher      → enqueue       │
          │  ├── parse worker    → fast lane     │
          │  ├── embed worker    → slow lane     │
          │  └── connector poller → enqueue      │
          └──────────────────────────────────────┘
```

Every `crux mcp` process does two things on startup: serve MCP requests by reading SQLite
directly, and *try* to become the leader. The winner additionally runs the watcher and
workers in-process. The losers are pure readers.

## Leader election

```sql
CREATE TABLE leader (
  workspace   TEXT PRIMARY KEY,
  holder      TEXT NOT NULL,     -- uuid, unique per process
  pid         INTEGER NOT NULL,
  hostname    TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  heartbeat   INTEGER NOT NULL
);
```

**Acquire** — a single conditional write, atomic under SQLite's write lock:

```sql
INSERT INTO leader (workspace, holder, pid, hostname, acquired_at, heartbeat)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT (workspace) DO UPDATE
  SET holder = excluded.holder, pid = excluded.pid, hostname = excluded.hostname,
      acquired_at = excluded.acquired_at, heartbeat = excluded.heartbeat
  WHERE leader.heartbeat < ?           -- only steal an expired lease
RETURNING holder;
```

If the returned `holder` is your uuid, you're the leader.

- **Heartbeat** every 5 s. **Lease** expires at 15 s.
- Losers retry acquisition every 5 s, so a dead leader is replaced within ~20 s.
- On clean shutdown, delete the row so failover is immediate.
- Before every write batch, the leader re-checks it still holds the lease. If it lost it
  (paused process, machine sleep, debugger breakpoint), it stops writing and demotes itself
  to reader. This is the fencing check that prevents two writers after a stall.
- `pid` + `hostname` are diagnostic only — never used for liveness, since a recycled pid
  would lie. The heartbeat is the only authority.

## Why not a separate daemon

The obvious alternative is a `cruxd` background service with a unix socket, which is what
most tools in this space do. Rejected for v1:

- A second binary to build, ship, sign, and notarize on macOS.
- A socket protocol to design, version, and debug — plus Windows named pipes.
- Service installation (launchd/systemd), which users hate and corporate laptops block.
- Orphaned-daemon bug reports: "I uninstalled it and something is still eating my CPU."
- **Readers would depend on the daemon being alive.** With the SQLite-as-IPC design,
  search keeps working perfectly even when indexing is completely down — it just returns
  slightly older data, and `crux.status()` says so.

`crux daemon` ships later as an *option*, for people who want indexing to continue when no
agent is open. Same code path — it simply runs the leader loop without serving MCP.

## Concurrency rules

- **WAL mode**, `busy_timeout = 5000`. Readers never block the writer; the writer never
  blocks readers.
- Exactly **one write connection**, owned by the leader. Workers hand write batches to it
  through an in-process channel.
- **Never hold a transaction across parse or embed work.** Read the job, close the
  transaction, do the slow work, open a new short transaction to commit results. A
  transaction held open across a 400 ms embedding call will starve every reader.
- Write batches are capped (e.g. 500 rows or 50 ms, whichever first) so a bulk reindex
  can't hold the write lock long enough to stall an interactive query.

## Workspaces

One `index.db` per workspace, at `<workspace>/.crux/index.db`. A leader is elected per
workspace, so watching three repos means three leaders — possibly in three different MCP
host processes, which is fine and requires no coordination.

Global, cross-workspace sources (a notes folder, a Notion connector) live in
`~/.crux/global.db` with their own leader, and are attached read-only into workspace queries
when the user has enabled them for that workspace.
