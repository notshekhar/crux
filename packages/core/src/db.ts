/**
 * Database open, pragmas, and schema — see 04-storage.md.
 *
 * One index.db per workspace. WAL so readers never block the writer; exactly one
 * write connection, owned by the leader (01-architecture.md:96).
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const SCHEMA_VERSION = 1;

const SCHEMA = /* sql */ `
-- ── Queue and file state (02-queue.md) ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY,
  workspace   TEXT    NOT NULL,
  path        TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  priority    INTEGER NOT NULL DEFAULT 10,
  state       TEXT    NOT NULL DEFAULT 'pending',
  payload     TEXT,
  enqueued_at INTEGER NOT NULL,
  lease_until INTEGER,
  worker      TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT
);

-- Coalescing: at most one PENDING job per (workspace, path, kind). Scoped to
-- pending on purpose — a file edited while its job is running must get a new
-- row rather than being swallowed. That is the lost-update race.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_dedupe
  ON jobs (workspace, path, kind) WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS jobs_pull ON jobs (state, priority, enqueued_at);
CREATE INDEX IF NOT EXISTS jobs_lease ON jobs (state, lease_until) WHERE state = 'running';

CREATE TABLE IF NOT EXISTS files (
  workspace     TEXT NOT NULL,
  path          TEXT NOT NULL,
  disk_mtime    REAL,      -- cheap pre-filter ONLY, never authoritative. REAL, not
                           -- INTEGER: truncating sub-millisecond precision creates
                           -- exactly the collision the pre-filter must detect.
  disk_size     INTEGER,   -- cheap pre-filter ONLY, never authoritative
  read_at       REAL,      -- when we read the bytes; guards the racy-clean window
  indexed_hash  TEXT,      -- THE AUTHORITY: hash of the bytes we actually indexed
  indexed_at    INTEGER,
  lang          TEXT,
  parse_state   TEXT,
  skip_reason   TEXT,      -- so status() can explain why a file is not searchable
  embed_state   TEXT,
  PRIMARY KEY (workspace, path)
);

-- ── Leader election (01-architecture.md) ────────────────────────────────────

CREATE TABLE IF NOT EXISTS leader (
  workspace   TEXT PRIMARY KEY,
  holder      TEXT NOT NULL,
  pid         INTEGER NOT NULL,
  hostname    TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  heartbeat   INTEGER NOT NULL
);

-- ── Content-addressed core (04-storage.md) ──────────────────────────────────

CREATE TABLE IF NOT EXISTS chunks (
  content_hash TEXT PRIMARY KEY,
  header       TEXT NOT NULL,
  body         TEXT NOT NULL,
  tokens       TEXT NOT NULL,   -- crux_code expansion; see tokens.ts
  kind         TEXT NOT NULL,
  lang         TEXT,
  n_tokens     INTEGER
);

CREATE TABLE IF NOT EXISTS vectors (
  content_hash TEXT NOT NULL,
  model_id     TEXT NOT NULL,
  dim          INTEGER NOT NULL,
  vec          BLOB NOT NULL,
  scale        REAL NOT NULL,
  PRIMARY KEY (content_hash, model_id)
);

CREATE TABLE IF NOT EXISTS file_chunks (
  workspace    TEXT NOT NULL,
  path         TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  ord          INTEGER NOT NULL,
  start_line   INTEGER NOT NULL,
  end_line     INTEGER NOT NULL,
  PRIMARY KEY (workspace, path, ord)
);
CREATE INDEX IF NOT EXISTS file_chunks_by_hash ON file_chunks (content_hash);

-- ── Structure ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS symbols (
  id         INTEGER PRIMARY KEY,
  workspace  TEXT NOT NULL,
  path       TEXT NOT NULL,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  signature  TEXT,
  doc        TEXT,
  parent     TEXT,
  start_line INTEGER,
  end_line   INTEGER,
  exported   INTEGER NOT NULL DEFAULT 0,
  scip_id    TEXT,
  -- Lowercased with separators stripped: get_user_by_id, getUserById, and
  -- GetUserByID all normalise to getuserbyid, so a query in one convention
  -- finds a definition written in another.
  name_norm  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS symbols_name ON symbols (workspace, name);
-- The symbol arm matches normalised names; without this index every lookup
-- degrades into a full scan of the symbol table.
CREATE INDEX IF NOT EXISTS symbols_name_norm ON symbols (workspace, name_norm);
CREATE INDEX IF NOT EXISTS symbols_path ON symbols (workspace, path);
CREATE INDEX IF NOT EXISTS symbols_scip ON symbols (workspace, scip_id) WHERE scip_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS edges (
  workspace TEXT NOT NULL,
  src       TEXT NOT NULL,
  dst       TEXT NOT NULL,
  kind      TEXT NOT NULL,
  path      TEXT,
  line      INTEGER,
  precision TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS edges_src ON edges (workspace, src, kind);
CREATE INDEX IF NOT EXISTS edges_dst ON edges (workspace, dst, kind);

-- ── Full text ───────────────────────────────────────────────────────────────

-- the tokens column carries the crux_code expansion (see tokens.ts). A real FTS5
-- tokenizer would need the fts5_api C interface, which bun:sqlite does not
-- expose, so the expansion happens at write time instead.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  body, header, tokens,
  content = 'chunks', content_rowid = 'rowid',
  tokenize = 'unicode61'
);

-- Substring matching: sock_time finds ERR_SOCK_TIMEOUT, which FTS5's normal
-- tokenizers cannot do and which is how people half-remember identifiers.
CREATE VIRTUAL TABLE IF NOT EXISTS trigrams USING fts5(
  body,
  content = 'chunks', content_rowid = 'rowid',
  tokenize = 'trigram'
);

-- External-content tables are not maintained automatically: without these the
-- index silently drifts from chunks and queries return deleted code.
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts (rowid, body, header, tokens) VALUES (new.rowid, new.body, new.header, new.tokens);
  INSERT INTO trigrams (rowid, body) VALUES (new.rowid, new.body);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, body, header, tokens)
    VALUES ('delete', old.rowid, old.body, old.header, old.tokens);
  INSERT INTO trigrams (trigrams, rowid, body) VALUES ('delete', old.rowid, old.body);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, body, header, tokens)
    VALUES ('delete', old.rowid, old.body, old.header, old.tokens);
  INSERT INTO trigrams (trigrams, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO chunks_fts (rowid, body, header, tokens) VALUES (new.rowid, new.body, new.header, new.tokens);
  INSERT INTO trigrams (rowid, body) VALUES (new.rowid, new.body);
END;

-- ── Git / temporal ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS commits (
  workspace TEXT, sha TEXT, author TEXT, ts INTEGER,
  subject TEXT, body TEXT, pr_ref TEXT,
  PRIMARY KEY (workspace, sha)
);

CREATE TABLE IF NOT EXISTS file_commits (
  workspace TEXT, path TEXT, sha TEXT, churn INTEGER,
  PRIMARY KEY (workspace, path, sha)
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export class UnsupportedSqliteError extends Error {
    constructor(missing: string[]) {
        super(
            `This SQLite build is missing: ${missing.join(", ")}.\n` +
                `crux needs FTS5 and the trigram tokenizer (SQLite >= 3.34).\n` +
                `On macOS, Bun links the system SQLite, so this means macOS < 12.`,
        );
        this.name = "UnsupportedSqliteError";
    }
}

/**
 * Assert the retrieval arms this build can actually support.
 *
 * On macOS, Bun links Apple's system SQLite rather than bundling its own, so the
 * available version is whatever the OS ships. Failing loudly here beats silently
 * losing a retrieval arm at query time (04-storage.md).
 */
export function assertCapabilities(db: Database): void {
    const missing: string[] = [];
    try {
        db.run("CREATE VIRTUAL TABLE temp.crux_probe_fts USING fts5(x)");
        db.run("DROP TABLE temp.crux_probe_fts");
    } catch {
        missing.push("FTS5");
    }
    try {
        db.run("CREATE VIRTUAL TABLE temp.crux_probe_tri USING fts5(x, tokenize = 'trigram')");
        db.run("DROP TABLE temp.crux_probe_tri");
    } catch {
        missing.push("trigram tokenizer");
    }
    if (missing.length > 0) throw new UnsupportedSqliteError(missing);
}

export interface OpenOptions {
    /** Read-only reader connection. Leaders open read-write. */
    readonly?: boolean;
    /** Skip capability probing — tests that never touch FTS. */
    skipCapabilityCheck?: boolean;
}

/**
 * Open (and if needed create) a workspace index.
 *
 * The schema is a derived cache: on a version mismatch the honest move is to
 * drop and reindex rather than migrate (04-storage.md). User config lives in
 * .crux/config.toml and is never touched here.
 */
export function openIndex(path: string, opts: OpenOptions = {}): Database {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

    const db = new Database(path, opts.readonly ? { readonly: true } : { create: true });

    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA synchronous = NORMAL"); // WAL makes FULL unnecessary for a cache
    db.run("PRAGMA foreign_keys = ON");

    if (opts.readonly) return db;
    if (!opts.skipCapabilityCheck) assertCapabilities(db);

    db.run(SCHEMA);

    const found = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get();
    if (!found) {
        db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
    } else if (Number(found.value) !== SCHEMA_VERSION) {
        throw new Error(
            `Index schema is v${found.value}, this build expects v${SCHEMA_VERSION}. ` +
                `The index is a derived cache — delete .crux/ and reindex.`,
        );
    }

    return db;
}
