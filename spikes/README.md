# Spikes

De-risking runs against the Phase 1 assumptions in [`../plan`](../plan). Each is standalone:

```
bun spikes/sqlite-capability.ts
bun spikes/fs-watch-recursive.ts
bun spikes/treesitter-throughput.ts
bun spikes/vector-scan.ts

bun spikes/native-addon-compile.ts   # kept as the record of a negative result;
                                     # needs `bun add -d @parcel/watcher` to run
                                     # at all, since that dependency was dropped
```

Run on macOS 15 / arm64, Bun 1.4.0, 2026-08-01.

## Results

| Spike | Question | Verdict |
|---|---|---|
| `sqlite-capability` | FTS5 available in the SQLite Bun uses? | **Yes** |
| | trigram tokenizer available? | **Yes** — `sock_time` matches `ERR_SOCK_TIMEOUT` |
| | external-content FTS tables work? | **Yes** — with `'rebuild'`, not manual delete |
| | custom FTS5 tokenizer registerable? | **No** — no `fts5_api` surface |
| | pre-tokenization workaround viable? | **Yes** — 5/5 recall cases |
| `native-addon-compile` | `@parcel/watcher` survives `--compile`? | **No** — `.node` not embedded |
| `fs-watch-recursive` | built-in `fs.watch` replaces it? | **Yes** — incl. compiled, recursive, nested |
| `treesitter-throughput` | WASM parsing hits the ~2 ms/file claim? | **Yes** — 0.57 ms p50 |
| `vector-scan` | int8 scan viable without SIMD? | **Yes** — 14 ms @ 100k, beats the SIMD budget |

## What changed in the plan

- **`04-storage.md`** — `crux_code` is a write-time function over a companion column, not a
  registered tokenizer. Added the separator-stripped concatenation for cross-convention
  matching. Documented that Bun uses Apple's system SQLite on macOS (trigram floor: macOS 12).
  Replaced the estimated vector numbers with measured ones.
- **`03-watcher.md`** — backend is built-in `fs.watch`, not `@parcel/watcher`. Event types are
  unreliable and must never be branched on.
- **`00-overview.md`** — removed the predicted slow-vector-scan cost; it was wrong by ~10×.
- **`10-roadmap.md`** — native-deps risk promoted to Confirmed; two new risks registered.

## Numbers worth keeping

**Parse** (`treesitter-throughput`, loop's own source, 466 files / 3.7 MB TypeScript,
single-threaded):

```
grammar load   14 ms one-time
throughput     799 files/s, 6.3 MB/s
per file       p50 0.57 ms   p95 3.01 ms   p99 6.33 ms   max 17.6 ms
extracted      3022 symbols, 1904 imports, 0 parse failures
```

At 8 parse workers that is a ~10k-file repo cold-indexed in roughly 1.5 s of parse time, so the
60-second time-to-first-value requirement in `07-mcp.md` has a lot of headroom.

**Vector scan** (`vector-scan`, 384 dims, top-20, single-threaded, no SIMD):

```
100k chunks     14 ms     37 MB    7.2 M vec/s
500k chunks     65 ms    183 MB    7.6 M vec/s
  1M chunks    131 ms    366 MB    7.6 M vec/s
```

**Hashing** — Bun's `CryptoHasher` has no blake3, and adding one means a native dependency that
`native-addon-compile` rules out. sha256 is hardware-accelerated on arm64 at **1793 MB/s**
against blake2b256's 645 MB/s, so `02-queue.md`'s blake3 becomes sha256 truncated to 128 bits.

## Pinned versions

`web-tree-sitter` must be pinned to **0.24.7** to match `tree-sitter-wasms@0.1.13`. The 0.26
runtime rejects those grammars at load (`getDylinkMetadata` failure), and the export shape
changed at 0.25 (`Parser.Language` after `init()` before then, named exports after). Grammar
`.wasm` files are ABI-locked to a runtime range — upgrading one means upgrading both and
re-testing.

## Still open

- **`fs.watch` `recursive: true` on Linux.** Unverified; needs a CI run on a real Linux runner
  before Phase 1 closes. Fallback is a watch per directory, which reintroduces inotify limits.
- **`--compile` on non-darwin targets.** Only macOS/arm64 was exercised here.
