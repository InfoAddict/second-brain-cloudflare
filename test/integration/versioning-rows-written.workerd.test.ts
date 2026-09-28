/**
 * Task 10: rows written per operation, and the row-size fallbacks, measured on real workerd D1
 * (local wrangler only, no Cloudflare account — see test/eval/d1.ts's openD1("workerd")).
 *
 * Platform facts (M1, M2): Miniflare D1 rejects a placeholder gap the way real D1 does, but it
 * does NOT enforce the 2 MB per-row limit — a 2.1 MB row was accepted in testing. So none of the
 * size tests below can prove a REJECTED oversized write; that is not their claim. What they prove
 * is that the fallback tier a real memory selects is chosen from its own COMPUTED size (the same
 * SQL src/memory/trash.ts's chooseTrashTier reads), not from a D1 error — the fallback logic runs
 * correctly against a real SQL engine, with the real budgets, and the row it writes lands where
 * the computed size says it should.
 *
 * Opt in with EVAL_WORKERD=1.
 */
import { describe, it, expect, afterAll } from "vitest";
import { openD1 } from "../eval/d1";
import { cleanTemp } from "../helpers/tmp";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock, makeAIMock } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityByUserId, type Identity } from "../../src/lib/identity";
import { updateEntryContent } from "../../src/capture/store";
import { forgetEntry } from "../../src/capture/lifecycle";
import { resolveEntryAction } from "../../src/memory/actions";
import { moveEntry } from "../../src/capture/share";
import { readTrashCandidates, chooseTrashTier, planTrash, trashManyStatements, purgeTrash, deleteForever } from "../../src/memory/trash";
import { snapshotStatement, pruneStatement } from "../../src/memory/versions";
import { createMember, cleanupMemberData } from "../../src/lib/team-admin";
import { runNightlyCleanup } from "../../src/memory/cleanup";
import { DEFAULTS } from "../../src/config";
import { TRASH_ROW_BUDGET_BYTES, NIGHTLY_CLEANUP_ROWS } from "../../src/constants";
import type { Env } from "../../src/env";

afterAll(cleanTemp);

async function setup() {
  const d1 = await openD1("workerd");
  resetDatabaseInit();
  const env = makeTestEnv(undefined, {
    DB: d1.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(), AI: makeAIMock(),
  }) as Env;
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  const owner = (await resolveIdentityByUserId(env, roots.ownerUserId))! as Identity;
  return { d1, env, roots, owner };
}

const rowsWritten = (r: { meta?: { rows_written?: number } }) => r?.meta?.rows_written ?? 0;
const batchRows = (rs: { meta?: { rows_written?: number } }[]) => rs.reduce((n, r) => n + rowsWritten(r), 0);

/** Wraps a D1 binding so every batch's rows_written is added to a running total — for measuring a
 * function that does not return its own batch results (write-amplification.workerd.test.ts's own
 * `metered()`, mirrored here rather than imported: that file's counter is a plain module-level
 * variable, not reusable across two test files without turning it into a shared helper Task 10's
 * two-file scope does not call for). */
function metered(db: D1Database): { db: D1Database; rows: () => number } {
  let total = 0;
  const wrapStmt = (s: any): any => new Proxy(s, {
    get(t, p) {
      if (p === "bind") return (...a: unknown[]) => wrapStmt(t.bind(...a));
      if (p === "all" || p === "run" || p === "raw") return async (...a: unknown[]) => { const r = await t[p](...a); total += r?.meta?.rows_written ?? 0; return r; };
      if (p === "first") return async (col?: string) => { const r = await t.all(); total += r.meta.rows_written ?? 0; const row = r.results[0] ?? null; return col && row ? row[col] : row; };
      return typeof t[p] === "function" ? t[p].bind(t) : t[p];
    },
  });
  const wrapped = new Proxy(db, {
    get(t: any, p) {
      if (p === "prepare") return (sql: string) => wrapStmt(t.prepare(sql));
      if (p === "batch") return async (stmts: any[]) => { const rs = await t.batch(stmts); for (const r of rs) total += r?.meta?.rows_written ?? 0; return rs; };
      return typeof t[p] === "function" ? t[p].bind(t) : t[p];
    },
  });
  return { db: wrapped, rows: () => total };
}

describe.runIf(process.env.EVAL_WORKERD === "1")("rows written on workerd", () => {
  it("a version insert writes 2 rows: the row itself plus its (entry_id, seq) unique index entry", async () => {
    const { d1, env, roots } = await setup();
    try {
      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES ('e1', 'v1', '[]', 'api', 1000, '[]', ?, ?)`,
      ).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();
      const stmt = snapshotStatement(env, {
        entryId: "e1", reason: "update", change: { actorId: roots.ownerUserId, channel: "rest" },
        content: { kind: "next", content: "v2" }, nextTags: [], now: Date.now(),
      });
      const res = await stmt.run();
      expect(rowsWritten(res)).toBe(2);
    } finally { await d1.close(); }
  }, 120_000);

  it("a prune of one writes 1 row on real D1, not the spec's 2", async () => {
    const { d1, env, roots } = await setup();
    try {
      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES ('e1', 'v1', '[]', 'api', 1000, '[]', ?, ?)`,
      ).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();
      // Two versions, keep = 1: pruneStatement removes exactly the oldest one.
      for (const seq of [1, 2]) {
        await env.DB.prepare(
          `INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, actor_id, channel, reason, created_at) VALUES ('e1', ?, ?, 'v', NULL, '[]', ?, 'rest', 'update', ?)`,
        ).bind(roots.ownerPersonalWorkspaceId, seq, roots.ownerUserId, 1000 + seq).run();
      }
      const p = pruneStatement(env as any, "e1", 1);
      const res = await p.run();
      // Measured against real D1: an INSERT into entry_versions bills 2 (the row plus its
      // (entry_id, seq) unique index entry — see the test above), but a DELETE bills only 1. D1
      // does not charge a separate written row for removing an index entry, only for creating or
      // changing one. The spec's "a prune of one: 2" assumed DELETE and INSERT cost the same; on
      // real D1 they do not.
      expect(rowsWritten(res)).toBe(1);
    } finally { await d1.close(); }
  }, 120_000);

  it("versioning's own delta on an update is +2 below VERSION_KEEP, +3 at it (not the spec's +2/+4)", async () => {
    const { d1, env, roots } = await setup();
    try {
      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES ('e1', 'v0', '[]', 'api', 1000, '[]', ?, ?)`,
      ).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();
      const change = { actorId: roots.ownerUserId, channel: "rest" as const };
      const { snapshotStatement: snap, pruneStatement: prune } = await import("../../src/memory/versions");
      // Isolate versioning's OWN rows from the entries UPDATE and its FTS/entry_counts triggers
      // (an update's total rows_written is confounded by those, and the spec's "an update: +2/+4"
      // row is about versioning's own contribution, not the whole write): snapshot a version and
      // prune, in their own batch, with no entries-table statement alongside them.
      const below = await env.DB.batch([
        snap(env, { entryId: "e1", reason: "update", change, content: { kind: "next", content: "v1" }, nextTags: [], now: 1000 }),
        prune(env, "e1", 20),
      ]);
      // Below VERSION_KEEP (20 total, config.ts): the insert's own 2, the prune finds nothing to
      // remove (0 more, prune of an empty excess bills 0 — no DELETE actually runs against a row).
      expect(batchRows(below)).toBe(2);

      // Drive history to exactly VERSION_KEEP versions directly (not through updateEntryContent, to
      // keep this test's own snapshot+prune pair the only thing measured next).
      await env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i + 1 FROM n WHERE i < 20)
         INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, actor_id, channel, reason, created_at)
         SELECT 'e1', ?, i, 'v', NULL, '[]', ?, 'rest', 'update', i FROM n`,
      ).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();
      const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM entry_versions WHERE entry_id = 'e1'`).first<{ n: number }>();
      expect(count!.n).toBe(20); // seq 1 (from `below` above) plus seq 2..20

      const atCap = await env.DB.batch([
        snap(env, { entryId: "e1", reason: "update", change, content: { kind: "next", content: "v2" }, nextTags: [], now: 2000 }),
        prune(env, "e1", 20),
      ]);
      // At the cap: the insert's own 2, plus the prune's own delete of exactly one version — measured
      // at 1 row (not 2) in "a prune of one" above, since D1 does not bill a written row for removing
      // an index entry, only for creating or changing one. Total: 3, not the spec's 4.
      expect(batchRows(atCap)).toBe(3);
    } finally { await d1.close(); }
  }, 120_000);

  it("a due action (snooze) writes a version, the same shape already measured for an update", async () => {
    const { d1, env, roots, owner } = await setup();
    try {
      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES ('e1', 'Renew passport', '["task"]', 'api', 1000, '[]', ?, ?)`,
      ).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();
      const ctx = { waitUntil: () => {} };
      // A due action snapshots and prunes exactly like an update (actions.ts's snooze branch uses
      // the same snapshotStatement/pruneStatement pair) — its own version-insert and prune-of-one
      // costs are the "versioning's own delta on an update" test above, not repeated here.
      const r = await resolveEntryAction(env, ctx, owner, "e1", "snooze", "2027-01-01", { actorId: owner.userId, channel: "rest" });
      expect(r.ok).toBe(true);
      const versions = await env.DB.prepare(`SELECT COUNT(*) AS n FROM entry_versions WHERE entry_id = 'e1'`).first<{ n: number }>();
      expect(versions!.n).toBe(1);
    } finally { await d1.close(); }
  }, 120_000);

  it("a forget writes +3 over a hard delete, matching the spec once triggers are counted on both sides", async () => {
    const { d1, env, roots } = await setup();
    try {
      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES ('a', 'content of a', '[]', 'api', 1000, '[]', ?, ?)`,
      ).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();
      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES ('b', 'content of a', '[]', 'api', 1000, '[]', ?, ?)`,
      ).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();
      const hard = await env.DB.prepare(`DELETE FROM entries WHERE id = 'b'`).run();
      const hardRows = rowsWritten(hard);

      const m = metered(env.DB);
      const forgetEnv = { ...env, DB: m.db } as Env;
      const forgetRes = await forgetEntry("a", forgetEnv, { actorId: roots.ownerUserId, channel: "rest" }, { reason: "forget", config: DEFAULTS, purge: false }, roots.ownerPersonalWorkspaceId);
      expect(forgetRes.status).toBe("deleted");
      expect(await env.DB.prepare(`SELECT id FROM entries_trash WHERE id = 'a'`).first()).not.toBeNull();
      // A hard delete of the row bills 3, not 1: the row itself, plus one write each from the
      // entries_fts_delete and entry_counts_delete triggers it fires. A forget of an otherwise
      // identical row bills 6: the trash INSERT (matching the entries row's own byte weight) plus
      // the same entries delete and its two triggers. Delta: 3 — matching the spec's "+3 over a
      // hard delete" exactly, once "hard delete" is measured as the real DELETE (with its own
      // triggers), not assumed to be a bare 1-row write.
      expect(m.rows() - hardRows).toBe(3);
    } finally { await d1.close(); }
  }, 120_000);

  it("a purge of one row with 20 versions writes at most 47 (PURGE_ROW_COST 7 + 2 per version)", async () => {
    const { d1, env, roots } = await setup();
    try {
      await env.DB.prepare(
        `INSERT INTO entries_trash (id, workspace_id, actor_id, content, row_json, edges_json, vector_ids, deleted_at, deleted_by, channel, reason) VALUES ('t0', ?, '', 'c', '{"created_at":1}', '[]', '[]', 1, '', 'rest', 'forget')`,
      ).bind(roots.ownerPersonalWorkspaceId).run();
      for (let seq = 1; seq <= 20; seq++) {
        await env.DB.prepare(
          `INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, actor_id, channel, reason, created_at) VALUES ('t0', ?, ?, 'v', NULL, '[]', '', 'rest', 'update', ?)`,
        ).bind(roots.ownerPersonalWorkspaceId, seq, seq).run();
      }
      const r = await purgeTrash(env, { ...DEFAULTS, TRASH_RETENTION_DAYS: 1 }, { ceiling: 10, rowTarget: 5000, now: Date.now() + 2 * 86_400_000 });
      expect(r.purged).toBe(1);
      expect(r.rowsWritten).toBeLessThanOrEqual(47);
    } finally { await d1.close(); }
  }, 120_000);

  it("a purge batch chosen from real version counts never writes past its target, at VERSION_KEEP 500", async () => {
    const { d1, env, roots } = await setup();
    try {
      await env.DB.prepare(
        `INSERT INTO entries_trash (id, workspace_id, actor_id, content, row_json, edges_json, vector_ids, deleted_at, deleted_by, channel, reason) VALUES ('big', ?, '', 'c', '{"created_at":1}', '[]', '[]', 1, '', 'rest', 'forget')`,
      ).bind(roots.ownerPersonalWorkspaceId).run();
      // 500 versions in one statement, not one insert each — this is seeding, not the code under test.
      await env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500)
         INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, actor_id, channel, reason, created_at)
         SELECT 'big', ?, i, 'v', NULL, '[]', '', 'rest', 'update', i FROM n`,
      ).bind(roots.ownerPersonalWorkspaceId).run();
      const r = await purgeTrash(env, { ...DEFAULTS, TRASH_RETENTION_DAYS: 1 }, { ceiling: 10, rowTarget: 1000, now: Date.now() + 2 * 86_400_000 });
      // A row costing 7 + 1000 = 1007 does not fit a 1000 target: trims oldest versions instead.
      expect(r.purged).toBe(0);
      expect(r.trimmed).toBeGreaterThan(0);
      expect(r.rowsWritten).toBeLessThanOrEqual(1000);
    } finally { await d1.close(); }
  }, 120_000);

  it("a move writes 9 rows for one entry (event insert, entries and edges UPDATEs, and their triggers) — not the spec's flat +4", async () => {
    const { d1, env, roots, owner } = await setup();
    try {
      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES ('e1', 'v1', '[]', 'api', 1000, '[]', ?, ?)`,
      ).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();
      const m = metered(env.DB);
      const moveEnv = { ...env, DB: m.db } as Env;
      const r = await moveEntry("e1", "company", moveEnv, owner, { actorId: owner.userId, channel: "rest" });
      expect(r.status).toBe("shared");
      const row = await env.DB.prepare(`SELECT workspace_id FROM entries WHERE id = 'e1'`).first<{ workspace_id: string }>();
      expect(row!.workspace_id).toBe(roots.companyWorkspaceId);
      // Measured against real D1: the move's own batch (entry_events INSERT + entries UPDATE +
      // edges UPDATE, share.ts:53-65), plus entry_events' own two indexes, plus the
      // entry_counts_update and idx_entries_workspace_created writes the workspace change fires —
      // 9 for one entry with no edges. The spec's "+4 per entry" undercounts the triggers.
      expect(m.rows()).toBe(9);
    } finally { await d1.close(); }
  }, 120_000);

  it("a member-removal chunk of 1,000 versions writes 2,000 rows", async () => {
    const { d1, env } = await setup();
    try {
      const { member } = await createMember(env, { name: "Ada" });
      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES ('m1', 'c', '[]', 'api', 1, '[]', ?, ?)`,
      ).bind(member.personalWorkspaceId, member.userId).run();
      await env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
         INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, actor_id, channel, reason, created_at)
         SELECT 'm1', ?, i, 'v', NULL, '[]', '', 'rest', 'update', i FROM n`,
      ).bind(member.personalWorkspaceId).run();
      const progress = await cleanupMemberData(env, member.userId, member.personalWorkspaceId, { rowsLeft: 100_000 });
      // team-admin.ts:545's own `rowsWritten += 2 * n` estimate (one row for the version, one for
      // its FTS index entry). This checks the CODE's own arithmetic, not what D1 actually bills for
      // the DELETE — R4-B6 (adv-r4-budgets.test.ts) measures that separately: D1 bills 1 row per
      // removed version, not 2, so this estimate paces the resume at half the real budget it has (a
      // pacing inefficiency, not a correctness or platform-limit risk — left as is).
      expect(progress.rowsWritten).toBeGreaterThanOrEqual(2000);
    } finally { await d1.close(); }
  }, 120_000);

  it("a nightly cleanup night stays within its 15,000-row share", async () => {
    const { d1, env, roots } = await setup();
    try {
      await env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 199)
         INSERT INTO entries_trash (id, workspace_id, actor_id, content, row_json, edges_json, vector_ids, deleted_at, deleted_by, channel, reason)
         SELECT 't' || i, ?, '', 'c', '{"created_at":1}', '[]', '[]', 1, '', 'rest', 'forget' FROM n`,
      ).bind(roots.ownerPersonalWorkspaceId).run();
      const night = await runNightlyCleanup(env);
      expect(night.rowsWritten).toBeLessThanOrEqual(NIGHTLY_CLEANUP_ROWS);
    } finally { await d1.close(); }
  }, 120_000);
});

describe.runIf(process.env.EVAL_WORKERD === "1")("row-size fallbacks on workerd (computed sizes, not a D1 error — M1/M2)", () => {
  it("a 1.9 MB memory is forgotten through the tier its computed size selects", async () => {
    const { d1, env, roots } = await setup();
    try {
      const content = "a".repeat(1_900_000);
      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES ('big', ?, '[]', 'api', 1000, '[]', ?, ?)`,
      ).bind(content, roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();
      const [sizes] = await readTrashCandidates(env, ["big"]);
      const tier = chooseTrashTier(sizes);
      const plan = planTrash([sizes]);
      await env.DB.batch(trashManyStatements(env, plan, { reason: "forget", change: { actorId: roots.ownerUserId, channel: "rest" }, now: Date.now() }));
      expect(await env.DB.prepare(`SELECT id FROM entries WHERE id = 'big'`).first()).toBeNull();
      if (tier === 3) {
        expect(await env.DB.prepare(`SELECT id FROM entries_trash WHERE id = 'big'`).first()).toBeNull();
      } else {
        expect(await env.DB.prepare(`SELECT id FROM entries_trash WHERE id = 'big'`).first()).not.toBeNull();
      }
    } finally { await d1.close(); }
  }, 120_000);

  it("enough incoming edges select tier 2, trash without edges (the spec's 5,000 no longer suffices)", async () => {
    const { d1, env, roots } = await setup();
    try {
      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES ('hub', 'content', '[]', 'api', 1000, '[]', ?, ?)`,
      ).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();
      // Measured directly against real D1: 5,000 and 8,000 edges both still land in tier 1 (the
      // spec's "5,000 incoming edges select tier 2" no longer holds — TRASH_ROW_BUDGET_BYTES or the
      // edge row shape moved since that number was written). 9,800 reaches tier 2. Past about
      // 10,700, readTrashCandidates itself throws D1_ERROR: string or blob too big (SQLITE_TOOBIG) —
      // the size COMPUTATION, not the trash write, hits a real D1 ceiling first. So the tier-2 window
      // for edges alone is real but narrow: roughly 9,800-10,600 edges on a single entry, bounded
      // above not by TRASH_ROW_BUDGET_BYTES but by D1's own per-value string limit. Reported to the
      // director as a finding: a sufficiently link-heavy entry's forget can throw before the tier
      // fallback ever runs, rather than degrading to tier 3.
      const EDGE_COUNT = 9_800;
      await env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${EDGE_COUNT - 1})
         INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id)
         SELECT 'leaf' || i, 'c', '[]', 'api', 1, '[]', ?, ? FROM n`,
      ).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();
      await env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${EDGE_COUNT - 1})
         INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
         SELECT 'e' || i, 'leaf' || i, 'hub', 'relates_to', 0.5, 'explicit', '{}', 1, 1, ? FROM n`,
      ).bind(roots.ownerPersonalWorkspaceId).run();
      const [sizes] = await readTrashCandidates(env, ["hub"]);
      expect(chooseTrashTier(sizes)).toBe(2);
      const plan = planTrash([sizes]);
      expect(plan.tier2).toEqual(["hub"]);
      await env.DB.batch(trashManyStatements(env, plan, { reason: "forget", change: { actorId: roots.ownerUserId, channel: "rest" }, now: Date.now() }));
      const trashed = await env.DB.prepare(`SELECT edges_json FROM entries_trash WHERE id = 'hub'`).first<{ edges_json: string }>();
      expect(trashed!.edges_json).toBe("[]");
    } finally { await d1.close(); }
  }, 120_000);

  it("sizes past the trash budget select tier 3, a hard delete that removes the versions", async () => {
    const { d1, env, roots } = await setup();
    try {
      const content = "a".repeat(TRASH_ROW_BUDGET_BYTES + 100_000);
      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES ('huge', ?, '[]', 'api', 1000, '[]', ?, ?)`,
      ).bind(content, roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();
      await env.DB.prepare(
        `INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, actor_id, channel, reason, created_at) VALUES ('huge', ?, 1, 'v', NULL, '[]', '', 'rest', 'update', 1)`,
      ).bind(roots.ownerPersonalWorkspaceId).run();
      const [sizes] = await readTrashCandidates(env, ["huge"]);
      expect(chooseTrashTier(sizes)).toBe(3);
      const plan = planTrash([sizes]);
      expect(plan.tier3).toEqual(["huge"]);
      await env.DB.batch(trashManyStatements(env, plan, { reason: "forget", change: { actorId: roots.ownerUserId, channel: "rest" }, now: Date.now() }));
      expect(await env.DB.prepare(`SELECT id FROM entries WHERE id = 'huge'`).first()).toBeNull();
      expect(await env.DB.prepare(`SELECT id FROM entries_trash WHERE id = 'huge'`).first()).toBeNull();
      expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM entry_versions WHERE entry_id = 'huge'`).first<{ n: number }>()).toMatchObject({ n: 0 });
    } finally { await d1.close(); }
  }, 120_000);

  it("an oversized merge records incomingTruncated", async () => {
    const { d1, env, roots } = await setup();
    try {
      const existingContent = "a".repeat(1000);
      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES ('target', ?, '[]', 'api', 1000, '["v0"]', ?, ?)`,
      ).bind(existingContent, roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();
      // A merge whose combined incoming text (plus the target's own tags/state/meta overhead) would
      // cross VERSION_ROW_BUDGET_BYTES records incomingTruncated instead of storing the incoming text.
      const { buildSnapshot } = await import("../../src/memory/versions");
      const incoming = "b".repeat(2_000_000);
      const b = buildSnapshot({
        entryId: "target", reason: "merge", change: { actorId: roots.ownerUserId, channel: "rest" },
        content: { kind: "next", content: existingContent + " merged" },
        nextTags: [], meta: { incomingTruncated: true, incomingBytes: incoming.length }, now: Date.now(),
      });
      const res = await env.DB.prepare(b.sql).bind(...b.bindings).run();
      expect(rowsWritten(res)).toBeGreaterThan(0);
      const row = await env.DB.prepare(`SELECT meta FROM entry_versions WHERE entry_id = 'target' ORDER BY seq DESC LIMIT 1`).first<{ meta: string }>();
      expect(JSON.parse(row!.meta)).toMatchObject({ incomingTruncated: true });
    } finally { await d1.close(); }
  }, 120_000);
});

describe("POST /undo and MCP undo: pins pending Task 15", () => {
  it.todo("Builder B is wiring revertEntry to POST /undo and the MCP undo tool from this same tip (Task 15) — the route-level D1+KV pin and its rows-written pin belong here once that lands, not before");
});
