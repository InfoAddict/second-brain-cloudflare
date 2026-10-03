/**
 * UX-I: every PNG a walkthrough or an on-demand shot takes lands under one run directory, with an
 * index.md captioning each one. Output root is fixed and outside this repo's git tree — the
 * project's docs/ is local-only and already gitignored (docs/*), so nothing here is ever
 * committed by accident.
 */
import { mkdirSync, appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "puppeteer-core";

export const SCREENSHOTS_ROOT = "/home/rahil/Projects/second-brain/second-brain-cloudflare/docs/superpowers/screenshots/v4/harness";

function timestampRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export interface ShotRecorder {
  runId: string;
  dir: string;
  /** Captures `page` as `<slug>.png` in this run's directory and adds one line to index.md.
   * `slug` should be filesystem-safe and already say which journey/step/viewport/locale it is. */
  shot(page: Page, slug: string, caption: string): Promise<string>;
}

/** Starts a new run directory (or reuses `runId` if given, so a runner and an on-demand shot in
 * the same invocation can share one index.md). */
export function startRun(runId: string = timestampRunId()): ShotRecorder {
  const dir = join(SCREENSHOTS_ROOT, runId);
  mkdirSync(dir, { recursive: true });
  const indexPath = join(dir, "index.md");
  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, `# UX-I screenshots — run ${runId}\n\nNo Cloudflare account: local D1, KV, AI and Vectorize only.\n\n`);
  }
  return {
    runId,
    dir,
    async shot(page, slug, caption) {
      const file = join(dir, `${slug}.png`);
      await page.screenshot({ path: file as `${string}.png`, fullPage: true });
      appendFileSync(indexPath, `- [${slug}.png](./${slug}.png) — ${caption}\n`);
      return file;
    },
  };
}
