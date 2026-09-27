// Round-4 adversary reproductions for revertEntry (T-0089.1.3), against the simplification at dee8bc69.
// Each test asserts the CORRECT behaviour, so each one fails until its finding is fixed.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeAIMock, makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityByUserId, type Identity } from "../../src/lib/identity";
import { captureEntry } from "../../src/capture/entry";
import { appendToEntry, updateEntryContent } from "../../src/capture/store";
import { applyStatus, forgetEntry } from "../../src/capture/lifecycle";
import { moveEntry } from "../../src/capture/share";
import { resolveEntryAction } from "../../src/memory/actions";
import { deleteForever } from "../../src/memory/trash";
import { D1_ROW_MAX_BYTES } from "../../src/constants";
import { revertEntry } from "../../src/memory/undo";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const stream = (text: string) => new ReadableStream({ start(c) {
  c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
  c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close();
} });

let sqlite: SqliteD1;
let env: Env;
let owner: Identity;
let store: Map<string, { id: string; values: number[]; metadata: Record<string, unknown> }>;

function statefulVectorize(matchId?: string) {
  store = new Map();
  const overrides: Record<string, unknown> = {
    upsert: vi.fn(async (vs: any[]): Promise<any> => { for (const v of vs) store.set(v.id, v); return { mutationId: "m" }; }),
    insert: vi.fn(async (vs: any[]): Promise<any> => { for (const v of vs) store.set(v.id, v); return { mutationId: "m" }; }),
    deleteByIds: vi.fn(async (ids: string[]): Promise<any> => { for (const i of ids) store.delete(i); return { mutationId: "m" }; }),
    getByIds: vi.fn(async (ids: string[]): Promise<any> => ids.map(i => store.get(i)).filter(Boolean)),
  };
  if (matchId) overrides.query = vi.fn().mockResolvedValue({ matches: [{ id: matchId, score: 0.9, metadata: { parentId: matchId } }] });
  return makeVectorizeMock(overrides as any);
}
const decisionAI = (decision: string) =>
  ({ run: vi.fn(async (model: string) => model.startsWith("@cf/baai/bge") ? { data: [new Array(384).fill(0.1)] } : stream(decision)) }) as any;

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: statefulVectorize(), AI: makeAIMock() });
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  owner = (await resolveIdentityByUserId(env, roots.ownerUserId))!;
});
afterEach(() => sqlite.close());

const seed = (id: string, over: Record<string, unknown> = {}) => sqlite.db.prepare(
  `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id, when_at, when_kind, when_label, when_source)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).bind(
  id, over.content ?? "text", JSON.stringify(over.tags ?? []), over.source ?? "api", over.createdAt ?? 1000, over.updatedAt ?? null,
  JSON.stringify(over.vectorIds ?? [id]), over.workspaceId ?? owner.personalWorkspaceId, over.actorId ?? owner.userId,
  over.whenAt ?? null, over.whenKind ?? null, over.whenLabel ?? null, over.whenSource ?? null,
).run();
const row = (id: string) => sqlite.rows().find((r: any) => r.id === id) as any;
const versions = async (id: string) => (await env.DB.prepare(`SELECT * FROM entry_versions WHERE entry_id = ? ORDER BY seq`).bind(id).all()).results as any[];
const change = (who: Identity = owner, channel: "rest" | "mcp" = "rest") => ({ actorId: who.userId, channel });
const member = async (name: string) => (await resolveIdentityByUserId(env, (await createMember(env, { name })).member.userId))!;

/** Runs `race` once, just before the revert's own [snapshot, UPDATE, prune] batch reaches the database. */
function beforeRevertBatch(base: Env, race: () => Promise<void>): Env {
  const raw = base.DB as any;
  let fired = false;
  const db = {
    ...raw,
    prepare: (sql: string) => raw.prepare(sql),
    batch: async (stmts: any[]) => {
      const isRevert = stmts.some(s => typeof s.sourceSql === "function" && s.sourceSql().includes("json_extract(ov.meta, '$.nonce')"));
      if (isRevert && !fired) { fired = true; await race(); }
      return raw.batch(stmts);
    },
  };
  return { ...base, DB: db } as unknown as Env;
}



/** A merge decider whose merged text is the target's current text plus the incoming capture, like a real merge. */
function mergingEnv(target: string) {
  const ai = { run: vi.fn(async (model: string, input: any) => {
    if (model.startsWith("@cf/baai/bge")) return { data: (Array.isArray(input?.text) ? input.text : [input?.text]).map(() => new Array(384).fill(0.1)) };
    return stream(JSON.stringify({ action: "merge", target_id: target, merged_content: `${currentContent(target)} ${pending.shift() ?? ""}` }));
  }) } as any;
  return makeTestEnv(undefined, { DB: sqlite.db as any, OAUTH_KV: makeMemoryKV(), VECTORIZE: statefulVectorize(target), AI: ai }) as Env;
}
const pending: string[] = [];
const currentContent = (id: string) => row(id)?.content ?? "";
const capture = (e: Env, text: string, ws = owner.personalWorkspaceId, actor = owner.userId) => {
  pending.push(text);
  return captureEntry(text, [], "api", e, ctx, undefined, { workspaceId: ws, actorId: actor }, undefined, { channel: "rest" });
};
const live = (content: string) => sqlite.rows().filter((r: any) => r.content === content);

/** Counts every D1 execution, batches as one. */
function counting(base: Env) {
  const raw = base.DB as any;
  const executed: string[] = [];
  const wrap = (s: any, sql: string): any => ({
    ...s, sourceSql: () => sql, raw: () => s,
    bind: (...a: unknown[]) => wrap(s.bind(...a), sql),
    run: () => { executed.push(sql); return s.run(); },
    first: (c?: string) => { executed.push(sql); return s.first(c); },
    all: () => { executed.push(sql); return s.all(); },
  });
  const db = { ...raw, prepare: (sql: string) => wrap(raw.prepare(sql), sql), batch: (stmts: any[]) => { executed.push(`BATCH(${stmts.length})`); return raw.batch(stmts.map((s: any) => s.raw())); } };
  return { env: { ...base, DB: db } as unknown as Env, executed };
}


describe("ADV-U18 (MINOR): a failed re-creation batch is recorded as done, so the fact can never be re-created", () => {
  it("after the insert batch fails, the result says so or a later rollback still brings the fact back", async () => {
    const e = mergingEnv("old");
    await seed("old", { content: "Old text", tags: ["work"] });
    await capture(e, "Incoming fact");
    const mergeSeq = (await versions("old"))[0].seq;
    const raw = e.DB as any;
    let failed = false;
    const flaky = { ...e, DB: { ...raw, prepare: (sql: string) => raw.prepare(sql), batch: async (stmts: any[]) => {
      // the re-creation INSERT batch, which runs after the revert batch has committed
      if (!failed && stmts.every(s => s.sourceSql?.().startsWith("INSERT INTO entries (id, content"))) { failed = true; throw new Error("D1_ERROR: Network connection lost."); }
      return raw.batch(stmts);
    } } } as unknown as Env;
    const r = await revertEntry(flaky, owner, "old", change(), DEFAULTS);
    expect(failed).toBe(true);
    expect(r.status).toBe("reverted");
    expect(row("old").content).toBe("Old text");
    expect(live("Incoming fact")).toHaveLength(0);
    const told = (r as any).recreatedIncomingId ?? (r as any).keptIncoming ?? (r as any).incomingTruncated;
    if (told === undefined) {
      // Silent. The revert's meta already records the id, so "at most once" now blocks every retry.
      await revertEntry(e, owner, "old", change(), DEFAULTS); // redo
      await revertEntry(e, owner, "old", change(), DEFAULTS, mergeSeq); // roll back to the merge again
      expect(live("Incoming fact")).toHaveLength(1); // actual: 0 — the fact is only in history, which prunes at 20
    }
  });
});

describe("ADV-U19 (MINOR): the oversize fallback drops the record, so 'at most once' no longer holds", () => {
  it("rolling back past a merge twice on a ~1.85 MB row leaves one copy of the incoming fact", async () => {
    const e = mergingEnv("big");
    await seed("big", { content: "Old text", tags: ["work"] });
    const incoming = "i".repeat(900_000);
    expect((await capture(e, incoming)).status).toBe("merged");
    const mergeSeq = (await versions("big"))[0].seq;
    // The row keeps growing after the merge (still well inside D1's 2 MB row).
    expect(await appendToEntry(e, "big", "", "g".repeat(950_000), [], "api", DEFAULTS, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, change())).toBe(true);
    // First rollback: the version row needs a full 1.85 MB copy, so recreated_incoming is dropped.
    expect((await revertEntry(e, owner, "big", change(), DEFAULTS, mergeSeq)).status).toBe("reverted");
    expect(live(incoming)).toHaveLength(1);
    // Undo the rollback, then roll back to the merge again.
    expect((await revertEntry(e, owner, "big", change(), DEFAULTS)).status).toBe("reverted");
    expect((await revertEntry(e, owner, "big", change(), DEFAULTS, mergeSeq)).status).toBe("reverted");
    expect(live(incoming)).toHaveLength(1); // actual: 2
  }, 120_000);
});

describe("ADV-U20 (MINOR): keptIncoming says a row is kept after it has been deleted forever", () => {
  it("redo does not report a deleted row as 'kept as its own memory'", async () => {
    const e = mergingEnv("old");
    await seed("old", { content: "Old text", tags: ["work"] });
    await capture(e, "Incoming fact");
    const x = ((await revertEntry(e, owner, "old", change(), DEFAULTS)) as any).recreatedIncomingId as string;
    await deleteForever(e, { id: x }, change());
    const redo = await revertEntry(e, owner, "old", change(), DEFAULTS);
    expect(row(x)).toBeUndefined();
    // Task 15 will turn this into user-facing text; it must not claim a memory exists that does not.
    const claim = ((redo as any).keptIncoming ?? []).find((k: any) => k.id === x);
    expect(claim?.reason).not.toBe("kept as its own memory"); // actual: "kept as its own memory" (test/integration/adv-undo-r3.test.ts U16 pins it)
  });
});
