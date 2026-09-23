import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeSqliteD1, splitSchemaStatements, stripSqlComments } from "../helpers/sqlite-d1";

export interface EvalD1 { db: D1Database; kind: "sqlite" | "workerd"; close(): Promise<void> }

const ROOT = process.env.SB_EVAL_ROOT ?? resolve(import.meta.dirname, "../..");

export async function openD1(kind: "sqlite" | "workerd"): Promise<EvalD1> {
  if (kind === "sqlite") {
    const sqlite = makeSqliteD1();
    return { db: sqlite.db as unknown as D1Database, kind, close: async () => sqlite.close() };
  }
  // workerd: wrangler's local D1 (real rows_read in meta). Local only: no remote binding, throwaway state dir.
  const dir = mkdtempSync(join(tmpdir(), "sb-eval-d1-"));
  const configPath = join(dir, "wrangler.jsonc");
  writeFileSync(configPath, JSON.stringify({
    name: "sb-eval",
    compatibility_date: "2026-06-17",
    d1_databases: [{ binding: "DB", database_name: "sb-eval", database_id: "eval-local-only" }],
  }));
  const { getPlatformProxy } = await import("wrangler");
  let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | undefined;
  try {
    proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath, persist: { path: join(dir, "state") } });
    const schema = readFileSync(join(ROOT, "db/schema.sql"), "utf8");
    for (const statement of splitSchemaStatements(stripSqlComments(schema))) {
      const sql = statement.trim();
      if (sql) await proxy.env.DB.prepare(sql).run();
    }
  } catch (e) {
    await proxy?.dispose();
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const opened = proxy;
  return {
    db: opened.env.DB,
    kind,
    close: async () => { await opened.dispose(); rmSync(dir, { recursive: true, force: true }); },
  };
}
