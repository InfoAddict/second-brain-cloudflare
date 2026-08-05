import type { Env } from "../env";

// The schema work below is idempotent but not free — roughly a dozen D1 statements per
// call. All four nightly jobs run inside a single scheduled() invocation and therefore
// share one subrequest budget, and each of them awaits initializeDatabase, so without
// memoisation the same CREATE/ALTER sequence is paid for three or four times per cron.
// Memoise per isolate: the first caller does the work, everyone else awaits that promise.
//
// Deliberately not routed through ensureDbReady (src/runtime/state.ts) — that fires under
// ctx.waitUntil *without* awaiting, and the nightly jobs must not begin querying before
// the schema exists. They await this directly and must keep doing so.
let initPromise: Promise<void> | null = null;

export async function initializeDatabase(env: Env): Promise<void> {
  if (!initPromise) {
    initPromise = applySchema(env).catch((e) => {
      // The memo keys on SUCCESS, not on completion. Clearing it here is what makes a
      // failed or half-applied schema retryable: latching a resolved promise would leave
      // every later caller in this isolate doing nothing against a database that was
      // never migrated. Before memoisation each nightly job re-ran the DDL and repaired
      // the previous one's transient failure; this preserves that.
      initPromise = null;
      throw e;
    });
  }
  return initPromise;
}

/**
 * Test seam. The memo is module-scoped, so within a single test file the second call
 * would otherwise be a no-op and assertions about issued statements would go blind.
 */
export function resetDatabaseInit(): void {
  initPromise = null;
}

/**
 * The one ALTER failure that is routine rather than a fault: the column was added by an
 * earlier run. Every other error means the schema is not in the shape the code expects.
 */
function isDuplicateColumn(e: unknown): boolean {
  return /duplicate column name/i.test(String((e as { message?: string })?.message ?? e));
}

// Rejects on any genuine failure. Nothing here may swallow errors: a resolved promise is
// the signal initializeDatabase memoises, so swallowing would cache a schema that was
// never applied. The installer creates the D1 database moments before the first request
// reaches the Worker, so the very first run is exactly when a transient error is most
// likely — and most damaging, since that run is the one that creates every table.
async function applySchema(env: Env): Promise<void> {
  await env.DB.exec(`CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'api', created_at INTEGER NOT NULL, vector_ids TEXT NOT NULL DEFAULT '[]')`);
  await env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC)`);
  await env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source)`);
  // Relationship graph (issue #16). One additive table — never touches existing
  // rows/queries, so old code ignores it and rollback is a no-op. Designed to never
  // need an ALTER: type/provenance are free TEXT validated in code, and metadata is
  // a JSON escape-hatch for any future per-edge attribute.
  await env.DB.exec(`CREATE TABLE IF NOT EXISTS edges (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'relates_to', weight REAL NOT NULL DEFAULT 0.5, provenance TEXT NOT NULL DEFAULT 'inferred', metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(source_id, target_id, type))`);
  await env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id)`);
  await env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id)`);
  for (const alter of [
    `ALTER TABLE entries ADD COLUMN recall_count INTEGER DEFAULT 0`,
    `ALTER TABLE entries ADD COLUMN importance_score INTEGER DEFAULT 0`,
    `ALTER TABLE entries ADD COLUMN contradiction_wins INTEGER DEFAULT 0`,
    `ALTER TABLE entries ADD COLUMN contradiction_losses INTEGER DEFAULT 0`,
    // updated_at and staleness_checked_at are deliberately nullable and deliberately NOT
    // backfilled. Every reader coalesces them to a sensible default — updated_at to
    // created_at (COALESCE in SQL, ?? in TS), staleness_checked_at to 0 — so on an
    // existing row a NULL and a written value are indistinguishable downstream, and a
    // backfill would be a pure no-op that still costs one row written per entry. That is
    // not free: D1's plan limits row writes per day, and exceeding the cap fails every
    // query account-wide until 00:00 UTC, so backfilling a large brain on the ordinary
    // upgrade path is an availability risk that buys nothing. Please do not add one.
    // test/unit/updated-at-coalesced.test.ts fails if any reader stops coalescing.
    `ALTER TABLE entries ADD COLUMN updated_at INTEGER`,
    `ALTER TABLE entries ADD COLUMN staleness_checked_at INTEGER`,
  ]) {
    try {
      await env.DB.exec(alter);
    } catch (e) {
      if (!isDuplicateColumn(e)) throw e; // column already exists — anything else is real
    }
  }
}
