/**
 * The open-loops queue: entries tagged "task" that have not been marked done,
 * with agent build-log tags excluded so a member's real commitments are not
 * drowned by their own tools' notes to themselves. Mirrors GET /stale +
 * POST /stale/keep (src/routes/admin.ts), sharing OPEN_LOOP_SQL between the
 * queue, its count, and the count folded into GET /brief so they cannot drift
 * apart (src/memory/loops.ts).
 */
import { describe, it, expect, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { setDbReady } from "../../src/runtime/state";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as any;

let sq: SqliteD1 | null = null;
afterEach(() => { sq?.close(); sq = null; setDbReady(false); });

function dbOf(s: SqliteD1) {
  return {
    prepare: (sql: string) => s.db.prepare(sql),
    exec: (sql: string) => s.db.exec(sql),
    async batch(stmts: { run(): Promise<any> }[]) {
      const out: any[] = [];
      for (const st of stmts) out.push(await st.run());
      s.issued.splice(s.issued.length - stmts.length, stmts.length, `BATCH(${stmts.length})`);
      return out.map((r: any) => ({ ...r, meta: { changes: 1, ...r?.meta } }));
    },
  };
}

async function migrated(): Promise<SqliteD1> {
  const s = makeSqliteD1();
  resetDatabaseInit();
  await initializeDatabase({ DB: dbOf(s) } as unknown as Env);
  setDbReady(true);
  return s;
}

const envOf = (s: SqliteD1): Env => makeTestEnv(dbOf(s) as any);

function seedLoop(s: SqliteD1, id: string, content: string, extraTags: string[] = []) {
  s.seed({ id, content, createdAt: 1000, tags: ["task", ...extraTags], source: "claude-desktop" });
}

describe("GET /loops", () => {
  it("requires auth", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("GET", "/loops", { token: null }), envOf(sq), ctx);
    expect(res.status).toBe(401);
  });

  it("returns entries tagged task and nothing else", async () => {
    sq = await migrated();
    seedLoop(sq, "open-1", "Follow up with the accountant about Q3");
    sq.seed({ id: "not-a-task", content: "Just a note", createdAt: 1000, tags: ["work"] });

    const data = await (await worker.fetch(req("GET", "/loops"), envOf(sq), ctx)).json() as any;

    expect(data.ok).toBe(true);
    expect(data.entries.map((e: any) => e.id)).toEqual(["open-1"]);
    expect(data.total).toBe(1);
  });

  it("excludes tasks already marked done", async () => {
    sq = await migrated();
    seedLoop(sq, "done-1", "Already handled", ["task:done"]);

    const data = await (await worker.fetch(req("GET", "/loops"), envOf(sq), ctx)).json() as any;
    expect(data.entries).toEqual([]);
  });

  it("excludes deprecated entries", async () => {
    sq = await migrated();
    seedLoop(sq, "gone", "Retired long ago", ["status:deprecated"]);

    const data = await (await worker.fetch(req("GET", "/loops"), envOf(sq), ctx)).json() as any;
    expect(data.entries).toEqual([]);
  });

  it.each(["claude-response", "codex-response", "build-log", "resume-playbook"])(
    "excludes agent-log tag %s so build notes don't drown real commitments",
    async (tag) => {
      sq = await migrated();
      seedLoop(sq, "agent-1", "Ran the migration", [tag]);

      const data = await (await worker.fetch(req("GET", "/loops"), envOf(sq), ctx)).json() as any;
      expect(data.entries).toEqual([]);
    },
  );

  it("carries content, source, tags and created_at for the reviewer", async () => {
    sq = await migrated();
    seedLoop(sq, "open-1", "Follow up with the accountant about Q3", ["finance"]);

    const data = await (await worker.fetch(req("GET", "/loops"), envOf(sq), ctx)).json() as any;

    const entry = data.entries[0];
    expect(entry.content).toBe("Follow up with the accountant about Q3");
    expect(entry.source).toBe("claude-desktop");
    expect(entry.tags).toEqual(expect.arrayContaining(["task", "finance"]));
    expect(entry.created_at).toBe(1000);
  });

  it("orders newest first", async () => {
    sq = await migrated();
    sq.seed({ id: "older", content: "Older loop", createdAt: 1000, tags: ["task"] });
    sq.seed({ id: "newer", content: "Newer loop", createdAt: 2000, tags: ["task"] });

    const data = await (await worker.fetch(req("GET", "/loops"), envOf(sq), ctx)).json() as any;
    expect(data.entries.map((e: any) => e.id)).toEqual(["newer", "older"]);
  });

  it("counts the whole queue, not the page", async () => {
    sq = await migrated();
    for (let i = 0; i < 30; i++) seedLoop(sq, `t${i}`, `Task ${i}`);

    const data = await (await worker.fetch(req("GET", "/loops?limit=10"), envOf(sq), ctx)).json() as any;
    expect(data.entries).toHaveLength(10);
    expect(data.total).toBe(30);
  });

  it("pages without repeating or skipping", async () => {
    sq = await migrated();
    for (let i = 0; i < 25; i++) seedLoop(sq, `t${i}`, `Task ${i}`);

    const first = await (await worker.fetch(req("GET", "/loops?limit=10&offset=0"), envOf(sq), ctx)).json() as any;
    const second = await (await worker.fetch(req("GET", "/loops?limit=10&offset=10"), envOf(sq), ctx)).json() as any;

    const ids = [...first.entries, ...second.entries].map((e: any) => e.id);
    expect(new Set(ids).size).toBe(20);
  });

  // The two readings of this fact — the chip on /brief and the queue behind
  // it — must never disagree, the same reason the stale count and queue share
  // a predicate.
  it("agrees with the count /brief puts on the attention chip", async () => {
    sq = await migrated();
    seedLoop(sq, "live-1", "A real commitment");
    seedLoop(sq, "live-2", "Another real commitment");
    seedLoop(sq, "done-1", "Finished", ["task:done"]);

    const brief = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    const queue = await (await worker.fetch(req("GET", "/loops"), envOf(sq), ctx)).json() as any;

    expect(brief.loops.open).toBe(queue.total);
  });
});

describe("POST /loops/resolve", () => {
  it("requires auth", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("POST", "/loops/resolve", { token: null, body: { id: "x", action: "done" } }), envOf(sq), ctx);
    expect(res.status).toBe(401);
  });

  it("rejects an unknown action", async () => {
    sq = await migrated();
    seedLoop(sq, "open-1", "A task");
    const res = await worker.fetch(req("POST", "/loops/resolve", { body: { id: "open-1", action: "nope" } }), envOf(sq), ctx);
    expect(res.status).toBe(400);
  });

  it("404s for an id the caller cannot see", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("POST", "/loops/resolve", { body: { id: "missing", action: "done" } }), envOf(sq), ctx);
    expect(res.status).toBe(404);
  });

  it("'done' appends task:done and drops it from the queue", async () => {
    sq = await migrated();
    seedLoop(sq, "open-1", "Follow up with the accountant");

    const res = await worker.fetch(req("POST", "/loops/resolve", { body: { id: "open-1", action: "done" } }), envOf(sq), ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);

    const row = (await sq.db.prepare(`SELECT tags FROM entries WHERE id = ?`).bind("open-1").first()) as any;
    const tags = JSON.parse(row.tags);
    expect(tags).toContain("task");
    expect(tags).toContain("task:done");

    const queue = await (await worker.fetch(req("GET", "/loops"), envOf(sq), ctx)).json() as any;
    expect(queue.total).toBe(0);
  });

  it("'not-task' removes the task tag and drops it from the queue", async () => {
    sq = await migrated();
    seedLoop(sq, "open-1", "Not actually a commitment", ["work"]);

    const res = await worker.fetch(req("POST", "/loops/resolve", { body: { id: "open-1", action: "not-task" } }), envOf(sq), ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);

    const row = (await sq.db.prepare(`SELECT tags FROM entries WHERE id = ?`).bind("open-1").first()) as any;
    const tags = JSON.parse(row.tags);
    expect(tags).not.toContain("task");
    expect(tags).toContain("work");

    const queue = await (await worker.fetch(req("GET", "/loops"), envOf(sq), ctx)).json() as any;
    expect(queue.total).toBe(0);
  });

  it("leaves content untouched", async () => {
    sq = await migrated();
    seedLoop(sq, "open-1", "Follow up with the accountant");

    await worker.fetch(req("POST", "/loops/resolve", { body: { id: "open-1", action: "done" } }), envOf(sq), ctx);

    const row = (await sq.db.prepare(`SELECT content FROM entries WHERE id = ?`).bind("open-1").first()) as any;
    expect(row.content).toBe("Follow up with the accountant");
  });

  describe("the entry_events record", () => {
    function collectingCtx() {
      const pending: Promise<unknown>[] = [];
      return {
        ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as any,
        async settle() {
          while (pending.length) {
            const batch = pending.splice(0, pending.length);
            await Promise.all(batch);
          }
        },
      };
    }

    it("writes a status_changed row naming the actor, the entry and the action", async () => {
      sq = await migrated();
      seedLoop(sq, "open-1", "Follow up with the accountant");
      const { ctx: c, settle } = collectingCtx();

      await worker.fetch(req("POST", "/loops/resolve", { body: { id: "open-1", action: "done" } }), envOf(sq), c);
      await settle();

      const { results } = await sq.db
        .prepare(`SELECT entry_id, event, payload FROM entry_events ORDER BY rowid ASC`)
        .all();
      const rows = results as Record<string, any>[];
      expect(rows).toHaveLength(1);
      expect(rows[0].entry_id).toBe("open-1");
      expect(rows[0].event).toBe("status_changed");
      expect(JSON.parse(rows[0].payload)).toEqual({ loop_action: "done" });
    });
  });
});
