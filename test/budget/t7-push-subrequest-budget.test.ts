/**
 * Update (auditor, 2026-09-27): 4dd6c70d on v4/t7-b added MAX_PUSH_FETCHES_PER_RUN = 40, so the single-workspace
 * cases below now pass on 851fd48f. The cap is per pushDueItems call, though, and the hourly cron's
 * pushDueItemsAllWorkspaces calls it once per subscribed workspace inside ONE invocation, so a team brain can
 * still exceed 50 external fetches; the last test reproduces that and fails on 851fd48f.
 *
 * Original note, budget guard for v4/t7-b (8e98d523): src/push/send.ts against the Workers
 * free-plan cap of 50 external fetch subrequests PER INVOCATION.
 *
 * pushDueItems sends one external fetch per (due candidate x subscription)
 * pair (send.ts:297-303), capped only on candidates
 * (MAX_NOTIFICATIONS_PER_RUN = 3, send.ts:22) — there is no cap on
 * subscriptions, and no aggregate fetch-budget check across the whole
 * pushDueItemsAllWorkspaces run that the hourly cron ("30 * * * *" on
 * integration sync; push shares that cron) drives. The existing
 * test/integration/push-send.test.ts even documents this in a comment
 * ("Capped per-run at 3 candidates x 4 subs = 12 sends, results capped at
 * 10") — only the *reported results* are capped at 10, not the actual sends.
 *
 * 3 candidates x 17 subscriptions on ONE workspace = 51 fetches, one more
 * than the 50/invocation cap. This test FAILS on the lane tip on purpose, to
 * pin that exact reproduction. The following test pins the safe boundary
 * (16 subscriptions = 48 fetches) so the two together bracket the exact
 * point of breach.
 *
 * Consequence if this ever fires for real: fetch calls past the subrequest
 * limit throw, so sendOne's try/catch (send.ts:214) records those as
 * "failed", bumping fail_count — a subscription can be deleted after 5 such
 * runs (MAX_FAIL_COUNT, send.ts:24) even though it was never actually
 * unreachable, only starved by its own workspace's other subscriptions.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { pushDueItems, pushDueItemsAllWorkspaces } from "../../src/push/send";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import type { Env } from "../../src/env";

const DAY = 24 * 60 * 60 * 1000;
const EXTERNAL_FETCH_SUBREQUEST_CAP = 50;
const MAX_NOTIFICATIONS_PER_RUN = 3;

let sq: SqliteD1 | null = null;
afterEach(() => { sq?.close(); sq = null; resetDatabaseInit(); vi.restoreAllMocks(); });

function dbOf(s: SqliteD1) {
  return { prepare: (sql: string) => s.db.prepare(sql), exec: (sql: string) => s.db.exec(sql), batch: (stmts: any[]) => s.db.batch(stmts) };
}

async function migrated(): Promise<SqliteD1> {
  const s = makeSqliteD1();
  resetDatabaseInit();
  await initializeDatabase({ DB: dbOf(s) } as unknown as Env);
  return s;
}

function seedDue(s: SqliteD1, id: string, whenAt: number) {
  s.seed({ id, content: `Item ${id}`, createdAt: 1000, tags: [] });
  s.db.prepare(`UPDATE entries SET when_at = ?, when_kind = 'due', when_source = 'model', when_label = ? WHERE id = ?`)
    .bind(whenAt, `Item ${id}`, id).run();
}

const VALID_P256DH = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const VALID_AUTH = "BTBZMqHH6r4Tts7J_aSIgg";

function seedSubscriptions(s: SqliteD1, count: number, workspaceId = "") {
  for (let n = 0; n < count; n++) {
    const i = workspaceId ? `${workspaceId}-${n}` : n;
    s.db.prepare(
      `INSERT INTO push_subscriptions (id, workspace_id, endpoint_hash, subscription_json, content_free, created_at, fail_count)
       VALUES (?, ?, ?, ?, 0, ?, 0)`,
    ).bind(
      `sub-${i}`, workspaceId, `hash-${i}`,
      JSON.stringify({ endpoint: `https://push.example.com/${i}`, keys: { p256dh: VALID_P256DH, auth: VALID_AUTH } }),
      Date.now(),
    ).run();
  }
}

async function seedThreeDueCandidates(s: SqliteD1) {
  for (let i = 0; i < 3; i++) seedDue(s, `e${i}`, Date.now() - (i + 1) * 1000);
}

describe("pushDueItems — external fetch subrequests per invocation", () => {
  it("3 due candidates x 17 subscriptions on one workspace exceeds the 50-fetch cap", async () => {
    sq = await migrated();
    await seedThreeDueCandidates(sq);
    seedSubscriptions(sq, 17);
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));

    await pushDueItems(env, "");

    // 3 candidates x 17 subs = 51 external fetches in this one call — already
    // over budget before any other workspace in the same cron run is counted.
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(EXTERNAL_FETCH_SUBREQUEST_CAP);
  });

  it("pins the safe boundary: 3 candidates x 16 subscriptions stays at or under 48, leaving room for the calendar feed fetch in the same hourly invocation", async () => {
    sq = await migrated();
    await seedThreeDueCandidates(sq);
    seedSubscriptions(sq, 16);
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));

    await pushDueItems(env, "");

    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(MAX_NOTIFICATIONS_PER_RUN * 16);
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(EXTERNAL_FETCH_SUBREQUEST_CAP);
  });

  it("the hourly all-workspaces run stays within 50 external fetches for a 9-member team (3 due x 2 devices each)", async () => {
    sq = await migrated();
    for (const ws of Array.from({ length: 9 }, (_, m) => `ws-${m}`)) {
      for (let i = 0; i < 3; i++) {
        seedDue(sq, `${ws}-e${i}`, Date.now() - (i + 1) * 1000);
        sq.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(ws, `${ws}-e${i}`).run();
      }
      seedSubscriptions(sq, 2, ws);
    }
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));

    await pushDueItemsAllWorkspaces(env);

    // 9 personal workspaces x 3 candidates x 2 devices = 54 sends in one cron invocation. Past 50 the runtime throws,
    // sendOne records "failed", and MAX_FAIL_COUNT deletes live subscriptions after 5 runs: silent breakage on Free.
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(EXTERNAL_FETCH_SUBREQUEST_CAP - 2);
  });
});
