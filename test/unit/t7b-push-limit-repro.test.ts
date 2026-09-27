import { afterEach, describe, expect, it, vi } from "vitest";
import { pushDueItems } from "../../src/push/send";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import type { Config } from "../../src/config";

vi.mock("../../src/push/crypto", () => ({
  encryptWebPush: vi.fn(async () => ({ body: new Uint8Array([1]) })),
}));
vi.mock("../../src/push/vapid", () => ({
  vapidAuthHeader: vi.fn(async () => "test"),
}));

afterEach(() => vi.restoreAllMocks());

async function runWithSubscriptions(subscriptionCount: number, dueCount: number) {
  const due = Array.from({ length: dueCount }, (_, i) => ({
    id: `due-${i}`, content: "Due item", when_at: Date.now() - 60_000,
    when_label: "Due item", tags: '["task"]',
  }));
  const subs = Array.from({ length: subscriptionCount }, (_, i) => ({
    id: `sub-${i}`, endpoint_hash: `hash-${i}`, content_free: 0, fail_count: 0,
    subscription_json: JSON.stringify({
      endpoint: `https://push.example/${i}`, keys: { p256dh: "AA", auth: "AA" },
    }),
  }));
  const bindCounts: number[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          bindCounts.push(args.length);
          return { all: async () => ({ results: sql.includes("FROM entries") ? due : subs }) };
        },
      };
    },
    batch: async () => [],
  };
  const env = makeTestEnv(db as any, { OAUTH_KV: makeMemoryKV() });
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));
  await pushDueItems(env, "personal", { TIMEZONE: "UTC" } as Config);
  return { bindCounts, fetchCalls: fetchSpy.mock.calls.length };
}

describe("Track 7 lane B push free-plan limits", () => {
  it("keeps outcome update binds within 100 for 101 personal subscriptions", async () => {
    const result = await runWithSubscriptions(101, 1);
    expect(Math.max(...result.bindCounts)).toBeLessThanOrEqual(100);
  });

  it("keeps a three-due-item run within 1000 subrequests for 334 subscriptions", async () => {
    const result = await runWithSubscriptions(334, 3);
    expect(result.fetchCalls).toBeLessThanOrEqual(1000);
  });
});
