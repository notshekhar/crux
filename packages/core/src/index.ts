export { openIndex, assertCapabilities, UnsupportedSqliteError, SCHEMA_VERSION } from "./db.ts";
export type { OpenOptions } from "./db.ts";

export { Queue, Priority, MAX_ATTEMPTS, DEFAULT_LEASE_MS, STAT_RACE_WINDOW_MS, decideWork } from "./queue.ts";
export type { Job, JobKind, EnqueueInput, FileState, WorkDecision, SkipReason } from "./queue.ts";

export { Leader, HEARTBEAT_MS, LEASE_MS } from "./leader.ts";
export type { LeaderOptions } from "./leader.ts";

export { hashBytes, hashFile, spanId, HASH_HEX_LEN } from "./hash.ts";
export { tokenize, tokenColumn, toMatchExpression } from "./tokens.ts";

export { detectLang, LANGUAGES } from "./lang.ts";
export type { Lang, LangSpec, SymbolKind } from "./lang.ts";

export { parseSource, parseFile, grammarDir } from "./parse.ts";
export type { ParseResult, ParsedSymbol, ParsedImport, ParsedCall } from "./parse.ts";

export { indexFile, removeFile, collectGarbage, synthesizeHeader } from "./indexer.ts";
export type { IndexInput, IndexStats } from "./indexer.ts";

export { search, lookupSymbol } from "./search.ts";
export type { Span, SearchOptions, SymbolHit, Arm } from "./search.ts";

export { Watcher, walkWorkspace, DEBOUNCE_MS, BACKPRESSURE_DEPTH } from "./watcher.ts";
export type { WatcherOptions, WatcherStatus } from "./watcher.ts";

export { loadIgnoreRules, shouldSkipDirectory, MAX_FILE_BYTES } from "./ignore.ts";
export type { IgnoreRules } from "./ignore.ts";

export { ParseWorker } from "./worker.ts";
export type { WorkerOptions, JobOutcome } from "./worker.ts";

export { Workspace, INDEX_RELATIVE_PATH, nestedRepos } from "./workspace.ts";
export type { WorkspaceOptions, Status } from "./workspace.ts";

export { createMcpServer, serveMcp } from "./mcp.ts";

export { fetchGrammars, missingGrammars, grammarCacheDir, grammarSource, GRAMMAR_PACKAGE_VERSION } from "./grammars.ts";
export type { FetchResult } from "./grammars.ts";
