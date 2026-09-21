import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";
import { buildMcpServer } from "../../src/mcp/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { VECTORIZE_GET_BY_IDS_BATCH } from "../../src/constants";

function makeCtx() {
  const pending: Promise<any>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<any>) => pending.push(p) } as any,
    drain: () => Promise.allSettled(pending),
  };
}

const denied = () => Promise.reject(new Error("VECTORIZE_QUERY_ERROR (code = 40001): Authentication error"));

// The two ways Vectorize actually goes away in a deployment: never bound (index
// not created), or bound but every call rejected (token lacks Vectorize Edit).
const UNAVAILABLE: [string, () => Partial<Env>][] = [
  ["binding absent", () => ({ VECTORIZE: undefined as any })],
  ["calls denied", () => ({
    VECTORIZE: makeVectorizeMock({
      query: vi.fn(denied), insert: vi.fn(denied), upsert: vi.fn(denied),
      deleteByIds: vi.fn(denied), getByIds: vi.fn(denied), describe: vi.fn(denied),
    } as any),
  })],
];

async function seed(db: D1Mock, content: string) {
  const { ctx, drain } = makeCtx();
  await worker.fetch(req("POST", "/capture", { body: { content } }), makeTestEnv(db), ctx);
  await drain();
  return db.entries[0];
}

describe("Vectorize unavailable — writes degrade to keyword-only (#270)", () => {
  let db: D1Mock;
  beforeEach(() => { db = makeTestDb(); });

  for (const [label, overrides] of UNAVAILABLE) {
    describe(label, () => {
      it("POST /capture stores the entry instead of throwing", async () => {
        const env = makeTestEnv(db, overrides());
        const { ctx, drain } = makeCtx();
        const res = await worker.fetch(req("POST", "/capture", { body: { content: "keyword only capture" } }), env, ctx);
        await drain();

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true });
        expect(db.entries).toHaveLength(1);
        expect(db.entries[0].content).toBe("keyword only capture");
      });

      it("POST /append commits the addition and flags it unindexed", async () => {
        const { id } = await seed(db, "original content");
        const env = makeTestEnv(db, overrides());
        const { ctx, drain } = makeCtx();
        const res = await worker.fetch(req("POST", "/append", { body: { id, addition: "appended text" } }), env, ctx);
        await drain();

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true, semantic_unavailable: true });
        expect(db.entries[0].content).toContain("appended text");
      });

      it("POST /update commits new content and keeps the old vectors", async () => {
        const { id } = await seed(db, "original content");
        const oldVectorIds = db.entries[0].vector_ids;
        expect(JSON.parse(oldVectorIds).length).toBeGreaterThan(0);

        const env = makeTestEnv(db, overrides());
        const { ctx, drain } = makeCtx();
        const res = await worker.fetch(req("POST", "/update", { body: { id, content: "replacement content" } }), env, ctx);
        await drain();

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true, vectors: 0, semantic_unavailable: true });
        expect(db.entries[0].content).toBe("replacement content");
        // #212: with Vectorize gone the old index is the entry's only remaining
        // searchability — retiring it would leave the entry silently unfindable.
        expect(db.entries[0].vector_ids).toBe(oldVectorIds);
      });

      it("GET /recall still degrades to keyword-only", async () => {
        await seed(db, "findable by keyword");
        const env = makeTestEnv(db, overrides());
        const { ctx } = makeCtx();
        const res = await worker.fetch(req("GET", "/recall?query=findable"), env, ctx);

        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.ok).toBe(true);
        expect(body.results.length).toBeGreaterThan(0);
      });
    });
  }

  it("captures without duplicate detection rather than rejecting the write", async () => {
    // Only the duplicate query fails: capture must proceed on the advisory check
    // alone, without consulting index health or touching the primary embed.
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: vi.fn(denied) } as any) });
    const { ctx, drain } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "advisory check skipped" } }), env, ctx);
    await drain();

    expect(res.status).toBe(200);
    expect(db.entries).toHaveLength(1);
    expect(JSON.parse(db.entries[0].vector_ids).length).toBeGreaterThan(0);
  });

  it("still fails loudly when the embed fails but Vectorize is healthy (#212)", async () => {
    // The distinction the fix turns on: a failing embed against a reachable index
    // is a transient fault, not a keyword-only deployment. Committing here would
    // report success for content the index never received.
    const { id, content, vector_ids } = await seed(db, "original content");
    const env = makeTestEnv(db, {
      AI: { run: vi.fn().mockRejectedValue(new Error("Neurons daily limit exceeded (code 4006)")) } as any,
    });
    const { ctx, drain } = makeCtx();
    const res = await worker.fetch(req("POST", "/update", { body: { id, content: "replacement content" } }), env, ctx);
    await drain();

    expect(res.status).toBe(500);
    expect(db.entries[0].content).toBe(content);
    expect(db.entries[0].vector_ids).toBe(vector_ids);
  });
});

// #352: a failed Vectorize call does not establish WHY it failed. A transient
// 5xx must not be reported as a missing index.
describe("recall wording for Vectorize failures (#352)", () => {
  let db: D1Mock;
  beforeEach(() => { db = makeTestDb(); });

  const transient = () => makeTestEnv(db, {
    VECTORIZE: makeVectorizeMock({ query: vi.fn().mockRejectedValue(new Error("vectorize internal error (code 5xx)")) } as any),
  });

  async function callMcpRecall(env: Env, query: string) {
    const { ctx } = makeCtx();
    const server = buildMcpServer(env, ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const result = await client.callTool({ name: "recall", arguments: { query } });
      return (result.content as { text: string }[])[0].text;
    } finally {
      await client.close();
    }
  }

  it("a transient Vectorize query error yields the neutral wording, not a missing-index diagnosis", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(req("GET", "/recall?query=nothing+stored+here"), transient(), ctx);
    const body = await res.json() as any;

    expect(body.semantic_unavailable).toBe(true);
    expect(body.message).toContain("unavailable or incomplete");
    expect(body.message).not.toContain("Vectorize index missing");
    expect(body.message).toContain("may be missing");
    expect(body.message).toContain("wrangler vectorize create");
  });

  it("MCP recall states results MAY be keyword-only and does not assert the index is missing", async () => {
    const text = await callMcpRecall(transient(), "nothing stored here");

    expect(text).toContain("unavailable or incomplete");
    expect(text).toContain("may be keyword matches only");
    expect(text).not.toContain("because the Vectorize index is missing");
    expect(text).toContain("may be missing");
  });

  it("an absent binding still reports semantic_unavailable with the neutral wording", async () => {
    const { ctx } = makeCtx();
    const env = makeTestEnv(db, { VECTORIZE: undefined as any });
    const res = await worker.fetch(req("GET", "/recall?query=nothing+stored+here"), env, ctx);
    const body = await res.json() as any;

    expect(body.semantic_unavailable).toBe(true);
    expect(body.message).toContain("unavailable or incomplete");
    expect(body.message).not.toContain("Vectorize index missing");
    expect(body.message).toContain("may be missing");
  });

  it("a healthy recall carries no unavailable notice", async () => {
    const { ctx } = makeCtx();
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [] }) } as any) });
    const res = await worker.fetch(req("GET", "/recall?query=nothing+stored+here"), env, ctx);
    const body = await res.json() as any;

    expect(body.semantic_unavailable).toBe(false);
    expect(body.message).toBe("Nothing found matching that query.");

    const text = await callMcpRecall(env, "nothing stored here");
    expect(text).not.toContain("unavailable or incomplete");
  });

  it("a later getByIds batch failing after an earlier success keeps the successful batch's matches", async () => {
    // Tag-scoped path: more vector ids than one getByIds batch, so a second call is made.
    const total = VECTORIZE_GET_BY_IDS_BATCH + 1;
    const ids = Array.from({ length: total }, (_, i) => `v${i}`);
    db.entries.push({
      id: "e1", content: "quarterly pricing review", tags: JSON.stringify(["shared"]), source: "api",
      created_at: Date.now(), vector_ids: JSON.stringify(ids), recall_count: 0, importance_score: 0,
    });
    const values = new Array(384).fill(0.1);
    const getByIds = vi.fn()
      .mockResolvedValueOnce(ids.slice(0, VECTORIZE_GET_BY_IDS_BATCH).map(id => ({ id, values, metadata: { parentId: "e1", isUpdate: false } })))
      .mockRejectedValueOnce(new Error("vectorize internal error (code 5xx)"));
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ getByIds } as any) });
    const { ctx } = makeCtx();

    // No token overlap with the entry's content: the keyword rows cannot surface it,
    // so it can only appear via the first batch's dense vectors.
    const res = await worker.fetch(req("GET", "/recall?query=zebra+migration+patterns&tag=shared"), env, ctx);
    const body = await res.json() as any;

    expect(getByIds).toHaveBeenCalledTimes(2);
    expect(body.semantic_unavailable).toBe(true);
    expect(body.results.map((r: any) => r.id)).toEqual(["e1"]);
  });
});
