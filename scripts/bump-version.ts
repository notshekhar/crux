/**
 * Bump the crux version across the packages that ship as one unit, in a single
 * step so they never drift.
 *
 *   bun run bump patch          # 0.1.0 → 0.1.1
 *   bun run bump minor          # 0.1.0 → 0.2.0
 *   bun run bump major          # 0.1.0 → 1.0.0
 *   bun run bump 0.9.1          # set an explicit version
 *
 * Only the `version` line is rewritten, so formatting and key order in each
 * package.json are untouched. Prints the tag to push.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGES = ["core", "cli"] as const;
const ROOT = join(import.meta.dir, "..");
const pkgPath = (name: string) => join(ROOT, "packages", name, "package.json");
const VERSION_RE = /("version":\s*")[^"]+(")/;

function readVersion(path: string): string {
    const m = readFileSync(path, "utf8").match(/"version":\s*"([^"]+)"/);
    if (!m?.[1]) throw new Error(`no version field in ${path}`);
    return m[1];
}

function bump(version: string, level: "patch" | "minor" | "major"): string {
    const parts = version.split(".").map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
        throw new Error(`current version is not semver: ${version}`);
    }
    const [major = 0, minor = 0, patch = 0] = parts;
    if (level === "major") return `${major + 1}.0.0`;
    if (level === "minor") return `${major}.${minor + 1}.0`;
    return `${major}.${minor}.${patch + 1}`;
}

const arg = process.argv[2];
if (!arg) {
    console.error("usage: bun run bump <patch|minor|major|X.Y.Z>");
    process.exit(1);
}

const current = readVersion(pkgPath("cli"));
const next =
    arg === "patch" || arg === "minor" || arg === "major"
        ? bump(current, arg)
        : /^\d+\.\d+\.\d+$/.test(arg)
          ? arg
          : (() => {
                console.error(`not a version or level: ${arg}`);
                process.exit(1);
            })();

for (const name of PACKAGES) {
    const path = pkgPath(name);
    const before = readFileSync(path, "utf8");
    const after = before.replace(VERSION_RE, `$1${next}$2`);
    if (before === after) throw new Error(`failed to rewrite version in ${path}`);
    writeFileSync(path, after);
    console.log(`  ${name}: ${current} → ${next}`);
}

console.log(`\nnext:`);
console.log(`  git commit -am "Release v${next}"`);
console.log(`  git tag v${next} && git push origin main --tags`);
