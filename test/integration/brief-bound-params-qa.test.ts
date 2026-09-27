/**
 * QA: the project filter adds up to 40 LIKE bindings to every brief statement. D1 rejects
 * more than 100 bound parameters, and the SQLite test double does not, so count them here.
 */
import { describe, it, expect, afterEach } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { computeBrief, computeAgentBrief } from "../../src/brief/compute";
import { D1_MAX_BOUND_PARAMS } from "../../src/constants";
import type { Identity } from "../../src/lib/identity";
import type { ProjectRow } from "../../src/projects/registry";
import type { Env } from "../../src/env";

let sq: SqliteD1 | null = null;
afterEach(() => { sq?.close(); sq = null; });

async function measure(run: (env: Env) => Promise<unknown>) {
  sq = makeSqliteD1();
  resetDatabaseInit();
  const counts: number[] = [];
  const db = {
    prepare: (sql: string) => {
      const st = sq!.db.prepare(sql);
      return { ...st, bind: (...args: unknown[]) => { counts.push(args.length); return st.bind(...args); }, first: st.first?.bind(st), all: st.all?.bind(st), run: st.run?.bind(st) };
    },
    exec: (sql: string) => sq!.db.exec(sql),
    batch: (s: any[]) => sq!.db.batch(s),
  };
  await initializeDatabase({ DB: sq.db } as unknown as Env);
  const env = makeTestEnv(db as any);
  counts.length = 0;
  await run(env);
  return Math.max(0, ...counts);
}

const project: ProjectRow = {
  id: "site", workspace_id: "w0", name: "Site", description: "", status: "active",
  aliases: Array.from({ length: 39 }, (_, i) => `alias-${i}`), created_at: 1, updated_at: null,
};
const admin = (teams: number): Identity => ({
  userId: "u1", role: "admin", personalWorkspaceId: "w0",
  companyWorkspaceIds: Array.from({ length: teams }, (_, i) => `team-${i}`), defaultShare: "",
} as Identity);

describe("brief with a 40-pattern project filter stays under D1's bound-parameter ceiling", () => {
  for (const teams of [1, 8, 30]) {
    // Known defect (QA T-0089.6.8): the resurface pick binds scope + project patterns twice and
    // overflows at 8+ workspaces with a 39-alias project. it.fails flips red once that is fixed.
    const known = teams === 1 ? it : it.fails;
    known(`computeBrief, admin in ${teams} teams`, async () => {
      expect(await measure(env => computeBrief(env, admin(teams), true, [project]))).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    });
    it(`computeAgentBrief, admin in ${teams} teams`, async () => {
      expect(await measure(env => computeAgentBrief(env, admin(teams), [project]))).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    });
  }
});
