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
interface GuardRef {
  current: Env;
  /** The two original, unpatched methods — repair must run through these, never the patched db. */
  rawDB: Pick<D1Database, "prepare" | "batch">;
}

const patched = new WeakSet<object>();
const envRefs = new WeakMap<object, GuardRef>();

function retryOnce<T>(ref: GuardRef, attempt: () => Promise<T>): Promise<T> {
  return attempt().catch(async (e) => {
    if (!isFtsFailure(e)) throw e;
    // Repair through ref.rawDB (the captured pre-patch prepare/batch), not
    // ref.current.DB — that binding is the one being patched, and calling it
    // here would recurse into this same guard.
    await repairFtsIndex({ ...ref.current, DB: ref.rawDB as D1Database });
    return attempt();
  });
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
    __inner: (statement as unknown as { __inner?: D1PreparedStatement }).__inner ?? statement,
  } as unknown as D1PreparedStatement;
}

function unwrapStatement(statement: D1PreparedStatement): D1PreparedStatement {
  return (statement as unknown as { __inner?: D1PreparedStatement }).__inner ?? statement;
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

    db.prepare = (sql: string) => wrapStatement(originalPrepare(sql), guardRef);
    // Unwrap each statement first: a batch retries as ONE unit at the batch
    // level below, so the individual statements inside it must run un-guarded
    // — each carrying its own retryOnce would let one statement's repair
    // recurse into env.DB.batch() from inside another batch call still
    // in flight on the same connection (test/helpers/sqlite-d1.ts serializes
    // batches on one connection), deadlocking the two against each other.
    db.batch = (statements: D1PreparedStatement[]) =>
      retryOnce(guardRef, () => originalBatch(statements.map(unwrapStatement)));
  }

  return env;
}
