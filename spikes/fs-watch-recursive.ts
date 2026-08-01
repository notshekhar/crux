/**
 * Can Bun built-in fs.watch replace @parcel/watcher?
 *
 * The native-addon spike proved `bun build --compile` will not embed a .node addon, so
 * @parcel/watcher costs us the single-binary claim. fs.watch is part of the
 * runtime and therefore compiles in for free.
 *
 * What has to hold for 03-watcher.md:
 *   1. recursive: true works (one watch for a whole tree)
 *   2. rename-over-target (the editor save pattern) is observed
 *   3. nested subdirectories created *after* the watch starts are covered
 *   4. it still works inside a compiled binary
 */

import { watch } from "node:fs";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const compiled = !Bun.main.endsWith(".ts");

const dir = await mkdtemp(join(tmpdir(), "crux-fsw-"));
const seen: string[] = [];
let watchErr: string | null = null;
let recursiveSupported = true;

let w: ReturnType<typeof watch> | null = null;
try {
    w = watch(dir, { recursive: true }, (event, filename) => {
        if (filename) seen.push(`${event}:${filename}`);
    });
    w.on("error", (e) => (watchErr = (e as Error).message));
} catch (e) {
    recursiveSupported = false;
    watchErr = (e as Error).message;
}

if (recursiveSupported) {
    // 2. editor save: write temp, rename over target, then modify
    const target = join(dir, "retry.ts");
    await writeFile(join(dir, ".goutputstream-XYZ"), "export class RetryPolicy {}");
    await Bun.$`mv ${join(dir, ".goutputstream-XYZ")} ${target}`.quiet();
    await Bun.sleep(150);
    await writeFile(target, "export class RetryPolicy { execute() {} }");

    // 3. subdirectory created after the watch began
    await mkdir(join(dir, "src", "billing"), { recursive: true });
    await Bun.sleep(150);
    await writeFile(join(dir, "src", "billing", "webhook.ts"), "export const retry = 1");

    await Bun.sleep(500);
    w?.close();
}
await rm(dir, { recursive: true, force: true });

const sawTarget = seen.some((s) => s.includes("retry.ts"));
const sawNested = seen.some((s) => s.includes("billing/webhook.ts") || s.includes("webhook.ts"));

console.log(`\n  fs.watch ${compiled ? "(STANDALONE BINARY)" : "(from source)"}\n`);
const row = (ok: boolean, label: string, note = "") =>
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${note ? `\n        ${note}` : ""}`);

row(
    recursiveSupported,
    "recursive: true accepted",
    watchErr ? `error: ${watchErr}` : `${process.platform}/${process.arch}`,
);
row(sawTarget, "rename-over-target observed");
row(sawNested, "nested dir created after watch start is covered");
console.log(`\n        events: ${seen.join(", ") || "(none)"}\n`);

process.exit(recursiveSupported && sawTarget && sawNested ? 0 : 1);
