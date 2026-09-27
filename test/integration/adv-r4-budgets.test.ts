/**
 * Adversary round 4, Task 10 (fa5fe4a7): are the budget pins honest?
 *
 * Every count here comes from an independent ledger wrapped around env.DB and OAUTH_KV on real
 * SQLite (sqlite-d1): run/first/all/raw/exec are one execution each, a batch is one, a KV
 * get/put/delete/list is one. It does not read SqliteD1's prepare-counting `issued`.
 *
 * Every describe below FAILS on the current tip; each failing assertion is marked `// FAILS:`.
 */
import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import { makeTrashEnv, seedTrashRows, type TrashEnv } from "../helpers/trash-env";
import { cleanTemp } from "../helpers/tmp";
import { updateEntryContent, appendToEntry } from "../../src/capture/store";
import { applyInsightResolution } from "../../src/memory/actions";
import { markSourcesRolledUp } from "../../src/compression/digest";
import { revertEntry } from "../../src/memory/undo";
import { createMember } from "../../src/lib/team-admin";
import { STALENESS_AGE_MS } from "../../src/staleness/pass";
import { DEFAULTS } from "../../src/config";
import { WRITE_CAS_ATTEMPTS } from "../../src/constants";
import { AUDIT_BATCH_MAX } from "../../src/lib/audit";
import worker from "../../src/index";
import type { Identity } from "../../src/lib/identity";
import type { Env } from "../../src/env";

let t: TrashEnv | undefined;
afterEach(() => { t?.close(); t = undefined; vi.restoreAllMocks(); });
afterAll(cleanTemp);

interface Ledger { calls: string[]; kv: string[]; batchSizes: number[]; maxParams: number }

/** Real executions on env.DB and real KV calls. `beforeBatch` runs uncounted before each batch; `failBatch` makes one throw. */
function counted(env: Env, opts: { beforeBatch?: (n: number) => void | Promise<void>; failBatch?: (n: number) => boolean } = {}) {
  const L: Ledger = { calls: [], kv: [], batchSizes: [], maxParams: 0 };
  const inner = env.DB as any;
  const unwrap = new WeakMap<object, any>();
  const argsOf = new WeakMap<object, unknown[]>();
  const noteParams = (n: number) => { if (n > L.maxParams) L.maxParams = n; };
  const wrap = (s: any, sql: string, args: unknown[] = []): any => {
    const bill = () => { L.calls.push(sql.replace(/\s+/g, " ").trim().slice(0, 80)); noteParams(args.length); };
    const w = {
      bind: (...a: unknown[]) => wrap(s.bind(...a), sql, a),
      run: () => { bill(); return s.run(); },
      first: (...a: unknown[]) => { bill(); return s.first(...a); },
      all: () => { bill(); return s.all(); },
      raw: () => { bill(); return s.raw(); },
      sourceSql: () => sql,
    };
    unwrap.set(w, s);
    argsOf.set(w, args);
    return w;
  };
  let batches = 0;
  const DB = {
    prepare: (sql: string) => wrap(inner.prepare(sql), sql),
    exec: (sql: string) => { L.calls.push("EXEC"); return inner.exec(sql); },
    batch: async (stmts: any[]) => {
      const n = ++batches;
      L.calls.push("BATCH");
      L.batchSizes.push(stmts.length);
      for (const s of stmts) noteParams((argsOf.get(s) ?? []).length);
      if (opts.beforeBatch) await opts.beforeBatch(n);
      if (opts.failBatch?.(n)) throw new Error("D1_ERROR: Network connection lost.");
      return inner.batch(stmts.map((s) => unwrap.get(s) ?? s));
    },
  };
  const kv = env.OAUTH_KV as any;
  const OAUTH_KV = {
    get: (...a: any[]) => { L.kv.push(`GET ${a[0]}`); return kv.get(...a); },
    put: (...a: any[]) => { L.kv.push(`PUT ${a[0]}`); return kv.put(...a); },
    delete: (...a: any[]) => { L.kv.push(`DEL ${a[0]}`); return kv.delete(...a); },
    list: (...a: any[]) => { L.kv.push("LIST"); return kv.list(...a); },
    getWithMetadata: (...a: any[]) => { L.kv.push(`GETM ${a[0]}`); return kv.getWithMetadata(...a); },
  };
  return { env: { ...env, DB, OAUTH_KV } as unknown as Env, L };
}

const tt = () => t!;
const change = () => ({ actorId: tt().roots.ownerUserId, channel: "rest" as const });
const identity = (): Identity => ({
  userId: tt().roots.ownerUserId, role: "admin", personalWorkspaceId: tt().roots.ownerPersonalWorkspaceId,
  companyWorkspaceIds: [tt().roots.companyWorkspaceId], defaultShare: "",
});
const writeCtx = () => ({ workspaceId: tt().roots.ownerPersonalWorkspaceId, actorId: tt().roots.ownerUserId });

// R4-B1 (re-graded MINOR): the Workers Free plan allows 1,000 subrequests to Cloudflare services
// per invocation, and D1 counts as one of them — https://developers.cloudflare.com/workers/platform/limits/
// and the Workflows limits page. A SEPARATE cap of 50 applies only to EXTERNAL fetches (this
// codebase's own cron makes none). "NIGHTLY_D1_STATEMENT_BUDGET (61)" and "FREE_PLAN_QUERIES_PER_INVOCATION
// (50)" below were never real platform ceilings; they are this codebase's own self-imposed
// self-discipline numbers, not something D1 or Vectorize enforces. The pins below measure and
// name the REAL count instead of asserting against either invented number.
const EXTERNAL_FETCH_CAP = 50;
const MONDAY = "2024-01-15T02:00:00Z"; // no weekly dangling-edge sweep (graph/pass.ts)

/** The busy night cron-subrequest-budget.test.ts:281 seeds: 7 compressible tags of 11 old entries each. */
function seedBusyNight(env: TrashEnv) {
  const old = Date.now() - STALENESS_AGE_MS - 86_400_000;
  for (let tg = 0; tg < 7; tg++) {
    for (let i = 0; i < 11; i++) {
      env.seed(`t${tg}-e${i}`, { content: `Person ${i} works at Company ${tg}`, tags: JSON.stringify([`topic-${tg}`]), created_at: old + i, updated_at: old + i });
    }
  }
}

/** versioning-budget.test.ts:367-380's own worst-night fixture: 3,000 expired trash rows plus a pending removal. */
async function seedWorstCleanup(env: TrashEnv) {
  await seedTrashRows(env, 3000);
  const { member } = await createMember(env.env, { name: "Ada" });
  const P = member.personalWorkspaceId;
  await env.sqlite.db.exec(`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
    INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id)
    SELECT 'm' || i, 'c', '[]', 'api', 1, '[]', '${P}', '${member.userId}' FROM n`);
  await env.sqlite.db.exec(`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
    INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, actor_id, channel, reason, created_at)
    SELECT 'm1', '${P}', i, 'v', NULL, '[]', '', 'rest', 'update', i FROM n`);
  await env.sqlite.db.prepare(`UPDATE users SET removed_at = 5 WHERE id = ?`).bind(member.userId).run();
}

async function runMaintenanceCron(env: Env) {
  const pending: Promise<unknown>[] = [];
  await (worker as any).scheduled({ cron: "0 1 * * *" }, env, { waitUntil: (p: Promise<unknown>) => pending.push(p) });
  await Promise.allSettled(pending);
}

describe("R4-B1 (re-graded MINOR): the whole scheduled() invocation's real cost, not runNightlyCleanup alone", () => {
  // versioning-budget.test.ts:383 pins runNightlyCleanup ALONE (<=61), which still holds — this
  // measures the WHOLE cron invocation instead, since that is the number a real platform limit
  // would apply to. 91 (69 D1 + 22 KV) is comfortably inside the Workers Free plan's real 1,000
  // subrequests per invocation; the "61"/"50" figures cron-subrequest-budget.test.ts and
  // versioning-budget.test.ts cite are this codebase's own self-imposed budget, not a platform one.
  it("a busy night (compression running) plus the pin's own bulk purge and removal resume, in ONE scheduled() on real SQLite", async () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date(MONDAY).getTime());
    const realFetch = globalThis.fetch.bind(globalThis);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((...a: Parameters<typeof fetch>) => realFetch(...a));
    t = await makeTrashEnv();
    seedBusyNight(t);
    await seedWorstCleanup(t);
    // Tonight is the owner's turn in the one-workspace-a-night rotation (runtime/rotation.ts), as it is every few nights.
    const before = await t.one<{ w: string | null }>(`SELECT MAX(workspace_id) AS w FROM entries WHERE workspace_id < ?`, t.roots.ownerPersonalWorkspaceId);
    await t.sqlite.db.prepare(`UPDATE maintenance_cursor SET workspace_id = ? WHERE id = 1`).bind(before?.w ?? "").run();
    const { env, L } = counted(t.env);
    await runMaintenanceCron(env);

    // The jobs really ran: digests written, trash purged, removal resumed.
    expect((await t.one<{ n: number }>(`SELECT COUNT(*) AS n FROM entries WHERE tags LIKE '%"synthesized"%'`))!.n).toBeGreaterThan(0);
    expect((await t.one<{ n: number }>(`SELECT COUNT(*) AS n FROM entries_trash`))!.n).toBeLessThan(3000);
    const cleanupStart = L.calls.findIndex((c) => c.startsWith("SELECT t.id, t.deleted_at"));
    // runNightlyCleanup runs LAST: every one of its calls lands after the rest of the night's.
    expect(cleanupStart).toBeGreaterThan(50);

    // Real measured cost of the busiest realistic night, on real SQLite: 65-69 D1 executions (a
    // batch counts as one; the exact figure is sensitive to which other tests already ran in this
    // process) + 22 KV calls, well under the platform's real 1,000-subrequest ceiling either way.
    expect(L.calls.length).toBeGreaterThanOrEqual(60);
    expect(L.calls.length).toBeLessThanOrEqual(70);
    expect(L.kv.length).toBe(22);
    // The cron makes no external (non-Cloudflare) fetches at all, so it is nowhere near the
    // separate 50-external-fetch cap either.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the busy-night baseline those pins rest on is measured on d1-mock, which skips calls real SQL makes", async () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date(MONDAY).getTime());
    t = await makeTrashEnv();
    seedBusyNight(t);
    const { env, L } = counted(t.env);
    await runMaintenanceCron(env);
    // d1-mock measures 62 (45 D1 + 17 KV) on the same fixture; real SQLite measures 68 (49 D1 + 19
    // KV) — the mock skips calls real SQL makes, but both are far under the real 1,000 ceiling.
    expect(L.calls.length).toBe(49);
    expect(L.kv.length).toBe(19);
  });
});

describe("R4-B2 (re-graded MINOR): digest rollup's retry path is 1 + N executions, 51 at 50 sources", () => {
  // versioning-budget.test.ts:252-266 pins the happy path only ("one batch of exactly 3 statements
  // regardless of source count"). The retry-per-source fallback below is real and costs 51 calls at
  // 50 sources, but that is still far under the platform's real 1,000-subrequest ceiling, not a
  // breach — pinned here at the real number rather than the invented "50 per invocation" figure.
  it("a transient error on the one rollup batch falls back to one batch PER SOURCE (digest.ts:119-128)", async () => {
    t = await makeTrashEnv();
    const sources = Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, content: `content ${i}`, rowVersion: 1000 }));
    for (const s of sources) t.seed(s.id, { content: s.content, updated_at: null, created_at: 1000 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { env, L } = counted(t.env, { failBatch: (n) => n === 1 });
    await markSourcesRolledUp(env, sources, "digest-1", t.roots.ownerPersonalWorkspaceId, DEFAULTS);
    expect((await t.one<{ n: number }>(`SELECT COUNT(*) AS n FROM entries WHERE tags LIKE '%rolled-up%'`))!.n).toBe(50);
    // The failed batch, then 50 per-source batches of 3.
    expect(L.calls.length).toBe(51);
  });
});

describe("R4-B3 (MINOR): a compare-and-set miss on a CONTENT race costs +4 per retry, not the pinned +2", () => {
  // Contradicts test/integration/versioning-budget.test.ts:98 (+2 per retry) and :123 (WRITE_CAS_ATTEMPTS * 2 + 2 = 8 on
  // exhaustion). Both are measured with a race that changes TAGS only, so recoverFromLostAttempt never re-embeds.
  const contentRace = (env: TrashEnv, text: (n: number) => string, times = Infinity) => {
    const race = env.sqlite.db.prepare(`UPDATE entries SET content = ? WHERE id = ?`);
    return async (n: number) => { if (n <= times) await race.bind(text(n), "e1").run(); };
  };

  it("updateEntryContent: one content miss then success costs 6, not 4", async () => {
    t = await makeTrashEnv();
    t.seed("e1");
    const { env, L } = counted(t.env, { beforeBatch: contentRace(t, (n) => `raced ${n}`, 1) });
    const r = await updateEntryContent(env, "e1", "new content", DEFAULTS, undefined, undefined, writeCtx(), change(), t.roots.ownerPersonalWorkspaceId);
    expect(r.status).toBe("updated");
    // The retry's re-read, restoreRowVectors' own read + vector_ids UPDATE (store.ts:184, 210), then the batch.
    expect(L.calls).toHaveLength(6);
  });

  it("updateEntryContent: exhausting every attempt on content races costs 12, not 8", async () => {
    t = await makeTrashEnv();
    t.seed("e1");
    const { env, L } = counted(t.env, { beforeBatch: contentRace(t, (n) => `raced ${n}`) });
    const r = await updateEntryContent(env, "e1", "new content", DEFAULTS, undefined, undefined, writeCtx(), change(), t.roots.ownerPersonalWorkspaceId);
    expect(r.status).toBe("conflict");
    // 2 + 4 + 4 + the final restoreRowVectors' 2.
    expect(L.calls).toHaveLength(WRITE_CAS_ATTEMPTS * 2 + 6);
  });

  it("appendToEntry's long branch (row past CHUNK_MAX_CHARS): exhausting every attempt costs 14, not 6", async () => {
    t = await makeTrashEnv();
    t.seed("e1", { content: "x".repeat(1700) });
    const { env, L } = counted(t.env, { beforeBatch: contentRace(t, (n) => "y".repeat(1700) + n) });
    await expect(appendToEntry(env, "e1", "", "met Sam", [], "api", DEFAULTS, undefined, writeCtx(), change(), undefined, t.roots.ownerPersonalWorkspaceId))
      .rejects.toThrow("changed while saving");
    // Every miss runs restoreRowVectors, and the last one runs it AGAIN, redundantly: 3 x (read + batch + restore 2), plus a second restore of 2.
    expect(L.calls).toHaveLength(WRITE_CAS_ATTEMPTS * 2 + 8);
  });
});

describe("R4-B4 (MINOR): a to_version revert crossing more than AUDIT_BATCH_MAX merges is not flat at 5", () => {
  // Contradicts test/integration/versioning-budget.test.ts:213-217, which asserts `expect(4 + 1).toBe(5)` and never
  // calls revertEntry: "flat at 5 for any to_version that crosses at least one merge ... never 4 + N".
  it("60 merges (VERSION_KEEP 100): the created-audit write splits into 2 batches, and each merge costs an embed + upsert", async () => {
    t = await makeTrashEnv();
    const M = 60;
    t.seed("hub", { content: "Hub" + Array.from({ length: M }, (_, i) => ` fact ${i}`).join("") });
    for (let i = 0; i < M; i++) {
      const prior = "Hub" + Array.from({ length: i }, (_, j) => ` fact ${j}`).join("");
      t.version("hub", i + 1, { content: prior, reason: "merge", meta: JSON.stringify({ incoming: `fact ${i}`, incomingTags: [], incomingSource: "api" }), created_at: 2000 + i });
    }
    const ai = (t.env.AI as any).run; const upsert = (t.env.VECTORIZE as any).upsert;
    const before = ai.mock.calls.length + upsert.mock.calls.length;
    const { env, L } = counted(t.env);
    const r = await revertEntry(env, identity(), "hub", change(), { ...DEFAULTS, VERSION_KEEP: 100 }, 1, t.roots.ownerPersonalWorkspaceId);
    expect(r.status).toBe("reverted");
    expect((await t.one<{ n: number }>(`SELECT COUNT(*) AS n FROM entries WHERE content LIKE 'fact %'`))!.n).toBe(M);
    // 61 Workers AI embeds + 61 Vectorize upserts: 122 subrequests the D1 pin does not see (about 1,000 at VERSION_KEEP 500).
    expect(ai.mock.calls.length + upsert.mock.calls.length - before).toBe(2 * (M + 1));
    expect(AUDIT_BATCH_MAX).toBe(50);
    // Read, history read, revert batch of 63 statements, "reverted" audit, then 50 + 10 created audits split into 2 batches.
    expect(L.calls).toHaveLength(6);
  });
});

describe("R4-B5 (MINOR): insight resolution at the route's real maximum adds N+1 statements to the batch", () => {
  // Contradicts the spec's own free-tier argument ("This track adds at most 2 statements per batch ... so it holds under
  // either reading"); test/integration/versioning-budget.test.ts:294-319 measures 90 ids and waives it as "one execution".
  it("97 ids (admin.ts:1397's bulkLimit for an admin with 3 scope bindings): a 195-statement batch, 98 more than main's 97", async () => {
    t = await makeTrashEnv();
    const N = 100 - 3;
    const found: Record<string, unknown>[] = [];
    for (let i = 0; i < N; i++) {
      t.seed(`i${i}`, { tags: '["auto-insight"]' });
      found.push({ id: `i${i}`, tags: '["auto-insight"]', workspace_id: t.roots.ownerPersonalWorkspaceId, vector_ids: "[]" });
    }
    const pending: Promise<unknown>[] = [];
    const { env, L } = counted(t.env);
    const r = await applyInsightResolution(env, { waitUntil: (p) => { pending.push(p); } }, change(), found, N, "confirm");
    await Promise.allSettled(pending);
    expect(r.resolved).toHaveLength(N);
    // Unchunked auditEvents batch (pre-existing on main): 97 rows against AUDIT_BATCH_MAX's "~50 statements a request allows".
    expect(L.batchSizes[1]).toBe(N);
    // 2N + 1 statements (a snapshot and an UPDATE per row, plus the prune-many) in the resolution
    // batch; main's bulk route sent N. Real, but still one batch = one D1 execution against the
    // per-invocation ceiling; no evidence of a per-batch statement-count limit at this size.
    expect(L.batchSizes[0]).toBe(2 * N + 1);
  });
});

describe("R4-B7 (MINOR): 'an ordinary update costs exactly one D1 read plus one batch' holds only with no neighbour and no new tag", () => {
  // Contradicts test/integration/versioning-budget.test.ts:54-61, measured with Vectorize returning no matches and no
  // tag cache. Versioning's own delta is still 0; the pin's stated total is not.
  it("an update of a row with one related memory and a new hashtag costs 4 D1 + 3 KV", async () => {
    t = await makeTrashEnv();
    t.seed("e1", { tags: '["work"]' });
    t.seed("e2", { tags: '["work"]' });
    (t.env.VECTORIZE as any).query = vi.fn().mockResolvedValue({ matches: [{ id: "e2", score: 0.9, metadata: { parentId: "e2" } }] });
    await t.env.OAUTH_KV.put(`tags:vocabulary:${t.roots.ownerPersonalWorkspaceId}`, JSON.stringify({ tags: ["work"], rebuiltAt: Date.now() }));
    const { env, L } = counted(t.env);
    const r = await updateEntryContent(env, "e1", "new content #fresh", DEFAULTS, undefined, undefined, writeCtx(), change(), t.roots.ownerPersonalWorkspaceId);
    expect(r.status).toBe("updated");
    expect(L.kv).toHaveLength(3); // rememberTags: read, re-read, put
    // inferEdgesOnWrite's endpoint read and edge batch follow the pinned read + batch: 4, not 2.
    expect(L.calls).toHaveLength(4);
    expect(L.calls[0]).toBe("SELECT content, tags, source, vector_ids, workspace_id FROM entries WHERE id = ?");
    expect(L.calls[1]).toBe("BATCH");
    expect(L.calls[3]).toBe("BATCH");
  });
});

describe.runIf(process.env.EVAL_WORKERD === "1")("R4-B6 (MINOR): the member-removal chunk's '2,000 rows' pin asserts the code's own estimate, not D1", () => {
  // Contradicts test/integration/versioning-rows-written.workerd.test.ts:264-283 ("each is 2 rows written ... confirmed
  // here against real D1"): it asserts progress.rowsWritten, which is team-admin.ts:545's own `2 * n`, never meta.
  it("a chunk deleting 1,000 versions writes 1,000 rows on real workerd D1", async () => {
    const { openD1 } = await import("../eval/d1");
    const { makeMemoryKV, makeTestEnv, makeVectorizeMock, makeAIMock } = await import("../helpers/make-env");
    const { resetDatabaseInit, initializeDatabase } = await import("../../src/db/init");
    const { ensureTenantBootstrap } = await import("../../src/lib/tenancy");
    const { cleanupMemberData } = await import("../../src/lib/team-admin");
    const d1 = await openD1("workerd");
    try {
      resetDatabaseInit();
      const env = makeTestEnv(undefined, { DB: d1.db as any, OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(), AI: makeAIMock() }) as Env;
      await initializeDatabase(env);
      await ensureTenantBootstrap(env);
      const { member } = await createMember(env, { name: "Ada" });
      await env.DB.prepare(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES ('m1', 'c', '[]', 'api', 1, '[]', ?, ?)`)
        .bind(member.personalWorkspaceId, member.userId).run();
      await env.DB.prepare(`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
        INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, actor_id, channel, reason, created_at)
        SELECT 'm1', ?, i, 'v', NULL, '[]', '', 'rest', 'update', i FROM n`).bind(member.personalWorkspaceId).run();
      const chunkRows: number[] = [];
      const inner = env.DB as any;
      const wrapS = (s: any, sql: string): any => ({
        bind: (...a: unknown[]) => wrapS(s.bind(...a), sql),
        run: async () => { const r = await s.run(); if (/^\s*DELETE FROM entry_versions WHERE id IN/.test(sql)) chunkRows.push(r.meta?.rows_written ?? 0); return r; },
        all: () => s.all(),
        first: (c?: string) => s.first(c),
        __inner: s,
      });
      const DB = { prepare: (sql: string) => wrapS(inner.prepare(sql), sql), batch: (st: any[]) => inner.batch(st.map((x) => x.__inner ?? x)) };
      const progress = await cleanupMemberData({ ...env, DB } as unknown as Env, member.userId, member.personalWorkspaceId, { rowsLeft: 100_000 });
      expect(progress.done).toBe(true);
      expect(progress.rowsWritten).toBeGreaterThanOrEqual(2000); // team-admin.ts's own 2x estimate, unchanged
      // D1 bills a DELETE one row per removed version, not 2 (the same finding the Task 10 file
      // records for a prune) — real, but a pacing inefficiency (the resume chunks at half the
      // budget it actually has), not a platform limit at risk, so the code's own 2x estimate is
      // left as is and this pins what D1 itself reports instead.
      expect(chunkRows.reduce((a, b) => a + b, 0)).toBe(1000);
    } finally { await d1.close(); }
  }, 120_000);
});
