import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";
import type { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as unknown as ExecutionContext;
const BAD = 'invalid project tag "Bad Slug!": must match [a-z0-9][a-z0-9_-]{0,63}';

describe("project: tag validation on write routes", () => {
  let db: D1Mock;
  let env: Env;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("POST /capture rejects a malformed project tag and stores nothing", async () => {
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "note", tags: ["work", "project:Bad Slug!"] } }), env, ctx);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: BAD });
    expect(db.entries).toHaveLength(0);
  });

  it("POST /capture accepts a valid project tag without creating any registry state", async () => {
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "note", tags: ["project:my-app"] } }), env, ctx);

    expect(res.status).toBe(200);
    expect(JSON.parse(db.entries[0].tags)).toContain("project:my-app");
  });

  it("POST /update rejects a malformed project tag before touching the entry", async () => {
    db.entries.push({ id: "e1", content: "old", tags: '["work"]', source: "api", created_at: 1, vector_ids: '["e1"]', recall_count: 0, importance_score: 3 });

    const res = await worker.fetch(req("POST", "/update", { body: { id: "e1", content: "new", tags: ["project:Bad Slug!"] } }), env, ctx);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: BAD });
    expect(db.entries[0].content).toBe("old");
  });

  it("POST /update lets a caller add and remove project membership by tag replacement", async () => {
    db.entries.push({ id: "e1", content: "old", tags: '["project:a","work"]', source: "api", created_at: 1, vector_ids: '["e1"]', recall_count: 0, importance_score: 3 });

    const res = await worker.fetch(req("POST", "/update", { body: { id: "e1", content: "new", tags: ["work", "project:b"] } }), env, ctx);

    expect(res.status).toBe(200);
    expect(JSON.parse(db.entries[0].tags)).toEqual(["work", "project:b"]);
  });
});
