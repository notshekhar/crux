#!/usr/bin/env bun
/**
 * The crux CLI.
 *
 * `crux init` does the whole onboarding: creates .crux/, runs the cold index,
 * and prints ready-to-paste config for the MCP hosts. The time-to-first-value
 * target is under 60 seconds including the index — a product requirement, not
 * an aspiration (07-mcp.md:124).
 */

import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";

import { runUpgrade, getVersion, resolveAvailableUpdate } from "./upgrade.ts";
import {
    Workspace,
    serveMcp,
    grammarDir,
    LANGUAGES,
    assertCapabilities,
    UnsupportedSqliteError,
    openIndex,
    INDEX_RELATIVE_PATH,
    nestedRepos,
    fetchGrammars,
    missingGrammars,
    grammarSource,
} from "@notshekhar/crux-core";

const VERSION = getVersion();

/** Above this, `crux init` asks before indexing — see 09-operations.md. */
const LARGE_WORKSPACE_FILES = 25_000;

// ── Output ──────────────────────────────────────────────────────────────────
// Everything here writes to stderr when serving MCP, because stdout is the
// protocol channel. The commands below are interactive, so stdout is fine.

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const say = (s = "") => console.log(s);

function fail(message: string): never {
    console.error(`${red("error")} ${message}`);
    process.exit(1);
}

// ── Commands ────────────────────────────────────────────────────────────────

async function cmdInit(root: string, force: boolean) {
    say(`${bold("crux")} indexing ${root}`);
    say();

    // Validate the target BEFORE creating anything. Refusing to index a folder
    // after having written .crux/ and edited its .gitignore leaves a mess in a
    // directory the user never wanted touched.
    if (!force) {
        const repos = await nestedRepos(root);
        if (repos.length > 1) {
            say(yellow(`  this directory contains ${repos.length} git repositories`));
            say(dim(`  ${repos.slice(0, 5).join(", ")}${repos.length > 5 ? ", …" : ""}`));
            say();
            say(`  crux indexes one repo at a time — run ${bold("crux init")} inside the one you want.`);
            say(dim(`  to index everything here anyway: crux init --force`));
            say();
            return;
        }
    }

    await mkdir(join(root, ".crux"), { recursive: true });

    // The index is a derived cache and must never be committed.
    const gitignore = join(root, ".gitignore");
    const existing = existsSync(gitignore) ? await readFile(gitignore, "utf8") : "";
    if (!existing.includes(".crux")) {
        await appendFile(gitignore, `${existing.endsWith("\n") || existing === "" ? "" : "\n"}.crux/\n`);
        say(`${dim("added .crux/ to .gitignore")}`);
    }

    // A freshly installed binary has no grammars — they are downloaded rather
    // than bundled, because 40 MB of parsers for languages you do not use is
    // not worth shipping. init is an explicit setup step, so this is the right
    // place to fetch them; `crux mcp` never reaches for the network.
    const missing = missingGrammars();
    if (missing.length > 0) {
        say(dim(`fetching ${missing.length} language grammars from ${grammarSource()}`));
        const result = await fetchGrammars(missing, (lang) => {
            if (lang) process.stdout.write(`\r  ${dim(lang)}\x1b[K`);
        });
        process.stdout.write("\r\x1b[K");
        if (result.failed.length > 0) {
            say(yellow(`  could not fetch: ${result.failed.map((f) => f.lang).join(", ")}`));
            say(dim("  those languages will be indexed as plain text until `crux doctor --fetch` succeeds"));
        }
        say();
    }

    const started = Date.now();
    const ws = new Workspace({
        root,
        onProgress: (done, total) => process.stdout.write(`\r  indexing ${done}/${total} files`),
    });

    // Secondary guard for a single very large tree (a monorepo, or a home
    // directory with no repos in it). Cheap: the walk stops at the limit.
    if (!force) {
        const walked = await ws.filesToIndex(LARGE_WORKSPACE_FILES + 1);
        if (walked.length > LARGE_WORKSPACE_FILES) {
            say(yellow(`  more than ${LARGE_WORKSPACE_FILES.toLocaleString()} files here`));
            say(dim(`  that will take a while — re-run with --force if it is what you meant`));
            say();
            ws.close();
            return;
        }
    }

    const found = await ws.coldIndex();
    await ws.drain();
    process.stdout.write("\r\x1b[K");

    const status = ws.status();
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    say(`${green("✓")} indexed ${status.files} files in ${seconds}s`);
    say(`  ${status.symbols} symbols, ${status.chunks} chunks, ${(status.indexBytes / 1e6).toFixed(1)} MB`);
    if (found !== status.files) say(dim(`  ${found - status.files} files skipped (binary, generated, or ignored)`));
    say();

    printHostConfig(root);
    ws.close();
}

function printHostConfig(root: string) {
    const binary = process.execPath.endsWith("bun") ? `bun ${resolve(import.meta.dir, "cli.ts")}` : "crux";
    const config = {
        mcpServers: {
            crux: { command: binary.split(" ")[0], args: [...binary.split(" ").slice(1), "mcp", root] },
        },
    };

    say(bold("Add to your agent:"));
    say();
    say(dim("  Claude Code   ") + `claude mcp add crux -- ${binary} mcp ${root}`);
    say(dim("  loop          ") + `loop mcp add crux -- ${binary} mcp ${root}`);
    say();
    say(dim("  Cursor / Windsurf / Zed — add to the MCP config file:"));
    say(
        JSON.stringify(config, null, 2)
            .split("\n")
            .map((l) => `  ${l}`)
            .join("\n"),
    );
    say();
}

async function cmdDoctor(root: string, fetchGrammarsRequested: boolean) {
    say(`${bold("crux doctor")}`);
    say();

    let problems = 0;
    const ok = (label: string, detail = "") => say(`  ${green("✓")} ${label} ${dim(detail)}`);
    const bad = (label: string, fix: string) => {
        problems++;
        say(`  ${red("✗")} ${label}`);
        say(`      ${yellow("fix:")} ${fix}`);
    };

    // SQLite capabilities. On macOS Bun links the system SQLite, so the version
    // is whatever the OS ships — this is a real constraint, not a formality.
    try {
        const probe = openIndex(":memory:");
        assertCapabilities(probe);
        const v = probe.query<{ v: string }, []>("SELECT sqlite_version() v").get();
        ok("sqlite", `${v?.v} with FTS5 + trigram`);
        probe.close();
    } catch (e) {
        if (e instanceof UnsupportedSqliteError) bad("sqlite", "upgrade to macOS 12+ (crux needs SQLite >= 3.34)");
        else bad("sqlite", (e as Error).message);
    }

    // Grammars — without these Tier 1 is dead and only lexical search works.
    const dir = grammarDir();
    let missing = Object.values(LANGUAGES).filter((l) => !existsSync(join(dir, l.grammar)));

    if (missing.length > 0 && fetchGrammarsRequested) {
        say(`  ${dim(`fetching ${missing.length} grammars from ${grammarSource()}`)}`);
        const result = await fetchGrammars(missing, (lang) => {
            if (lang) process.stdout.write(`\r  ${dim(`  ${lang}...`)}\x1b[K`);
        });
        process.stdout.write("\r\x1b[K");
        missing = missing.filter((m) => !result.installed.includes(m.lang));
        for (const f of result.failed) say(`  ${red("✗")} ${f.lang}: ${f.error}`);
    }

    if (missing.length === 0) ok("grammars", `${Object.keys(LANGUAGES).length} languages in ${dir}`);
    else bad(`grammars: ${missing.map((m) => m.lang).join(", ")} missing`, "crux doctor --fetch");

    // The index itself.
    const indexPath = join(root, INDEX_RELATIVE_PATH);
    if (!existsSync(indexPath)) {
        say(`  ${yellow("-")} index not built yet ${dim("run: crux init")}`);
    } else {
        try {
            const ws = new Workspace({ root, readonly: true });
            const s = ws.status();
            ok("index", `${s.files} files, ${s.symbols} symbols, ${(s.indexBytes / 1e6).toFixed(1)} MB`);

            if (s.queue.dead > 0) {
                bad(`${s.queue.dead} dead jobs`, "crux retry --dead");
            }
            if (s.watcher.degraded) bad("watcher degraded", s.watcher.degraded);
            ws.close();
        } catch (e) {
            bad("index unreadable", `delete ${join(root, ".crux")} and run crux init`);
        }
    }

    say();
    say(problems === 0 ? green("  no problems found") : red(`  ${problems} problem${problems === 1 ? "" : "s"}`));
    process.exit(problems === 0 ? 0 : 1);
}

async function cmdStatus(root: string) {
    const ws = new Workspace({ root, readonly: true });
    const s = ws.status();

    say(`${bold("crux")} ${s.workspace}`);
    say();
    say(`  files      ${s.files}`);
    say(`  symbols    ${s.symbols}`);
    say(`  chunks     ${s.chunks}`);
    say(`  index      ${(s.indexBytes / 1e6).toFixed(1)} MB`);
    say(`  queue      ${s.queue.pending} pending, ${s.queue.running} running, ${s.queue.dead} dead`);
    say(`  fresh      ${s.queue.pending === 0 ? green("yes") : yellow(`${s.queue.pending} files behind`)}`);
    say();
    say(dim("  coverage"));
    say(`    lexical    ${Math.round(s.coverage.lexical * 100)}%`);
    say(`    syntactic  ${Math.round(s.coverage.syntactic * 100)}%`);
    say(`    precise    ${dim("0%  SCIP lands in Phase 2")}`);
    say(`    vectors    ${dim("0%  embeddings land in Phase 3")}`);
    say();
    say(dim("  network    none — nothing leaves this machine"));
    ws.close();

    // Checked here rather than on every command: status is the "how healthy am
    // I" command, and no other path should pay for a network round trip.
    const update = await resolveAvailableUpdate(VERSION);
    if (update) {
        say();
        say(`  ${yellow(`update available: ${VERSION} → ${update.replace(/^v/, "")}`)}  ${dim("run: crux upgrade")}`);
    }
}

async function cmdSearch(root: string, query: string, limit: number) {
    const ws = new Workspace({ root, readonly: true });
    const started = performance.now();
    const hits = ws.search(query, { limit });
    const ms = performance.now() - started;

    if (hits.length === 0) {
        say(dim(`no matches for ${JSON.stringify(query)}`));
        const s = ws.status();
        if (s.files === 0) say(dim("the index is empty — run: crux init"));
        ws.close();
        return;
    }

    for (const hit of hits) {
        say(`${bold(hit.path)}:${hit.startLine}-${hit.endLine} ${dim(`[${hit.why.matched.join("+")}]`)}`);
        const preview = (hit.text || "").split("\n").slice(0, 4);
        for (const line of preview) say(dim(`  ${line.slice(0, 110)}`));
        say();
    }
    say(dim(`${hits.length} results in ${ms.toFixed(1)}ms`));
    ws.close();
}

async function cmdSymbol(root: string, name: string) {
    const ws = new Workspace({ root, readonly: true });
    const hits = ws.symbol(name);

    if (hits.length === 0) say(dim(`no symbol named ${JSON.stringify(name)}`));
    for (const h of hits) {
        say(`${bold(h.name)} ${dim(h.kind)}${h.exported ? green(" exported") : ""}`);
        say(`  ${h.path}:${h.startLine}`);
        if (h.signature) say(dim(`  ${h.signature.slice(0, 120)}`));
        if (h.doc) say(dim(`  ${h.doc.split("\n")[0]?.slice(0, 120)}`));
        say();
    }
    ws.close();
}

async function cmdMcp(root: string) {
    // stdout is the MCP protocol channel from here on — never write to it.
    const ws = new Workspace({ root });

    const isLeader = await ws.start();
    if (isLeader) {
        // Catch up on anything that changed while nothing was watching, then
        // drain in the background. Queries work against the partial index
        // throughout, so this must not block the handshake.
        void (async () => {
            await ws.coldIndex();
            await ws.drain();
        })();
    }

    process.on("SIGINT", () => {
        ws.close();
        process.exit(0);
    });
    process.on("SIGTERM", () => {
        ws.close();
        process.exit(0);
    });

    await serveMcp(ws);
}

// ── Entry ───────────────────────────────────────────────────────────────────

const HELP = `${bold("crux")} — a local-first context engine for coding agents

${bold("usage")}
  crux init [path]              index a workspace and print agent config
  crux init --force             index even a very large tree
  crux mcp [path]               serve over MCP on stdio (what agents run)
  crux search <query> [path]    search from the terminal
  crux symbol <name> [path]     look up a symbol
  crux status [path]            what is indexed and how fresh
  crux doctor [path]            check the install and print fixes
  crux doctor --fetch           download missing language grammars
  crux upgrade                  update crux to the latest release
  crux version | -v             print the version

${bold("options")}
  -n, --limit <n>               results to return (default 10)
  --force                       with upgrade: reinstall even if up to date
  -v, --version
`;

async function main() {
    const argv = process.argv.slice(2);
    if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
        say(HELP);
        return;
    }
    if (argv[0] === "-v" || argv[0] === "--version" || argv[0] === "version") {
        say(VERSION);
        return;
    }

    const command = argv[0];
    const rest = argv.slice(1);

    let limit = 10;
    const limitAt = rest.findIndex((a) => a === "-n" || a === "--limit");
    if (limitAt >= 0) {
        limit = Number(rest[limitAt + 1]) || 10;
        rest.splice(limitAt, 2);
    }

    const positional = rest.filter((a) => !a.startsWith("-"));

    switch (command) {
        case "upgrade":
        case "update":
            await runUpgrade({ force: rest.includes("--force") });
            return;
        case "init":
            return cmdInit(resolve(positional[0] ?? process.cwd()), rest.includes("--force"));
        case "mcp":
            return cmdMcp(resolve(positional[0] ?? process.cwd()));
        case "doctor":
            return cmdDoctor(resolve(positional[0] ?? process.cwd()), rest.includes("--fetch"));
        case "status":
            return cmdStatus(resolve(positional[0] ?? process.cwd()));
        case "search": {
            const query = positional[0];
            if (!query) fail("search needs a query: crux search 'where do we retry webhooks'");
            return cmdSearch(resolve(positional[1] ?? process.cwd()), query, limit);
        }
        case "symbol": {
            const name = positional[0];
            if (!name) fail("symbol needs a name: crux symbol RetryPolicy");
            return cmdSymbol(resolve(positional[1] ?? process.cwd()), name);
        }
        default:
            fail(`unknown command ${JSON.stringify(command)}\n\n${HELP}`);
    }
}

await main();
