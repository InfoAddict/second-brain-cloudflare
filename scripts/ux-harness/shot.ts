/**
 * UX-I: capture one named screen or state on demand, for any lane to use for before/after shots.
 *
 * Usage: node scripts/ux-shot.mjs --name=<slug> --caption="<one line>" [--path=/] [--url=http://localhost:8788]
 *        [--brain=default] [--viewport=desktop|mobile] [--locale=en|it] [--theme=light|dark] [--run=<runId>]
 *        [--wait=<selector>] [--script=<page.evaluate JS, e.g. to open a sheet before the shot>]
 *
 * With --url, attaches to an already-running `npm run dev:local` (or another UX-I server) instead
 * of starting one, so other lanes can shoot a screen they are already looking at.
 */
import { openBrowser, type Locale, type Theme, type Viewport } from "./browser";
import { startRun } from "./screenshots";
import { startDevServer } from "./dev-server";

function arg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function main() {
  const name = arg("name");
  const caption = arg("caption");
  if (!name || !caption) {
    console.error('usage: node scripts/ux-shot.mjs --name=<slug> --caption="<one line>" [--path=/] [--url=...] [--brain=default] [--viewport=desktop|mobile] [--locale=en|it] [--theme=light|dark] [--run=<runId>]');
    process.exit(2);
  }
  const path = arg("path", "/")!;
  const viewport = (arg("viewport", "desktop") as Viewport);
  const locale = (arg("locale", "en") as Locale);
  const theme = (arg("theme", "light") as Theme);
  const waitSelector = arg("wait");
  const script = arg("script");

  let baseUrl = arg("url");
  let ownServer: Awaited<ReturnType<typeof startDevServer>> | undefined;
  if (!baseUrl) {
    ownServer = await startDevServer({ brain: arg("brain", "default")! });
    baseUrl = ownServer.url;
  }

  const session = await openBrowser();
  const rec = startRun(arg("run"));
  try {
    const page = await session.newPage({ baseUrl, token: "ux-harness-local-token", viewport, locale, theme });
    await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle0" });
    if (waitSelector) await page.waitForSelector(waitSelector, { timeout: 10_000 });
    if (script) await page.evaluate(script);
    const file = await rec.shot(page, name, `${caption} (${viewport}, ${locale}, ${theme})`);
    console.log(`ux-harness: wrote ${file}`);
    console.log(`ux-harness: index at ${rec.dir}/index.md`);
  } finally {
    await session.close();
    if (ownServer) await ownServer.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
