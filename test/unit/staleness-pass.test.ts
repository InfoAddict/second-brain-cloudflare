import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "../../src/index";
import { runStalenessPass, STALENESS_AGE_MS, STALENESS_PASS_LIMIT } from "../../src/staleness/pass";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";

describe("runStalenessPass", () => {
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
  });

  it("flags state entries older than threshold with stale:as-of", async () => {
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    db.entries.push({
      id: "job",
      content: "Alice works at Acme Corp",
      tags: "[]",
      source: "api",
      created_at: old,
      updated_at: old,
      vector_ids: "[]",
    });
    const env = makeTestEnv(db);

    await runStalenessPass(env, {} as ExecutionContext);

    const row = db.entries.find(e => e.id === "job")!;
    const tags: string[] = JSON.parse(row.tags);
    expect(tags).toContain("volatility:state");
    expect(tags).toContain("stale:as-of");
  });

  it("does not flag durable entries", async () => {
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    db.entries.push({
      id: "bday",
      content: "Birthday is March 12",
      tags: "[]",
      source: "api",
      created_at: old,
      updated_at: old,
      vector_ids: "[]",
    });
    const env = makeTestEnv(db);

    await runStalenessPass(env, {} as ExecutionContext);

    const tags: string[] = JSON.parse(db.entries.find(e => e.id === "bday")!.tags);
    expect(tags).toContain("volatility:durable");
    expect(tags).not.toContain("stale:as-of");
  });

  it("skips entries newer than STALENESS_AGE_MS", async () => {
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    const recent = Date.now() - 7 * 86400000;
    db.entries.push(
      {
        id: "old-job",
        content: "Alice works at Acme Corp",
        tags: "[]",
        source: "api",
        created_at: old,
        updated_at: old,
        vector_ids: "[]",
      },
      {
        id: "recent-job",
        content: "Bob works at Beta Inc",
        tags: "[]",
        source: "api",
        created_at: recent,
        updated_at: recent,
        vector_ids: "[]",
      },
    );
    const env = makeTestEnv(db);

    await runStalenessPass(env, {} as ExecutionContext);

    const oldTags: string[] = JSON.parse(db.entries.find(e => e.id === "old-job")!.tags);
    const recentTags: string[] = JSON.parse(db.entries.find(e => e.id === "recent-job")!.tags);
    expect(oldTags).toContain("stale:as-of");
    expect(recentTags).not.toContain("stale:as-of");
    expect(recentTags).not.toContain("volatility:state");
  });

  it(`processes at most STALENESS_PASS_LIMIT (${STALENESS_PASS_LIMIT}) entries per run`, async () => {
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    for (let i = 0; i < 30; i++) {
      db.entries.push({
        id: `job-${i}`,
        content: `Person ${i} works at Company ${i}`,
        tags: "[]",
        source: "api",
        created_at: old + i,
        updated_at: old + i,
        vector_ids: "[]",
      });
    }
    const env = makeTestEnv(db);

    await runStalenessPass(env, {} as ExecutionContext);

    const flagged = db.entries.filter(e => {
      const tags: string[] = JSON.parse(e.tags);
      return tags.includes("stale:as-of");
    });
    expect(flagged).toHaveLength(STALENESS_PASS_LIMIT);
    const unprocessed = db.entries.filter(e => {
      const tags: string[] = JSON.parse(e.tags);
      return !tags.includes("stale:as-of");
    });
    expect(unprocessed).toHaveLength(30 - STALENESS_PASS_LIMIT);
  });

  it("clears stale:as-of when reclassified as durable", async () => {
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    db.entries.push({
      id: "bday-stale",
      content: "Birthday is March 12",
      tags: '["stale:as-of"]',
      source: "api",
      created_at: old,
      updated_at: old,
      vector_ids: "[]",
    });
    const env = makeTestEnv(db);

    await runStalenessPass(env, {} as ExecutionContext);

    const tags: string[] = JSON.parse(db.entries.find(e => e.id === "bday-stale")!.tags);
    expect(tags).toContain("volatility:durable");
    expect(tags).not.toContain("stale:as-of");
  });

  it("does not overwrite existing volatility tag", async () => {
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    db.entries.push({
      id: "user-vol",
      content: "Birthday is March 12",
      tags: '["volatility:volatile"]',
      source: "api",
      created_at: old,
      updated_at: old,
      vector_ids: "[]",
    });
    const env = makeTestEnv(db);

    await runStalenessPass(env, {} as ExecutionContext);

    const tags: string[] = JSON.parse(db.entries.find(e => e.id === "user-vol")!.tags);
    expect(tags).toContain("volatility:volatile");
    expect(tags).not.toContain("volatility:durable");
  });

  it("advances staleness_checked_at even when classification is null", async () => {
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    db.entries.push({
      id: "uncertain",
      content: "Some random note without clear signals",
      tags: "[]",
      source: "api",
      created_at: old,
      updated_at: old,
      vector_ids: "[]",
    });
    const env = makeTestEnv(db);

    await runStalenessPass(env, {} as ExecutionContext);

    const row = db.entries.find(e => e.id === "uncertain")!;
    expect(row.staleness_checked_at).toBeGreaterThan(0);
    const tags: string[] = JSON.parse(row.tags);
    expect(tags).not.toContain("volatility:state");
    expect(tags).not.toContain("stale:as-of");
  });

  it("convergence: two passes inspect more than 25 entries total", async () => {
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    for (let i = 0; i < 30; i++) {
      db.entries.push({
        id: `job-${i}`,
        content: `Person ${i} works at Company ${i}`,
        tags: "[]",
        source: "api",
        created_at: old + i,
        updated_at: old + i,
        vector_ids: "[]",
      });
    }
    const env = makeTestEnv(db);

    await runStalenessPass(env, {} as ExecutionContext);
    const afterFirst = db.entries.filter(e => e.staleness_checked_at != null).length;
    expect(afterFirst).toBe(STALENESS_PASS_LIMIT);

    await runStalenessPass(env, {} as ExecutionContext);
    const afterSecond = db.entries.filter(e => e.staleness_checked_at != null).length;
    expect(afterSecond).toBeGreaterThan(25);
  });

  it("flags volatile (task) entries with stale:as-of", async () => {
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    db.entries.push({
      id: "task-entry",
      content: "Finish the quarterly report",
      tags: '["task"]',
      source: "api",
      created_at: old,
      updated_at: old,
      vector_ids: "[]",
    });
    const env = makeTestEnv(db);

    await runStalenessPass(env, {} as ExecutionContext);

    const tags: string[] = JSON.parse(db.entries.find(e => e.id === "task-entry")!.tags);
    expect(tags).toContain("volatility:volatile");
    expect(tags).toContain("stale:as-of");
  });
});

describe("scheduled handler staleness wiring", () => {
  it("runs staleness pass alongside other nightly jobs", async () => {
    const db = makeTestDb();
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    db.entries.push({
      id: "job",
      content: "Bob works at Example Inc",
      tags: "[]",
      source: "api",
      created_at: old,
      updated_at: old,
      vector_ids: "[]",
    });
    const env = makeTestEnv(db, { VECTORIZE: { query: vi.fn(), getByIds: vi.fn(), upsert: vi.fn(), insert: vi.fn(), deleteByIds: vi.fn() } as any });
    const pending: Promise<any>[] = [];
    const ctx = { waitUntil: (p: Promise<any>) => pending.push(p) } as any;

    await (worker as any).scheduled({} as any, env, ctx);
    await Promise.allSettled(pending);

    const tags: string[] = JSON.parse(db.entries.find(e => e.id === "job")!.tags);
    expect(tags).toContain("stale:as-of");
  });
});
