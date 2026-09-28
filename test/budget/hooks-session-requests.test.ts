/**
 * Budget guard for v4/hooks (7b7d8f5d): how many Worker HTTP requests one
 * agent session generates via integrations/agent-hooks-core/core.js, against
 * the Workers free-plan cap of 100,000 requests/day.
 *
 * performRecall (session start): at most 2 GET /recall attempts (a project
 * arm, and only on a 404/400 fallback an unscoped arm — core.js:394-419) plus
 * exactly 1 GET /brief, fired concurrently via startBrief (core.js:392).
 * performCapture (session end, Codex/Cursor): exactly 1 POST /capture, plus
 * one GET /health the first time in 24h per Worker origin
 * (workerMajorVersion, core.js:154, HEALTH_TTL_MS cached to a file).
 *
 * A solo user having, say, 20 sessions/day against these bounds is at most
 * 20 x (2 recall + 1 brief + 1 capture + <=1 health) <= 120 requests/day —
 * four orders of magnitude under the 100k/day cap. The real risk this file
 * checks for is not steady-state volume but an uncapped-per-prompt path; see
 * hooks-per-prompt-guard.test.ts for that.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanTemp } from "../helpers/tmp";

const core = require("../../integrations/agent-hooks-core/core.js");

afterEach(cleanTemp);
const tmp = () => mkdtempSync(join(tmpdir(), "sb-hooks-budget-"));

function countingFetchStub(handler: (url: URL) => { status: number; body: unknown } | null) {
  const calls: string[] = [];
  return {
    calls,
    install: () => {
      const real = global.fetch;
      // @ts-expect-error test stub
      global.fetch = async (url: string) => {
        const u = new URL(String(url));
        calls.push(u.pathname);
        const hit = handler(u);
        if (!hit) throw new Error(`unreachable: ${u.pathname}`);
        return new Response(JSON.stringify(hit.body), { status: hit.status, headers: { "Content-Type": "application/json" } });
      };
      return () => { global.fetch = real; };
    },
  };
}

describe("session start: performRecall request count", () => {
  it("fires at most 2 recall attempts + 1 brief when the project arm succeeds", async () => {
    const stub = countingFetchStub((u) => {
      if (u.pathname === "/recall") return { status: 200, body: { ok: true, results: [{ content: "x" }] } };
      if (u.pathname === "/brief") return { status: 200, body: { ok: true } };
      return null;
    });
    const restore = stub.install();
    try {
      await core.performRecall({
        env: { SECOND_BRAIN_URL: "https://w.example", SECOND_BRAIN_TOKEN: "t" },
        cwd: "/some/project", sessionId: "s1",
      });
    } finally { restore(); }
    expect(stub.calls.filter(p => p === "/recall").length).toBeLessThanOrEqual(2);
    expect(stub.calls.filter(p => p === "/brief").length).toBe(1);
    expect(stub.calls.length).toBeLessThanOrEqual(3);
  });

  it("worst case (project arm 404s, falls back unscoped) is still bounded: 2 recall + 1 brief = 3", async () => {
    const stub = countingFetchStub((u) => {
      if (u.pathname === "/recall" && u.searchParams.get("project")) return { status: 404, body: { ok: false } };
      if (u.pathname === "/recall") return { status: 200, body: { ok: true, results: [] } };
      if (u.pathname === "/brief") return { status: 200, body: { ok: true } };
      return null;
    });
    const restore = stub.install();
    try {
      await core.performRecall({
        env: { SECOND_BRAIN_URL: "https://w.example", SECOND_BRAIN_TOKEN: "t" },
        cwd: "/some/project", sessionId: "s2",
      });
    } finally { restore(); }
    expect(stub.calls.length).toBe(3);
  });
});

describe("session end: performCapture request count", () => {
  it("costs exactly 1 POST /capture once the Worker's 24h health cache is warm", async () => {
    const dir = tmp();
    const stub = countingFetchStub((u) => {
      if (u.pathname === "/health") return { status: 200, body: { version: "4.0.0" } };
      if (u.pathname === "/capture") return { status: 200, body: { ok: true } };
      return null;
    });
    let restore = stub.install();
    try {
      // Warm the 24h health cache first (as a prior session in the same day would have).
      await core.workerMajorVersion({ baseUrl: "https://w.example", token: "t" }, Date.now(), dir);
    } finally { restore(); }
    stub.calls.length = 0;
    restore = stub.install();
    try {
      const result = await core.performCapture({
        env: { SECOND_BRAIN_URL: "https://w.example", SECOND_BRAIN_TOKEN: "t" }, userTurns: ["a".repeat(60), "b".repeat(60), "c".repeat(100)],
        meta: { hostLabel: "Codex", source: "codex-session", workspace: "personal" },
        namespace: "codex", sessionId: "s3", cacheDir: dir,
      });
      expect(result.sent).toBe(true);
    } finally { restore(); }
    expect(stub.calls).toEqual(["/capture"]);
  });

  it("costs 1 extra GET /health on a cold cache (first session-end of the day for this Worker origin)", async () => {
    const dir = tmp();
    const stub = countingFetchStub((u) => {
      if (u.pathname === "/health") return { status: 200, body: { version: "4.0.0" } };
      if (u.pathname === "/capture") return { status: 200, body: { ok: true } };
      return null;
    });
    const restore = stub.install();
    try {
      const result = await core.performCapture({
        env: { SECOND_BRAIN_URL: "https://w.example", SECOND_BRAIN_TOKEN: "t" }, userTurns: ["a".repeat(60), "b".repeat(60), "c".repeat(100)],
        meta: { hostLabel: "Codex", source: "codex-session", workspace: "personal" },
        namespace: "codex", sessionId: "s4", cacheDir: dir,
      });
      expect(result.sent).toBe(true);
    } finally { restore(); }
    expect(stub.calls.sort()).toEqual(["/capture", "/health"]);
  });

  it("still pays for the (cached) health check before the threshold gate, but never sends /capture below threshold", async () => {
    // performCapture checks workerMajorVersion (a GET /health, cached 24h)
    // BEFORE shouldCaptureSession (core.js: major-version check precedes the
    // threshold check) — so a too-short session still costs a health request
    // on a cold cache, but never a POST /capture.
    const dir = tmp();
    const stub = countingFetchStub(() => ({ status: 200, body: { version: "4.0.0" } }));
    const restore = stub.install();
    try {
      const result = await core.performCapture({
        env: { SECOND_BRAIN_URL: "https://w.example", SECOND_BRAIN_TOKEN: "t" }, userTurns: ["too short"],
        meta: { hostLabel: "Codex", source: "codex-session", workspace: "personal" },
        namespace: "codex", sessionId: "s5", cacheDir: dir,
      });
      expect(result.sent).toBe(false);
      expect(result.reason).toBe("below-threshold");
    } finally { restore(); }
    expect(stub.calls).toEqual(["/health"]);
    expect(stub.calls).not.toContain("/capture");
  });
});
