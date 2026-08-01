#!/usr/bin/env bun
// Standalone binary build via `bun build --compile`.
//
// crux has no native modules — that is deliberate and load-bearing: the watcher
// uses Bun's built-in fs.watch and tree-sitter runs as WASM, precisely so every
// target cross-compiles from any host (see spikes/README.md).
//
// Output: dist/bin/<target>/ containing `crux` (or `crux.exe`) and package.json,
// plus dist/bin/crux-<target>.tar.gz ready to upload to GitHub Releases.

import { readFileSync, mkdirSync, existsSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const pkg = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8")) as { version: string };

const VALID_TARGETS = new Set([
    "bun-darwin-arm64",
    "bun-darwin-x64",
    "bun-linux-x64",
    "bun-linux-arm64",
    "bun-windows-x64",
]);

function currentTarget(): string {
    const os =
        process.platform === "darwin"
            ? "darwin"
            : process.platform === "linux"
              ? "linux"
              : process.platform === "win32"
                ? "windows"
                : null;
    if (!os) throw new Error(`Unsupported platform: ${process.platform}`);

    const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
    if (!arch) throw new Error(`Unsupported arch: ${process.arch}`);

    return `bun-${os}-${arch}`;
}

const target = process.argv[2] ?? currentTarget();
if (!VALID_TARGETS.has(target)) {
    console.error(`Invalid target: ${target}. Valid: ${[...VALID_TARGETS].join(", ")}`);
    process.exit(1);
}

const shortTarget = target.replace("bun-", "");
const ext = target.includes("windows") ? ".exe" : "";

const binDir = join(import.meta.dir, "dist", "bin");
const stageDir = join(binDir, shortTarget);
const binPath = join(stageDir, `crux${ext}`);

if (existsSync(stageDir)) rmSync(stageDir, { recursive: true });
mkdirSync(stageDir, { recursive: true });

// Maximize CPU compatibility: x64 → -baseline (Nehalem) so binaries run on any
// x86_64 CPU; the default is Haswell/AVX2 and SIGILLs on older machines. arm64
// has no baseline/modern split. Windows is excluded because Bun's
// bun-windows-x64-baseline runtime fails to extract. The published asset keeps
// the plain arch name — only the compile target gains the suffix.
const compileTarget = shortTarget.endsWith("x64") && !target.includes("windows") ? `${target}-baseline` : target;

console.log(`▶ building ${binPath} (v${pkg.version}) [target ${compileTarget}]`);

await $`bun build ${join(import.meta.dir, "src/cli.ts")} \
  --compile \
  --target=${compileTarget} \
  --minify \
  --define __CRUX_VERSION__=${JSON.stringify(pkg.version)} \
  --outfile ${binPath}`;

// Ship package.json alongside: the installer reads it to decide whether an
// existing install is already up to date.
copyFileSync(join(import.meta.dir, "package.json"), join(stageDir, "package.json"));

// chdir + relative path so tar doesn't choke on absolute paths across OSes.
const tarballRel = `crux-${shortTarget}.tar.gz`;
const tarball = join(binDir, tarballRel);
if (existsSync(tarball)) rmSync(tarball);
await $`tar -czf ${tarballRel} ${shortTarget}`.cwd(binDir);

console.log(`✓ built ${binPath}`);
console.log(`✓ packaged ${tarball}`);
