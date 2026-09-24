/**
 * T-0042 / T-0077: moving a brain's existing vectors onto a new embedding scheme
 * (contextual chunk text, pooling) in place.
 *
 * Real SQLite for the same reason as embedding-migration.test.ts: the cursor and
 * the row re-read are SQL. The Vectorize double is stateful, so "what the index
 * holds" is asserted, not just what was upserted.
 *
 * Properties, in order:
 *  1. Every entry that needs a rewrite is reached, none twice past its cursor.
 *  2. Interrupting anywhere resumes; a stalled run stops with its cursor kept.
 *  3. The index and entries.vector_ids agree afterwards, with no stale chunk ids.
 *  4. An edit landing mid-rewrite is never overwritten with the old content.
 *  5. Recall's query pooling stays correct while two poolings coexist.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeMemoryKV } from "../helpers/make-env";
import { DEFAULTS, type Config } from "../../src/config";
import { storeEntry } from "../../src/capture/store";
import {
  MIGRATION_KEY, SCHEME_MIGRATION_KEY, queryPoolings, readSchemeMigration, runSchemeBatch, schemeLedgerMatters, type SchemeMigrationState,
} from "../../src/migration/embedding";
import { schemeOf } from "../../src/embedding/scheme";
import { chunkText } from "../../src/text/chunk";
import type { Env } from "../../src/env";

const legacy: Config = { ...DEFAULTS, CONTEXTUAL_EMBEDDINGS: "off" };
const ctx: Config = { ...DEFAULTS, CONTEXTUAL_EMBEDDINGS: "on" };
const cls: Config = { ...legacy, EMBEDDING_POOLING: "cls" };

const para = (i: number) => `Rollout step ${i} is owned by team ${i * 7} and reviewed weekly.`;
const long = (tag: string, n = 3600) => `${tag} programme notes. ${Array.from({ length: 200 }, (_, i) => para(i)).join(" ")}`.slice(0, n);

interface Harness { env: Env; index: Map<string, { metadata: Record<string, any>; values: number[] }>; embeds: { text: string; pooling?: string }[]; kv: ReturnType<typeof makeMemoryKV> }

function harness(d1: SqliteD1, opts: { failFrom?: number; onUpsert?: (n: number) => void } = {}): Harness {
  const index = new Map<string, { metadata: Record<string, any>; values: number[] }>();
  const embeds: { text: string; pooling?: string }[] = [];
  const kv = makeMemoryKV();
  let calls = 0;
  let upserts = 0;
  const env = {
    DB: d1.db,
    OAUTH_KV: kv,
    AI: {
      run: vi.fn(async (_m: string, input: { text: string[]; pooling?: string }) => {
        calls++;
        if (opts.failFrom !== undefined && calls >= opts.failFrom) throw new Error("quota exhausted (4006)");
        embeds.push({ text: input.text[0], pooling: input.pooling });
        return { data: [[0.1, 0.2, 0.3]] };
      }),
    },
    VECTORIZE: {
      upsert: vi.fn(async (vs: { id: string; values: number[]; metadata: Record<string, any> }[]) => {
        upserts++;
        opts.onUpsert?.(upserts);
        for (const v of vs) index.set(v.id, { metadata: v.metadata, values: v.values });
        return { count: vs.length };
      }),
      deleteByIds: vi.fn(async (ids: string[]) => { for (const id of ids) index.delete(id); }),
    },
  } as unknown as Env;
  return { env, index, embeds, kv };
}

/** Writes an entry the way the shipped write path did before the scheme change, and seeds its row. */
async function seedIndexed(d1: SqliteD1, h: Harness, id: string, content: string, createdAt: number, over: { source?: string; tags?: string[] } = {}) {
  d1.seed({ id, content, createdAt, source: over.source ?? "api", tags: over.tags ?? [] });
  await storeEntry(h.env, id, content, over.tags ?? [], over.source ?? "api", createdAt, legacy, { workspaceId: "", actorId: "" });
}

const idsOf = (d1: SqliteD1, id: string): string[] => JSON.parse(d1.rows().find(r => r.id === id)!.vector_ids as string);
const drain = async (env: Env, cfg: Config, max = 40) => {
  for (let i = 0; i < max; i++) if ((await runSchemeBatch(env, cfg)).done) return i + 1;
  throw new Error("did not finish");
};

describe("in-place scheme migration: contextual text", () => {
  let d1: SqliteD1;
  let h: Harness;
  beforeEach(async () => {
    d1 = makeSqliteD1();
    h = harness(d1);
    await seedIndexed(d1, h, "long-1", long("Alpha"), 1);
    await seedIndexed(d1, h, "short-1", "a short note", 2);
    await seedIndexed(d1, h, "mail-1", long("Mail"), 3, { source: "email-gmail" });
    await seedIndexed(d1, h, "long-2", long("Beta", 5000), 4);
    d1.seed({ id: "gone", content: long("Gone"), createdAt: 5, tags: ["status:deprecated"] });
    await seedIndexed(d1, h, "long-3", long("Gamma"), 6);
    h.embeds.length = 0;
  });

  it("rewrites every long, non-mirrored, live entry and leaves the rest alone", async () => {
    const before = new Map(h.index);
    await drain(h.env, ctx);

    for (const id of ["long-1", "long-2", "long-3"]) {
      const ids = idsOf(d1, id);
      expect(ids.length).toBeGreaterThan(1);
      for (const v of ids) expect(h.index.get(v)?.metadata).toMatchObject({ contextualized: true, scheme: 2, parentId: id });
    }
    // untouched: same vector objects, no extra embeds for them
    for (const id of ["short-1", "mail-1"]) for (const v of idsOf(d1, id)) expect(h.index.get(v)).toBe(before.get(v));
    expect(h.embeds.some(e => e.text === "a short note")).toBe(false);
    expect(h.embeds.every(e => e.text.startsWith("[Memory: "))).toBe(true);
  });

  it("agrees with the index afterwards: every id in vector_ids exists, no orphan chunk ids remain", async () => {
    await drain(h.env, ctx);
    const owned = new Set(d1.rows().flatMap(r => JSON.parse(r.vector_ids as string) as string[]));
    expect([...h.index.keys()].sort()).toEqual([...owned].sort());
  });

  it("deletes an old chunk id the new set no longer uses, after the new set is written", async () => {
    // an id left in vector_ids by an earlier, longer version of the entry
    h.index.set("long-1-chunk-9", { metadata: { parentId: "long-1" }, values: [0] });
    d1.db.prepare(`UPDATE entries SET vector_ids = ? WHERE id = ?`).bind(JSON.stringify([...idsOf(d1, "long-1"), "long-1-chunk-9"]), "long-1").run();
    await drain(h.env, ctx);
    expect(h.index.has("long-1-chunk-9")).toBe(false);
    expect(idsOf(d1, "long-1")).not.toContain("long-1-chunk-9");
  });

  it("stores raw chunk content and leaves entries.content untouched", async () => {
    const contentBefore = d1.rows().map(r => r.content);
    await drain(h.env, ctx);
    expect(d1.rows().map(r => r.content)).toEqual(contentBefore);
    for (const v of h.index.values()) expect(String(v.metadata.content)).not.toContain("[Memory:");
  });

  it("finishes with a ledger that a later run treats as idle", async () => {
    await drain(h.env, ctx);
    const state = (await readSchemeMigration(h.env))!;
    expect(state.finishedAt).toBeTypeOf("number");
    expect(state.target).toBe(schemeOf(ctx));
    h.embeds.length = 0;
    const again = await runSchemeBatch(h.env, ctx);
    expect(again).toMatchObject({ done: true, processed: 0 });
    expect(h.embeds).toHaveLength(0);
  });

  it("stays inside the chunk budget per batch, always taking the first entry", async () => {
    const r = await runSchemeBatch(h.env, ctx, { chunkBudget: 1, count: true });
    expect(r.processed).toBe(1);
    expect(r.done).toBe(false);
    expect(r.remaining).toBeGreaterThan(0);
  });

  it("resumes from its cursor after an interruption without redoing finished entries", async () => {
    const first = await runSchemeBatch(h.env, ctx, { chunkBudget: 1 });
    expect(first.processed).toBe(1);
    const cursor = (await readSchemeMigration(h.env))!.cursorId;
    expect(cursor).toBe("long-1");
    h.embeds.length = 0;
    await drain(h.env, ctx);
    // long-1 was already done: none of its (prefixed, "Alpha") chunks are embedded again
    expect(h.embeds.some(e => e.text.includes("Alpha programme"))).toBe(false);
  });

  it("stops on a budget failure, keeps its cursor, and finishes once embedding works again", async () => {
    const bad = harness(d1, { failFrom: 1 });
    for (const [k, v] of h.index) bad.index.set(k, v);
    const stalled = await runSchemeBatch(bad.env, ctx);
    expect(stalled).toMatchObject({ processed: 0, failed: 1, stalled: true, stalledReason: "budget", done: false });
    const state = (await readSchemeMigration(bad.env))!;
    expect(state.cursorId).toBeNull();
    // same ledger, a healthy binding
    const good = harness(d1);
    for (const [k, v] of bad.index) good.index.set(k, v);
    await good.kv.put(SCHEME_MIGRATION_KEY, JSON.stringify(state));
    await drain(good.env, ctx);
    for (const v of idsOf(d1, "long-2")) expect(good.index.get(v)?.metadata.contextualized).toBe(true);
  });

  it("does not overwrite an edit that lands while an entry is being rebuilt", async () => {
    const edited = long("Edited", 3400);
    let fired = false;
    const race = harness(d1, {
      onUpsert: () => {
        if (fired) return;
        fired = true;
        // the user edit commits after the migration read the row but before it re-checks
        d1.db.prepare(`UPDATE entries SET content = ? WHERE id = ?`).bind(edited, "long-1").run();
      },
    });
    for (const [k, v] of h.index) race.index.set(k, v);
    await drain(race.env, ctx);
    const texts = [...race.index.values()].filter(v => v.metadata.parentId === "long-1").map(v => String(v.metadata.content));
    expect(texts.join(" ")).toContain("Edited programme");
    expect(texts.join(" ")).not.toContain("Alpha programme");
  });

  it("removes what it wrote for an entry deleted while it was being rebuilt", async () => {
    const race = harness(d1, {
      onUpsert: n => { if (n === 1) d1.db.prepare(`DELETE FROM entries WHERE id = ?`).bind("long-1").run(); },
    });
    for (const [k, v] of h.index) race.index.set(k, v);
    await runSchemeBatch(race.env, ctx, { chunkBudget: 1 });
    expect([...race.index.values()].some(v => v.metadata.parentId === "long-1" && v.metadata.contextualized)).toBe(false);
  });

  it("does nothing when the switch is off, and never rewrites vectors already contextual", async () => {
    await drain(h.env, ctx);
    const snapshot = new Map(h.index);
    h.embeds.length = 0;
    const r = await runSchemeBatch(h.env, legacy);
    expect(r).toMatchObject({ done: true, processed: 0 });
    expect(h.embeds).toHaveLength(0);
    expect(h.index).toEqual(snapshot);
  });

  it("pauses while a model migration is in flight", async () => {
    await h.kv.put(MIGRATION_KEY, JSON.stringify({ model: ctx.EMBEDDING_MODEL, startedAt: 1, cursorCreatedAt: null, cursorId: null, processed: 0, failed: 0, totalAtStart: 5 }));
    const r = await runSchemeBatch(h.env, ctx);
    expect(r).toMatchObject({ paused: "model-migration", done: false, processed: 0 });
    expect(h.embeds).toHaveLength(0);
  });
});

describe("in-place scheme migration: pooling", () => {
  let d1: SqliteD1;
  let h: Harness;
  beforeEach(async () => {
    d1 = makeSqliteD1();
    h = harness(d1);
    await seedIndexed(d1, h, "long-1", long("Alpha"), 1);
    await seedIndexed(d1, h, "short-1", "a short note", 2);
    await seedIndexed(d1, h, "short-2", "another short note", 3);
    h.embeds.length = 0;
  });

  it("rewrites single-chunk entries too, because the vector space changes", async () => {
    await drain(h.env, cls);
    expect(h.embeds.map(e => e.pooling)).toSatisfy((p: (string | undefined)[]) => p.length > 0 && p.every(x => x === "cls"));
    expect(h.index.get("short-1")?.metadata.scheme).toBe(schemeOf(cls));
    expect(h.index.get("short-2")?.metadata.scheme).toBe(schemeOf(cls));
  });

  it("queries under both poolings until the ledger is finished, then one", async () => {
    expect(schemeLedgerMatters(cls)).toBe(true);
    expect(schemeLedgerMatters(legacy)).toBe(false);
    expect(schemeLedgerMatters(ctx)).toBe(false);
    // no ledger yet: a brain that may hold legacy vectors
    expect(queryPoolings(null, cls).sort()).toEqual(["cls", "mean"]);
    await runSchemeBatch(h.env, cls, { chunkBudget: 1 });
    const mid = await readSchemeMigration(h.env);
    expect(mid?.finishedAt).toBeUndefined();
    expect(queryPoolings(mid, cls).sort()).toEqual(["cls", "mean"]);
    await drain(h.env, cls);
    expect(queryPoolings(await readSchemeMigration(h.env), cls)).toEqual(["cls"]);
  });

  it("answers mean without reading anything for an ordinary brain", () => {
    expect(queryPoolings(null, legacy)).toEqual(["mean"]);
    expect(queryPoolings(null, ctx)).toEqual(["mean"]);
  });

  it("migrates back when cls is switched off: a change of target starts a new run over the old sources", async () => {
    await drain(h.env, cls);
    h.embeds.length = 0;
    const back = await runSchemeBatch(h.env, legacy, { chunkBudget: 1 });
    expect(back.processed).toBe(1);
    const mid = (await readSchemeMigration(h.env))!;
    expect(mid.sources).toEqual([schemeOf(cls)]);
    expect(queryPoolings(mid, legacy).sort()).toEqual(["cls", "mean"]);
    await drain(h.env, legacy);
    expect(queryPoolings(await readSchemeMigration(h.env), legacy)).toEqual(["mean"]);
    expect(h.embeds.every(e => e.pooling === undefined)).toBe(true);
  });

  it("a new target over an unfinished run remembers every scheme a vector may still be in", async () => {
    await runSchemeBatch(h.env, cls, { chunkBudget: 1 });
    await runSchemeBatch(h.env, { ...cls, CONTEXTUAL_EMBEDDINGS: "on" }, { chunkBudget: 1 });
    const state = (await readSchemeMigration(h.env)) as SchemeMigrationState;
    expect(state.target).toBe(4);
    expect([...state.sources].sort()).toEqual([1, 3]);
  });
});

describe("in-place scheme migration: idle cost", () => {
  it("a brain on the legacy scheme costs one KV read of the ledger and no D1 statement", async () => {
    const d1 = makeSqliteD1();
    const h = harness(d1);
    const prepare = vi.spyOn(d1.db, "prepare");
    const get = vi.spyOn(h.kv, "get");
    const r = await runSchemeBatch(h.env, legacy);
    expect(r).toMatchObject({ done: true, processed: 0 });
    expect(prepare).not.toHaveBeenCalled();
    expect(get.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe("in-place scheme migration: tenancy", () => {
  let d1: SqliteD1;
  let h: Harness;
  const stamp = (id: string) => [...h.index.values()].filter(m => m.metadata.parentId === id).map(m => m.metadata.workspace_id);
  beforeEach(async () => {
    d1 = makeSqliteD1();
    h = harness(d1);
    d1.seed({ id: "a", content: long("Alpha"), createdAt: 1 });
    d1.db.prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = ?`).bind("ws-team", "u-1", "a").run();
    await storeEntry(h.env, "a", long("Alpha"), [], "api", 1, legacy, { workspaceId: "ws-team", actorId: "u-1" });
  });

  it("stamps every rewritten vector with the row's own workspace, not a default", async () => {
    await drain(h.env, ctx);
    const ws = stamp("a");
    expect(ws.length).toBeGreaterThan(1);
    expect(new Set(ws)).toEqual(new Set(["ws-team"]));
  });

  it("re-stamps from the fresh row when the entry is shared while it is being rebuilt", async () => {
    let fired = false;
    const race = harness(d1, {
      onUpsert: () => {
        if (fired) return;
        fired = true;
        // shareEntry moves the row to another workspace between the read and the re-check
        d1.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind("ws-other", "a").run();
      },
    });
    for (const [k, v] of h.index) race.index.set(k, v);
    await drain(race.env, ctx);
    const ws = [...race.index.values()].filter(m => m.metadata.parentId === "a").map(m => m.metadata.workspace_id);
    expect(new Set(ws)).toEqual(new Set(["ws-other"]));
  });

  it("gives up on an entry that keeps changing rather than looping", async () => {
    let n = 0;
    const race = harness(d1, { onUpsert: () => { d1.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(`ws-${++n}`, "a").run(); } });
    for (const [k, v] of h.index) race.index.set(k, v);
    const r = await runSchemeBatch(race.env, ctx);
    expect(r.failed).toBe(1);
  });
});

describe("in-place scheme migration: poison entries", () => {
  it("steps past an entry that fails for its own reasons after three tries, and finishes the rest", async () => {
    const d1 = makeSqliteD1();
    const h = harness(d1);
    await seedIndexed(d1, h, "bad", long("Poison"), 1);
    await seedIndexed(d1, h, "good", long("Fine"), 2);
    const real = h.env.AI.run as unknown as (m: string, i: { text: string[] }) => Promise<unknown>;
    (h.env.AI as { run: unknown }).run = vi.fn(async (m: string, i: { text: string[] }) => {
      if (i.text[0].includes("Poison programme")) throw new Error("input rejected");
      return real(m, i);
    });
    for (let run = 0; run < 2; run++) {
      expect(await runSchemeBatch(h.env, ctx)).toMatchObject({ processed: 0, failed: 1, stalled: true, done: false });
      expect((await readSchemeMigration(h.env))!.cursorId).toBeNull();
    }
    // the third failure steps the cursor past it
    await runSchemeBatch(h.env, ctx);
    expect((await readSchemeMigration(h.env))!.cursorId).toBe("bad");
    await drain(h.env, ctx);
    const state = (await readSchemeMigration(h.env))!;
    expect(state.skipped).toBe(1);
    expect(state.finishedAt).toBeTypeOf("number");
    for (const v of idsOf(d1, "good")) expect(h.index.get(v)?.metadata.contextualized).toBe(true);
  });

  it("does not count a quota failure against the entry", async () => {
    const d1 = makeSqliteD1();
    const h = harness(d1);
    await seedIndexed(d1, h, "a", long("Alpha"), 1);
    const bad = harness(d1, { failFrom: 1 });
    for (const [k, v] of h.index) bad.index.set(k, v);
    for (let i = 0; i < 5; i++) expect(await runSchemeBatch(bad.env, ctx)).toMatchObject({ stalled: true, stalledReason: "budget" });
    expect((await readSchemeMigration(bad.env))!.skipped).toBe(0);
  });
});

describe("in-place scheme migration: switching contextual embeddings off and on", () => {
  it("resumes without re-embedding entries that are already contextual", async () => {
    const d1 = makeSqliteD1();
    const h = harness(d1);
    await seedIndexed(d1, h, "a", long("Alpha"), 1);
    await seedIndexed(d1, h, "b", long("Beta"), 2);
    await drain(h.env, ctx);
    h.embeds.length = 0;
    expect(await runSchemeBatch(h.env, legacy)).toMatchObject({ done: true, processed: 0 });
    expect(await runSchemeBatch(h.env, ctx)).toMatchObject({ done: true, processed: 0 });
    expect(h.embeds).toHaveLength(0);
    expect((await readSchemeMigration(h.env))!.finishedAt).toBeTypeOf("number");
  });

  it("carries a half-finished run across an off and on", async () => {
    const d1 = makeSqliteD1();
    const h = harness(d1);
    for (let i = 0; i < 3; i++) await seedIndexed(d1, h, `e${i}`, long(`Topic${i}`), i + 1);
    await runSchemeBatch(h.env, ctx, { chunkBudget: 1 });
    const cursor = (await readSchemeMigration(h.env))!.cursorId;
    await runSchemeBatch(h.env, legacy);
    h.embeds.length = 0;
    await drain(h.env, ctx);
    expect(cursor).toBe("e0");
    expect(h.embeds.some(e => e.text.includes("Topic0 programme"))).toBe(false);
    for (const id of ["e0", "e1", "e2"]) for (const v of idsOf(d1, id)) expect(h.index.get(v)?.metadata.contextualized).toBe(true);
  });
});

describe("in-place scheme migration: pace", () => {
  it("does not spend runs on entries that need no rewrite: a page of shorts around three long notes takes one run", async () => {
    const d1 = makeSqliteD1();
    const h = harness(d1);
    for (let i = 0; i < 120; i++) d1.seed({ id: `s${String(i).padStart(3, "0")}`, content: `short note ${i}`, createdAt: 10 + i });
    for (const [i, id] of ["l1", "l2", "l3"].entries()) {
      d1.seed({ id, content: long(id), createdAt: 500 + i });
      await storeEntry(h.env, id, long(id), [], "api", 500 + i, legacy, { workspaceId: "", actorId: "" });
    }
    h.embeds.length = 0;
    const r = await runSchemeBatch(h.env, ctx);
    expect(r).toMatchObject({ processed: 3, done: true, remaining: 0 });
    expect(h.embeds.every(e => e.text.startsWith("[Memory: "))).toBe(true);
  });

  it("reports remaining as entries still to rewrite, not every later row", async () => {
    const d1 = makeSqliteD1();
    const h = harness(d1);
    for (let i = 0; i < 30; i++) d1.seed({ id: `s${i}`, content: `short ${i}`, createdAt: i });
    for (let i = 0; i < 4; i++) await seedIndexed(d1, h, `l${i}`, long(`T${i}`), 100 + i);
    const r = await runSchemeBatch(h.env, ctx, { chunkBudget: 1, count: true });
    expect(r.remaining).toBe(3);
  });

  it("does not scan every later row to count what remains unless asked", async () => {
    const d1 = makeSqliteD1();
    const h = harness(d1);
    for (let i = 0; i < 4; i++) await seedIndexed(d1, h, `l${i}`, long(`T${i}`), 100 + i);
    const prepare = vi.spyOn(d1.db, "prepare");
    const r = await runSchemeBatch(h.env, ctx, { chunkBudget: 1 });
    expect(r).toMatchObject({ done: false, remaining: null });
    expect(prepare.mock.calls.map(c => String(c[0])).filter(sql => /COUNT\(/i.test(sql))).toEqual([]);
  });

  it("stops at the daily neuron cap and picks up the next UTC day", async () => {
    const d1 = makeSqliteD1();
    const h = harness(d1);
    for (let i = 0; i < 6; i++) await seedIndexed(d1, h, `l${i}`, long(`T${i}`), i + 1);
    const day1 = Date.UTC(2026, 8, 24, 12);
    const r1 = await runSchemeBatch(h.env, ctx, { chunkBudget: 1000, neuronCap: 1.5, now: day1 });
    expect(r1.processed).toBeGreaterThan(0);
    expect(r1.processed).toBeLessThan(6);
    expect(r1.capped).toBe(true);
    const r2 = await runSchemeBatch(h.env, ctx, { chunkBudget: 1000, neuronCap: 1.5, now: day1 + 3600_000 });
    expect(r2).toMatchObject({ processed: 0, capped: true });
    const r3 = await runSchemeBatch(h.env, ctx, { chunkBudget: 1000, neuronCap: 1.5, now: day1 + 86_400_000 });
    expect(r3.processed).toBeGreaterThan(0);
  });
});

describe("scheme migration schedule", () => {
  it("runs from the hourly cron with the full budget and from the nightly cron with the small one", async () => {
    const { default: worker } = await import("../../src/index");
    const { INTEGRATION_SYNC_CRON } = await import("../../src/integrations/mirror");
    const { SCHEME_NIGHTLY_CHUNK_BUDGET, SCHEME_RUN_CHUNK_BUDGET } = await import("../../src/migration/embedding");
    const d1 = makeSqliteD1();
    const h = harness(d1);
    for (let i = 0; i < 30; i++) await seedIndexed(d1, h, `e${String(i).padStart(2, "0")}`, long(`T${i}`), i + 1);
    h.embeds.length = 0;
    const waits: Promise<unknown>[] = [];
    const ctxStub = { waitUntil: (p: Promise<unknown>) => { waits.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext;
    const env = { ...h.env, AUTH_TOKEN: "t", VECTORIZE_GRACE_MS: "0" } as Env;
    await worker.scheduled({ cron: INTEGRATION_SYNC_CRON, scheduledTime: Date.now() } as unknown as ScheduledEvent, env, ctxStub);
    await Promise.allSettled(waits);
    const hourly = h.embeds.length;
    expect(hourly).toBeGreaterThan(SCHEME_NIGHTLY_CHUNK_BUDGET);
    expect(hourly).toBeLessThanOrEqual(SCHEME_RUN_CHUNK_BUDGET + 10);
  });
});

describe("scheme migration run cost", () => {
  it("a full run's own JavaScript stays a small part of the free plan's 10 ms CPU", async () => {
    const { SCHEME_RUN_CHUNK_BUDGET } = await import("../../src/migration/embedding");
    const d1 = makeSqliteD1();
    const h = harness(d1);
    for (let i = 0; i < 30; i++) await seedIndexed(d1, h, `e${String(i).padStart(2, "0")}`, long(`T${i}`, 2700), i + 1);
    await runSchemeBatch(h.env, ctx, { chunkBudget: 5 }); // warm the code paths
    const before = process.cpuUsage();
    const r = await runSchemeBatch(h.env, ctx);
    const cpu = process.cpuUsage(before);
    const ms = (cpu.user + cpu.system) / 1000;
    expect(r.chunks).toBeLessThanOrEqual(SCHEME_RUN_CHUNK_BUDGET + 8);
    expect(r.chunks).toBeGreaterThan(SCHEME_RUN_CHUNK_BUDGET - 8);
    // In-process SQLite and the test doubles are included here, which the Worker does not pay for (its D1, KV, Vectorize and AI
    // calls are I/O); the bound is generous and exists to catch a run whose own computation grows.
    expect(ms, `one ${r.chunks}-chunk run took ${ms.toFixed(1)} ms of CPU in this test`).toBeLessThan(60);
    process.stdout.write(`SCHEME_RUN_CPU ${ms.toFixed(1)}ms for ${r.chunks} chunks, ${r.processed} notes\n`);
  });
});
