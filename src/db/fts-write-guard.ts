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

// Case-insensitive. Strips leading comments/whitespace, then (if what
// remains starts with WITH) scans PAST the leading CTE clause with a small
// lexer that respects quoted strings, comments, and balanced parentheses —
// not a lazy regex scan, which is fooled by write-shaped text sitting inside
// a string literal or a read-only CTE body (v2 review, S4). What is left
// after that scan is matched against the write verb (with its OR-clause and
// INTO/FROM variants), an optional `main.` schema qualifier, and the table
// name bare or quoted with `"`, `` ` ``, or `[]`, followed by whitespace,
// `(`, `;`, or end of string (the `;` addition is S4's sibling finding, S3:
// a valid semicolon-terminated statement was falling through unclassified).
//
// The trailing lookahead is what keeps the bare form from matching
// `entries_fts`, `entries_x`, or `entriesé`: `_` and non-ASCII letters are
// none of whitespace/`(`/`;`/end, so the boundary holds without a separate
// `\b` check (which JS treats as ASCII-only and would wrongly see a boundary
// before "é"). Quoted forms need no extra check either: matching the literal
// `"entries"` (etc.) already excludes `"entries_fts"`, whose quoted content
// is a different string.
const LEADING_COMMENT_OR_WS = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/;
const ENTRIES_NAME = `(?:entries|"entries"|\`entries\`|\\[entries\\])`;
const ENTRIES_WRITE_STATEMENT = new RegExp(
  `^(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|REPLACE\\s+INTO|UPDATE(?:\\s+OR\\s+\\w+)?|DELETE\\s+FROM)` +
  `\\s+(?:main\\.)?${ENTRIES_NAME}(?=\\s|\\(|;|$)`,
  "iu",
);

function stripLeadingCommentsAndWs(sql: string): string {
  let stripped = sql;
  let prev: string;
  do {
    prev = stripped;
    stripped = stripped.replace(LEADING_COMMENT_OR_WS, "");
  } while (stripped !== prev);
  return stripped;
}

/** Advances past whitespace and comments starting at `i`. */
function skipWsAndComments(sql: string, i: number): number {
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    break;
  }
  return i;
}

/**
 * `sql[i]` must be `(`. Returns the index just past its matching `)`,
 * skipping over quoted strings and comments along the way so a paren (or a
 * write verb, per S4) inside a string literal is never mistaken for real
 * SQL structure.
 */
function skipBalancedParens(sql: string, i: number): number {
  const n = sql.length;
  let depth = 0;
  for (; i < n; i++) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i++;
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; } // doubled-quote escape
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return n;
}

/**
 * Walks past a leading `WITH` clause — one or more `name [(cols)] AS (
 * body )` CTEs, comma-separated — to the outer statement that follows.
 * `sql` must already start with `WITH` (case-insensitive). Malformed input
 * (a shape this scanner does not recognize) bails out at the point it gets
 * confused, which only ever makes the remainder MORE likely to fail the
 * write-verb match, never less — the write classification stays conservative.
 */
function skipLeadingWith(sql: string): string {
  const n = sql.length;
  // Optional RECURSIVE must be consumed here, before the loop starts looking
  // for the first CTE's name — otherwise it reads "RECURSIVE" itself as that
  // name and never finds the real one (v2.2 review).
  let i = /^WITH\s*(?:RECURSIVE\s+)?/i.exec(sql)![0].length;
  for (;;) {
    i = skipWsAndComments(sql, i);
    const nameStart = i;
    while (i < n && /[\p{L}\p{N}_"`]/u.test(sql[i])) i++;
    if (i === nameStart) return sql.slice(i); // no CTE name — malformed, bail
    i = skipWsAndComments(sql, i);
    if (sql[i] === "(") i = skipBalancedParens(sql, i); // optional column list
    i = skipWsAndComments(sql, i);
    const asMatch = /^AS\b/i.exec(sql.slice(i));
    if (!asMatch) return sql.slice(i); // malformed — bail conservatively
    i = skipWsAndComments(sql, i + asMatch[0].length);
    if (sql[i] !== "(") return sql.slice(i); // malformed — bail conservatively
    i = skipBalancedParens(sql, i);
    i = skipWsAndComments(sql, i);
    if (sql[i] === ",") { i++; continue; }
    return sql.slice(i);
  }
}

function isEntriesWriteSql(sql: string): boolean {
  let stripped = stripLeadingCommentsAndWs(sql);
  if (/^WITH\b/i.test(stripped)) {
    stripped = stripLeadingCommentsAndWs(skipLeadingWith(stripped));
  }
  return ENTRIES_WRITE_STATEMENT.test(stripped);
}

function retryOnce<T>(ref: GuardRef, attempt: () => Promise<T>): Promise<T> {
  return attempt().catch(async (e) => {
    if (!isFtsFailure(e)) throw e;
    // Repair through ref.rawDB (the captured pre-patch prepare/batch), not
    // ref.current.DB — that binding is the one being patched, and calling it
    // here would recurse into this same guard.
    await repairFtsIndex({ ...ref.current, DB: ref.rawDB as D1Database }, e);
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
      return isEntriesWriteSql(sql) ? wrapStatement(statement, guardRef) : statement;
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
