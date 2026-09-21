/**
 * The `project` param on capture, list, digest, graph and recall, end to end
 * through the Worker against real SQLite.
 *
 * A project is `project:<slug>` plus its aliases, so every read asks the same
 * two questions: does an entry tagged only with an ALIAS (a legacy plain tag)
 * come back, and does nothing outside the project or the caller's scope.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import type { Env } from "../../src/env";

const BASE = "http://localhost";
const ALICE = "test-token";
let bobToken = "";

let sqlite: SqliteD1;
let env: Env;
let pending: Promise<unknown>[] = [];
let aliceWs = "";
let bobWs = "";
let companyWs = "";
let aliceId = "";
let bobId = "";

const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext;
const BAD_SLUG = 'invalid project tag "Bad Slug!": must match [a-z0-9][a-z0-9_-]{0,63}';
const OLD = Date.now() - 200 * 24 * 3600 * 1000;

function call(method: string, path: string, token: string | null, body?: unknown): Promise<Response> {
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx,
  );
}
const jsonOf = async (res: Response) => res.json() as Promise<any>;

async function settle(): Promise<void> {
  while (pending.length) {
    const batch = pending;
    pending = [];
    await Promise.all(batch);
  }
}

async function projectAudit() {
  await settle();
  const { results } = await env.DB.prepare(
    `SELECT actor_id, workspace_id, event, payload FROM admin_events WHERE event LIKE 'project_%' ORDER BY created_at ASC, rowid ASC`,
  ).all<{ actor_id: string; workspace_id: string; event: string; payload: string }>();
  return results.map(r => ({ ...r, payload: JSON.parse(r.payload) }));
}

function seed(id: string, workspaceId: string, tags: string[], opts: { createdAt?: number; actorId?: string; content?: string } = {}) {
  sqlite.db
    .prepare(`INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, 'test', ?, ?, ?, ?, ?)`)
    .bind(id, opts.content ?? `site note ${id}`, JSON.stringify(tags), opts.createdAt ?? 1000, opts.createdAt ?? 1000, JSON.stringify([`v-${id}`]), workspaceId, opts.actorId ?? aliceId)
    .run();
}

function seedEdge(id: string, a: string, b: string, weight: number, workspaceId = aliceWs) {
  sqlite.db
    .prepare(`INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id) VALUES (?, ?, ?, 'relates_to', ?, 'explicit', '{}', 1, 1, ?)`)
    .bind(id, a, b, weight, workspaceId)
    .run();
}

const registry = async () =>
  (await sqlite.db.prepare(`SELECT id, workspace_id, name, status FROM projects ORDER BY workspace_id, id`).all()).results as { id: string; workspace_id: string; name: string; status: string }[];

async function createProject(token: string, body: Record<string, unknown>) {
  const res = await call("POST", "/projects", token, body);
  expect(res.status).toBe(201);
}

beforeEach(async () => {
  resetDatabaseInit();
  pending = [];
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
    // The tag-first recall branch fetches stored vectors by id and scores them locally.
    VECTORIZE: makeVectorizeMock({
      getByIds: (async (ids: string[]) =>
        ids.map(id => ({ id, values: new Array(384).fill(0.1), metadata: { parentId: id.replace(/^v-/, "") } }))) as unknown as VectorizeIndex["getByIds"],
    }),
  });
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  const bob = await createMember(env, { name: "Bob" });
  bobToken = bob.token;
  aliceId = roots.ownerUserId;
  aliceWs = roots.ownerPersonalWorkspaceId;
  companyWs = roots.companyWorkspaceId;
  bobId = bob.member.userId;
  bobWs = bob.member.personalWorkspaceId;
  await settle();
  await env.DB.prepare(`DELETE FROM admin_events`).run();
});

afterEach(() => sqlite?.close());

describe("POST /capture with project", () => {
  it("unions project:<slug> into the tags, auto-creates the project and audits it", async () => {
    const res = await call("POST", "/capture", ALICE, { content: "Decided to move hosting to Fly", tags: ["infra"], project: "website" });

    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    expect(body.tags).toEqual(expect.arrayContaining(["infra", "project:website"]));
    expect(await registry()).toEqual([{ id: "website", workspace_id: aliceWs, name: "website", status: "active" }]);
    expect(await projectAudit()).toEqual([
      { actor_id: aliceId, workspace_id: aliceWs, event: "project_autocreated", payload: { slug: "website" } },
    ]);
    const row = await sqlite.db.prepare(`SELECT tags FROM entries WHERE id = ?`).bind(body.id).first() as { tags: string };
    expect(JSON.parse(row.tags)).toEqual(expect.arrayContaining(["project:website"]));
  });

  it("does not re-create, re-audit or overwrite an existing project", async () => {
    await createProject(ALICE, { id: "website", name: "The Website", description: "keep me" });
    await env.DB.prepare(`DELETE FROM admin_events`).run();

    await call("POST", "/capture", ALICE, { content: "First note about the site", project: "website" });
    await call("POST", "/capture", ALICE, { content: "A completely different second note", project: "website" });

    expect(await registry()).toEqual([{ id: "website", workspace_id: aliceWs, name: "The Website", status: "active" }]);
    expect(await projectAudit()).toEqual([]);
  });

  it("creates the project in the workspace the entry landed in", async () => {
    await call("POST", "/capture", ALICE, { content: "Shared launch checklist", project: "launch", workspace: "company" });

    expect(await registry()).toEqual([{ id: "launch", workspace_id: companyWs, name: "launch", status: "active" }]);
    expect((await projectAudit())[0]).toMatchObject({ workspace_id: companyWs, event: "project_autocreated" });
  });

  it("400s an invalid slug with the grammar error and stores nothing", async () => {
    const res = await call("POST", "/capture", ALICE, { content: "note", project: "Bad Slug!" });

    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ ok: false, error: BAD_SLUG });
    expect((await sqlite.db.prepare(`SELECT COUNT(*) AS n FROM entries`).first() as { n: number }).n).toBe(0);
    expect(await registry()).toEqual([]);
  });

  it("400s a non-string project", async () => {
    expect((await call("POST", "/capture", ALICE, { content: "note", project: 5 })).status).toBe(400);
  });

  it("ignores an empty project, like every other optional param", async () => {
    const res = await call("POST", "/capture", ALICE, { content: "note without a project", project: "" });
    expect(res.status).toBe(200);
    expect(await registry()).toEqual([]);
  });

  it("does not create a project when the capture is blocked as a duplicate", async () => {
    env = makeTestEnv(undefined, {
      DB: sqlite.db as unknown as Env["DB"],
      OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({
        query: (async () => ({ matches: [{ id: "existing", score: 0.99, metadata: { parentId: "existing" } }] })) as unknown as VectorizeIndex["query"],
      }),
    });
    seed("existing", aliceWs, []);

    const res = await call("POST", "/capture", ALICE, { content: "Duplicate note", project: "ghost" });

    expect((await jsonOf(res)).duplicate).toBe(true);
    expect(await registry()).toEqual([]);
  });

  it("a literal project: tag alone never creates a registry row", async () => {
    await call("POST", "/capture", ALICE, { content: "Tagged directly", tags: ["project:direct"] });
    expect(await registry()).toEqual([]);
  });
});

describe("GET /list with project", () => {
  beforeEach(async () => {
    await createProject(ALICE, { id: "site", name: "Site", aliases: ["hosting"] });
    seed("member", aliceWs, ["project:site", "infra"]);
    seed("aliased", aliceWs, ["hosting"]);
    seed("other", aliceWs, ["infra"]);
    seed("other-project", aliceWs, ["project:app"]);
    seed("bobs", bobWs, ["project:site"], { actorId: bobId });
    seed("shared", companyWs, ["project:site"]);
  });

  const ids = async (path: string, token = ALICE) => (await jsonOf(await call("GET", path, token))).map((e: any) => e.id).sort();

  it("returns members and alias-matched entries across the readable layers, nothing else", async () => {
    // "shared" is a company-layer member: membership is the tag, wherever Alice can read it.
    expect(await ids("/list?project=site&n=50")).toEqual(["aliased", "member", "shared"]);
  });

  it("ANDs with the tag filter", async () => {
    expect(await ids("/list?project=site&tag=infra&n=50")).toEqual(["member"]);
    expect(await ids("/list?project=site&tag=hosting&n=50")).toEqual(["aliased"]);
  });

  it("stays inside the caller's scope and follows the layer filter", async () => {
    await createProject(ALICE, { id: "site", name: "Company Site", workspace: "company" });

    expect(await ids("/list?project=site&n=50&workspace=company")).toEqual(["shared"]);
    expect(await ids("/list?project=site&n=50&workspace=personal")).toEqual(["aliased", "member"]);
    // Bob sees the company row and his own, never Alice's personal ones.
    await createProject(bobToken, { id: "site", name: "Bob Site" });
    expect(await ids("/list?project=site&n=50", bobToken)).toEqual(["bobs", "shared"]);
  });

  it("still filters an archived project", async () => {
    await call("PATCH", "/projects/site", ALICE, { status: "archived" });
    expect(await ids("/list?project=site&n=50")).toEqual(["aliased", "member", "shared"]);
  });

  it("404s an unknown project and names the known ones", async () => {
    const res = await call("GET", "/list?project=nope", ALICE);

    expect(res.status).toBe(404);
    expect(await jsonOf(res)).toEqual({ ok: false, error: 'unknown project "nope"', known_projects: ["site"] });
  });

  it("does not resolve a colleague's personal project", async () => {
    const res = await call("GET", "/list?project=site", bobToken);
    expect(res.status).toBe(404);
    expect((await jsonOf(res)).known_projects).toEqual([]);
  });

  it("400s an invalid slug and ignores an empty one", async () => {
    const bad = await call("GET", "/list?project=Bad%20Slug!", ALICE);
    expect(bad.status).toBe(400);
    expect((await jsonOf(bad)).error).toBe(BAD_SLUG);
    expect((await ids("/list?project=&n=50")).length).toBe(5);
  });
});

