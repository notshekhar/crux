/**
 * The filesystem watcher — see 03-watcher.md.
 *
 * Its only job is turning filesystem noise into a small number of high-quality
 * queue rows. It never parses, never hashes, never blocks. If it is doing work,
 * it is wrong.
 *
 * Backend is Bun's built-in `fs.watch`, not @parcel/watcher: `bun build
 * --compile` does not embed .node addons, which would break the single-binary
 * story (spikes/native-addon-compile.ts). fs.watch is part of the runtime and
 * compiles in for free.
 */

import { watch, type FSWatcher } from "node:fs";
import { relative, join, sep } from "node:path";
import { loadIgnoreRules, type IgnoreRules } from "./ignore.ts";
import { Priority, type Queue } from "./queue.ts";

/** Trailing-edge debounce per path. Long enough to collapse a save burst, short enough to feel instant. */
export const DEBOUNCE_MS = 200;
/** Above this queue depth the watcher stops emitting per-file events (02-queue.md:189). */
export const BACKPRESSURE_DEPTH = 10_000;

export interface WatcherOptions {
    workspace: string;
    queue: Queue;
    debounceMs?: number;
    ignore?: IgnoreRules;
    /** Called when the watcher degrades or recovers, for status reporting. */
    onDegraded?: (reason: string) => void;
    /** Called after each debounced flush — test seam. */
    onFlush?: (paths: string[]) => void;
}

export interface WatcherStatus {
    watching: boolean;
    degraded: string | null;
    eventsSeen: number;
    enqueued: number;
    suppressed: number;
}

export class Watcher {
    private readonly opts: Required<Pick<WatcherOptions, "workspace" | "queue">> & WatcherOptions;
    private readonly ignore: IgnoreRules;
    private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

    private handle: FSWatcher | null = null;
    private degraded: string | null = null;
    private stats = { eventsSeen: 0, enqueued: 0, suppressed: 0 };

    /** Set while a git operation is being handled in bulk. */
    private suppressUntil = 0;

    constructor(opts: WatcherOptions) {
        this.opts = opts;
        this.ignore = opts.ignore ?? loadIgnoreRules(opts.workspace);
    }

    start(): void {
        if (this.handle) return;
        try {
            this.handle = watch(this.opts.workspace, { recursive: true }, (_event, filename) => {
                // Event TYPE is deliberately ignored. fs.watch reports almost
                // everything as 'rename', including plain modifies, so branching
                // on it is a bug waiting to happen. A path is dirty; the hash
                // check in the queue decides what actually changed.
                if (filename) this.onPath(filename.toString());
            });

            this.handle.on("error", (err) => this.degrade(`watch error: ${(err as Error).message}`));
        } catch (err) {
            const e = err as NodeJS.ErrnoException;
            // ENOSPC means inotify watches are exhausted — a real failure on
            // Linux monorepos that looks like a disk error. Never fail silently:
            // a watcher that has quietly died is the stale-index scenario this
            // whole design exists to prevent.
            if (e.code === "ENOSPC") {
                this.degrade(
                    "inotify watch limit reached. Fix with:\n" +
                        "  sudo sysctl fs.inotify.max_user_watches=524288\n" +
                        "Falling back to periodic scans until then.",
                );
            } else {
                this.degrade(`could not watch ${this.opts.workspace}: ${e.message}`);
            }
        }
    }

    private degrade(reason: string): void {
        this.degraded = reason;
        this.opts.onDegraded?.(reason);
    }

    /** Ignore per-file events for a moment while a bulk change is handled. */
    suppress(ms: number): void {
        this.suppressUntil = Date.now() + ms;
    }

    private onPath(filename: string): void {
        this.stats.eventsSeen++;

        const rel = filename.split(sep).join("/");

        // .git/HEAD and .git/index are tiny and tell us something big is about
        // to happen — handle them before the denylist rejects everything .git.
        if (rel === ".git/HEAD" || rel === ".git/index") {
            this.onGitChange(rel);
            return;
        }

        if (Date.now() < this.suppressUntil) {
            this.stats.suppressed++;
            return;
        }
        if (this.ignore.shouldSkip(rel)) return;

        // Debounce per path, trailing edge. A single save in VS Code produces
        // create + write + rename; this collapses them to one enqueue.
        const existing = this.pending.get(rel);
        if (existing) clearTimeout(existing);
        this.pending.set(
            rel,
            setTimeout(() => {
                this.pending.delete(rel);
                this.flush(rel);
            }, this.opts.debounceMs ?? DEBOUNCE_MS),
        );
    }

    private flush(rel: string): void {
        // Backpressure: past this depth, per-file events stop helping and the
        // leader should be draining, not growing the queue.
        if (this.opts.queue.depth().pending > BACKPRESSURE_DEPTH) {
            this.stats.suppressed++;
            return;
        }

        this.opts.queue.enqueue({
            workspace: this.opts.workspace,
            path: rel,
            kind: "parse",
            priority: Priority.EDITOR_SAVE,
        });
        this.stats.enqueued++;
        this.opts.onFlush?.([rel]);
    }

    /**
     * A branch switch emits thousands of individual events. Asking git what
     * changed is cheaper, ordered, and gives deletes and renames explicitly
     * rather than inferring them from event soup.
     */
    private onGitChange(which: string): void {
        this.suppress(2_000);
        void this.enqueueGitDiff(which === ".git/HEAD");
    }

    private async enqueueGitDiff(headMoved: boolean): Promise<void> {
        try {
            const args = headMoved ? ["diff", "--name-status", "HEAD@{1}", "HEAD"] : ["status", "--porcelain"];

            const proc = Bun.spawn(["git", ...args], { cwd: this.opts.workspace, stdout: "pipe", stderr: "ignore" });
            const out = await new Response(proc.stdout).text();
            if ((await proc.exited) !== 0) return;

            const inputs = [];
            for (const line of out.split("\n")) {
                if (!line.trim()) continue;
                // "M\tpath" from diff, or " M path" from status --porcelain.
                const path = line.slice(headMoved ? line.indexOf("\t") + 1 : 3).trim();
                if (!path || this.ignore.shouldSkip(path)) continue;

                inputs.push({
                    workspace: this.opts.workspace,
                    path,
                    kind: "parse" as const,
                    priority: Priority.BULK,
                });
            }
            if (inputs.length > 0) {
                this.opts.queue.enqueueMany(inputs);
                this.stats.enqueued += inputs.length;
                this.opts.onFlush?.(inputs.map((i) => i.path));
            }
        } catch {
            // Not a git repo, or git is unavailable. The per-file events that
            // follow will cover it — this is an optimisation, not a dependency.
        }
    }

    status(): WatcherStatus {
        return { watching: this.handle !== null, degraded: this.degraded, ...this.stats };
    }

    stop(): void {
        for (const timer of this.pending.values()) clearTimeout(timer);
        this.pending.clear();
        this.handle?.close();
        this.handle = null;
    }
}

/**
 * Walk the tree for a cold index, pruning ignored subtrees rather than
 * filtering after the fact.
 *
 * Queries work against the partial index throughout, so this does not need to
 * finish before the watcher starts (03-watcher.md:114).
 */
export async function walkWorkspace(root: string, ignore: IgnoreRules = loadIgnoreRules(root)): Promise<string[]> {
    const { readdir } = await import("node:fs/promises");
    const found: string[] = [];

    async function descend(dir: string): Promise<void> {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return; // permissions, or it vanished mid-walk
        }

        for (const entry of entries) {
            const abs = join(dir, entry.name);
            const rel = relative(root, abs).split(sep).join("/");
            if (ignore.shouldSkip(rel)) continue;

            if (entry.isDirectory()) await descend(abs);
            else if (entry.isFile()) found.push(rel);
        }
    }

    await descend(root);
    return found;
}
