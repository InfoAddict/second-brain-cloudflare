import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import worker from "../../src/index";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { FTS_READY_KV_KEY } from "../../src/constants";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { recallEntries } from "../../src/recall/search";
import { buildMcpServer } from "../../src/mcp/server";
import type { RecallDiagnostics, RecallInternalOptions } from "../../src/recall/types";
import type { Env } from "../../src/env";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { req } from "../helpers/make-request";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;
const databases: SqliteD1[] = [];

afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close();
  vi.restoreAllMocks();
});

async function setup(publicPath = false) {
  resetDatabaseInit();
  resetFtsReadyMemo();
  const sqlite = makeSqliteD1();
  databases.push(sqlite);
  const query = vi.fn().mockResolvedValue({
    matches: [{ id: "dense-doc", score: 0.9, metadata: { parentId: "dense-doc", content: "semantic neighbor", created_at: 1 } }],
  });
  const env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({ query }),
  });
  await initializeDatabase(env);
  const roots = publicPath ? await ensureTenantBootstrap(env) : undefined;
  sqlite.seed({ id: "dense-doc", content: "an unrelated semantic neighbor note", createdAt: 1 });
  sqlite.seed({ id: "kw-doc", content: "the zylophantine rollout checklist", createdAt: 2 });
  if (roots) {
    await sqlite.db.prepare("UPDATE entries SET workspace_id = ?").bind(roots.ownerPersonalWorkspaceId).run();
  }
  await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
  resetFtsReadyMemo();
  sqlite.issued.length = 0;
  sqlite.batches.length = 0;
  return { env, query, sqlite };
}

async function run(env: Env, variant?: RecallInternalOptions["variant"], query = "zylophantine rollout") {
  const diagnostics: RecallDiagnostics = {};
  const result = await recallEntries(
    { query, topK: 5, synthesize: false }, env, ctx, undefined, { diagnostics, variant },
  );
  return { ids: result.matches.map(m => m.id), diagnostics };
}

describe("internal.variant.arms", () => {
  it("keeps default and explicit both identical", async () => {
    const { env, query } = await setup();
    const a = await run(env);
    const b = await run(env, { arms: "both" });
    expect(a.ids).toEqual(b.ids);
    expect(new Set(a.ids)).toEqual(new Set(["kw-doc", "dense-doc"]));
    expect(a.diagnostics.ftsRoute).toBe("fts");
    expect(query).toHaveBeenCalled();
  });

  it("keyword-only skips embedding and Vectorize entirely", async () => {
    const { env, query } = await setup();
    const r = await run(env, { arms: "keyword-only" });
    expect(r.ids).toEqual(["kw-doc"]);
    expect(query).not.toHaveBeenCalled();
    expect((env.AI.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("dense-only skips the keyword arm and reports why", async () => {
    const { env, sqlite } = await setup();
    const r = await run(env, { arms: "dense-only" });
    expect(r.ids).toEqual(["dense-doc"]);
    expect(r.diagnostics.ftsRoute).toBe("skipped-by-variant");
    expect(r.diagnostics.keywordIds).toEqual([]);
    expect(sqlite.batches.some(batch => batch.some(sql => sql.includes("SELECT e.id, e.content") && sql.includes("entries_fts MATCH")))).toBe(false);
  });

  it.each(["zylophantine rollout", "semantic neighbor", "absent phrase"])(
    "matches the unmodified SQL, top-k IDs, and stable diagnostics for %s",
    async queryText => {
      const { env, sqlite } = await setup();
      const { ids, diagnostics } = await run(env, undefined, queryText);
      const { stageMs: _timings, ...stableDiagnostics } = diagnostics;
      expect({ sql: sqlite.issued, batches: sqlite.batches, ids, diagnostics: stableDiagnostics }).toMatchSnapshot();
    },
  );

  it("HTTP and MCP recall cannot pass a variant through", async () => {
    const { env, query } = await setup(true);
    const response = await worker.fetch(req("GET", "/recall?query=zylophantine+rollout&variant=dense-only&arms=keyword-only"), env, ctx);
    expect(response.status).toBe(200);
    const body = await response.json() as { results: { id: string }[] };
    expect(body.results.map(item => item.id)).toEqual(expect.arrayContaining(["kw-doc", "dense-doc"]));
    expect(query).toHaveBeenCalled();

    query.mockClear();
    const server = buildMcpServer(env, ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "variant-boundary-test", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const result = await client.callTool({ name: "recall", arguments: {
        query: "zylophantine rollout", variant: { arms: "dense-only" }, arms: "keyword-only",
      } });
      const text = (result.content as { text?: string }[])[0]?.text ?? "";
      expect(text).toContain("zylophantine rollout checklist");
      expect(text).toContain("unrelated semantic neighbor note");
      expect(query).toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
});
