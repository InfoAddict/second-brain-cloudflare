/**
 * GET /tags?counts=1: the plain tag list plus how many memories carry each tag.
 * Additive; the default response stays a bare string array for every existing consumer.
 * Real SQLite through the Worker, so scoping and the one-statement budget are asserted
 * on what actually runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import type { Env } from "../../src/env";

const BASE = "http://localhost";
const ALICE = "test-token";
let bobToken = "";

let pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext;

let sqlite: SqliteD1;
let env: Env;
let aliceWs = "";
let bobWs = "";
let companyWs = "";
let aliceId = "";

const call = (path: string, token: string) =>
  worker.fetch(new Request(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } }), env, ctx);

async function settle() {
  while (pending.length) {
    const batch = pending;
    pending = [];
    await Promise.all(batch);
  }
}

function seed(id: string, workspaceId: string, tags: string[]) {
  sqlite.db
    .prepare(`INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, 'test', 1000, 1000, '[]', ?, ?)`)
    .bind(id, `note ${id}`, JSON.stringify(tags), workspaceId, aliceId)
    .run();
}

beforeEach(async () => {
  resetDatabaseInit();
  pending = [];
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  const bob = await createMember(env, { name: "Bob" });
  bobToken = bob.token;
  bobWs = bob.member.personalWorkspaceId;
  aliceWs = roots.ownerPersonalWorkspaceId;
  companyWs = roots.companyWorkspaceId;
  aliceId = roots.ownerUserId;
  await settle();
});

afterEach(() => sqlite?.close());

describe("GET /tags?counts=1", () => {
  it("returns [{tag, count}] in the same order and for the same tags as the plain list", async () => {
    seed("a", aliceWs, ["react", "work"]);
    seed("b", aliceWs, ["react", "typescript"]);
    seed("c", aliceWs, ["react"]);

    const plain = await (await call("/tags", ALICE)).json() as string[];
    const counted = await (await call("/tags?counts=1", ALICE)).json() as { tag: string; count: number }[];

    expect(plain).toEqual(["react", "typescript", "work"]);
    expect(counted).toEqual([
      { tag: "react", count: 3 },
      { tag: "typescript", count: 1 },
      { tag: "work", count: 1 },
    ]);
    expect(counted.map(c => c.tag)).toEqual(plain);
  });

  it("counts an entry once per tag and carries system and project tags like the plain list does", async () => {
    seed("a", aliceWs, ["project:website", "kind:episodic", "web"]);
    seed("b", aliceWs, ["project:website", "web", "web"]);

    const counted = await (await call("/tags?counts=1", ALICE)).json() as { tag: string; count: number }[];

    expect(Object.fromEntries(counted.map(c => [c.tag, c.count]))).toEqual({
      "kind:episodic": 1,
      "project:website": 2,
      web: 2,
    });
  });

  it("leaves the default response a plain string array, with or without a falsy counts", async () => {
    seed("a", aliceWs, ["react"]);

    for (const path of ["/tags", "/tags?counts=0", "/tags?counts=false", "/tags?counts="]) {
      const body = await (await call(path, ALICE)).json();
      expect(body, path).toEqual(["react"]);
    }
  });

  it("accepts counts=true", async () => {
    seed("a", aliceWs, ["react"]);
    expect(await (await call("/tags?counts=true", ALICE)).json()).toEqual([{ tag: "react", count: 1 }]);
  });

  it("returns an empty array when there is nothing", async () => {
    expect(await (await call("/tags?counts=1", ALICE)).json()).toEqual([]);
  });

  it("is scoped like /tags: never a colleague's private tags or counts, shared ones for both", async () => {
    seed("alice-private", aliceWs, ["legal", "shared-topic"]);
    seed("bob-private", bobWs, ["job-hunting", "shared-topic"]);
    seed("company-1", companyWs, ["handbook", "shared-topic"]);

    const bob = await (await call("/tags?counts=1", bobToken)).json() as { tag: string; count: number }[];
    const alice = await (await call("/tags?counts=1", ALICE)).json() as { tag: string; count: number }[];

    expect(bob).toEqual([
      { tag: "handbook", count: 1 },
      { tag: "job-hunting", count: 1 },
      { tag: "shared-topic", count: 2 },
    ]);
    expect(alice.map(c => c.tag)).toContain("legal");
    expect(alice.map(c => c.tag)).not.toContain("job-hunting");
    expect(alice.find(c => c.tag === "shared-topic")!.count).toBe(2);
  });

  it("requires auth", async () => {
    const res = await worker.fetch(new Request(`${BASE}/tags?counts=1`), env, ctx);
    expect(res.status).toBe(401);
  });

  it("costs one entries statement on top of the cached vocabulary read", async () => {
    seed("a", aliceWs, ["react", "work"]);
    await call("/tags", ALICE); // warms the KV vocabulary
    await settle();

    const prepare = vi.spyOn(env.DB, "prepare");
    await call("/tags?counts=1", ALICE);
    const sql = prepare.mock.calls.map(c => String(c[0]));
    prepare.mockRestore();

    const entryStatements = sql.filter(s => /\bFROM entries\b/i.test(s));
    expect(entryStatements).toHaveLength(1);
    expect(entryStatements[0]).not.toMatch(/GROUP BY|json_each/i);
  });

  it("flags approximate counts when the scan hits its cap, without changing the body shape", async () => {
    const insert = sqlite.db.prepare(`INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, 'n', '["bulk"]', 'test', 1, 1, '[]', ?, ?)`);
    for (let i = 0; i < 5001; i++) insert.bind(`bulk-${i}`, aliceWs, aliceId).run();

    const res = await call("/tags?counts=1", ALICE);

    expect(res.headers.get("X-Counts-Approximate")).toBe("1");
    const body = await res.json() as { tag: string; count: number }[];
    expect(body.map(b => b.tag)).toEqual(["bulk"]);
    expect(body[0].count).toBe(5000);
  });

  it("sets no approximate flag on a normal brain", async () => {
    seed("a", aliceWs, ["react"]);
    expect((await call("/tags?counts=1", ALICE)).headers.get("X-Counts-Approximate")).toBeNull();
  });
});
