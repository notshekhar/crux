# 08 — Sources Beyond Code

Code is Phase 1–3. Everything else arrives through one connector interface and reuses the
entire pipeline — the same queue, the same content-hash dedupe, the same chunking, the same
retrieval.

The watcher and the connector poller are the same idea: both turn external change into
queue rows.

## Interface

```ts
interface Connector {
  id: string                                     // "github" | "notion" | "web" | "folder"

  auth(): Promise<void>                          // OAuth device flow → OS keychain
  list(cursor?: string): AsyncIterable<DocRef>   // incremental via provider cursor
  fetch(ref: DocRef): Promise<Document>
  watch?(): AsyncIterable<ChangeEvent>           // webhook or poll, if supported
}

interface Document {
  id: string
  title: string
  body: string            // markdown, normalized
  url?: string
  updatedAt: number
  author?: string
  refs?: string[]         // linked issues, PRs, commits, file paths
  acl?: string[]          // who can see this, if the source has permissions
}
```

A `source_sync` job runs per connector on a schedule, walks `list()` from the stored cursor,
and enqueues per-document work. Documents hash exactly like files, so unchanged pages cost
nothing.

## Ship order

Deliberately ordered by value-per-unit-pain:

**1. Local folders and files.** Markdown notes, PDFs, an Obsidian vault, a `docs/` tree
outside the repo. No auth, no API, reuses the existing watcher. Immediate value for people
who keep design docs next to code. PDF text extraction only — no OCR in v1.

**2. GitHub issues and PRs.** Best signal-to-noise of any external source. PR descriptions
and review threads explain *why* code is the way it is, and issues describe intended
behavior. Also the source of the cross-linking below. Token auth, simple REST, good
incremental support via `updated_at`.

**3. Web crawler.** Point it at framework docs — `docs.stripe.com`, a library's reference —
with a depth and domain limit. Cache locally so the agent can query them offline. Respect
`robots.txt`, rate-limit politely, re-crawl on a slow schedule.

**4. Linear.** Clean API, good cursors, real webhook support. Tickets tie directly to
branches and PRs.

**5. Notion.** Widely used, but the API is slow, deeply paginated, and the block model is
painful to flatten into good prose. Real work, real payoff.

**6. Slack.** Last, deliberately. Worst signal-to-noise, hardest auth, and by far the most
privacy-sensitive — an accidental index of a DM channel is a serious incident. Requires
explicit per-channel opt-in, never workspace-wide.

## Cross-source linking — the sleeper feature

The individually most valuable thing in this document, and it costs almost nothing once two
sources exist.

Parse references out of everything:

- Commit messages → `#1234`, `ENG-456`, `Fixes #789`
- Code comments → `TODO(ENG-456)`, links to docs, `see: RFC-12`
- PR bodies → linked issues, referenced files
- Docs → file paths, symbol names, repo links

Store them as `edges` with `kind='references'`. Now:

- `crux.history` on a function surfaces **the ticket that motivated it** and the design doc
  that specified it — not just the commit that touched it.
- `crux.pack` on a task description finds the design doc, then the code that implements it,
  then the tests, following links rather than similarity.
- A question about a feature name that appears nowhere in the code still resolves, because
  the Linear ticket names it and links the PR.

This is the thing no single-source tool can do, and it's why the connector framework earns
its place rather than being scope creep.

## Scoping and privacy

- Each source is enabled **per workspace**. A Notion connector attached to `work-repo` must
  not leak into `side-project`.
- Documents carry `acl` where the source provides it; queries filter on the authenticated
  user's identity. Under-enforcement here is a data breach, so when in doubt, exclude.
- Everything from an external source is marked **untrusted** in the response envelope — see
  the prompt-injection discussion in [09-operations](09-operations.md).
- Credentials live in the OS keychain (Keychain / libsecret / Credential Manager), never in
  `.crux/config.toml`, and never in the database.
- `crux.status()` lists every enabled connector and the last time each one talked to the
  network. If a user can't answer "what is this thing sending where", they will uninstall
  it, and they'd be right to.
