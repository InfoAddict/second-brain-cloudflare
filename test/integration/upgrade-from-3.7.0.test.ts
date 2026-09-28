/**
 * Upgrade path from a 3.7.0-shaped database (Task 11, T-0089.1.1 T-0089.1.2).
 *
 * test/fixtures/schema-3.7.0.sql is db/schema.sql frozen at release commit 0a39810, before
 * tenancy, when_*, recall_count or entry_versions/entries_trash existed. Loading it and then
 * calling initializeDatabase exercises the real upgrade chain (every ALTER since 3.7.0, not just
 * the new tables), which is the only way "no backfill writes" is a fact about production rather
 * than about a hand-trimmed fixture.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeMemoryKV, makeTestEnv, makeAIMock, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, stripSqlComments, splitSchemaStatements, type SqliteD1 } from "../helpers/sqlite-d1";
import { req } from "../helpers/make-request";
import worker from "../../src/index";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { updateEntryContent, appendToEntry } from "../../src/capture/store";
import { applyStatus, forgetEntry } from "../../src/capture/lifecycle";
import { resolveEntryAction } from "../../src/memory/actions";
import { getTrashedEntry, restoreEntry } from "../../src/memory/trash";
import { importExportPayload } from "../../src/entries/import";
import { readEntryHistory } from "../../src/memory/history";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityFromToken, type Identity } from "../../src/lib/identity";
import { VERSIONS_SINCE_KV_KEY } from "../../src/constants";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";

// A string path, not new URL(...): a duplicate global URL type (DOM lib vs node:url) makes
// readFileSync's URL overload unresolvable under this project's tsconfig. Same convention as
// every other fixture path in test/ (e.g. db-init.test.ts's own schema.sql read).
const FIXTURE = resolve(import.meta.dirname, "../fixtures/schema-3.7.0.sql");

/** The real SqliteD1 facade (batch, queueing, everything Task 1-6's code relies on), started
 * empty and loaded from the frozen 3.7.0 fixture instead of the current db/schema.sql. */
function make370D1(): SqliteD1 & { changes: () => number } {
  const d1 = makeSqliteD1({ schema: false });
  const schema = readFileSync(FIXTURE, "utf8");
  for (const statement of splitSchemaStatements(stripSqlComments(schema))) {
    const sql = statement.trim();
    if (!sql) continue;
    d1.db.exec(sql);
  }
  return d1 as any;
}

let d1: SqliteD1;
let env: Env;
const ctx = { waitUntil: (_: Promise<unknown>) => {} } as unknown as ExecutionContext;
const totalChanges = async () => ((await (d1.db as any).prepare(`SELECT total_changes() AS n`).first()) as any).n as number;

beforeEach(() => {
  resetDatabaseInit();
  d1 = make370D1();
});
afterEach(() => d1.close());

describe("upgrade from a 3.7.0-shaped database", () => {
  it("creates entry_versions, entries_trash and their index, and writes no rows", async () => {
    // A realistic pre-4.0 brain: 50 ordinary entries, a capsule row, a deprecated row, and 20
    // edges between them — not the two-row toy a passing test could rubber-stamp.
    const entryTuples = Array.from({ length: 50 }, (_, i) =>
      `('e${i}', 'memory number ${i}', '["a"]', 'api', ${1000 + i}, '[]')`).join(",\n      ");
    d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES
      ${entryTuples},
      ('cap', 'the capsule content', '["capsule:core","status:canonical"]', 'api', 6000, '[]'),
      ('dep', 'a deprecated memory', '["status:deprecated"]', 'api', 6100, '[]')`);
    const edgeTuples = Array.from({ length: 20 }, (_, i) =>
      `('edge${i}', 'e${i}', 'e${(i + 1) % 50}', 'relates_to', 0.5, 'inferred', '{}', 1000, 1000)`).join(",\n      ");
    d1.db.exec(`INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at) VALUES
      ${edgeTuples}`);
    const before = await totalChanges();

    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });
    await initializeDatabase(env);

    const objects = (await (d1.db as any).prepare(`SELECT name, type FROM sqlite_master WHERE name IN ('entry_versions','entries_trash','idx_entry_versions_entry','idx_entries_trash_deleted')`).all()).results as { name: string; type: string }[];
    expect(objects.map((o) => o.name).sort()).toEqual(["entries_trash", "entry_versions", "idx_entries_trash_deleted", "idx_entry_versions_entry"].sort());
    expect(objects.find((o) => o.name === "entry_versions")!.type).toBe("table");
    expect(objects.find((o) => o.name === "entries_trash")!.type).toBe("table");

    // total_changes() only counts INSERT/UPDATE/DELETE (row writes), never DDL: this is the
    // direct proof that upgrading a 3.7.0 brain to 4.0's schema touches no existing row and
    // inserts none of its own, even with the ALTERs (updated_at among them) still pending
    // against a 52-entry, 20-edge corpus that includes a capsule and a deprecated row.
    expect((await totalChanges()) - before).toBe(0);

    expect(await env.OAUTH_KV.get(VERSIONS_SINCE_KV_KEY)).not.toBeNull();

    // updated_at arrives by ALTER with no backfill (design: "never backfills, at any brain
    // size"), so every row reads NULL until something writes it. Half the ordinary entries are
    // touched here — after the migration this counted, so the "no rows written" claim above
    // still stands — to leave the brain in the mixed shape the spec asks for: NULL updated_at
    // on half, a real one on the rest.
    const half = Array.from({ length: 25 }, (_, i) => `'e${i}'`).join(",");
    await (d1.db as any).prepare(`UPDATE entries SET updated_at = 9999 WHERE id IN (${half})`).run();
    const nullCount = (await (d1.db as any).prepare(`SELECT COUNT(*) AS n FROM entries WHERE updated_at IS NULL`).first()).n as number;
    const setCount = (await (d1.db as any).prepare(`SELECT COUNT(*) AS n FROM entries WHERE updated_at IS NOT NULL`).first()).n as number;
    expect(nullCount).toBe(27); // 25 untouched ordinary entries + cap + dep
    expect(setCount).toBe(25);
  });

  it("creates idx_entries_ledger and idx_entries_standing on a 3.7.0 upgrade, both empty", async () => {
    // A pre-4.0 brain never wrote either marker tag, so migrating it must not reinterpret
    // anything: both indexes are created and both start empty (T-0089.7.1, T-0089.7.2).
    d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES ('e1', 'an ordinary pre-4.0 memory', '["decision","standing"]', 'api', 1000, '[]')`);
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });

    await initializeDatabase(env);

    const objects = (await (d1.db as any).prepare(
      `SELECT name, type FROM sqlite_master WHERE name IN ('idx_entries_ledger','idx_entries_standing')`,
    ).all()).results as { name: string; type: string }[];
    expect(objects.map((o) => o.name).sort()).toEqual(["idx_entries_ledger", "idx_entries_standing"]);
    expect(objects.every((o) => o.type === "index")).toBe(true);

    // The pre-4.0 row's plain "decision"/"standing" tags are ordinary tags (P7.2), not the
    // reserved "ledger:decision"/"standing:active" markers, so neither index picks it up.
    const ledgerCount = (await (d1.db as any).prepare(
      `SELECT COUNT(*) AS n FROM entries WHERE instr(lower(tags), '"ledger:decision"') > 0`,
    ).first()).n as number;
    const standingCount = (await (d1.db as any).prepare(
      `SELECT COUNT(*) AS n FROM entries WHERE instr(lower(tags), '"standing:active"') > 0`,
    ).first()).n as number;
    expect(ledgerCount).toBe(0);
    expect(standingCount).toBe(0);
  });

  it("a second cold start issues only the probe, no more CREATEs", async () => {
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });
    await initializeDatabase(env);
    resetDatabaseInit();
    d1.issued.length = 0;
    await initializeDatabase(env);
    expect(d1.issued.some((s) => /CREATE TABLE IF NOT EXISTS entry_versions/.test(s))).toBe(false);
    expect(d1.issued.some((s) => /CREATE TABLE IF NOT EXISTS entries_trash/.test(s))).toBe(false);
  });

  it("a pre-4.0 row's first update versions correctly with no gap: seq 1, valid_from = COALESCE(updated_at, created_at)", async () => {
    d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES ('e1', 'I live in Berlin', '["home"]', 'api', 1000, '[]')`);
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });
    await initializeDatabase(env);
    const roots = await ensureTenantBootstrap(env);
    // Bootstrap assigns legacy rows to the owner's personal workspace (main tenancy.ts:127); a
    // one-time backfill of workspace_id/actor_id is out of scope for Task 11 (design row 23), so
    // it is not asserted against here.
    await (d1.db as any).prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = 'e1'`).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();

    const change = { actorId: roots.ownerUserId, channel: "rest" as const };
    const r = await updateEntryContent(env, "e1", "I live in Munich now", DEFAULTS, undefined, undefined, { workspaceId: roots.ownerPersonalWorkspaceId, actorId: roots.ownerUserId }, change, roots.ownerPersonalWorkspaceId);
    expect(r.status).toBe("updated");

    const versions = (await (d1.db as any).prepare(`SELECT * FROM entry_versions WHERE entry_id = 'e1' ORDER BY seq`).all()).results as any[];
    expect(versions).toHaveLength(1);
    expect(versions[0].seq).toBe(1);
    expect(versions[0].content).toBe("I live in Berlin");
    // updated_at was NULL on this legacy row, so valid_from falls back to created_at (P13 / design "valid_from").
    expect(versions[0].valid_from).toBe(1000);
  });

  it("a pre-4.0 row's first append versions correctly and reconstructs the prior text", async () => {
    d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES ('e1', 'Notes:', '["work"]', 'api', 1000, '[]')`);
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });
    await initializeDatabase(env);
    const roots = await ensureTenantBootstrap(env);
    await (d1.db as any).prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = 'e1'`).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();

    const change = { actorId: roots.ownerUserId, channel: "rest" as const };
    const ok = (await appendToEntry(env, "e1", "Notes:", "met Sam", [], "api", DEFAULTS, undefined, { workspaceId: roots.ownerPersonalWorkspaceId, actorId: roots.ownerUserId }, change, undefined, roots.ownerPersonalWorkspaceId)).indexed;
    expect(ok).toBe(true);

    const row = await (d1.db as any).prepare(`SELECT content FROM entries WHERE id = 'e1'`).first();
    expect(row.content).toContain("Notes:");
    expect(row.content).toContain("met Sam");
    const versions = (await (d1.db as any).prepare(`SELECT * FROM entry_versions WHERE entry_id = 'e1' ORDER BY seq`).all()).results as any[];
    expect(versions).toHaveLength(1);
    expect(versions[0].seq).toBe(1);
    expect(versions[0].valid_from).toBe(1000);
  });

  it("init sets versions:since", async () => {
    d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES ('e1', 'memory', '["a"]', 'api', 1000, '[]')`);
    const before = Date.now();
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });
    await initializeDatabase(env);
    const since = await env.OAUTH_KV.get(VERSIONS_SINCE_KV_KEY);
    expect(since).not.toBeNull();
    expect(Number(since)).toBeGreaterThanOrEqual(before);
  });

  it("a pre-4.0 row's first set_status versions correctly: seq 1, valid_from = COALESCE(updated_at, created_at)", async () => {
    d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES ('e1', 'Some memory', '["work"]', 'api', 1000, '[]')`);
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });
    await initializeDatabase(env);
    const roots = await ensureTenantBootstrap(env);
    await (d1.db as any).prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = 'e1'`).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();

    const change = { actorId: roots.ownerUserId, channel: "rest" as const };
    const result = await applyStatus("e1", "deprecated", env, change, DEFAULTS, roots.ownerPersonalWorkspaceId);
    expect(result).toEqual({ status: "ok", indexed: false, validity: expect.any(Object) });

    const versions = (await (d1.db as any).prepare(`SELECT * FROM entry_versions WHERE entry_id = 'e1' ORDER BY seq`).all()).results as any[];
    expect(versions).toHaveLength(1);
    expect(versions[0].seq).toBe(1);
    expect(versions[0].valid_from).toBe(1000);
  });

  it("a pre-4.0 row's first snooze versions correctly: seq 1, valid_from = COALESCE(updated_at, created_at)", async () => {
    d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES ('e1', 'Renew the passport', '["task"]', 'api', 1000, '[]')`);
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });
    await initializeDatabase(env);
    const roots = await ensureTenantBootstrap(env);
    await (d1.db as any).prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = 'e1'`).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();

    const identity: Identity = {
      userId: roots.ownerUserId, role: "admin", personalWorkspaceId: roots.ownerPersonalWorkspaceId,
      companyWorkspaceIds: [roots.companyWorkspaceId], defaultShare: "",
    };
    const change = { actorId: roots.ownerUserId, channel: "rest" as const };
    const result = await resolveEntryAction(env, ctx, identity, "e1", "snooze", "2027-01-01", change);
    expect(result.ok).toBe(true);

    const versions = (await (d1.db as any).prepare(`SELECT * FROM entry_versions WHERE entry_id = 'e1' ORDER BY seq`).all()).results as any[];
    expect(versions).toHaveLength(1);
    expect(versions[0].seq).toBe(1);
    expect(versions[0].valid_from).toBe(1000);
  });

  it("a pre-4.0 row's first merge versions correctly: seq 1, valid_from = COALESCE(updated_at, created_at)", async () => {
    d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids, importance_score) VALUES ('e1', 'I prefer dark mode', '["ui"]', 'api', 1000, '[]', 0)`);
    const vectorize = makeVectorizeMock({
      query: vi.fn().mockResolvedValue({ matches: [{ id: "e1", score: 0.88, metadata: { parentId: "e1" } }] }),
    });
    // Merge-decision-only AI stub: embed calls answer with a vector, everything else (the merge
    // prompt) answers with the fixed decision below, matching test/integration/smart-merge.test.ts's
    // makeMergeAI shape.
    const mergedContent = "I prefer dark mode, especially at night";
    const ai = {
      run: vi.fn().mockImplementation(async (model: string) => {
        if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
        const response = JSON.stringify({ action: "merge", target_id: "e1", merged_content: mergedContent });
        return new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`));
            c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            c.close();
          },
        });
      }),
    } as unknown as Ai;

    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: ai, VECTORIZE: vectorize });
    await initializeDatabase(env);
    const roots = await ensureTenantBootstrap(env);
    await (d1.db as any).prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = 'e1'`).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();

    const res = await worker.fetch(req("POST", "/capture", { body: { content: "I like dark mode especially at night" } }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.action).toBe("merged");
    expect(data.id).toBe("e1");

    const row = await (d1.db as any).prepare(`SELECT content FROM entries WHERE id = 'e1'`).first();
    expect(row.content).toBe(mergedContent);
    const versions = (await (d1.db as any).prepare(`SELECT * FROM entry_versions WHERE entry_id = 'e1' ORDER BY seq`).all()).results as any[];
    expect(versions).toHaveLength(1);
    expect(versions[0].seq).toBe(1);
    expect(versions[0].valid_from).toBe(1000);
  });

  it("a pre-4.0 row's forget works: it moves to the trash intact", async () => {
    d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES ('e1', 'Old memory', '["x"]', 'api', 1000, '[]')`);
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });
    await initializeDatabase(env);
    const roots = await ensureTenantBootstrap(env);
    await (d1.db as any).prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = 'e1'`).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();

    const change = { actorId: roots.ownerUserId, channel: "rest" as const };
    const result = await forgetEntry("e1", env, change, { reason: "forget", config: DEFAULTS, purge: false }, roots.ownerPersonalWorkspaceId);
    expect(result.status).toBe("deleted");
    expect((result as any).trashed).toBe(true);
    expect(await (d1.db as any).prepare(`SELECT id FROM entries WHERE id = 'e1'`).first()).toBeNull();
    expect(await (d1.db as any).prepare(`SELECT id FROM entries_trash WHERE id = 'e1'`).first()).not.toBeNull();
  });

  it("forget then restore a pre-4.0 row with NULL columns round-trips it", async () => {
    // recall_count/importance_score/contradiction_wins/contradiction_losses already exist as
    // nullable columns at 3.7.0 (unlike updated_at/when_*, which only arrive by ALTER); a real
    // pre-4.0 brain can hold rows where an older write path left them NULL rather than 0.
    d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids, recall_count, importance_score, contradiction_wins, contradiction_losses)
      VALUES ('leg', 'legacy content', '["x"]', 'voice', 4000, '[]', NULL, NULL, NULL, NULL)`);
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });
    await initializeDatabase(env);
    const roots = await ensureTenantBootstrap(env);
    await (d1.db as any).prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = 'leg'`).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();

    const change = { actorId: roots.ownerUserId, channel: "rest" as const };
    const forgotten = await forgetEntry("leg", env, change, { reason: "forget", config: DEFAULTS, purge: false }, roots.ownerPersonalWorkspaceId);
    expect(forgotten.status).toBe("deleted");

    const trashed = await getTrashedEntry(env, undefined, "leg");
    expect(trashed).not.toBeNull();
    const restored = await restoreEntry(env, trashed!, change, DEFAULTS);
    expect(restored.status).toBe("restored");

    const row = await (d1.db as any).prepare(`SELECT * FROM entries WHERE id = 'leg'`).first() as any;
    expect(row.content).toBe("legacy content");
    expect(row.source).toBe("voice");
    expect(row.recall_count).toBeNull();
    expect(row.importance_score).toBeNull();
    expect(row.contradiction_wins).toBeNull();
    expect(row.contradiction_losses).toBeNull();
    // updated_at and when_at exist only by ALTER, with no backfill: NULL on every untouched row.
    expect(row.updated_at).toBeNull();
    expect(row.when_at).toBeNull();
  });

  it("import of a 3.7.0 export whose ids are partly in trash skips them as in_trash", async () => {
    d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES ('trashed-id', 'will be trashed', '["x"]', 'api', 1000, '[]')`);
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });
    await initializeDatabase(env);
    const roots = await ensureTenantBootstrap(env);
    await (d1.db as any).prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = 'trashed-id'`).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();

    const change = { actorId: roots.ownerUserId, channel: "rest" as const };
    const forgotten = await forgetEntry("trashed-id", env, change, { reason: "forget", config: DEFAULTS, purge: false }, roots.ownerPersonalWorkspaceId);
    expect(forgotten.status).toBe("deleted");
    expect(await (d1.db as any).prepare(`SELECT id FROM entries_trash WHERE id = 'trashed-id'`).first()).not.toBeNull();

    const summary = await importExportPayload(env, {
      version: 2,
      entries: [
        { id: "trashed-id", content: "a stale export of the trashed row", created_at: 1000 },
        { id: "fresh-id", content: "a genuinely new row", created_at: 2000 },
      ],
    }, { writeCtx: { workspaceId: roots.ownerPersonalWorkspaceId, actorId: roots.ownerUserId } });

    expect(summary.imported).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.skipped_in_trash).toBe(1);
    expect(summary.results).toContainEqual({ id: "trashed-id", status: "skipped", reason: "in_trash" });
    expect(summary.results).toContainEqual({ id: "fresh-id", status: "imported" });
    // The stale copy was skipped, not imported over the trash row it belongs to.
    expect(await (d1.db as any).prepare(`SELECT id FROM entries WHERE id = 'trashed-id'`).first()).toBeNull();
  });

  it("a pre-4.0 shared event hides older events from a non-author", async () => {
    d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES ('p1', 'a shared memory', '["x"]', 'api', 1000, '[]')`);
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });
    await initializeDatabase(env);
    const roots = await ensureTenantBootstrap(env);
    // Landed in the company workspace before 4.0 ever recorded fromWorkspaceId on a move event.
    await (d1.db as any).prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = 'p1'`)
      .bind(roots.companyWorkspaceId, roots.ownerUserId).run();

    const bump = (event: string, actorId: string, now: number, payload: Record<string, unknown> = {}) =>
      env.DB.prepare(`INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), "p1", actorId, event, JSON.stringify(payload), now).run();
    await bump("created", roots.ownerUserId, 100);
    await bump("shared", roots.ownerUserId, 200, { workspaceId: roots.companyWorkspaceId }); // pre-4.0: no fromWorkspaceId
    await bump("updated", roots.ownerUserId, 300);

    const { token } = await createMember(env, { name: "Bob" });
    const bob = (await resolveIdentityFromToken(token, env))!;

    const history = await readEntryHistory(env, bob, "p1");
    const events = (history?.history.items.filter((i: any) => i.kind === "event") ?? []).map((e: any) => e.event);
    expect(events).not.toContain("created");
    expect(events).toContain("shared");
    expect(events).toContain("updated");
  });
});

describe("the 3.7.0 d1-mock probe shape", () => {
  // Not real SQLite: the point here is to pin the exact STATEMENTS init issues against a probe
  // shaped like everything-but-Task-11, which is easiest to state as a mock (see
  // test/unit/db-init.test.ts's own makeMigrationDb for the established pattern this mirrors).
  // Object and trigger names/bodies are read out of the CURRENT db/schema.sql rather than
  // hand-duplicated, so this does not drift from the schema as new objects are added elsewhere.
  const SCHEMA_SQL = readFileSync(resolve(import.meta.dirname, "../../db/schema.sql"), "utf8");
  const NEW_OBJECTS = new Set(["entry_versions", "idx_entry_versions_entry", "entries_trash", "idx_entries_trash_deleted"]);
  const TRIGGER_BODIES = new Map(
    [...SCHEMA_SQL.matchAll(/CREATE TRIGGER IF NOT EXISTS (\w+)[\s\S]*?END;/g)].map((m) => [m[1], m[0].slice(0, -1)]),
  );
  const CAPSULE_INDEX_DDL = SCHEMA_SQL.match(/CREATE INDEX IF NOT EXISTS idx_entries_capsule[^;]*/)?.[0] ?? "";
  const PRE_TASK11_OBJECTS = [
    ...[...SCHEMA_SQL.matchAll(/CREATE (?:UNIQUE\s+)?(?:VIRTUAL\s+)?(TABLE|INDEX|TRIGGER)(?:\s+IF NOT EXISTS)?\s+(\w+)/g)]
      .map((m) => ({ name: m[2], kind: m[1].toLowerCase() as "table" | "index" | "trigger" }))
      .filter((o) => !NEW_OBJECTS.has(o.name)),
    // db/schema.sql deliberately omits this one (comment at db/schema.sql:253): when_at is a
    // runtime-only ALTER column, so a literal fresh-install schema file can't reference it in a
    // partial index. src/db/init.ts creates idx_entries_when for every brain, fresh or upgraded.
    { name: "idx_entries_when", kind: "index" as const },
  ];
  // Every entries/edges/users/admin_events column the app knows how to ALTER in, already present
  // — this models a brain fully migrated except for Task 11's two tables, not literally the
  // historical 0a39810 release (which also predates several unrelated later columns).
  const ENTRIES_ALTER_COLUMNS = ["updated_at", "staleness_checked_at", "when_at", "when_kind", "when_source", "when_label"];
  const BASE_ENTRIES_COLUMNS = ["id", "content", "tags", "source", "created_at", "vector_ids", "recall_count", "importance_score", "contradiction_wins", "contradiction_losses", "workspace_id", "actor_id"];
  const EDGES_ALTER_COLUMNS = ["workspace_id"];
  const USERS_ALTER_COLUMNS = ["default_share", "removed_at", "last_used_at"];
  const ADMIN_EVENTS_ALTER_COLUMNS = ["target_user_id", "workspace_id"];
  const PROBE = /^SELECT type AS kind, name, sql AS definition FROM sqlite_master\b/;

  function makePreTask11Mock() {
    const objects = new Map(PRE_TASK11_OBJECTS.map((o) => [o.name, o.kind] as const));
    const execd: string[] = [];
    const prepared: string[] = [];
    const DB = {
      async exec(sql: string) { execd.push(sql); },
      prepare(sql: string) {
        prepared.push(sql);
        const make = (): any => ({
          bind: () => make(),
          first: async () => null,
          all: async () => ({
            results: PROBE.test(sql)
              ? [
                ...[...objects].map(([name, kind]) => ({
                  kind, name,
                  definition: name === "idx_entries_capsule" ? CAPSULE_INDEX_DDL : TRIGGER_BODIES.get(name),
                })),
                ...BASE_ENTRIES_COLUMNS.map((name) => ({ kind: "column", name })),
                ...ENTRIES_ALTER_COLUMNS.map((name) => ({ kind: "column", name })),
                ...EDGES_ALTER_COLUMNS.map((name) => ({ kind: "edge_column", name })),
                ...USERS_ALTER_COLUMNS.map((name) => ({ kind: "user_column", name })),
                ...ADMIN_EVENTS_ALTER_COLUMNS.map((name) => ({ kind: "admin_event_column", name })),
                // entry_versions does not exist yet: no entry_version_column rows at all.
              ]
              : [],
          }),
          run: async () => ({ meta: { changes: 0 } }),
        });
        return make();
      },
      async batch(stmts: { run(): Promise<unknown> }[]) { return Promise.all(stmts.map((s) => s.run())); },
    } as unknown as D1Database;
    return { env: makeTestEnv(undefined, { DB, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() }), execd, prepared };
  }

  /** The name (and, for an ALTER, "table.column") a DDL statement targets — never its full body,
   * so this stayed correct once Builder B's branch added entries_trash.vector_ids and this
   * branch added entry_versions.prior_length_utf16, neither of which changes a name being matched. */
  function target(sql: string): string {
    const created = sql.match(/CREATE (?:UNIQUE )?(?:VIRTUAL )?(?:TABLE|INDEX|TRIGGER)(?:\s+IF NOT EXISTS)?\s+(\w+)/);
    if (created) return created[1];
    const altered = sql.match(/ALTER TABLE (\w+) ADD COLUMN (\w+)/);
    if (altered) return `${altered[1]}.${altered[2]}`;
    return sql;
  }

  beforeEach(resetDatabaseInit);

  it("makes init issue the four CREATEs and nothing else", async () => {
    const { env: mockEnv, execd, prepared } = makePreTask11Mock();

    await initializeDatabase(mockEnv);

    // The four new objects, in SCHEMA_OBJECTS's own declaration order, plus two harmless
    // artifacts: applySchema probes once up front and never again, so the freshly-created
    // entry_versions and entries_trash tables' own prior_length_utf16 and nonce columns (baked
    // into their CREATEs) still get an ALTER attempted against the stale pre-creation probe. D1
    // (and real SQLite) reject it as a duplicate column, caught by isDuplicateColumn — the same
    // routine, non-fatal collision a brand-new brain hits on every cold start
    // (test/unit/db-init.test.ts's "migrates a genuinely empty database"), not a new one Task 11
    // introduced. MOVED (T-0089.1.1, adv-final MAJOR 1): entries_trash.nonce joins
    // prior_length_utf16 in this list.
    // MOVED (T-0089.2.1): a 3.7.0 brain is also owed the two validity ALTERs, and nothing else.
    expect(execd.map(target)).toEqual([
      "entry_versions",
      "idx_entry_versions_entry",
      "entries_trash",
      "idx_entries_trash_deleted",
      "entries.valid_from",
      "entries.valid_until",
      "entry_versions.prior_length_utf16",
      "entries_trash.nonce",
    ]);
    expect(execd[0]).toContain("prior_length_utf16"); // created already the wide way, not by a later ALTER
    expect(prepared).toEqual([expect.stringMatching(PROBE)]);
  });
});
