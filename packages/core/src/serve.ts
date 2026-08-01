/**
 * `crux serve` — a local inspector for the index.
 *
 * Bound to localhost only. The index contains your source code, so this is not
 * something to expose on a network interface; there is no auth because there is
 * nothing to authenticate against on a loopback socket.
 */

import type { Workspace } from "./workspace.ts";
import { importGraph, fileDetail, symbolGraph, internals, hotspots } from "./graph.ts";
import { lookupSymbol } from "./search.ts";
// The UI is one self-contained file with inline CSS and JS: no CDN, no build
// step, and `--compile` embeds it so the binary serves it with nothing on disk.
//
// The cast is needed because @types/bun types every `*.html` import as its
// HTMLBundle bundler feature; with `type: "text"` the runtime hands back a
// plain string.
import UI_HTML_ASSET from "./ui.html" with { type: "text" };
const UI_HTML = UI_HTML_ASSET as unknown as string;

const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
    });

export interface ServeOptions {
    port?: number;
    hostname?: string;
}

export function serveInspector(ws: Workspace, opts: ServeOptions = {}) {
    const routes: Record<string, (url: URL) => unknown> = {
        "/api/overview": () => ({
            ...ws.status(),
            hotspots: hotspots(ws.db, ws.root, 15),
        }),

        "/api/graph": (url) =>
            importGraph(ws.db, ws.root, {
                depth: Number(url.searchParams.get("depth") ?? 2),
                scope: url.searchParams.get("scope") ?? undefined,
                maxNodes: Number(url.searchParams.get("max") ?? 250),
                granularity: url.searchParams.get("granularity") === "file" ? "file" : "module",
            }),

        "/api/internals": () => internals(ws.db, ws.root),

        "/api/search": (url) => {
            const q = url.searchParams.get("q") ?? "";
            if (!q.trim()) return { spans: [] };
            return { spans: ws.search(q, { limit: 30, withText: true }) };
        },

        "/api/file": (url) => {
            const path = url.searchParams.get("path") ?? "";
            return fileDetail(ws.db, ws.root, path) ?? { error: "not indexed" };
        },

        "/api/symbol": (url) => {
            const name = url.searchParams.get("name") ?? "";
            return { ...symbolGraph(ws.db, ws.root, name), matches: lookupSymbol(ws.db, name, ws.root, 30) };
        },

        "/api/files": (url) => {
            const prefix = url.searchParams.get("prefix") ?? "";
            return {
                files: ws.db
                    .query<any, [string, string]>(
                        `SELECT path, lang, parse_state AS parseState, skip_reason AS skipReason
                           FROM files WHERE workspace = ? AND path LIKE ? ORDER BY path LIMIT 500`,
                    )
                    .all(ws.root, `${prefix}%`),
            };
        },
    };

    return Bun.serve({
        port: opts.port ?? 4319,
        // Loopback only. The index holds your source; it must not be reachable
        // from the network by default.
        hostname: opts.hostname ?? "127.0.0.1",

        fetch(req) {
            const url = new URL(req.url);

            const route = routes[url.pathname];
            if (route) {
                try {
                    return json(route(url));
                } catch (err) {
                    return json({ error: (err as Error).message }, 500);
                }
            }

            if (url.pathname === "/" || url.pathname === "/index.html") {
                return new Response(UI_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
            }
            return new Response("not found", { status: 404 });
        },
    });
}
