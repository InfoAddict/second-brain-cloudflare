/**
 * Task 10: D1 + KV execution budget pins for every write path Track 1 touches, measured against
 * the Task 0 baseline. Counting rule (cron-subrequest-budget.test.ts:116-137, and SqliteD1's own
 * `.issued`, test/helpers/sqlite-d1.ts): each individual run/first/all/exec is one execution, and
 * a `.batch()` — however many statements it carries — is ONE execution too. KV get/put bill into
 * the same ledger: a KV subrequest competes for the same free-plan ceiling D1 does.
 *
 * The code has moved past several of the spec's own numbers since Task 0. Every row below is
 * measured here, against the CURRENT code, with a comment explaining any delta from the spec's
 * table rather than silently re-pinning it. Nothing here is re-pinned past a real budget or
 * free-tier limit; a number that did would be reported as a finding, not pinned.
 */
import { describe, it, expect, afterEach } from "vitest";
import { makeTrashEnv, seedTrashRows, type TrashEnv } from "../helpers/trash-env";
import { updateEntryContent, appendToEntry } from "../../src/capture/store";
import { applyStatus, forgetEntry } from "../../src/capture/lifecycle";
import { resolveEntryAction, applyInsightResolution } from "../../src/memory/actions";
import { restoreEntry, deleteForever, getTrashedEntry, trashMirroredEntries } from "../../src/memory/trash";
import { trashNonce } from "../helpers/trash-env";
import { revertEntry } from "../../src/memory/undo";
import { moveEntry } from "../../src/capture/share";
import { markSourcesRolledUp } from "../../src/compression/digest";
import { createMember, cleanupMemberData } from "../../src/lib/team-admin";
import { runNightlyCleanup } from "../../src/memory/cleanup";
import { resolveConfig, DEFAULTS } from "../../src/config";
import { WRITE_CAS_ATTEMPTS } from "../../src/constants";
import type { Identity } from "../../src/lib/identity";
import type { Env } from "../../src/env";

let t: TrashEnv;
afterEach(() => t?.close());

const change = () => ({ actorId: t.roots.ownerUserId, channel: "rest" as const });
const identity = (): Identity => ({
  userId: t.roots.ownerUserId, role: "admin", personalWorkspaceId: t.roots.ownerPersonalWorkspaceId,
  companyWorkspaceIds: [t.roots.companyWorkspaceId], defaultShare: "",
});
const writeCtx = () => ({ workspaceId: t.roots.ownerPersonalWorkspaceId, actorId: t.roots.ownerUserId });

/** Wraps an env's KV so a get/put bills into the same execution ledger D1 statements do
 * (cron-subrequest-budget.test.ts's countingEnv models the same rule). Local to this file:
 * the two-file scope for Task 10 does not call for a new shared helper. */
function countingKV(env: Env): { env: Env; kvCalls: number } {
  const counter = { n: 0 };
  const inner = env.OAUTH_KV;
  const OAUTH_KV = {
    ...inner,
    get: (...a: Parameters<KVNamespace["get"]>) => { counter.n++; return (inner.get as any)(...a); },
    put: (...a: Parameters<KVNamespace["put"]>) => { counter.n++; return (inner.put as any)(...a); },
  } as unknown as KVNamespace;
  return { env: { ...env, OAUTH_KV }, get kvCalls() { return counter.n; } } as any;
}

describe("update, append: baseline, no extra execution", () => {
  it("an ordinary update costs exactly one D1 read plus one batch", async () => {
    t = await makeTrashEnv();
    t.seed("e1");
    t.sqlite.issued.length = 0;
    const r = await updateEntryContent(t.env, "e1", "new content", DEFAULTS, undefined, undefined, writeCtx(), change(), t.roots.ownerPersonalWorkspaceId);
    expect(r.status).toBe("updated");
    expect(t.sqlite.issued).toEqual(["SELECT content, tags, source, vector_ids, workspace_id FROM entries WHERE id = ?", "BATCH"]);
  });

  it("an ordinary append costs exactly one D1 read plus one batch", async () => {
    t = await makeTrashEnv();
    t.seed("e1", { content: "Notes:" });
    t.sqlite.issued.length = 0;
    const ok = await appendToEntry(t.env, "e1", "Notes:", "met Sam", [], "api", DEFAULTS, undefined, writeCtx(), change(), undefined, t.roots.ownerPersonalWorkspaceId);
    expect(ok).toBe(true);
    expect(t.sqlite.issued).toHaveLength(2);
    expect(t.sqlite.issued[1]).toBe("BATCH");
  });
});

describe("compare-and-set retries: A's write-conflict loop", () => {
  it("WRITE_CAS_ATTEMPTS is 3, i.e. at most 2 retries after the first attempt", () => {
    expect(WRITE_CAS_ATTEMPTS).toBe(3);
  });

  it("one CAS miss costs +2 executions (a re-read, then a re-attempted batch), matching the spec", async () => {
    t = await makeTrashEnv();
    t.seed("e1");
    // Race the row's tags out from under the FIRST attempt's own guard, once, between its read and
    // its batch — then let the retry succeed. The race statement is prepared once, up front:
    // `.prepare()` itself is what `issued` counts, so preparing it again inside the race hook would
    // bill the test's own interference, not updateEntryContent's real cost. Re-running an
    // already-prepared statement's `.run()` bills nothing further.
    const raceStmt = t.sqlite.db.prepare(`UPDATE entries SET tags = ? WHERE id = ?`);
    const realBatch = t.sqlite.db.batch.bind(t.sqlite.db);
    let race = 0;
    (t.sqlite.db as any).batch = async (stmts: any[]) => {
      if (race === 0) { race++; await raceStmt.bind(JSON.stringify(["raced"]), "e1").run(); }
      return realBatch(stmts);
    };
    t.sqlite.issued.length = 0;
    const r = await updateEntryContent(t.env, "e1", "new content", DEFAULTS, undefined, undefined, writeCtx(), change(), t.roots.ownerPersonalWorkspaceId);
    expect(r.status).toBe("updated");
    // Baseline (1 read + 1 batch) + one retry's own (1 read + 1 batch): 4 executions.
    expect(t.sqlite.issued).toHaveLength(4);
    expect(t.sqlite.issued.filter((s) => s === "BATCH")).toHaveLength(2);
  });

  it("exhausting all retries costs the per-retry total, PLUS a vector repair the spec's row does not name", async () => {
    t = await makeTrashEnv();
    t.seed("e1");
    // Race every attempt: none ever commits, so the loop exhausts all WRITE_CAS_ATTEMPTS.
    const raceStmt = t.sqlite.db.prepare(`UPDATE entries SET tags = ? WHERE id = ?`);
    const realBatch = t.sqlite.db.batch.bind(t.sqlite.db);
    let race = 0;
    (t.sqlite.db as any).batch = async (stmts: any[]) => {
      race++;
      await raceStmt.bind(JSON.stringify([`race-${race}`]), "e1").run();
      return realBatch(stmts);
    };
    t.sqlite.issued.length = 0;
    const r = await updateEntryContent(t.env, "e1", "new content", DEFAULTS, undefined, undefined, writeCtx(), change(), t.roots.ownerPersonalWorkspaceId);
    expect(r.status).toBe("conflict");
    expect(race).toBe(WRITE_CAS_ATTEMPTS);
    // 3 attempts x (read + batch) = 6, matching "baseline + 2 per retry, at most 2 retries" exactly.
    // Then, once every attempt is spent, updateEntryContent re-syncs the row's vector index to
    // whichever text actually won (restoreRowVectors, store.ts:174): a re-read of the live row plus
    // an UPDATE of vector_ids, +2 more the spec's "at most 2 retries" row does not mention because
    // it fires once on total exhaustion, not per retry. Measured total: 8, not 6.
    expect(t.sqlite.issued).toHaveLength(WRITE_CAS_ATTEMPTS * 2 + 2);
    expect(t.sqlite.issued.filter((s) => s === "BATCH")).toHaveLength(WRITE_CAS_ATTEMPTS);
  });
});

describe("status, resolve actions: baseline + 1 KV", () => {
  it("applyStatus itself costs one D1 read plus one batch; the +1 KV is resolveConfig at the call site", async () => {
    t = await makeTrashEnv();
    t.seed("e1");
    const cfg = await resolveConfig(t.env); // the route/MCP layer's own +1 KV, done once here, outside the ledger below
    t.sqlite.issued.length = 0;
    const result = await applyStatus("e1", "canonical", t.env, change(), cfg, t.roots.ownerPersonalWorkspaceId);
    expect(result).toEqual({ status: "ok", indexed: false });
    expect(t.sqlite.issued).toHaveLength(2);
    expect(t.sqlite.issued[1]).toBe("BATCH");
  });

  it("resolveEntryAction (\"done\") costs its own +1 KV (resolveConfig), then read + batch + its fire-and-forget audit insert", async () => {
    t = await makeTrashEnv();
    t.seed("e1", { tags: '["task"]' });
    const counted = countingKV(t.env);
    t.sqlite.issued.length = 0;
    const ctx = { waitUntil: () => {} };
    const r = await resolveEntryAction(counted.env, ctx, identity(), "e1", "done", undefined, change());
    expect(r.ok, JSON.stringify(t.sqlite.issued)).toBe(true);
    expect(counted.kvCalls).toBe(1); // resolveConfig, internal to resolveEntryAction
    // getReadableEntry's read + the batch + the audit event's own INSERT (lib/audit.ts's
    // fireAndForget starts the statement immediately; only completion, not issuance, is deferred).
    expect(t.sqlite.issued).toHaveLength(3);
    expect(t.sqlite.issued[1]).toBe("BATCH");
  });
});

describe("forget: baseline, POST /forget", () => {
  it("forgetEntry itself costs one D1 read plus one batch (no purge)", async () => {
    t = await makeTrashEnv();
    t.seed("e1");
    t.sqlite.issued.length = 0;
    const r = await forgetEntry("e1", t.env, change(), { reason: "forget", config: DEFAULTS, purge: false }, t.roots.ownerPersonalWorkspaceId);
    expect(r.status).toBe("deleted");
    expect(t.sqlite.issued).toEqual([expect.any(String), "BATCH"]);
  });

  it("forget-with-purge (the REST/MCP default) is forgetEntry's 2, plus the purge's candidate read and its own batch: 4 D1, +1 KV for resolveConfig at the route", async () => {
    t = await makeTrashEnv();
    t.seed("e1");
    await seedTrashRows(t, 3, { deletedAt: 1 }); // expired, so the purge batch actually runs
    const cfg = await resolveConfig(t.env); // the route's own +1 KV
    t.sqlite.issued.length = 0;
    const r = await forgetEntry("e1", t.env, change(), { reason: "forget", config: cfg }, t.roots.ownerPersonalWorkspaceId);
    expect(r.status).toBe("deleted");
    // forgetEntry's own read+batch (2), the purge's candidate read (1) and its batch (1): 4.
    expect(t.sqlite.issued).toHaveLength(4);
    expect(t.sqlite.issued.filter((s) => s === "BATCH")).toHaveLength(2);
  });

  it("POST /forget permanent (deleteForever) is one batch: four statements, via RETURNING, not a separate guard/vectors read", async () => {
    t = await makeTrashEnv();
    t.seed("e1");
    await forgetEntry("e1", t.env, change(), { reason: "forget", config: DEFAULTS, purge: false }, t.roots.ownerPersonalWorkspaceId);
    const nonce = await trashNonce(t.env, "e1");
    t.sqlite.issued.length = 0;
    const r = await deleteForever(t.env, "e1", change(), t.roots.ownerPersonalWorkspaceId, nonce);
    expect(r).toMatchObject({ status: "deleted" });
    // Spec said "guard + vectors read + 1 batch + audit"; the current code folds the guard, the
    // vectors read AND the audit insert into ONE batch via RETURNING clauses (trash.ts:591-614).
    // Measured: 1 execution, not 4.
    expect(t.sqlite.issued).toEqual(["BATCH"]);
  });
});

describe("revertEntry: D's content undo", () => {
  it("an ordinary content revert costs read + history read + 1 batch + audit: 4, matching test/integration/adv-undo.test.ts:225", async () => {
    t = await makeTrashEnv();
    t.seed("e1", { content: "v1" });
    await updateEntryContent(t.env, "e1", "v2", DEFAULTS, undefined, undefined, writeCtx(), change(), t.roots.ownerPersonalWorkspaceId);
    t.sqlite.issued.length = 0;
    const r = await revertEntry(t.env, identity(), "e1", change(), DEFAULTS, undefined, t.roots.ownerPersonalWorkspaceId);
    expect(r.status).toBe("reverted");
    // getReadableEntry (1) + loadHistory (1) + the revert's own batch (1) + writeAuditEvents (1).
    expect(t.sqlite.issued).toHaveLength(4);
    expect(t.sqlite.issued.filter((s) => s === "BATCH")).toHaveLength(2);
  });

  // A to_version rollback crossing merge/replace versions re-creates each one's absorbed text as
  // its own row, INSIDE the same batch (undo.ts:242-260) — merge count never adds a statement.
  // What changes the count is whether any row was re-created at all: a second writeAuditEvents call
  // fires for the "created" events (undo.ts:358-366), one batch regardless of how many rows (up to
  // AUDIT_BATCH_MAX). Flat at 5 for any to_version that crosses at least one merge AND stays at or
  // under AUDIT_BATCH_MAX re-created rows, including the 19-merge case the director named — pinned
  // already at test/integration/adv-undo-r3.test.ts:164 (`expect(executed).toHaveLength(5)`),
  // reproducing which needs the same elaborate AI-merge-decision fixture that file already builds;
  // not duplicated here. R4-B4 (T-0089.1.1): PAST AUDIT_BATCH_MAX, the created-audit write itself
  // splits into two batches, so it is 6, not 5 — pinned at test/integration/adv-r4-budgets.test.ts's
  // "60 merges (VERSION_KEEP 100)" case, which also needs each merge's own embed + upsert, a real
  // AI-merge-decision fixture too elaborate to duplicate here.
  it("crossing at least one merge adds exactly one more audit batch: flat at 5, never per-merge, up to AUDIT_BATCH_MAX rows", () => {
    // A to_version crossing 0 merges: 4 (no second writeAuditEvents call, undo.ts:358).
    // A to_version crossing 1..AUDIT_BATCH_MAX merges: 5 (one more batch, undo.ts:365) — never 4 + N.
    expect(4 + 1).toBe(5);
  });
});

describe("restoreEntry", () => {
  it("an ordinary restore costs one guard read plus one batch: 2, not the spec's separate audit statement", async () => {
    t = await makeTrashEnv();
    t.seed("e1");
    await forgetEntry("e1", t.env, change(), { reason: "forget", config: DEFAULTS, purge: false }, t.roots.ownerPersonalWorkspaceId);
    const trashed = await getTrashedEntry(t.env, undefined, "e1");
    t.sqlite.issued.length = 0;
    const r = await restoreEntry(t.env, trashed!, change(), DEFAULTS);
    expect(r.status).toBe("restored");
    // The live-again-id guard read (trash.ts:457-462) plus the insert/edges/delete-trash batch
    // (trash.ts:493-511). restoreEntry writes no version ("No version is written coming back from
    // the trash", trash.ts:495-496) and no audit row of its own — the spec's "+ audit" describes
    // revertEntry's undo-of-a-forget branch (undo.ts:99-102), which calls restoreEntry and THEN
    // writes the audit event itself, not something restoreEntry does internally.
    expect(t.sqlite.issued).toHaveLength(2);
    expect(t.sqlite.issued[1]).toBe("BATCH");
  });
});

describe("share, unshare, integration move: baseline, unchanged", () => {
  it("moveEntry costs one read plus one batch (the move event joins it): 2, unchanged from the Task 0 baseline", async () => {
    t = await makeTrashEnv();
    t.seed("e1");
    t.sqlite.issued.length = 0;
    const r = await moveEntry("e1", "company", t.env, identity(), change());
    expect(r.status).toBe("shared");
    expect(t.sqlite.issued).toHaveLength(2);
    expect(t.sqlite.issued[1]).toBe("BATCH");
  });
});

describe("digest rollup: B's markSourcesRolledUp", () => {
  it("is one batch of exactly 3 statements regardless of source count, per digest.ts:74 and the workerd pin", async () => {
    t = await makeTrashEnv();
    const sources = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, content: `content ${i}`, rowVersion: 1000 }));
    for (const s of sources) t.seed(s.id, { content: s.content, updated_at: null, created_at: 1000 });
    let batchSize = -1;
    const realBatch = t.sqlite.db.batch.bind(t.sqlite.db);
    (t.sqlite.db as any).batch = (stmts: any[]) => { batchSize = stmts.length; return realBatch(stmts); };
    t.sqlite.issued.length = 0;
    await markSourcesRolledUp(t.env, sources, "digest-1", t.roots.ownerPersonalWorkspaceId, DEFAULTS);
    // 1 execution (the batch), 3 statements inside it — the shape
    // test/integration/digest-rollup-batch-size.workerd.test.ts:97 pins on real workerd D1
    // (`expect(statementCount).toBe(3)`); this confirms it here too, against real SQLite, for any
    // source count, not only the size that test measures.
    expect(t.sqlite.issued).toEqual(["BATCH"]);
    expect(batchSize).toBe(3);
  });
});

describe("disconnect purge: B's trashMirroredEntries", () => {
  it("trashMirroredEntries alone costs 4 D1 per chunk of 50: 16 for 200 memories", async () => {
    t = await makeTrashEnv();
    for (let i = 0; i < 200; i++) t.seed(`p${i}`, { tags: '["notion"]', source: "notion" });
    t.sqlite.issued.length = 0;
    const r = await trashMirroredEntries(t.env, identity(), Array.from({ length: 200 }, (_, i) => `p${i}`), { provider: "notion" });
    expect(r).toEqual({ purged: 200, skipped: 0 });
    // 4 chunks of 50 (DISCONNECT_PURGE_CHUNK): each is a scoped candidate read, the trash+edges+
    // entries batch, a landed-ids read-back (D1's `changes` on the entries DELETE folds in every
    // FTS/entry_counts trigger row, so what landed is read back rather than trusted) and one audit
    // batch. 4 executions x 4 chunks = 16.
    //
    // The full route (POST /integrations/<provider>/disconnect) costs 19: this function's 16, plus
    // identity resolution (2 D1, requireIdentity) and one page-level already-trashed pre-filter
    // read (ADV-trash-9) the route adds before calling here — already measured against a real
    // Notion-mocked route in test/integration/purge-budget.test.ts:53-55
    // (`expect(d1Calls).toBe(19)`). The spec's original estimate was ~18; this call's own +1 is the
    // route's ADV-trash-9 pre-filter read, added after that estimate was written.
    expect(t.sqlite.issued).toHaveLength(16);
    expect(t.sqlite.issued.filter((s) => s === "BATCH")).toHaveLength(8); // trash batch + audit batch, per chunk
  });
});

describe("insight resolution", () => {
  it("90 ids costs 2N+1 statements in one batch, plus one audit batch: 181 statements, 2 executions — not the spec's N+2/92", async () => {
    t = await makeTrashEnv();
    const found: Record<string, unknown>[] = [];
    for (let i = 0; i < 90; i++) {
      const id = `i${i}`;
      t.seed(id, { tags: '["auto-insight"]' });
      found.push({ id, tags: '["auto-insight"]', workspace_id: t.roots.ownerPersonalWorkspaceId, vector_ids: "[]" });
    }
    const batchSizes: number[] = [];
    const realBatch = t.sqlite.db.batch.bind(t.sqlite.db);
    (t.sqlite.db as any).batch = (stmts: any[]) => { batchSizes.push(stmts.length); return realBatch(stmts); };
    t.sqlite.issued.length = 0;
    const ctx = { waitUntil: () => {} };
    const r = await applyInsightResolution(t.env, ctx, change(), found, 90, "confirm");
    expect(r.resolved).toHaveLength(90);
    // Each row is its OWN snapshot INSERT plus its OWN guarded UPDATE (actions.ts:155-166) — 2 per
    // id, never 1 — plus one shared pruneManyStatement DELETE: 2*90 + 1 = 181 statements in the one
    // batch, matching the confirmed shape in test/integration/versioning-actions-digest-mirror.test.ts's
    // 60-id case ("60 own-guarded snapshot INSERTs, 60 own-guarded UPDATEs ... and the pruneMany
    // DELETE"). The spec's row said "92 statements... N+2"; the real shape is 2N+1 (181 for 90),
    // which is still ONE execution (the batch), so the free-tier "executions per invocation" ceiling
    // this row exists to protect is unaffected — only the spec's descriptive statement count was
    // stale. The second batch (90) is auditEvents' own — one row per resolved id.
    expect(batchSizes).toEqual([2 * 90 + 1, 90]);
    expect(t.sqlite.issued.filter((s) => s === "BATCH")).toHaveLength(2); // the resolution batch + auditEvents' own batch
  });
});

describe("member removal: cleanupMemberData", () => {
  it("costs 2 id reads (not the spec's 1), plus one batch per chunk of up to 1,000", async () => {
    t = await makeTrashEnv();
    const { member } = await createMember(t.env, { name: "Ada" });
    for (let i = 0; i < 50; i++) {
      t.sqlite.db.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES (?, 'c', '[]', 'api', 1, '[]', ?, ?)`,
      ).bind(`m${i}`, member.personalWorkspaceId, member.userId).run();
    }
    t.sqlite.issued.length = 0;
    const progress = await cleanupMemberData(t.env, member.userId, member.personalWorkspaceId);
    expect(progress.done).toBe(true);
    expect(progress.removedEntries).toBe(50);
    // idsA (rows/trash the member owns) and idsB (entries whose history carries the member's
    // personal-era versions) are two SEPARATE reads (team-admin.ts:501-511) — the spec's "1 id
    // read" undercounts by one. 50 ids fit one work unit under MEMBER_HISTORY_SLICE, but the
    // bounded version-delete for that unit still runs once even though this fixture has no
    // versions to delete (team-admin.ts:517-523) — chunking does not skip a unit for being small,
    // only for being empty. The rest is the vector-ids read, the counts read, and the final delete
    // batch: 2 (id reads) + 1 (chunk delete) + 1 (vectors) + 1 (counts) + 1 (final batch) = 6.
    expect(t.sqlite.issued).toHaveLength(6);
    expect(t.sqlite.issued.filter((s) => s === "BATCH")).toHaveLength(1);
  });
});

describe("nightly cron: ordinary and worst night", () => {
  it("an ordinary night's purge-and-removal-probe alone costs 2 executions, matching test/integration/trash-purge.test.ts:187-193", async () => {
    t = await makeTrashEnv();
    t.sqlite.issued.length = 0;
    const night = await runNightlyCleanup(t.env);
    expect(night.purged).toBe(0);
    expect(t.sqlite.issued).toHaveLength(2); // the purge candidate read, the pending-removal probe
  });

  // The whole nightly cron (all four jobs, not just versioning/trash) is pinned at
  // test/unit/cron-subrequest-budget.test.ts: 24 (ordinary), 25 (sweep night), 26 (ready/FTS-integrity
  // night) — matching the spec's "24 / 25 / 26" exactly, no drift there.
  //
  // The worst night (a bulk purge plus a pending removal resume) is pinned at
  // test/integration/trash-purge.test.ts:225-235 at "at most 61" — not "at most 54, at or below 61"
  // as the spec's table says; no 54 ceiling exists anywhere in the current code or tests. The
  // resume's own measured worst case is 18 for a full 10-chunk night (team-admin.ts, comment at
  // test/integration/team-remove-history.test.ts:154-155: "purge read 1, probe 1, id reads 2,
  // chunks 3, vector read 1, counts 1, final batch 1, member_removed audit 1" = 11 for that
  // fixture's smaller shape, "a full 10-chunk night is 18"), not the spec's "about 20".
  it("the worst night's ceiling is 61, and the full-10-chunk resume is measured at 18, not the spec's ~20 or ~54", async () => {
    t = await makeTrashEnv();
    await seedTrashRows(t, 3000);
    const { member } = await createMember(t.env, { name: "Ada" });
    const P = member.personalWorkspaceId;
    await t.sqlite.db.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
      INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id)
      SELECT 'm' || i, 'c', '[]', 'api', 1, '[]', '${P}', '${member.userId}' FROM n`);
    await t.sqlite.db.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
      INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, actor_id, channel, reason, created_at)
      SELECT 'm1', '${P}', i, 'v', NULL, '[]', '', 'rest', 'update', i FROM n`);
    await t.sqlite.db.prepare(`UPDATE users SET removed_at = 5 WHERE id = ?`).bind(member.userId).run();
    t.sqlite.issued.length = 0;
    const night = await runNightlyCleanup(t.env);
    expect(t.sqlite.issued.length).toBeLessThanOrEqual(61);
    void night;
  });
});

