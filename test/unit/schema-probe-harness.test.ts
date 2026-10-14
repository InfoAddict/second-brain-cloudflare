import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { withFtsWriteGuard } from "../../src/db/fts-write-guard";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { D1Mock } from "../helpers/d1-mock";
import { makeTestEnv } from "../helpers/make-env";

// The probe harness: pins how the schema probe is called so the doubles that answer it
// cannot drift from the real call shape and pass through a TypeError by accident.

const BINDS = 12;
const OLD_PROBE_PREFIX = "SELECT type AS kind, name, sql AS definition FROM sqlite_master";
const WARN_MSG = "Schema probe failed; applying the full schema instead:";

const isProbe = (sql: string) => sql.includes("sqlite_master") && sql.includes("pragma_table_info");

interface Call { sql: string; binds?: unknown[]; terminal?: string }

/** Wraps a D1-shaped db, logging every prepared SQL, its binds and the terminal method. */
function recordingDb(inner: any) {
  const calls: Call[] = [];
  const execs: string[] = [];
  const batches: number[] = [];
  const db = {
    prepare(sql: string) {
      const call: Call = { sql };
      calls.push(call);
      const wrap = (st: any): any => ({
        bind: (...args: unknown[]) => { call.binds = args; return wrap(st.bind(...args)); },
        all: (...a: unknown[]) => { call.terminal = "all"; return st.all(...a); },
        first: (...a: unknown[]) => { call.terminal = "first"; return st.first(...a); },
        run: (...a: unknown[]) => { call.terminal = "run"; return st.run(...a); },
        raw: (...a: unknown[]) => { call.terminal = "raw"; return st.raw(...a); },
      });
      return wrap(inner.prepare(sql));
    },
    exec: (sql: string) => { execs.push(sql); return inner.exec(sql); },
    batch: (s: unknown[]) => { batches.push(s.length); return inner.batch(s); },
    __vectorOwners: () => (inner.__vectorOwners ? inner.__vectorOwners() : new Map()),
  };
  return { db: db as unknown as D1Database, calls, execs, batches, probes: () => calls.filter(c => isProbe(c.sql)) };
}

/** A db whose probe is `probe`; everything else goes to `inner`. The stub supports bind(). */
function dbWhoseProbe(inner: any, probe: () => unknown, seen: { binds?: unknown[]; n: number }) {
  return {
    prepare: (sql: string) => {
      if (!isProbe(sql)) return inner.prepare(sql);
      seen.n++;
      return { bind: (...b: unknown[]) => { seen.binds = b; return { all: async () => probe() }; } };
    },
    exec: (sql: string) => inner.exec(sql),
    batch: (s: any) => inner.batch(s),
  } as unknown as D1Database;
}

async function captureProbeSql(): Promise<string> {
  const s = makeSqliteD1({ schema: false });
  const rec = recordingDb(s.db);
  await initializeDatabase(makeTestEnv(undefined, { DB: rec.db }));
  const p = rec.probes();
  expect(p).toHaveLength(1);
  return p[0].sql;
}

/** A fresh brain migrated through the real probe: the reference for a full migration. */
async function referenceBrain() {
  resetDatabaseInit();
  const ref = makeSqliteD1({ schema: false });
  await initializeDatabase(makeTestEnv(undefined, { DB: ref.db as unknown as D1Database }));
  resetDatabaseInit();
  return ref;
}

function objectNames(s: ReturnType<typeof makeSqliteD1>) {
  return s.db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
    .then((r: any) => (r.results as { type: string; name: string }[]).map(o => `${o.type}:${o.name}`));
}

beforeEach(() => { resetDatabaseInit(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("schema probe harness", () => {
  it("[CP1-T01] the probe is one prepared statement, bound with 12 values, ended with .all()", async () => {
    const s = makeSqliteD1({ schema: false });
    const rec = recordingDb(s.db);
    await initializeDatabase(makeTestEnv(undefined, { DB: rec.db }));

    const probes = rec.probes();
    expect(probes).toHaveLength(1);
    expect(probes[0].binds).toHaveLength(BINDS);
    expect(probes[0].terminal).toBe("all");
    expect((probes[0].sql.match(/\?/g) ?? []).length).toBe(BINDS);
  });

  it("[CP1-T02] the shared mock answers the captured probe with a migrated brain's rows", async () => {
    const sql = await captureProbeSql();
    const binds = Array.from({ length: BINDS }, (_, i) => `v${i}`);
    const res: any = await new D1Mock().prepare(sql).bind(...binds).all();

    const rows = res.results as { kind: string; name: unknown }[];
    expect(Array.isArray(rows)).toBe(true);
    const has = (kind: string, name: string) => rows.some(r => r.kind === kind && r.name === name);
    expect(has("table", "entries")).toBe(true);
    expect(has("index", "idx_entries_created_at")).toBe(true);
    expect(has("trigger", "entries_fts_insert")).toBe(true);
    expect(has("column", "workspace_id")).toBe(true);
    expect(has("edge_column", "workspace_id")).toBe(true);
    expect(has("entries_trash_column", "workspace_id") || rows.some(r => r.kind === "entries_trash_column")).toBe(true);
  });

  it("[CP1-T03] a migrated brain's cold start issues the probe and no schema statements", async () => {
    const rec = recordingDb(new D1Mock());
    await initializeDatabase(makeTestEnv(undefined, { DB: rec.db }));

    expect(rec.probes()).toHaveLength(1);
    const others = rec.calls.filter(c => !isProbe(c.sql)).map(c => c.sql);
    expect(others.filter(q => /^\s*(CREATE|ALTER|DROP)\b/i.test(q))).toEqual([]);
    expect(rec.execs).toEqual([]);
    expect(rec.batches).toEqual([]);
    expect(rec.calls[0].sql).toBe(rec.probes()[0].sql);
  });

  it("[CP1-T04] the mock's probe recogniser takes the new probe and rejects other sqlite_master reads", async () => {
    const mod: Record<string, unknown> = await import("../helpers/d1-mock");
    const recognise = mod.isSchemaProbe as ((sql: string) => boolean) | undefined;
    expect(typeof recognise, "d1-mock must export isSchemaProbe(sql): boolean").toBe("function");

    const newSql = await captureProbeSql();
    const oldSql = `${OLD_PROBE_PREFIX} WHERE type IN ('table','index','trigger') UNION ALL SELECT 'column', name, NULL FROM pragma_table_info('entries')`;
    expect(recognise!(newSql)).toBe(true);
    expect(recognise!(oldSql)).toBe(false);
    expect(recognise!("SELECT name, sql FROM sqlite_master WHERE name = ?")).toBe(false);
    expect(recognise!("SELECT id FROM entries")).toBe(false);
  });

  it("[CP1-T05] the write-guard interceptors and the mock let the probe be bound and run", async () => {
    const sql = await captureProbeSql();
    const binds = Array.from({ length: BINDS }, (_, i) => `v${i}`);

    const s = makeSqliteD1();
    const guarded = withFtsWriteGuard(makeTestEnv(undefined, { DB: s.db as unknown as D1Database }));
    const viaGuard: any = await guarded.DB.prepare(sql).bind(...(["column", "entries", "edge_column", "edges", "user_column", "users", "admin_event_column", "admin_events", "entry_version_column", "entry_versions", "entries_trash_column", "entries_trash"])).all();
    expect(Array.isArray(viaGuard.results)).toBe(true);
    expect(viaGuard.results.some((r: any) => r.kind === "table" && r.name === "entries")).toBe(true);

    const viaMock: any = await new D1Mock().prepare(sql).bind(...binds).all();
    expect(Array.isArray(viaMock.results)).toBe(true);
    expect(viaMock.results.length).toBeGreaterThan(0);
  });

  it("[CP1-T06] a stub that throws a TypeError surfaces it, not the injected error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = makeSqliteD1({ schema: false });
    const injected = new Error("D1_ERROR: unsupported statement");
    // No bind(): calling it throws a TypeError, as a stale stub would
    const db = {
      prepare: (sql: string) => (isProbe(sql) ? { all: async () => { throw injected; } } : s.db.prepare(sql)),
      exec: (q: string) => s.db.exec(q),
      batch: (b: any) => s.db.batch(b),
    } as unknown as D1Database;

    await initializeDatabase(makeTestEnv(undefined, { DB: db }));

    const call = warn.mock.calls.find(c => c[0] === WARN_MSG);
    expect(call).toBeDefined();
    expect(call![1]).toBeInstanceOf(TypeError);
    expect(call![1]).not.toBe(injected);
  });

  it("[CP1-T07] a throwing probe warns with its own error and the full schema is applied", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = makeSqliteD1({ schema: false });
    const seen = { n: 0 } as { binds?: unknown[]; n: number };
    const injected = new Error("D1_ERROR: distinctive probe failure 7f3a");

    await initializeDatabase(makeTestEnv(undefined, { DB: dbWhoseProbe(s.db, () => { throw injected; }, seen) }));

    expect(seen.n).toBe(1);
    expect(seen.binds).toHaveLength(BINDS);
    expect(warn).toHaveBeenCalledWith(WARN_MSG, injected);
    const ref = await referenceBrain();
    expect(await objectNames(s)).toEqual(await objectNames(ref));
    expect(s.columns().sort()).toEqual(ref.columns().sort());
  });

  describe("[CP1-T08] an unreadable probe result still migrates", () => {
    const cases: [string, () => unknown][] = [
      ["no results", () => ({ success: true })],
      ["rows missing kind", () => ({ results: [{ name: "entries" }, { name: "idx_entries_source" }] })],
      ["non-string names", () => ({ results: [{ kind: "table", name: 42 }, { kind: "column", name: { toString: () => "id" } }] })],
    ];
    for (const [label, probe] of cases) {
      it(`[CP1-T08] ${label}`, async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const s = makeSqliteD1({ schema: false });
        const seen = { n: 0 } as { binds?: unknown[]; n: number };

        await initializeDatabase(makeTestEnv(undefined, { DB: dbWhoseProbe(s.db, probe, seen) }));

        expect(seen.n).toBe(1);
        expect(seen.binds).toHaveLength(BINDS);
        const ref = await referenceBrain();
        expect(await objectNames(s)).toEqual(await objectNames(ref));
        expect(s.columns().sort()).toEqual(ref.columns().sort());
      });
    }
  });

  it("[CP1-T09] write-guard wrapped around a migrated brain starts up quickly and reaches the probe once", async () => {
    const s = makeSqliteD1();
    const rec = recordingDb(s.db);
    const env = withFtsWriteGuard(makeTestEnv(undefined, { DB: rec.db }));

    const t0 = Date.now();
    await initializeDatabase(env);
    await env.DB.prepare("INSERT INTO entries (id, content, tags, source, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind("e1", "hello", "[]", "test", 1700000000000).run();

    expect(Date.now() - t0).toBeLessThan(5000);
    expect(rec.probes()).toHaveLength(1);
    expect(rec.probes()[0].binds).toHaveLength(BINDS);
  }, 10000);
});

/** Like dbWhoseProbe, but counts how often the probe's all() returned a result. */
function dbWhoseProbeReturns(inner: any, probe: () => unknown, seen: { returned: number }) {
  return {
    prepare: (sql: string) => {
      if (!isProbe(sql)) return inner.prepare(sql);
      return { bind: () => ({ all: async () => { const r = probe(); seen.returned++; return r; } }) };
    },
    exec: (sql: string) => inner.exec(sql),
    batch: (s: any) => inner.batch(s),
  } as unknown as D1Database;
}

describe("[CP1-X01] an unreadable probe result is consumed, not crashed on", () => {
  const malformed: [string, () => unknown][] = [
    ["no results", () => ({ success: true })],
    ["rows missing kind", () => ({ results: [{ name: "entries" }, { name: "idx_entries_source" }] })],
    ["non-string names", () => ({ results: [{ kind: "table", name: 42 }, { kind: "column", name: { toString: () => "id" } }] })],
  ];
  for (const [label, probe] of malformed) {
    it(`[CP1-X01] ${label}: the result is returned and no probe failure is warned`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const s = makeSqliteD1({ schema: false });
      const seen = { returned: 0 };

      await initializeDatabase(makeTestEnv(undefined, { DB: dbWhoseProbeReturns(s.db, probe, seen) }));

      expect(seen.returned).toBe(1);
      expect(warn.mock.calls.filter(c => c[0] === WARN_MSG)).toEqual([]);
      expect(warn.mock.calls.flat().some(a => a instanceof TypeError)).toBe(false);
      const ref = await referenceBrain();
      expect(await objectNames(s)).toEqual(await objectNames(ref));
    });
  }
});

describe("[CP1-X02] the probe doubles answer the real recorded call", () => {
  async function recordedProbe() {
    const s = makeSqliteD1({ schema: false });
    const rec = recordingDb(s.db);
    await initializeDatabase(makeTestEnv(undefined, { DB: rec.db }));
    const p = rec.probes();
    expect(p).toHaveLength(1);
    return p[0] as Required<Pick<Call, "sql" | "binds">>;
  }

  // nonce is the one entries_trash column init.ts checks (the ALTER it would otherwise issue)
  it("[CP1-X02] the mock's migrated brain reports the nonce column on entries_trash", async () => {
    const { sql, binds } = await recordedProbe();
    const res: any = await new D1Mock().prepare(sql).bind(...binds).all();
    const rows = res.results as { kind: string; name: unknown }[];
    expect(rows.some(r => r.kind === "entries_trash_column" && r.name === "nonce")).toBe(true);
  });

  it("[CP1-X02] the guarded brain returns columns for every label and table init.ts binds", async () => {
    const { sql, binds } = await recordedProbe();
    expect(binds).toHaveLength(BINDS);

    const s = makeSqliteD1();
    const guarded = withFtsWriteGuard(makeTestEnv(undefined, { DB: s.db as unknown as D1Database }));
    const res: any = await guarded.DB.prepare(sql).bind(...binds).all();
    const rows = res.results as { kind: string; name: unknown }[];

    for (let i = 0; i < binds.length; i += 2) {
      const [kind, table] = [binds[i] as string, binds[i + 1] as string];
      expect(rows.some(r => r.kind === "table" && r.name === table), table).toBe(true);
      expect(rows.some(r => r.kind === kind && r.name === "id"), kind).toBe(true);
    }
  });
});
