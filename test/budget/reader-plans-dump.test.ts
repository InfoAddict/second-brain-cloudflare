/**
 * Budget auditor (brief 19): dumps the query plan of every statement the current-reader routes prepare, so two
 * trees can be diffed for plan regressions (a new SCAN where there was an index). Routes: GET /list, GET /entry,
 * GET /brief, GET /due, GET /loops, GET /decisions, GET /recall, plus buildStandingCache when present. 3,000
 * memories, some superseded (valid_until set) when the column exists. Opt-in: PLANS_OUT=<file>.
 */
import { afterEach, describe, it } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUT = process.env.PLANS_OUT;
let close: (() => void) | undefined;
afterEach(() => close?.());

describe.runIf(OUT)("reader route plans", () => {
  it("dumps plans", async () => {
    const { makeTrashEnv } = await import("../helpers/trash-env");
    const worker = (await import("../../src/index")).default;
    const t = await makeTrashEnv();
    close = () => t.close();
    for (let i = 0; i < 3000; i++) {
      const tags = i % 20 === 0 ? '["task","work"]' : i % 200 === 1 ? '["ledger:decision"]' : i % 150 === 2 ? '["standing:active"]' : '["work"]';
      t.seed(`f${i}`, { content: `memory ${i} about the atlas ledger`, created_at: 100 + i, tags, vector_ids: `["f${i}"]` });
    }
    const cols = await t.env.DB.prepare(`SELECT name FROM pragma_table_info('entries')`).all();
    if ((cols.results as { name: string }[]).some(c => c.name === "valid_until")) {
      await t.env.DB.prepare(`UPDATE entries SET valid_until = created_at + 10 WHERE CAST(substr(id, 2) AS INTEGER) % 10 = 3`).run();
    }
    const captured: { route: string; sql: string; args: unknown[] }[] = [];
    let route = "";
    const db = t.env.DB as any;
    const prepare = db.prepare.bind(db);
    const wrap = (s: any, sql: string): any => new Proxy(s, { get(target, p) {
      if (p === "bind") return (...a: unknown[]) => { captured.push({ route, sql, args: a }); return wrap(target.bind(...a), sql); };
      if (p === "__inner") return target;
      const v = target[p]; return typeof v === "function" ? v.bind(target) : v;
    } });
    const env = { ...t.env, DB: { prepare: (sql: string) => wrap(prepare(sql), sql), batch: (s: any[]) => db.batch(s.map((x: any) => x.__inner ?? x)), exec: (q: string) => db.exec(q) } } as any;
    const ctx = { waitUntil: () => {} } as any;
    const paths = ["/list?n=50", "/entry?id=f40", "/brief", "/due", "/loops", "/decisions?state=all&limit=20", "/recall?query=atlas+ledger&topK=5&synthesize=0"];
    for (const p of paths) {
      route = p;
      await worker.fetch(new Request(`http://localhost${p}`, { headers: { Authorization: "Bearer test-token" } }), env, ctx);
    }
    if (existsSync(resolve(__dirname, "../../src/standing/cache.ts"))) {
      route = "buildStandingCache";
      const { buildStandingCache } = await import("../../src/standing/cache");
      const { DEFAULTS } = await import("../../src/config");
      try { await buildStandingCache(env, { ...DEFAULTS, STANDING_MAX: 50, EMBEDDING_DIM: 384 } as any, t.roots.ownerPersonalWorkspaceId); } catch { /* plan capture only */ }
    }
    const out: { route: string; sql: string; plan: string[] }[] = [];
    for (const { route: r, sql, args } of captured) {
      if (!/\bentries\b|\bedges\b|entry_versions/.test(sql) || /^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) continue;
      try {
        const plan = await prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args.map(a => (a === undefined ? null : a))).all();
        out.push({ route: r, sql: sql.replace(/\s+/g, " ").slice(0, 100), plan: (plan.results as { detail: string }[]).map(x => x.detail) });
      } catch (e) { out.push({ route: r, sql: sql.replace(/\s+/g, " ").slice(0, 100), plan: [`UNEXPLAINED ${String(e).slice(0, 60)}`] }); }
    }
    writeFileSync(OUT!, JSON.stringify(out, null, 1));
  }, 120_000);
});
