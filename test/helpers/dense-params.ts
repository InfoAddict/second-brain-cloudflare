import type { Env } from "../../src/env";

/**
 * A fake D1 that records every prepared statement's SQL and its bound values, for builders
 * (src/memory/trash.ts) that call `env.DB.prepare(sql).bind(...)` directly rather than returning
 * a `{sql, bindings}` pair. Pair each recorded call with `denseProblem` (test/helpers/sql-dense.ts),
 * the shared density check src/memory/versions.ts's own builder tests use.
 */
export function captureEnv(): { env: Env; calls: { sql: string; args: unknown[] }[] } {
  const calls: { sql: string; args: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          calls.push({ sql, args });
          return { run: async () => ({ meta: { changes: 0 } }), all: async () => ({ results: [] }), first: async () => null };
        },
      };
    },
    async batch(stmts: unknown[]) { return stmts.map(() => ({ meta: { changes: 0 } })); },
  };
  return { env: { DB: db } as unknown as Env, calls };
}
