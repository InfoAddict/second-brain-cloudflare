import { describe, expect, it } from "vitest";
import { openD1 } from "./d1";

// Opt-in: boots a local workerd (never a remote binding).
describe.skipIf(!process.env.EVAL_WORKERD)("workerd D1 backend", () => {
  it("reports real rows_read and has FTS5 trigram and the shipped schema", async () => {
    const d1 = await openD1("workerd");
    try {
      await d1.db.prepare(`INSERT INTO entries (id, content, created_at) VALUES ('x', 'hello trigram world', 1)`).run();
      const hit = await d1.db.prepare(`SELECT id FROM entries_fts WHERE entries_fts MATCH '"trigram"'`).all();
      expect(hit.results).toHaveLength(1);
      const scan = await d1.db.prepare(`SELECT id FROM entries WHERE content LIKE '%zzz%'`).all();
      expect(scan.meta.rows_read).toBeGreaterThanOrEqual(1);
    } finally {
      await d1.close();
    }
  }, 120_000);
});
