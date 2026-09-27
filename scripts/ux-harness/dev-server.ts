/**
 * UX-I: the real Worker, running as a plain Node HTTP server, no Cloudflare account.
 *
 * `wrangler dev` cannot do this today: a real Workers AI binding calls out to Cloudflare and
 * needs a login even in local dev. Instead of wrangler's request pipeline, this constructs the
 * exact `env` object the Worker expects (real local D1 and KV from local-env.ts's
 * `openLocalBrain`, plus the local AI and Vectorize stands-ins) and calls the Worker's own
 * `fetch(request, env, ctx)` directly, the same shape every integration test in this repo already
 * uses (test/helpers/make-env.ts's makeTestEnv) — just with real, on-disk D1/KV instead of a
 * mock, and served over an actual socket so a real browser can drive the real dashboard.
 *
 * Static assets (the dashboard in public/) are served from this same origin, matching production's
 * single-origin Workers Assets setup: a request whose path resolves to a real file under public/
 * is served directly; everything else reaches the Worker's own fetch handler.
 */
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import worker from "../../src/index";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { openLocalBrain, ROOT } from "./local-env";

const PUBLIC_DIR = join(ROOT, "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

/** The file a request path resolves to under public/, or null if it names none (never escapes
 * public/ — `normalize` collapses ".." before the prefix check runs). */
function staticFileFor(pathname: string): string | null {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const full = normalize(join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) return null;
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  return full;
}

export interface DevServerHandle { port: number; url: string; close(): Promise<void> }

export async function startDevServer(opts: { brain: string; port?: number } = { brain: "default" }): Promise<DevServerHandle> {
  resetDatabaseInit();
  const { env, close: closeBrain } = await openLocalBrain(opts.brain);
  await initializeDatabase(env);

  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      const file = staticFileFor(pathname);
      if (file) {
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
        res.end(readFileSync(file));
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = chunks.length && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(", "));
      }
      const request = new Request(`http://localhost${req.url}`, { method: req.method, headers, body });
      const ctx = { waitUntil: (p: Promise<unknown>) => { p.catch((e) => console.error("ux-harness: waitUntil task failed:", e)); }, passThroughOnException: () => {} };
      const response = await (worker as { fetch: (r: Request, e: unknown, c: unknown) => Promise<Response> }).fetch(request, env, ctx);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
    } catch (e) {
      console.error("ux-harness dev server error:", e);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("ux-harness dev server error, see the server's own console");
    }
  });

  const port = opts.port ?? 8788;
  await new Promise<void>((done) => server.listen(port, done));
  return {
    port,
    url: `http://localhost:${port}`,
    close: () => new Promise<void>((done) => server.close(() => { closeBrain().then(done, done); })),
  };
}

// Runs the server directly when this file is the entry point (npm run dev:local).
const isMain = process.argv[1] && resolve(process.argv[1]).endsWith("dev-server.mjs");
if (isMain) {
  const brain = process.env.UX_BRAIN ?? "default";
  const port = process.env.UX_PORT ? Number(process.env.UX_PORT) : 8788;
  startDevServer({ brain, port }).then((h) => {
    console.log(`ux-harness: local Second Brain running at ${h.url} (brain: ${brain}, no Cloudflare account)`);
    console.log(`ux-harness: AUTH_TOKEN is "ux-harness-local-token" (paste it into the dashboard's connect form)`);
  }).catch((e) => { console.error(e); process.exit(1); });
}
