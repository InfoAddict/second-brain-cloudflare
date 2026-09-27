import { afterEach, expect, it, vi } from "vitest";
import { captureEntry } from "../../src/capture/entry";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import type { Env } from "../../src/env";

const stream = (text: string) => new ReadableStream({ start(c) {
  c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
  c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close();
}});
const pending: Promise<unknown>[] = [];
const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p); } } as ExecutionContext;

afterEach(async () => { await Promise.allSettled(pending); vi.restoreAllMocks(); pending.length = 0; });

it("does not clear vectors in another workspace after a lost system merge and embed failure", async () => {
  resetDatabaseInit();
  const sqlite = makeSqliteD1();
  let restoreEmbedFails = false;
  const env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({ query: vi.fn(async (): Promise<any> => ({ matches: [{ id: "target", score: 0.9, metadata: { parentId: "target" } }] })) }),
    AI: { run: vi.fn(async (model: string, opts: any) => {
      if (model.startsWith("@cf/baai/bge")) {
        if (restoreEmbedFails) throw new Error("local embed failure");
        return { data: [new Array(384).fill(0.1)] };
      }
      const prompt = String(opts?.messages?.[0]?.content ?? "");
      if (prompt.includes("Choose exactly one action")) return stream('{"action":"merge","target_id":"target","merged_content":"Combined digest"}');
      return stream("3");
    }) } as any,
  }) as Env;
  await initializeDatabase(env);
  sqlite.seed({ id: "target", content: "Old digest", tags: ["synthesized", "work"], source: "system", createdAt: 1, vectorIds: ["old-vector"] });
  const db = env.DB as any;
  const realPrepare = db.prepare.bind(db);
  let raced = false;
  db.prepare = (sql: string) => {
    // Current shape (buildCasGuard, ADV-1/ADV-2): "UPDATE entries AS e SET content = ..." with the
    // system-row guard (COALESCE(e.actor_id, '') = '') appended after the CAS predicate.
    if (!raced && sql.startsWith("UPDATE entries AS e SET content = ") && sql.includes("COALESCE(e.actor_id")) {
      raced = true;
      void sqlite.db.prepare("UPDATE entries SET workspace_id = 'other-private', actor_id = 'other-user' WHERE id = 'target'").run();
      restoreEmbedFails = true;
    }
    return realPrepare(sql);
  };

  await captureEntry("New digest", ["synthesized", "work"], "system", env, ctx, undefined,
    { workspaceId: "", actorId: "" }, undefined, { systemWrite: "digest" });
  const target = sqlite.rows().find(r => r.id === "target")!;
  expect(raced).toBe(true);
  expect(target.workspace_id).toBe("other-private");
  expect(target.vector_ids).not.toBe("[]");
  sqlite.close();
});
