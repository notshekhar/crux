/**
 * Does a native addon survive `bun build --compile`?
 *
 * Gates: 03-watcher.md (@parcel/watcher / FSEvents) vs
 *        10-roadmap.md risk "native deps break the single-binary story"
 *
 * @parcel/watcher is a native N-API addon. If `--compile` cannot embed the
 * .node file, the single-binary distribution claim is false and 03-watcher.md
 * needs a different backend.
 *
 * Run twice:
 *   bun spikes/native-addon-compile.ts                    # from the repo, node_modules present
 *   bun build --compile ... && ./binary         # standalone, run elsewhere
 */

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const standalone = !import.meta.path.includes("node_modules") && Bun.main.endsWith(".ts") === false;

async function main() {
    let watcher: typeof import("@parcel/watcher");
    try {
        watcher = await import("@parcel/watcher");
    } catch (e) {
        console.log(`  FAIL  import @parcel/watcher — ${(e as Error).message}`);
        process.exit(1);
    }

    const dir = await mkdtemp(join(tmpdir(), "crux-spike-"));
    const seen: string[] = [];

    const sub = await watcher.subscribe(dir, (err, events) => {
        if (err) return;
        for (const e of events) seen.push(`${e.type} ${e.path.split("/").pop()}`);
    });

    // Simulate the editor-save pattern from 03-watcher.md:66 — write a temp
    // file, then rename it over the target. We should observe the rename.
    const target = join(dir, "retry.ts");
    await writeFile(join(dir, ".goutputstream-XYZ"), "export class RetryPolicy {}");
    await Bun.$`mv ${join(dir, ".goutputstream-XYZ")} ${target}`.quiet();
    await writeFile(target, "export class RetryPolicy { execute() {} }");

    await Bun.sleep(600); // longer than the 200 ms debounce in the real watcher
    await sub.unsubscribe();
    await rm(dir, { recursive: true, force: true });

    const backend = process.platform === "darwin" ? "FSEvents" : process.platform === "linux" ? "inotify" : "RDCW";
    const ok = seen.length > 0;

    console.log(`\n  native addon ${standalone ? "(STANDALONE BINARY)" : "(from source)"}\n`);
    console.log(`  ${ok ? "PASS" : "FAIL"}  native addon loaded and ${backend} delivered events`);
    console.log(`        platform: ${process.platform}/${process.arch}`);
    console.log(`        events:   ${seen.join(", ") || "(none)"}\n`);
    process.exit(ok ? 0 : 1);
}

await main();
