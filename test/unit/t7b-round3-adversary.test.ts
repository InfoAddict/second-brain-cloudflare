import { afterEach, expect, it, vi } from "vitest";
import { pushDueItems, pushDueItemsAllWorkspaces } from "../../src/push/send";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import type { Env } from "../../src/env";
import type { Config } from "../../src/config";

vi.mock("../../src/push/crypto", () => ({ encryptWebPush: vi.fn(async () => ({ body: new Uint8Array([1]) })) }));
vi.mock("../../src/push/vapid", async (orig) => ({
  ...(await orig<typeof import("../../src/push/vapid")>()),
  vapidAuthHeader: vi.fn(async () => "test"),
}));

const cfg = { TIMEZONE: "UTC" } as Config;
const DAY = 86_400_000;
let sq: SqliteD1 | null = null;
afterEach(() => { sq?.close(); sq = null; resetDatabaseInit(); vi.restoreAllMocks(); });

function dbOf(s: SqliteD1) {
  return { prepare: (sql: string) => s.db.prepare(sql), exec: (sql: string) => s.db.exec(sql), batch: (stmts: any[]) => s.db.batch(stmts) };
}
async function setup() {
  sq = makeSqliteD1();
  resetDatabaseInit();
  await initializeDatabase({ DB: dbOf(sq) } as unknown as Env);
  sq.db.prepare(`INSERT INTO push_subscriptions
    (id, workspace_id, endpoint_hash, subscription_json, content_free, created_at, fail_count)
    VALUES (?, '', ?, ?, 0, ?, 0)`).bind(
      "sub", "sub", JSON.stringify({ endpoint: "https://push.example/sub", keys: { p256dh: "AA", auth: "AA" } }), Date.now(),
    ).run();
  return makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
}
function due(id: string, whenAt: number) {
  sq!.seed({ id, content: id, createdAt: 1, tags: ["task"] });
  sq!.db.prepare("UPDATE entries SET workspace_id = '', when_at = ?, when_kind = 'due', when_source = 'explicit' WHERE id = ?")
    .bind(whenAt, id).run();
}

it("reaches a new due item behind 15 already delivered old items", async () => {
  const env = await setup();
  const delivered: Record<string, { w: number; s: string[] }> = {};
  const old = Date.now() - 40 * DAY;
  for (let i = 0; i < 15; i++) {
    const id = `old-${String(i).padStart(2, "0")}`;
    due(id, old + i);
    delivered[id] = { w: old + i, s: ["sub"] };
  }
  due("new", Date.now() - 60_000);
  await env.OAUTH_KV.put("pushed:", JSON.stringify(delivered));
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));

  for (let run = 0; run < 3; run++) await pushDueItems(env, "", cfg);

  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

it("does not deliver the same item twice when cron invocations overlap", async () => {
  const env = await setup();
  due("due", Date.now() - 60_000);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    await gate;
    return new Response(null, { status: 201 });
  });

  const first = pushDueItemsAllWorkspaces(env, cfg);
  const second = pushDueItemsAllWorkspaces(env, cfg);
  try {
    for (let i = 0; i < 100 && fetchSpy.mock.calls.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 0));
  } finally {
    release();
  }
  await Promise.all([first, second]);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

// The 1,000-writes team case is an accepted team outgrow point (director ruling, round 3); test/unit/push-run-budget.test.ts pins its two requirements instead.
