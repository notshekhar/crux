/**
 * Where crux keeps things.
 *
 * Everything lives under one directory, `~/.crux`, the way `loop` uses
 * `~/.loop`. Nothing is written into the repos being indexed:
 *
 *   ~/.crux/
 *     ├── config.json          settings (via configstore)
 *     ├── grammars/            downloaded tree-sitter .wasm files
 *     └── index/
 *          ├── registry.json   workspace path → index file
 *          └── <name>-<hash>.db
 *
 * The index used to live at `<workspace>/.crux/index.db`, which meant dropping
 * a directory into every repo and *editing the user's .gitignore* to hide it.
 * Rewriting files in a project the user only asked to search is not something
 * a search tool should do. Keeping indexes central also means read-only
 * checkouts work, and `crux list` can show everything in one place.
 */

import Configstore from "configstore";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { hashBytes } from "./hash.ts";

export const CONFIG_DIR_NAME = ".crux";

/** ~/.crux — override with CRUX_HOME_DIR, which tests use to stay off the real home. */
export function configDir(): string {
    return process.env.CRUX_HOME_DIR ?? join(homedir(), CONFIG_DIR_NAME);
}

export function grammarCacheDir(): string {
    return process.env.CRUX_GRAMMAR_DIR ?? join(configDir(), "grammars");
}

export function indexDir(): string {
    return join(configDir(), "index");
}

/** Settings. Reads parse the file each time, so callers should not poll it. */
let store: Configstore | null = null;
export function settings(): Configstore {
    if (!store) store = new Configstore("crux", {}, { configPath: join(configDir(), "config.json") });
    return store;
}

/**
 * The index file for a workspace.
 *
 * Named `<basename>-<hash>` so the directory is browsable — you can tell which
 * index belongs to which project at a glance — while the hash keeps two repos
 * with the same basename apart.
 */
export function indexPathFor(workspace: string): string {
    const name = (workspace.split("/").filter(Boolean).pop() ?? "root").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
    return join(indexDir(), `${name}-${hashBytes(workspace).slice(0, 8)}.db`);
}

export interface RegistryEntry {
    workspace: string;
    index: string;
    createdAt: number;
    lastUsed: number;
}

function registryPath(): string {
    return join(indexDir(), "registry.json");
}

/** Every workspace crux has an index for. */
export function listWorkspaces(): RegistryEntry[] {
    try {
        const entries = JSON.parse(readFileSync(registryPath(), "utf8")) as RegistryEntry[];
        return Array.isArray(entries) ? entries : [];
    } catch {
        return [];
    }
}

/** Record a workspace, or refresh its last-used time. */
export function rememberWorkspace(workspace: string): void {
    mkdirSync(indexDir(), { recursive: true });

    const now = Date.now();
    const entries = listWorkspaces().filter((e) => e.workspace !== workspace);
    entries.push({
        workspace,
        index: indexPathFor(workspace),
        createdAt: listWorkspaces().find((e) => e.workspace === workspace)?.createdAt ?? now,
        lastUsed: now,
    });

    try {
        writeFileSync(registryPath(), JSON.stringify(entries, null, 2));
    } catch {
        // A registry that cannot be written is cosmetic — indexing still works.
    }
}

/** Delete a workspace's index and forget it. Returns bytes reclaimed. */
export function forgetWorkspace(workspace: string): number {
    const path = indexPathFor(workspace);
    let freed = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
        const file = `${path}${suffix}`;
        try {
            if (existsSync(file)) {
                freed += Bun.file(file).size;
                rmSync(file);
            }
        } catch {
            // already gone
        }
    }

    try {
        writeFileSync(
            registryPath(),
            JSON.stringify(
                listWorkspaces().filter((e) => e.workspace !== workspace),
                null,
                2,
            ),
        );
    } catch {
        // cosmetic
    }
    return freed;
}
