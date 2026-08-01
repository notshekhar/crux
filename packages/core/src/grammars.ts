/**
 * Grammar bootstrap — the other half of the WASM distribution story.
 *
 * Grammars are .wasm files, so the binary does not carry 40 MB of parsers for
 * languages you do not use (05-index-tiers.md:35). The cost is that a fresh
 * install has none, and a compiled binary has no node_modules to fall back on.
 *
 * This is the one place crux touches the network, it happens only when asked,
 * and it reports exactly what it will contact first. Everything else is
 * zero-network by default (09-operations.md).
 */

import { mkdir, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { LANGUAGES, type LangSpec } from "./lang.ts";

/** Pinned to match the web-tree-sitter runtime — grammars are ABI-locked to it. */
export const GRAMMAR_PACKAGE_VERSION = "0.1.13";
const CDN = `https://cdn.jsdelivr.net/npm/tree-sitter-wasms@${GRAMMAR_PACKAGE_VERSION}/out`;

export function grammarCacheDir(): string {
    return process.env.CRUX_GRAMMAR_DIR ?? join(homedir(), ".cache", "crux", "grammars");
}

export function missingGrammars(dir = grammarCacheDir()): LangSpec[] {
    return Object.values(LANGUAGES).filter((spec) => !existsSync(join(dir, spec.grammar)));
}

/** Where downloads come from, so it can be shown before anything is fetched. */
export function grammarSource(): string {
    return CDN;
}

export interface FetchResult {
    installed: string[];
    failed: { lang: string; error: string }[];
    dir: string;
}

/**
 * Download the grammars that are missing.
 *
 * Writes to a temp name and renames, so an interrupted download never leaves a
 * truncated .wasm that would fail to load with a confusing error later.
 */
export async function fetchGrammars(
    which: LangSpec[] = missingGrammars(),
    onProgress?: (lang: string, done: number, total: number) => void,
): Promise<FetchResult> {
    const dir = grammarCacheDir();
    await mkdir(dir, { recursive: true });

    const result: FetchResult = { installed: [], failed: [], dir };

    for (const [i, spec] of which.entries()) {
        onProgress?.(spec.lang, i, which.length);
        try {
            const response = await fetch(`${CDN}/${spec.grammar}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const bytes = new Uint8Array(await response.arrayBuffer());
            // A .wasm file starts with \0asm. Anything else is an error page.
            if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
                throw new Error("response was not a WebAssembly module");
            }

            const temp = join(dir, `.${spec.grammar}.partial`);
            await writeFile(temp, bytes);
            await rename(temp, join(dir, spec.grammar));
            result.installed.push(spec.lang);
        } catch (err) {
            result.failed.push({ lang: spec.lang, error: (err as Error).message });
        }
    }
    onProgress?.("", which.length, which.length);
    return result;
}
