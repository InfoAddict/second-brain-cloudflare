import { describe, expect, it, afterAll } from "vitest";
import { openD1 } from "./d1";
import { cleanTemp } from "../helpers/tmp";

// wrangler and Miniflare leave a miniflare-* dir behind even after dispose().
afterAll(cleanTemp);

// Opt-in: boots a local workerd (never a remote binding).
describe.skipIf(!process.env.EVAL_WORKERD)("workerd D1 backend", () => {
  it("has FTS5 trigram and the shipped schema", async () => {
    const d1 = await openD1("workerd");
    try {
      await d1.db.prepare(`INSERT INTO entries (id, content, created_at) VALUES ('x', 'hello trigram world', 1)`).run();
      const hit = await d1.db.prepare(`SELECT id FROM entries_fts WHERE entries_fts MATCH '"trigram"'`).all();
      expect(hit.results).toHaveLength(1);
    } finally {
      await d1.close();
    }
  }, 120_000);

  it("reports rows_read that scales with the scan, not the result", async () => {
    const d1 = await openD1("workerd");
    try {
      await d1.db.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500)
         INSERT INTO entries (id, content, created_at) SELECT 'r' || i, 'row ' || i, 1 FROM n`,
      ).run();
      const scan = await d1.db.prepare(`SELECT id FROM entries WHERE content LIKE '%zzz%'`).all();
      const lookup = await d1.db.prepare(`SELECT id FROM entries WHERE id = 'r7'`).all();
      expect(scan.results).toHaveLength(0);
      expect(scan.meta.rows_read).toBe(500);
      expect(lookup.meta.rows_read).toBe(1);
    } finally {
      await d1.close();
    }
  }, 120_000);
});

// Probe vs real workerd limits (CP2). Opt-in, local workerd only.
const OLD_PROBE_4_0_0 =
  `SELECT type AS kind, name, sql AS definition FROM sqlite_master WHERE type IN ('table','index','trigger') ` +
  `UNION ALL SELECT 'column' AS kind, name, NULL AS definition FROM pragma_table_info('entries')` +
  `UNION ALL SELECT 'edge_column' AS kind, name, NULL AS definition FROM pragma_table_info('edges')` +
  `UNION ALL SELECT 'user_column' AS kind, name, NULL AS definition FROM pragma_table_info('users')` +
  `UNION ALL SELECT 'admin_event_column' AS kind, name, NULL AS definition FROM pragma_table_info('admin_events')` +
  `UNION ALL SELECT 'entry_version_column' AS kind, name, NULL AS definition FROM pragma_table_info('entry_versions')` +
  `UNION ALL SELECT 'entries_trash_column' AS kind, name, NULL AS definition FROM pragma_table_info('entries_trash')`;

describe.skipIf(!process.env.EVAL_WORKERD)("workerd D1 probe limits", () => {
  it("[CP2-T11] real workerd runs the real probe", async () => {
    const { initializeDatabase, resetDatabaseInit } = await import("../../src/db/init");
    const { makeTestEnv } = await import("../helpers/make-env");
    const d1 = await openD1("workerd");
    try {
      const log: { sql: string; binds: unknown[] }[] = [];
      const wrapStmt = (stmt: any, rec: { sql: string; binds: unknown[] }): any =>
        new Proxy(stmt, {
          get(target, prop) {
            if (prop === "bind") {
              return (...args: unknown[]) => { rec.binds = args; return wrapStmt(target.bind(...args), rec); };
            }
            const v = target[prop];
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
      const recording = new Proxy(d1.db as any, {
        get(target, prop) {
          if (prop === "prepare") {
            return (sql: string) => {
              const rec = { sql, binds: [] as unknown[] };
              log.push(rec);
              return wrapStmt(target.prepare(sql), rec);
            };
          }
          const v = target[prop];
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      resetDatabaseInit();
      await initializeDatabase(makeTestEnv(recording as any));
      resetDatabaseInit();
      const probes = log.filter(r => r.sql.includes("sqlite_master") && r.sql.includes("pragma_table_info"));
      expect(probes).toHaveLength(1);
      const res = await d1.db.prepare(probes[0].sql).bind(...probes[0].binds).all<{ kind: string; name: string }>();
      expect(res.results).toContainEqual(expect.objectContaining({ kind: "table", name: "entries" }));
    } finally {
      await d1.close();
    }
  }, 120_000);

  it("[CP2-T12] real workerd rejects the 4.0.0 probe", async () => {
    const d1 = await openD1("workerd");
    try {
      await expect(d1.db.prepare(OLD_PROBE_4_0_0).all()).rejects.toThrow(/too many terms in compound SELECT/);
    } finally {
      await d1.close();
    }
  }, 120_000);

  it("[CP2-T13] workerd's limits are the numbers the guard assumes", async () => {
    const d1 = await openD1("workerd");
    try {
      const terms = (n: number) => Array.from({ length: n }, (_, i) => `SELECT ${i}`).join(" UNION ALL ");
      const binds = (n: number) => ({ sql: `SELECT ${Array.from({ length: n }, () => "?").join("+")} AS s`, args: new Array(n).fill(1) });
      const five = await d1.db.prepare(terms(5)).all();
      expect(five.results).toHaveLength(5);
      await expect(d1.db.prepare(terms(6)).all()).rejects.toThrow(/too many terms in compound SELECT/);
      const ok = binds(100);
      const hundred = await d1.db.prepare(ok.sql).bind(...ok.args).all<{ s: number }>();
      expect(hundred.results[0].s).toBe(100);
      const over = binds(101);
      await expect(d1.db.prepare(over.sql).bind(...over.args).all()).rejects.toThrow();
    } finally {
      await d1.close();
    }
  }, 120_000);
});

describe.skipIf(!process.env.EVAL_WORKERD)("workerd D1 probe, init path", () => {
  it("[CP2-X02] initializeDatabase's own probe succeeds on a migrated workerd brain", async () => {
    const { initializeDatabase, resetDatabaseInit } = await import("../../src/db/init");
    const { makeTestEnv } = await import("../helpers/make-env");
    const d1 = await openD1("workerd");
    const warnings: unknown[][] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      const prepared: string[] = [];
      const recording = new Proxy(d1.db as any, {
        get(target, prop) {
          if (prop === "prepare") return (sql: string) => { prepared.push(sql); return target.prepare(sql); };
          const v = target[prop];
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      resetDatabaseInit();
      await initializeDatabase(makeTestEnv(recording as any));
      resetDatabaseInit();
      expect(warnings.filter(w => String(w[0]).includes("Schema probe failed"))).toEqual([]);
      const probeAt = prepared.findIndex(s => s.includes("sqlite_master") && s.includes("pragma_table_info"));
      expect(probeAt).toBeGreaterThanOrEqual(0);
      expect(prepared.slice(probeAt + 1).filter(s => /^\s*(CREATE|ALTER)\b/i.test(s))).toEqual([]);
    } finally {
      console.warn = realWarn;
      await d1.close();
    }
  }, 120_000);

  it("[CP2-X03] workerd accepts 100 flat bound values and rejects 101 with its too-many-variables error", async () => {
    const d1 = await openD1("workerd");
    try {
      // Flat column list: a '+' chain hits the expression depth limit (100) first, not the bind limit.
      const flat = (n: number) => `SELECT ${Array.from({ length: n }, (_, i) => `? AS c${i}`).join(", ")}`;
      const ok = await d1.db.prepare(flat(100)).bind(...new Array(100).fill(1)).all();
      expect(ok.results).toHaveLength(1);
      await expect(d1.db.prepare(flat(101)).bind(...new Array(101).fill(1)).all()).rejects.toThrow(/too many SQL variables/i);
    } finally {
      await d1.close();
    }
  }, 120_000);
});

describe.skipIf(!process.env.EVAL_WORKERD)("workerd D1 probe, no DDL after a good probe", () => {
  it("[CP2-X04] a migrated workerd brain gets no schema DDL via exec or prepare after the probe", async () => {
    const { initializeDatabase, resetDatabaseInit } = await import("../../src/db/init");
    const { makeTestEnv } = await import("../helpers/make-env");
    const d1 = await openD1("workerd");
    const warnings: unknown[][] = [];
    const realWarn = console.warn;
    try {
      // Warm-up pass migrates fully (schema.sql may lag init); only the second pass is recorded.
      resetDatabaseInit();
      await initializeDatabase(makeTestEnv(d1.db as any));
      resetDatabaseInit();
      console.warn = (...args: unknown[]) => { warnings.push(args); };
      const log: { method: "exec" | "prepare"; sql: string }[] = [];
      const recording = new Proxy(d1.db as any, {
        get(target, prop) {
          if (prop === "prepare" || prop === "exec") {
            return (sql: string) => { log.push({ method: prop, sql }); return target[prop](sql); };
          }
          const v = target[prop];
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      await initializeDatabase(makeTestEnv(recording as any));
      resetDatabaseInit();
      expect(warnings.filter(w => String(w[0]).includes("Schema probe failed"))).toEqual([]);
      const probeAt = log.findIndex(r => r.method === "prepare" && r.sql.includes("sqlite_master") && r.sql.includes("pragma_table_info"));
      expect(probeAt).toBeGreaterThanOrEqual(0);
      expect(log.slice(probeAt + 1).filter(r => /\b(CREATE|ALTER|DROP)\b/i.test(r.sql))).toEqual([]);
    } finally {
      console.warn = realWarn;
      resetDatabaseInit();
      await d1.close();
    }
  }, 120_000);
});
