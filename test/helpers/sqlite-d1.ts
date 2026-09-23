/**
 * A D1 facade over real SQLite, for tests whose subject is the SQL itself.
 *
 * `test/helpers/d1-mock.ts` matches query strings and returns canned rows. That
 * is the right tool for most tests — it is fast and it keeps fixtures obvious —
 * but it cannot evaluate SQL, so anything whose correctness *is* the query is
 * untestable against it. The embedding migration is exactly that: a keyset
 * cursor whose comparison decides whether entries are skipped or repeated, and
 * an aggregate that projects chunk counts with integer division.
 *
 * D1 is SQLite, and `node:sqlite` ships with Node, so those queries can be run
 * for real against the project's own `db/schema.sql`. A wrong comparison then
 * fails the test instead of passing a string match.
 *
 * The schema migration in `src/db/init.ts` is the other case, and the sharper
 * one: `d1-mock`'s `exec()` is a no-op, so it cannot express "that column is
 * already there" or "that table is not" — the two facts the migration now reads
 * before it writes. Against real SQLite a probe that misreports an empty
 * database as migrated leaves the tables uncreated and the next statement fails,
 * which is exactly the regression worth catching. Pass `{ schema: false }` for a
 * database with nothing in it at all.
 *
 * Only the surface the code under test uses is implemented — `prepare`, `bind`,
 * `all`, `first`, `run`, `exec`. Reach for `d1-mock` for everything else.
 */
import { DatabaseSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// SB_EVAL_ROOT lets the bundled eval CLI (whose import.meta.dirname is the bundle's) find the schema.
const SCHEMA = resolve(process.env.SB_EVAL_ROOT ?? resolve(import.meta.dirname, "../.."), "db/schema.sql");

// One FIFO queue per connection, shared by every standalone statement AND
// every batch on that connection. A batch opens a SAVEPOINT for its whole
// body; without this, a standalone statement issued while that SAVEPOINT is
// open runs inside it on the same connection and gets rolled back with it if
// the batch later fails, even though it has nothing to do with the batch.
const connectionQueues = new WeakMap<DatabaseSync, Promise<unknown>>();

// Marks "this async call chain is executing as part of a batch already
// holding connection X's queue slot" — set only around db.batch()'s own
// body (see below). AsyncLocalStorage, not a plain flag, because a flag
// cannot tell a batch's OWN nested statement.run() calls (which must run
// inline, or they would queue behind their own still-running batch and
// deadlock) apart from a genuinely unrelated call that merely happens to
// execute during the same window (which must still queue and wait its turn).
//
// The store is a token, not just the DatabaseSync, because a batch's own
// statement.run() can spawn async work it does not await (a fire-and-forget
// `.then()`). That work still closes over this ALS context, so it can resume
// AFTER the batch has closed — by then the context is stale, and comparing
// only the connection would let it run inline as if still part of that
// batch, even inside a DIFFERENT, later batch's open SAVEPOINT. Comparing
// the token catches that: it changes every time a batch starts, so a stale
// context's token no longer matches whatever batch (if any) is active now.
const activeBatchConnection = new AsyncLocalStorage<{ db: DatabaseSync; token: object }>();

function enqueue<T>(db: DatabaseSync, fn: () => T | Promise<T>): Promise<T> {
  const store = activeBatchConnection.getStore();
  if (store && store.db === db && store.token === currentBatchToken.get(db)) {
    return Promise.resolve().then(fn);
  }
  const prior = connectionQueues.get(db) ?? Promise.resolve();
  const settled = prior.then(fn, fn);
  connectionQueues.set(db, settled.then(() => undefined, () => undefined));
  return settled;
}

/** The token of the batch CURRENTLY holding connection X's queue slot, if any. */
const currentBatchToken = new WeakMap<DatabaseSync, object>();

class SqliteStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly args: unknown[] = [],
  ) {}

  bind(...args: unknown[]): SqliteStatement {
    return new SqliteStatement(this.db, this.sql, args);
  }

  /** SQL text retained so batch-aware assertions can inspect its members. */
  sourceSql(): string {
    return this.sql;
  }

  private allOnce(): { results: unknown[]; success: true; meta: { rows_written: 0 } } {
    const rows = this.db.prepare(this.sql).all(...(this.args as never[]));
    // SQLite can prove that this SELECT wrote no rows, but it cannot reproduce
    // Cloudflare D1's billed rows_read (which includes index/table work rather
    // than merely returned rows). Leave rows_read absent instead of inventing it.
    return { results: rows, success: true, meta: { rows_written: 0 } };
  }

  private firstOnce(): unknown | null {
    const row = this.db.prepare(this.sql).get(...(this.args as never[]));
    return row ?? null;
  }

  /**
   * D1 returns each batched statement's ROWS as well as its meta, and a batch
   * carries reads as well as writes — identity resolution pairs its SELECT with
   * the throttled last_used_at write so the pair costs one subrequest. batch()
   * below executes statements through run(), and several tests wrap batch() with
   * their own `st.run()` loop, so a SELECT has to answer with its rows here or
   * the identity read comes back empty through every one of them.
   *
   * Additive for writes: `meta.rows_written` is unchanged, and `results` is
   * simply absent where there are no rows to report.
   */
  private runOnce(): { results?: unknown[]; success: true; meta: { rows_written: number } } {
    const statement = this.db.prepare(this.sql);
    if (/^\s*(SELECT|WITH)\b/i.test(this.sql)) {
      return { results: statement.all(...(this.args as never[])), success: true, meta: { rows_written: 0 } };
    }
    const result = statement.run(...(this.args as never[]));
    return { success: true, meta: { rows_written: Number(result.changes) } };
  }

  async all() { return enqueue(this.db, () => this.allOnce()); }
  async first() { return enqueue(this.db, () => this.firstOnce()); }
  async run() { return enqueue(this.db, () => this.runOnce()); }
}

export interface SqliteD1 {
  /** Shaped like `env.DB`. */
  db: {
    prepare(sql: string): SqliteStatement;
    exec(sql: string): Promise<void>;
    batch(statements: SqliteStatement[]): Promise<{ results?: unknown[]; success: true; meta: { rows_written: number } }[]>;
  };
  /**
   * One entry per D1 call made through `db` — which is one entry per subrequest,
   * since `prepare()` here is only ever followed by a single execution.
   */
  issued: string[];
  /** SQL members of each collapsed batch, without changing its one-subrequest count. */
  batches: string[][];
  /** Column names currently on `entries`, straight from SQLite. */
  columns(): string[];
  /** Insert an entry directly, bypassing the capture pipeline. */
  seed(entry: {
    id: string;
    content: string;
    createdAt: number;
    tags?: string[];
    source?: string;
    vectorIds?: string[];
    /** Drives the compression and resurfacing rules; defaults to 0. */
    importanceScore?: number;
  }): void;
  /** Every row, for assertions about what the code under test wrote. */
  rows(): Record<string, unknown>[];
  close(): void;
}

/**
 * A fresh in-memory database with the project's real schema applied.
 *
 * Using the shipped schema rather than a hand-written CREATE TABLE means a
 * column rename breaks these tests, which is the point — the migration's SQL
 * names columns.
 */
/**
 * Remove `-- …` line comments, respecting single-quoted string literals so a
 * "--" inside a default value is not mistaken for a comment.
 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inString) {
      out += ch;
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      // Skip to end of line, keeping the newline so line structure survives.
      while (i < sql.length && sql[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += ch;
  }
  return out;
}

/** Split top-level schema statements without cutting semicolons inside triggers. */
export function splitSchemaStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let trigger = false;
  for (const ch of sql) {
    current += ch;
    if (!trigger && /^\s*CREATE\s+TRIGGER\b/i.test(current)) trigger = true;
    if (ch !== ";") continue;
    if (trigger && !/\bEND\s*;\s*$/i.test(current)) continue;
    statements.push(current.slice(0, -1));
    current = "";
    trigger = false;
  }
  if (current.trim()) statements.push(current);
  return statements;
}

export function makeSqliteD1({ schema: applySchema = true }: { schema?: boolean } = {}): SqliteD1 {
  const raw = new DatabaseSync(":memory:");
  // The schema uses D1-flavoured DDL; execute it statement by statement so one
  // unsupported pragma cannot take the whole file down silently.
  const schema = applySchema ? readFileSync(SCHEMA, "utf8") : "";
  // Strip comments BEFORE splitting, not after. Splitting the raw file on ";"
  // and filtering comment lines out of each chunk looks equivalent but is not:
  // a ";" inside a trailing `-- comment` cuts the statement it is attached to
  // in half, and the two halves then fail to parse. Wrangler's own splitter is
  // comment-aware, so such a file migrates fine in production while silently
  // losing tables here — which is exactly how the whole `users` table (and with
  // it every tenancy test) went missing without a single red test.
  for (const statement of splitSchemaStatements(stripSqlComments(schema))) {
    const sql = statement.trim();
    if (!sql) continue;
    try {
      raw.exec(sql);
    } catch (e) {
      // A CREATE TABLE that does not apply leaves tests asserting against a
      // database that is missing the thing under test, so no table creation is
      // ever allowed to fail quietly. Indexes are the tolerated case: some use
      // D1-only syntax this facade does not need.
      if (/^\s*CREATE\s+TABLE\b/i.test(sql) || /\bentries\b/i.test(sql)) {
        throw new Error(`schema.sql statement failed:\n${sql}\n${String(e)}`);
      }
    }
  }

  const issued: string[] = [];
  const batches: string[][] = [];
  let savepointCounter = 0;

  return {
    issued,
    batches,
    db: {
      prepare: (sql: string) => {
        issued.push(sql);
        return new SqliteStatement(raw, sql);
      },
      // Present so a whole-Worker request against this facade runs the real
      // initializeDatabase path rather than failing on a missing method. The
      // schema is already applied above; that DDL is idempotent, and the ALTERs
      // raise the same "duplicate column name" D1 does, which init.ts expects.
      exec: async (sql: string) => {
        issued.push(sql);
        raw.exec(sql);
      },
      // A batch is ONE subrequest whatever it carries, which is the whole reason
      // production uses it — so it must count as one entry in `issued`, or the
      // budget tests measure something the platform does not charge for.
      //
      // Callers build the statements with env.DB.prepare(), and `prepare` above
      // has already pushed one entry per statement by the time this runs. The
      // last `statements.length` entries are therefore exactly this batch's, so
      // they are replaced by the single entry the platform actually charges for.
      batch: async (statements: SqliteStatement[]) => {
        issued.splice(Math.max(0, issued.length - statements.length), statements.length, "BATCH");
        // Some tests wrap a prepared statement to instrument run(). Preserve
        // compatibility with those D1-shaped wrappers while retaining SQL when
        // either the wrapper or its conventional __inner statement exposes it.
        batches.push(statements.map((statement) => {
          const wrapped = statement as SqliteStatement & { __inner?: SqliteStatement };
          if (typeof wrapped.sourceSql === "function") return wrapped.sourceSql();
          if (typeof wrapped.__inner?.sourceSql === "function") return wrapped.__inner.sourceSql();
          return "[wrapped D1 statement]";
        }));
        // Real D1 documents batch() as one transaction: a failure partway through
        // leaves no statement's effect behind. Without an explicit transaction here,
        // node:sqlite commits each statement.run() as it goes, so a caller that
        // retries a whole failed batch (the entries_fts write-path repair) would
        // re-apply statements that already landed and hit spurious constraint
        // errors that could never happen against real D1.
        //
        // A SAVEPOINT rather than BEGIN/COMMIT: this facade is one shared
        // synchronous connection, and some callers run two logical requests
        // concurrently (Promise.all of two handlers, each batching); BEGIN
        // would fail the second with "cannot start a transaction within a
        // transaction". Queued through enqueue() (shared with every
        // standalone statement on this connection, see above) so two
        // SAVEPOINTs never nest out of LIFO order, and no unrelated
        // standalone statement can run while this one is open.
        return enqueue(raw, () => {
          const token = {};
          currentBatchToken.set(raw, token);
          return activeBatchConnection.run({ db: raw, token }, async () => {
            const sp = `sqlite_d1_batch_${savepointCounter++}`;
            raw.exec(`SAVEPOINT ${sp}`);
            try {
              const out: { results?: unknown[]; success: true; meta: { rows_written: number } }[] = [];
              // Every statement.run() here — a real SqliteStatement directly,
              // or one reached indirectly through a test double's own run() —
              // is still inside the activeBatchConnection context this batch
              // just entered, so enqueue() runs it inline instead of queuing
              // it behind this same still-running batch.
              for (const statement of statements as unknown as { run(): unknown }[]) {
                out.push(await statement.run() as { results?: unknown[]; success: true; meta: { rows_written: number } });
              }
              raw.exec(`RELEASE ${sp}`);
              return out;
            } catch (e) {
              raw.exec(`ROLLBACK TO ${sp}`);
              raw.exec(`RELEASE ${sp}`);
              throw e;
            } finally {
              // Ends this batch's queue slot. Any async work spawned inside
              // it that resumes after this point no longer matches the
              // token, so enqueue() routes it back through the FIFO queue
              // instead of letting it run inline against whatever batch (if
              // any) is active on this connection by the time it resumes.
              if (currentBatchToken.get(raw) === token) currentBatchToken.delete(raw);
            }
          });
        });
      },
    },
    columns() {
      return (raw.prepare(`SELECT name FROM pragma_table_info('entries')`).all() as { name: string }[])
        .map(r => r.name);
    },
    seed({ id, content, createdAt, tags = [], source = "api", vectorIds = [], importanceScore = 0 }) {
      raw
        .prepare(
          `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, recall_count, importance_score)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
        )
        .run(id, content, JSON.stringify(tags), source, createdAt, JSON.stringify(vectorIds), importanceScore);
    },
    rows() {
      return raw
        .prepare(`SELECT * FROM entries ORDER BY created_at ASC, id ASC`)
        .all() as Record<string, unknown>[];
    },
    close() {
      raw.close();
    },
  };
}
