/**
 * `crux upgrade` / `crux update` — update in place.
 *
 * A git checkout fast-forwards and reinstalls deps; an installed binary re-runs
 * the release installer, which is the same script that put it there. The
 * install method is inferred from what is on disk rather than remembered, so a
 * binary that was later cloned over still does the right thing.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

// Injected at build time by build-bin.ts. Undefined when running from source,
// where package.json is the authority.
declare const __CRUX_VERSION__: string;

export const REPO_SLUG = "notshekhar/crux";
const INSTALL_URL = `https://raw.githubusercontent.com/${REPO_SLUG}/main/install.sh`;
const INSTALL_URL_PS1 = `https://raw.githubusercontent.com/${REPO_SLUG}/main/install.ps1`;

/** packages/cli/src/upgrade.ts → packages/cli */
function packageRoot(): string {
    return dirname(dirname(new URL(import.meta.url).pathname));
}

export function getVersion(): string {
    if (typeof __CRUX_VERSION__ !== "undefined") return __CRUX_VERSION__;
    try {
        const pkg = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as { version?: string };
        return typeof pkg.version === "string" ? pkg.version : "0.0.0";
    } catch {
        return "0.0.0";
    }
}

function semverGt(a: string, b: string): boolean {
    const norm = (v: string) =>
        v
            .replace(/^v/, "")
            .split(".")
            .map((n) => Number.parseInt(n, 10) || 0);
    const [a1 = 0, a2 = 0, a3 = 0] = norm(a);
    const [b1 = 0, b2 = 0, b3 = 0] = norm(b);
    if (a1 !== b1) return a1 > b1;
    if (a2 !== b2) return a2 > b2;
    return a3 > b3;
}

/**
 * The newest published tag, or null.
 *
 * The releases/latest redirect is preferred because it is not subject to the
 * anonymous GitHub API rate limit (60 req/h/IP) that bites CI and shared
 * networks. The API is the fallback.
 */
export async function fetchLatestTag(): Promise<string | null> {
    try {
        const r = await fetch(`https://github.com/${REPO_SLUG}/releases/latest`, {
            method: "HEAD",
            redirect: "follow",
        });
        const tag = r.url.split("/").pop() ?? "";
        if (/^v\d/.test(tag)) return tag;
    } catch {
        // fall through to the API
    }
    try {
        const r = await fetch(`https://api.github.com/repos/${REPO_SLUG}/releases/latest`, {
            headers: { accept: "application/vnd.github+json" },
        });
        if (!r.ok) return null;
        return ((await r.json()) as { tag_name?: string }).tag_name ?? null;
    } catch {
        return null;
    }
}

/** A newer release than `version`, or null. Never throws — callers may be on a plane. */
export async function resolveAvailableUpdate(version: string): Promise<string | null> {
    const latest = await fetchLatestTag();
    return latest && semverGt(latest, `v${version}`) ? latest : null;
}

export async function runUpgrade(opts: { force?: boolean } = {}): Promise<never> {
    const version = getVersion();
    console.log(`▶ Checking for updates (current v${version})`);

    const latest = await fetchLatestTag();
    if (!opts.force && latest && !semverGt(latest, `v${version}`)) {
        console.log(`✓ Up to date (latest ${latest})`);
        process.exit(0);
    }
    if (latest) console.log(`▶ Upgrading ${version} → ${latest}`);
    else console.log("▶ Could not query the latest release; running the installer anyway.");

    // A source checkout upgrades with git; anything else re-runs the installer.
    const root = packageRoot();
    const repoRoot = join(root, "..", "..");
    if (existsSync(join(repoRoot, ".git"))) return upgradeFromSource(repoRoot, opts);
    return upgradeFromRelease(opts);
}

function upgradeFromSource(root: string, opts: { force?: boolean }): never {
    console.log("▶ Install method: source");

    const pull = spawnSync("git", ["-C", root, "pull", opts.force ? "--force" : "--ff-only"], { stdio: "inherit" });
    if (pull.status !== 0) {
        console.error("✗ git pull failed");
        process.exit(pull.status ?? 1);
    }

    const install = spawnSync("bun", ["install"], { cwd: root, stdio: "inherit" });
    if (install.status !== 0) {
        console.error("✗ bun install failed");
        process.exit(install.status ?? 1);
    }

    console.log("✓ Up to date");
    process.exit(0);
}

function upgradeFromRelease(opts: { force?: boolean }): never {
    console.log("▶ Install method: binary");

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (opts.force) env.CRUX_FORCE = "1";

    const isWindows = process.platform === "win32";
    const result = isWindows
        ? spawnSync(
              "powershell",
              ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `irm ${INSTALL_URL_PS1} | iex`],
              {
                  stdio: "inherit",
                  env,
              },
          )
        : spawnSync("bash", ["-c", `curl -fsSL ${INSTALL_URL} | bash`], { stdio: "inherit", env });

    process.exit(result.status ?? 1);
}
