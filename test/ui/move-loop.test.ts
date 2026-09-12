/**
 * #347's pure drain loop for the "move already-synced memories" action,
 * following restore-loop.test.ts's pattern — the only existing multi-call
 * drain test in test/ui/ (see docs/superpowers/plans/2026-09-12-347-ui-contract.md
 * §7.1, which names this file's absence explicitly and gives this exact
 * skeleton as the thing to write).
 *
 * Contract this test pins for the implementer (not specified by the plan, so
 * fixed here — see the test-author's final report for the full list):
 *   - a function `runMoveLoop(provider, post, onProgress)` is a module-level
 *     global in public/js/integrations.js, extracted the same way
 *     `runImportLoop` is extracted in public/js/settings.js;
 *   - `post` is `(cursor) => Promise<{ moved, alreadyThere, missing, refused, remaining, cursor }>`,
 *     called with `undefined` on the first call and the previous response's
 *     `cursor` afterwards, until `cursor` is falsy;
 *   - `onProgress({ done, total })` fires after every page, `done` being the
 *     cumulative moved+alreadyThere+missing+refused so far;
 *   - `runMoveLoop` resolves `{ moved, alreadyThere, missing, refused }` totals
 *     on a full drain;
 *   - on a page rejecting, `runMoveLoop` rejects too (propagates, following
 *     runImportLoop's own precedent), but the rejection's Error carries a
 *     `.partial` property with the totals accumulated before the failure, so
 *     the caller can report "N moved so far, stopped, safe to resume" instead
 *     of losing that count the way syncIntegration's plain throw does today;
 *   - a batch making zero progress while remaining stays positive is treated
 *     as a stall and rejects with a message matching /stalled|did not advance/i,
 *     the same "fail loudly, don't spin" contract runImportLoop already has.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { installI18n } from "./_i18n-harness";

const ROOT = resolve(import.meta.dirname, "../..");

function loadRunMoveLoop(): (provider: string, post: any, onProgress?: any) => Promise<any> {
  const src = readFileSync(resolve(ROOT, "public/js/integrations.js"), "utf8");
  const ctx: any = { window: {}, document: {}, fetch: () => {}, console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  vm.runInContext(src, ctx);
  return ctx.runMoveLoop;
}

/** A Worker-side double: pages by an opaque cursor, exactly like the real move route. */
function fakeWorker(total: number, limit: number) {
  const calls: (string | undefined)[] = [];
  const post = async (cursor?: string) => {
    calls.push(cursor);
    const start = cursor ? Number(cursor) : 0;
    const page = Math.max(0, Math.min(limit, total - start));
    const next = start + page;
    return {
      moved: page, alreadyThere: 0, missing: 0, refused: 0,
      remaining: total - next,
      cursor: next < total ? String(next) : null,
    };
  };
  return { post, calls };
}

describe("#347 runMoveLoop", () => {
  it("is exported as a real function on public/js/integrations.js's module scope", () => {
    const runMoveLoop = loadRunMoveLoop();
    expect(typeof runMoveLoop).toBe("function");
  });

  it("drains to completion across batches and accumulates totals", async () => {
    const runMoveLoop = loadRunMoveLoop();
    const { post, calls } = fakeWorker(150, 40);

    const totals = await runMoveLoop("notion", post);

    expect(totals.moved).toBe(150);
    expect(totals.alreadyThere).toBe(0);
    expect(totals.missing).toBe(0);
    expect(totals.refused).toBe(0);
    // 4 pages: 40+40+40+30, called with undefined then the running cursor.
    expect(calls).toEqual([undefined, "40", "80", "120"]);
  });

  it("reports progress after every page", async () => {
    const runMoveLoop = loadRunMoveLoop();
    const { post } = fakeWorker(80, 40);
    const seen: number[] = [];

    await runMoveLoop("notion", post, ({ done }: any) => seen.push(done));

    expect(seen).toEqual([40, 80]);
  });

  it("stops and carries partial progress on a mid-drain failure, instead of losing it", async () => {
    const runMoveLoop = loadRunMoveLoop();
    let n = 0;
    const { post } = fakeWorker(150, 40);
    const flaky = async (cursor?: string) => {
      if (++n === 2) throw new Error("Server error: 500");
      return post(cursor);
    };

    let caught: any;
    try {
      await runMoveLoop("notion", flaky);
    } catch (e) {
      caught = e;
    }
    expect(caught, "expected runMoveLoop to reject on a mid-drain failure").toBeDefined();
    expect(caught.message).toMatch(/500/);
    // The first page (40 moved) must not be thrown away just because the
    // second page failed — this is what lets the caller say "stopped after
    // 40, safe to resume" instead of "failed" with no count.
    expect(caught.partial).toBeDefined();
    expect(caught.partial.moved).toBe(40);
  });

  it("fails loudly rather than looping forever against a cursor that never advances", async () => {
    const runMoveLoop = loadRunMoveLoop();
    const post = async () => ({ moved: 0, alreadyThere: 0, missing: 0, refused: 0, remaining: 60, cursor: "0" });

    await expect(runMoveLoop("notion", post)).rejects.toThrow(/stalled|did not advance/i);
  });

  it("keeps draining a batch that is entirely refusals, as long as the cursor keeps advancing", async () => {
    const runMoveLoop = loadRunMoveLoop();
    // Every item in this batch is refused (author lock, or scope loss), but
    // the cursor still moves — real forward progress through the item map,
    // just not forward progress on MOVING anything. Must not be confused with
    // the never-advancing stall above, and must not be reported as if 40
    // items moved.
    const post = async (cursor?: string) => {
      const next = cursor ? Number(cursor) + 10 : 10;
      return { moved: 0, alreadyThere: 0, missing: 0, refused: 10, remaining: 40 - next, cursor: next < 40 ? String(next) : null };
    };

    const totals = await runMoveLoop("notion", post);
    expect(totals.moved).toBe(0);
    expect(totals.refused).toBe(40);
  });
});
