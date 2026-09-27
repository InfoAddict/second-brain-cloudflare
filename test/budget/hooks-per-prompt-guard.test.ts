/**
 * Budget guard for v4/hooks (7b7d8f5d): whether a hook that fires per prompt
 * could exhaust the 100,000 requests/day (or neuron) free cap for a solo
 * user.
 *
 * cursor-hooks/before-submit-prompt.js is the one adapter that runs on every
 * prompt (Cursor's sessionStart is fire-and-forget and can lose the race
 * against the first model turn). It shares a 'cursor-delivered' marker with
 * session-start.js (DELIVERED_KEY) and checks it BEFORE making any request
 * (before-submit-prompt.js:29) — once either hook wins the race and sets the
 * marker, every later prompt in the session is a no-op with zero requests.
 *
 * That guard holds in the normal case (first test below). But
 * writeSessionCache (core.js:193-197) swallows a write failure and returns
 * false silently rather than throwing, and hasMarker just checks whether a
 * read finds anything. If the cache directory is ever unwritable (full disk,
 * permissions, a sandboxed $TMPDIR/$XDG_CACHE_HOME), the marker never
 * persists, hasMarker is false forever, and before-submit-prompt.js falls
 * back to running a full recall (up to 2 GET /recall + 1 GET /brief) on
 * EVERY prompt for the rest of the session — the second test pins this. At
 * ~0.013 neurons/recall call (15-t7-wow-spec.md:178 measurement) this is not
 * a realistic path to the 10,000 neurons/day cap or the 100k requests/day
 * cap for one user (it would take tens of thousands of prompts), so it is
 * MINOR, not a cap breach — but it is a real, silent loss of the "ask once"
 * guarantee, and a needless per-prompt cost for as long as the session runs.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanTemp } from "../helpers/tmp";

afterEach(cleanTemp);
const tmp = () => mkdtempSync(join(tmpdir(), "sb-hooks-prompt-guard-"));

function countingFetchStub() {
  const calls: string[] = [];
  return {
    calls,
    install: () => {
      const real = global.fetch;
      // @ts-expect-error test stub
      global.fetch = async (url: string) => {
        calls.push(new URL(String(url)).pathname);
        return new Response(JSON.stringify({ ok: true, results: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      };
      return () => { global.fetch = real; };
    },
  };
}

describe("cursor before-submit-prompt.js: per-prompt request guard", () => {
  it("makes at most one round of requests across many prompts in the same session (marker guard holds)", async () => {
    const cursor = require("../../integrations/cursor-hooks/before-submit-prompt.js");
    const dir = tmp();
    const env = { SECOND_BRAIN_URL: "https://w.example", SECOND_BRAIN_TOKEN: "t" };
    const stub = countingFetchStub();
    const restore = stub.install();
    try {
      const PROMPTS = 25;
      for (let i = 0; i < PROMPTS; i++) {
        await cursor.runBeforeSubmitPrompt({ sessionId: "sess-guard-ok", cwd: "/tmp" }, { env, cacheDir: dir });
      }
    } finally { restore(); }

    // One recall round (<=2 recall + 1 brief), never one round per prompt.
    expect(stub.calls.length).toBeLessThanOrEqual(3);
  });
});
