/**
 * Round 2 versions adversary follow-up (T-0089.1.1): markSourcesRolledUp's ADV-3/ADV-9 fix
 * (a569aa7) grew its batch from one shared snapshot to one snapshot + one mark per source, binding
 * each source's full content twice (the snapshot guard and the UPDATE guard). Measured against real
 * workerd D1 at the digest's own worst case (50 sources, the nightly cron's `LIMIT 50`, up to 1 MB
 * each): 101 statements (2N+1), ~100 MB total batch bytes — the whole nightly cron's own D1
 * subrequest budget for a single tag (compression/nightly.ts's COMPRESSION_MAX_TAGS_PER_RUN, whose
 * own doc comment assumed "about six" D1 calls per tag).
 *
 * The fix (this test now guards): the guard becomes (workspace_id, updated_at, byte length of
 * content) instead of full content, carried as one JSON tuple parameter for however many sources —
 * so the whole batch is 3 statements regardless of source count, not 2N+1.
 *
 * Measured against real workerd D1 (EVAL_WORKERD=1, local only) rather than estimated: SQL and
 * bound-parameter bytes are invisible to node:sqlite's driver, and D1's per-statement caps
 * (100 KB SQL, 100 bound params) are enforced by the real D1 shim, not by SQLite itself.
 */
import { describe, it, expect, afterAll } from "vitest";
import { openD1 } from "../eval/d1";
import { cleanTemp } from "../helpers/tmp";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { markSourcesRolledUp } from "../../src/compression/digest";
import { D1_MAX_BOUND_PARAMS } from "../../src/constants";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";

afterAll(cleanTemp);

const D1_MAX_SQL_BYTES = 100_000; // documented: applies per statement, including inside batch()
const SOURCES = 50; // the nightly cron's own cap (compression/digest.ts's `LIMIT 50`)
const CONTENT_BYTES = 1_000_000; // the adversary's stated worst case

describe.runIf(process.env.EVAL_WORKERD === "1")("digest rollup batch size on real workerd D1", () => {
  it(`measures markSourcesRolledUp's real batch at ${SOURCES} sources of ~1 MB`, async () => {
    const d1 = await openD1("workerd");
    try {
      resetDatabaseInit();
      const env = makeTestEnv(undefined, { DB: d1.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }) as Env;
      await initializeDatabase(env);
      const roots = await ensureTenantBootstrap(env);

      // Distinct content per source (a numbered suffix) so each has its own byte length; a
      // shared rowVersion (every row inserted "at" the same moment) is the realistic case —
      // rows a digest reads together are rarely edited in the same instant.
      const sources = Array.from({ length: SOURCES }, (_, i) => ({
        id: `dig-src-${i}`,
        content: "x".repeat(CONTENT_BYTES) + `-${i}`,
        rowVersion: 1, // COALESCE(updated_at, created_at); both columns are seeded to 1 below
      }));
      for (const s of sources) {
        await env.DB.prepare(
          `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, '[]', 'api', 1, 1, '[]', ?, ?)`,
        ).bind(s.id, s.content, roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();
      }

      // A pass-through wrapper: records every statement's SQL and bound-argument bytes, then
      // hands off to the real prepared statement so the batch actually runs against real D1.
      const calls: { sql: string; argBytes: number; argCount: number }[] = [];
      const realDb = env.DB;
      const measuringDb = {
        prepare(sql: string) {
          const real = realDb.prepare(sql);
          return {
            bind(...args: unknown[]) {
              const argBytes = args.reduce((n: number, a) => n + (typeof a === "string" ? Buffer.byteLength(a) : 8), 0);
              calls.push({ sql, argBytes, argCount: args.length });
              return real.bind(...args);
            },
          };
        },
        batch: (stmts: unknown[]) => realDb.batch(stmts as never),
      } as unknown as Env["DB"];

      let batchError: unknown;
      try {
        await markSourcesRolledUp({ ...env, DB: measuringDb }, sources, "digest1", roots.ownerPersonalWorkspaceId, DEFAULTS);
      } catch (e) {
        batchError = e;
      }

      const statementCount = calls.length;
      const maxSqlBytes = Math.max(...calls.map((c) => Buffer.byteLength(c.sql)));
      const maxArgCount = Math.max(...calls.map((c) => c.argCount));
      const totalBatchBytes = calls.reduce((n, c) => n + Buffer.byteLength(c.sql) + c.argBytes, 0);

      console.log("digest rollup batch measurement (post-fix):", {
        statementCount, maxSqlBytes, maxArgCount, totalBatchBytes,
        batchError: batchError instanceof Error ? batchError.message : batchError,
      });

      if (batchError) throw batchError;

      // The fix: one snapshot, one mark, one prune — regardless of source count. Was 2N+1 (101
      // at this size) before the byte-size fix; must never scale with N again.
      expect(statementCount).toBe(3);
      expect(maxSqlBytes).toBeLessThan(D1_MAX_SQL_BYTES);
      expect(maxArgCount).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
      // No statement carries a source's full content any more (guarded on updated_at + byte
      // length instead) — was ~100 MB total across the batch before the fix.
      expect(totalBatchBytes).toBeLessThan(50_000);

      const rolledUp = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM entries WHERE tags LIKE '%"rolled-up"%'`,
      ).first<{ n: number }>();
      expect(rolledUp?.n).toBe(SOURCES);
    } finally {
      await d1.close();
    }
  }, 180_000);
});
