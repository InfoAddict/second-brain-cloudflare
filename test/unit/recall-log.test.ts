/**
 * T-0089.5.2 Part A (sampled recall log) and Part B (implicit feedback),
 * tested against real SQLite so the SQL itself is under test, not a mock's
 * string matching.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/config";
import { RECALL_LOG_FOLLOW_WINDOW_MS, RECALL_LOG_PER_DAY, RECALL_LOG_RETENTION_DAYS } from "../../src/constants";
import { maybeLogRecall, maybeMarkFollowed, maybeMarkFollowedMany } from "../../src/recall/log";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import type { Env } from "../../src/env";

const DAY_MS = 86400000;

describe("maybeLogRecall", () => {
  let sqlite: SqliteD1 | undefined;
  afterEach(() => sqlite?.close());

  function setup() {
    sqlite = makeSqliteD1();
    const kv = makeMemoryKV();
    const env: Env = makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: kv });
    return { env, sqlite, kv };
  }

  const input = (overrides: Partial<Parameters<typeof maybeLogRecall>[2]> = {}) => ({
    workspaceId: "ws1",
    channel: "mcp" as const,
    query: "atlas ledger",
    params: { topK: 5, hops: 0 },
    returnedIds: ["e1", "e2"],
    now: 1_000_000,
    ...overrides,
  });

  it("writes nothing when RECALL_LOG is off (the default everywhere, D5.2)", async () => {
    const { env, sqlite } = setup();
    await maybeLogRecall(env, DEFAULTS, input());
    const rows = (await sqlite.db.prepare(`SELECT * FROM recall_log`).all()).results;
    expect(rows).toHaveLength(0);
  });

  it("writes one row when RECALL_LOG is on", async () => {
    const { env, sqlite } = setup();
    const cfg = { ...DEFAULTS, RECALL_LOG: "on" as const };
    await maybeLogRecall(env, cfg, input());
    const rows = (await sqlite.db.prepare(`SELECT * FROM recall_log`).all()).results as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspace_id: "ws1",
      created_at: 1_000_000,
      channel: "mcp",
      query: "atlas ledger",
      followed_ids: "[]",
    });
    expect(JSON.parse(rows[0].returned_ids as string)).toEqual(["e1", "e2"]);
    expect(JSON.parse(rows[0].params as string)).toEqual({ topK: 5, hops: 0 });
  });

  it("stops logging once the per-workspace daily cap is reached", async () => {
    const { env, sqlite } = setup();
    const cfg = { ...DEFAULTS, RECALL_LOG: "on" as const };
    for (let i = 0; i < RECALL_LOG_PER_DAY + 5; i++) {
      await maybeLogRecall(env, cfg, input({ now: 1_000_000 + i }));
    }
    const rows = (await sqlite.db.prepare(`SELECT COUNT(*) AS n FROM recall_log`).first()) as { n: number };
    expect(rows.n).toBe(RECALL_LOG_PER_DAY);
  });

  it("a different workspace gets its own cap", async () => {
    const { env, sqlite } = setup();
    const cfg = { ...DEFAULTS, RECALL_LOG: "on" as const };
    for (let i = 0; i < RECALL_LOG_PER_DAY; i++) {
      await maybeLogRecall(env, cfg, input({ now: 1_000_000 + i }));
    }
    await maybeLogRecall(env, cfg, input({ workspaceId: "ws2", now: 1_000_000 }));
    const rows = (await sqlite.db.prepare(`SELECT COUNT(*) AS n FROM recall_log WHERE workspace_id = 'ws2'`).first()) as { n: number };
    expect(rows.n).toBe(1);
  });

  it("a new day resets the cap", async () => {
    const { env, sqlite } = setup();
    const cfg = { ...DEFAULTS, RECALL_LOG: "on" as const };
    for (let i = 0; i < RECALL_LOG_PER_DAY; i++) {
      await maybeLogRecall(env, cfg, input({ now: 1_000_000 + i }));
    }
    await maybeLogRecall(env, cfg, input({ now: 1_000_000 + DAY_MS }));
    const rows = (await sqlite.db.prepare(`SELECT COUNT(*) AS n FROM recall_log`).first()) as { n: number };
    expect(rows.n).toBe(RECALL_LOG_PER_DAY + 1);
  });

  it("purges rows older than the retention window on insert, oldest first", async () => {
    const { env, sqlite } = setup();
    const cfg = { ...DEFAULTS, RECALL_LOG: "on" as const };
    const old = 1_000_000;
    await maybeLogRecall(env, cfg, input({ now: old }));
    const justOverRetention = old + RECALL_LOG_RETENTION_DAYS * DAY_MS + 1;
    await maybeLogRecall(env, cfg, input({ now: justOverRetention }));
    const rows = (await sqlite.db.prepare(`SELECT created_at FROM recall_log ORDER BY created_at`).all()).results as { created_at: number }[];
    expect(rows.map(r => r.created_at)).toEqual([justOverRetention]);
  });

  it("keeps a row inside the retention window", async () => {
    const { env, sqlite } = setup();
    const cfg = { ...DEFAULTS, RECALL_LOG: "on" as const };
    const first = 1_000_000;
    await maybeLogRecall(env, cfg, input({ now: first }));
    const stillFresh = first + RECALL_LOG_RETENTION_DAYS * DAY_MS - 1;
    await maybeLogRecall(env, cfg, input({ now: stillFresh }));
    const rows = (await sqlite.db.prepare(`SELECT COUNT(*) AS n FROM recall_log`).first()) as { n: number };
    expect(rows.n).toBe(2);
  });

  it("pins the cost: a heavy day of RECALL_LOG_PER_DAY logged recalls costs 2 D1 rows written each", async () => {
    // Budget auditor pin (T-0089.5.2): at most RECALL_LOG_PER_DAY (200) rows/day get
    // logged, and each logged recall costs one insert plus at most one purge delete —
    // about 400 D1 rows written/day, 0.4% of the 100k/day free-plan write cap.
    const { env, sqlite } = setup();
    const cfg = { ...DEFAULTS, RECALL_LOG: "on" as const };
    for (let i = 0; i < RECALL_LOG_PER_DAY; i++) {
      await maybeLogRecall(env, cfg, input({ now: 1_000_000 + i }));
    }
    // Each logged recall's insert + purge ride in one D1 batch (one subrequest, two rows).
    const batches = sqlite.issued.filter(s => s === "BATCH");
    expect(batches).toHaveLength(RECALL_LOG_PER_DAY);
    expect(RECALL_LOG_PER_DAY * 2).toBeLessThanOrEqual(400);
  });
});

describe("maybeMarkFollowed", () => {
  let sqlite: SqliteD1 | undefined;
  afterEach(() => sqlite?.close());

  function setup() {
    sqlite = makeSqliteD1();
    const kv = makeMemoryKV();
    const env: Env = makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: kv });
    return { env, sqlite, kv };
  }

  async function seedLog(sqlite: SqliteD1, row: { workspaceId: string; createdAt: number; returnedIds: string[]; followedIds?: string[] }) {
    await sqlite.db.prepare(
      `INSERT INTO recall_log (id, workspace_id, created_at, channel, query, params, returned_ids, followed_ids) VALUES (?, ?, ?, 'mcp', 'q', '{}', ?, ?)`
    ).bind("log1", row.workspaceId, row.createdAt, JSON.stringify(row.returnedIds), JSON.stringify(row.followedIds ?? [])).run();
  }

  const cfgOn = { ...DEFAULTS, RECALL_LOG: "on" as const };

  it("does nothing when RECALL_LOG is off", async () => {
    const { env, sqlite } = setup();
    await seedLog(sqlite, { workspaceId: "ws1", createdAt: 1_000_000, returnedIds: ["e1"] });
    await maybeMarkFollowed(env, DEFAULTS, "ws1", "e1", 1_000_000 + 1000);
    const row = (await sqlite.db.prepare(`SELECT followed_ids FROM recall_log WHERE id = 'log1'`).first()) as { followed_ids: string };
    expect(row.followed_ids).toBe("[]");
  });

  it("marks an id as followed when it was returned within the window", async () => {
    const { env, sqlite } = setup();
    await seedLog(sqlite, { workspaceId: "ws1", createdAt: 1_000_000, returnedIds: ["e1", "e2"] });
    await maybeMarkFollowed(env, cfgOn, "ws1", "e1", 1_000_000 + 1000);
    const row = (await sqlite.db.prepare(`SELECT followed_ids FROM recall_log WHERE id = 'log1'`).first()) as { followed_ids: string };
    expect(JSON.parse(row.followed_ids)).toEqual(["e1"]);
  });

  it("does not mark an id that was never returned", async () => {
    const { env, sqlite } = setup();
    await seedLog(sqlite, { workspaceId: "ws1", createdAt: 1_000_000, returnedIds: ["e1"] });
    await maybeMarkFollowed(env, cfgOn, "ws1", "e99", 1_000_000 + 1000);
    const row = (await sqlite.db.prepare(`SELECT followed_ids FROM recall_log WHERE id = 'log1'`).first()) as { followed_ids: string };
    expect(row.followed_ids).toBe("[]");
  });

  it("does not mark an id outside the 30-minute window", async () => {
    const { env, sqlite } = setup();
    await seedLog(sqlite, { workspaceId: "ws1", createdAt: 1_000_000, returnedIds: ["e1"] });
    await maybeMarkFollowed(env, cfgOn, "ws1", "e1", 1_000_000 + RECALL_LOG_FOLLOW_WINDOW_MS + 1);
    const row = (await sqlite.db.prepare(`SELECT followed_ids FROM recall_log WHERE id = 'log1'`).first()) as { followed_ids: string };
    expect(row.followed_ids).toBe("[]");
  });

  it("does not mark an id from a different workspace's recall", async () => {
    const { env, sqlite } = setup();
    await seedLog(sqlite, { workspaceId: "ws1", createdAt: 1_000_000, returnedIds: ["e1"] });
    await maybeMarkFollowed(env, cfgOn, "ws2", "e1", 1_000_000 + 1000);
    const row = (await sqlite.db.prepare(`SELECT followed_ids FROM recall_log WHERE id = 'log1'`).first()) as { followed_ids: string };
    expect(row.followed_ids).toBe("[]");
  });

  it("is idempotent: following the same id twice does not duplicate it", async () => {
    const { env, sqlite } = setup();
    await seedLog(sqlite, { workspaceId: "ws1", createdAt: 1_000_000, returnedIds: ["e1"], followedIds: ["e1"] });
    await maybeMarkFollowed(env, cfgOn, "ws1", "e1", 1_000_000 + 1000);
    const row = (await sqlite.db.prepare(`SELECT followed_ids FROM recall_log WHERE id = 'log1'`).first()) as { followed_ids: string };
    expect(JSON.parse(row.followed_ids)).toEqual(["e1"]);
  });

  it("uses the latest recall_log row for the workspace, not an older one", async () => {
    const { env, sqlite } = setup();
    await sqlite.db.prepare(
      `INSERT INTO recall_log (id, workspace_id, created_at, channel, query, params, returned_ids, followed_ids) VALUES ('log0', 'ws1', ?, 'mcp', 'q', '{}', '["e1"]', '[]')`
    ).bind(900_000).run();
    await seedLog(sqlite, { workspaceId: "ws1", createdAt: 1_000_000, returnedIds: ["e2"] });
    await maybeMarkFollowed(env, cfgOn, "ws1", "e1", 1_000_000 + 1000);
    const rows = (await sqlite.db.prepare(`SELECT id, followed_ids FROM recall_log ORDER BY id`).all()).results as { id: string; followed_ids: string }[];
    // e1 was only in the OLDER row's returned_ids; the latest row is the only one checked.
    expect(rows.find(r => r.id === "log0")!.followed_ids).toBe("[]");
    expect(rows.find(r => r.id === "log1")!.followed_ids).toBe("[]");
  });

  it("costs one indexed read and, only on a match, one row written", async () => {
    const { env, sqlite } = setup();
    await seedLog(sqlite, { workspaceId: "ws1", createdAt: 1_000_000, returnedIds: ["e1"] });
    sqlite.issued.length = 0;
    await maybeMarkFollowed(env, cfgOn, "ws1", "e1", 1_000_000 + 1000);
    expect(sqlite.issued.filter(s => s.includes("SELECT"))).toHaveLength(1);
    expect(sqlite.issued.filter(s => s.includes("UPDATE recall_log"))).toHaveLength(1);
  });

  it("costs zero writes when there is no match", async () => {
    const { env, sqlite } = setup();
    await seedLog(sqlite, { workspaceId: "ws1", createdAt: 1_000_000, returnedIds: ["e1"] });
    sqlite.issued.length = 0;
    await maybeMarkFollowed(env, cfgOn, "ws1", "e99", 1_000_000 + 1000);
    expect(sqlite.issued.filter(s => s.includes("UPDATE recall_log"))).toHaveLength(0);
  });
});

describe("maybeMarkFollowedMany", () => {
  let sqlite: SqliteD1 | undefined;
  afterEach(() => sqlite?.close());

  function setup() {
    sqlite = makeSqliteD1();
    const kv = makeMemoryKV();
    const env: Env = makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: kv });
    return { env, sqlite, kv };
  }

  const cfgOn = { ...DEFAULTS, RECALL_LOG: "on" as const };

  it("marks two ids from the same call in one read and one write (no lost update)", async () => {
    const { env, sqlite } = setup();
    await sqlite.db.prepare(
      `INSERT INTO recall_log (id, workspace_id, created_at, channel, query, params, returned_ids, followed_ids) VALUES ('log1', 'ws1', ?, 'mcp', 'q', '{}', ?, '[]')`,
    ).bind(1_000_000, JSON.stringify(["a", "b"])).run();
    sqlite.issued.length = 0;
    await maybeMarkFollowedMany(env, cfgOn, "ws1", ["a", "b"], 1_000_000 + 1000);
    expect(sqlite.issued.filter(s => s.includes("SELECT"))).toHaveLength(1);
    expect(sqlite.issued.filter(s => s.includes("UPDATE recall_log"))).toHaveLength(1);
    const row = (await sqlite.db.prepare(`SELECT followed_ids FROM recall_log WHERE id = 'log1'`).first()) as { followed_ids: string };
    expect(JSON.parse(row.followed_ids)).toEqual(["a", "b"]);
  });

  it("marks only the id that was actually returned", async () => {
    const { env, sqlite } = setup();
    await sqlite.db.prepare(
      `INSERT INTO recall_log (id, workspace_id, created_at, channel, query, params, returned_ids, followed_ids) VALUES ('log1', 'ws1', ?, 'mcp', 'q', '{}', '["a"]', '[]')`,
    ).bind(1_000_000).run();
    await maybeMarkFollowedMany(env, cfgOn, "ws1", ["a", "b"], 1_000_000 + 1000);
    const row = (await sqlite.db.prepare(`SELECT followed_ids FROM recall_log WHERE id = 'log1'`).first()) as { followed_ids: string };
    expect(JSON.parse(row.followed_ids)).toEqual(["a"]);
  });
});
