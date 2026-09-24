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
