import { expect } from "vitest";
import type { Env } from "../../src/env";

/** A fake D1 that records every prepared statement's SQL and its bound values. */
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

/** Every `?k` in `sql` is exactly {1..n}, with n === args.length (M1: D1 rejects a gap). */
export function assertDenseParams(sql: string, args: unknown[]): void {
  const nums = [...new Set([...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  expect(nums).toEqual(Array.from({ length: args.length }, (_, i) => i + 1));
}
