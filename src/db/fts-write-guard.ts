import type { Env } from "../env";
import { isFtsFailure, repairFtsIndex } from "./fts-repair";

// One choke point for every write to `entries`, instead of touching each of
// the several dozen call sites individually (see the fix's report). Patches
// env.DB.prepare/.bind and env.DB.batch IN PLACE (idempotent via `patched`)
// so a D1 error naming entries_fts repairs the index and retries EXACTLY the
// failed statement or batch once — never the whole handler, which could
// duplicate a partial multi-statement write. A failed statement or batch has
// no effect (D1 batch() is one transaction), so retrying it is safe.
//
// Patched in place, not swapped for a wrapped copy, so `env.DB` keeps its
// object identity: src/lib/tenancy.ts memoizes tenant bootstrap in a WeakMap
// keyed on that identity, and handing back a different object would make
// that cache miss and re-run the bootstrap batch on the next real request.
//
// Only statements that WRITE to `entries` are guarded at all — a read (even
// one that names entries_fts, even one that fails) passes through untouched.
// Guarding reads too is what let a malformed SELECT drop a healthy index.
interface GuardRef {
  current: Env;
  /** The two original, unpatched methods — repair must run through these, never the patched db. */
  rawDB: Pick<D1Database, "prepare" | "batch">;
}

const patched = new WeakSet<object>();
const envRefs = new WeakMap<object, GuardRef>();

// Case-insensitive, whitespace-tolerant. `entries\b` does not match
// `entries_fts` (`_` is a word character, so there is no boundary there) or
// `entry_events` (a different word), so both are excluded by construction.
const ENTRIES_WRITE_SQL = /^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+entries\b/i;

function retryOnce<T>(ref: GuardRef, attempt: () => Promise<T>): Promise<T> {
  return attempt().catch(async (e) => {
    if (!isFtsFailure(e)) throw e;
    // Repair through ref.rawDB (the captured pre-patch prepare/batch), not
    // ref.current.DB — that binding is the one being patched, and calling it
    // here would recurse into this same guard.
    const repaired = await repairFtsIndex({ ...ref.current, DB: ref.rawDB as D1Database });
    // The index was already healthy: this write's failure was real, not an
    // artifact of a broken index, so retrying it would just fail again (or
    // worse, succeed against a read error that was never about entries_fts).
    if (!repaired) throw e;
    return attempt();
  });
}

function unwrapStatement(statement: D1PreparedStatement): D1PreparedStatement {
  return (statement as unknown as { __inner?: D1PreparedStatement }).__inner ?? statement;
}

function wrapStatement(statement: D1PreparedStatement, ref: GuardRef): D1PreparedStatement {
  return {
    bind: (...args: unknown[]) => wrapStatement(statement.bind(...args), ref),
    run: () => retryOnce(ref, () => statement.run()),
    all: () => retryOnce(ref, () => statement.all()),
    first: (colName?: string) => retryOnce(ref, () => statement.first(colName as never)),
    raw: (options?: never) => retryOnce(ref, () => statement.raw(options)),
    // `.__inner` is this codebase's convention (sqlite-d1.ts,
    // cron-subrequest-budget.test.ts) for "skip every layer of test-double
    // instrumentation down to the raw statement" — resolve through to that,
    // not to the statement THIS wraps (itself already one of those doubles),
    // or a double's own batch() ends up running that middle layer's `run()`
    // a second time and billing the statement twice.
    __inner: unwrapStatement(statement),
    __entriesWrite: true,
  } as unknown as D1PreparedStatement;
}

export function withFtsWriteGuard(env: Env): Env {
  const rawDB = env.DB as unknown as object;
  const db = env.DB;

  let ref = envRefs.get(rawDB);
  if (!ref) {
    ref = { current: env, rawDB: { prepare: db.prepare.bind(db), batch: db.batch.bind(db) } };
    envRefs.set(rawDB, ref);
  } else {
    ref.current = env;
  }

  if (!patched.has(rawDB)) {
    patched.add(rawDB);
    const { prepare: originalPrepare, batch: originalBatch } = ref.rawDB;
    const guardRef = ref;

    // Not an entries write: return the statement untouched, no wrapping at
    // all, so a read against entries_fts (or anything else) never goes
    // through retryOnce regardless of what error it throws.
    db.prepare = (sql: string) => {
      const statement = originalPrepare(sql);
      return ENTRIES_WRITE_SQL.test(sql) ? wrapStatement(statement, guardRef) : statement;
    };

    // A batch retries as ONE unit if ANY statement in it writes to entries;
    // otherwise it passes straight through. Statements are unwrapped first
    // either way — a batch retries at the batch level, so the individual
    // statements inside it must run un-guarded, or one statement's own
    // repair could recurse into env.DB.batch() from inside another batch
    // still in flight on the same connection (test/helpers/sqlite-d1.ts
    // serializes batches on one connection), deadlocking the two.
    db.batch = (statements: D1PreparedStatement[]) => {
      const guarded = statements.some(s => (s as unknown as { __entriesWrite?: boolean }).__entriesWrite === true);
      const raw = statements.map(unwrapStatement);
      return guarded ? retryOnce(guardRef, () => originalBatch(raw)) : originalBatch(raw);
    };
  }

  return env;
}
