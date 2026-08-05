/**
 * The nightly jobs all run inside one scheduled() invocation and share its budget, so
 * how much work compression takes per run is a correctness property, not a tuning knob.
 *
 * Before this bound existed, every tag with more than ten eligible entries was compressed
 * on every run — so both the D1 subrequest count and the CPU time grew with how many
 * distinct tags a user had, and a heavily-tagged brain blew the free-plan ceilings. The
 * tests that matter here are the two that bounding could plausibly get wrong: that it
 * defers rather than drops, and that the rotation actually reaches every tag.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runNightlyCompression, COMPRESSION_MAX_TAGS_PER_RUN } from "../../src/compression/nightly";
import { resetDatabaseInit } from "../../src/db/init";
import { makeTestDb, makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";
import type { Env } from "../../src/env";

function makeSseStream(response: string) {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

function makeDigestAI() {
  return {
    run: vi.fn().mockImplementation(async (model: string, opts: any) => {
      if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
      if (opts?.stream) return makeSseStream("A digest of the tagged memories.");
      return { response: "3" };
    }),
  } as unknown as Ai;
}

function seedTags(db: D1Mock, tagCount: number, perTag = 15) {
  const old = Date.now() - 200 * 24 * 3600 * 1000;
  let i = 0;
  for (let t = 0; t < tagCount; t++) {
    for (let k = 0; k < perTag; k++, i++) {
      db.entries.push({
        id: `e-${i}`, content: `Memory ${i} about topic ${t}`, tags: JSON.stringify([`tag-${t}`]),
        source: "api", created_at: old + i, updated_at: old + i, vector_ids: "[]",
        recall_count: 0, importance_score: 0, contradiction_wins: 0, contradiction_losses: 0,
      });
    }
  }
}

/** Which tags have had a digest built for them so far. */
function digestedTags(db: D1Mock): Set<string> {
  const out = new Set<string>();
  for (const e of db.entries) {
    const tags: string[] = JSON.parse(e.tags ?? "[]");
    if (!tags.includes("synthesized")) continue;
    for (const t of tags) if (t.startsWith("tag-")) out.add(t);
  }
  return out;
}

async function runCron(env: Env) {
  const pending: Promise<any>[] = [];
  const ctx = { waitUntil: (p: Promise<any>) => pending.push(p) } as any as ExecutionContext;
  await runNightlyCompression(env, ctx);
  await Promise.allSettled(pending);
}

describe("runNightlyCompression() tag bound", () => {
  let db: D1Mock;
  let env: Env;

  beforeEach(() => {
    resetDatabaseInit();
    db = makeTestDb();
    env = makeTestEnv(db, { AI: makeDigestAI(), OAUTH_KV: makeMemoryKV() });
  });

  it(`compresses at most ${COMPRESSION_MAX_TAGS_PER_RUN} tags in one run`, async () => {
    seedTags(db, 20);

    await runCron(env);

    expect(digestedTags(db).size).toBe(COMPRESSION_MAX_TAGS_PER_RUN);
  });

  it("resumes after the last tag it processed rather than repeating the head", async () => {
    seedTags(db, 20);

    await runCron(env);
    const first = digestedTags(db);
    await runCron(env);
    const afterSecond = digestedTags(db);

    // The second run must have done new work, not re-done the first run's.
    expect(afterSecond.size).toBeGreaterThan(first.size);
    for (const t of first) expect(afterSecond.has(t)).toBe(true);
  });

  it("reaches every tag across enough runs — bounding defers, it never drops", async () => {
    const TAGS = 20;
    seedTags(db, TAGS);

    // Ceil(20/4) runs would suffice if nothing repeated; allow slack and assert coverage.
    for (let i = 0; i < 10; i++) await runCron(env);

    expect(digestedTags(db).size).toBe(TAGS);
  });

  it("takes every tag in one run when there are fewer than the bound", async () => {
    const under = COMPRESSION_MAX_TAGS_PER_RUN - 1;
    seedTags(db, under);
    const put = vi.spyOn(env.OAUTH_KV, "put");

    await runCron(env);

    expect(digestedTags(db).size).toBe(under);
    // No rotation is needed, so no cursor is written — there is nothing to resume from.
    expect(put).not.toHaveBeenCalled();
  });

  it("starts from the top when the cursor cannot be read", async () => {
    seedTags(db, 20);
    const failingKV = {
      get: vi.fn().mockRejectedValue(new Error("KV unavailable")),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn(), list: vi.fn(),
    } as unknown as KVNamespace;
    env = makeTestEnv(db, { AI: makeDigestAI(), OAUTH_KV: failingKV });

    await runCron(env);

    expect(digestedTags(db).size).toBe(COMPRESSION_MAX_TAGS_PER_RUN);
  });
});
