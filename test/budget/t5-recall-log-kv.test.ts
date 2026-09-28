/**
 * Budget auditor (brief 19), Track 5 recall log (v4/t5-log 2ab65c46). With RECALL_LOG on, maybeLogRecall
 * enforces its 200-a-day cap with a KV counter written on every logged recall (src/recall/log.ts:48-53), keyed
 * per member's personal workspace. Workers Free allows 1,000 KV writes a day for the whole account
 * (https://developers.cloudflare.com/workers/platform/pricing/#workers-kv): one heavy solo user spends 20% of it
 * on the counter, and five members spend all of it, after which every KV write fails for the day (OAuth
 * grants, push lease, standing cache, tag vocabulary). The cap can be kept in D1, which the log already writes.
 * Requires src/recall/log.ts; skipped where it does not exist.
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULTS } from "../../src/config";
import { makeMemoryKV } from "../helpers/make-env";

const HAS_LOG = existsSync(resolve(__dirname, "../../src/recall/log.ts"));

describe.runIf(HAS_LOG)("recall log KV cost with RECALL_LOG on", () => {
  it("a 5-member team logging a busy day stays well inside 1,000 KV writes", async () => {
    const { maybeLogRecall } = await import("../../src/recall/log");
    const kv = makeMemoryKV() as any;
    let puts = 0;
    const OAUTH_KV = new Proxy(kv, { get(t, p) {
      const v = t[p];
      if (p === "put") return (...a: unknown[]) => { puts++; return v.apply(t, a); };
      return typeof v === "function" ? v.bind(t) : v;
    } });
    const stmt: any = { bind: () => stmt, run: async () => ({ meta: {} }), all: async () => ({ results: [] }), first: async () => null };
    const env = { OAUTH_KV, DB: { prepare: () => stmt, batch: async (s: unknown[]) => s.map(() => ({ meta: {} })) } } as any;
    const cfg = { ...DEFAULTS, RECALL_LOG: "on" } as any;
    const now = Date.UTC(2026, 8, 28, 12);
    for (let m = 0; m < 5; m++) {
      for (let r = 0; r < 250; r++) {
        await maybeLogRecall(env, cfg, { workspaceId: `member-${m}`, channel: "mcp", query: `q ${r}`, params: {} as any, returnedIds: ["a"], now: now + r * 1000 } as any);
      }
    }
    expect(puts, "KV writes spent on the recall-log counter in one day").toBeLessThanOrEqual(100);
  });
});
