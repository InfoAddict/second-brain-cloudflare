import { describe, expect, it } from "vitest";
import { SCHEME_RUN_MAX_ENTRIES, schemePageQuery } from "../../src/migration/embedding";
import { openD1 } from "./d1";

const N = 20_000;
const LONG_EVERY = 29; // 3.5% of entries are long

// Opt-in: boots a local workerd, whose D1 reports the billed rows_read the free plan's daily allowance is counted in.
describe.skipIf(!process.env.EVAL_WORKERD)("scheme migration page query on workerd D1", () => {
  it("reads rows in proportion to the page, wherever the cursor is, not to what remains", async () => {
    const d1 = await openD1("workerd");
    try {
      await d1.db.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${N})
         INSERT INTO entries (id, content, created_at)
         SELECT 'r' || i, CASE WHEN i % ${LONG_EVERY} = 0 THEN substr(replace(hex(zeroblob(1200)), '0', 'ab'), 1, 2400) ELSE 'row ' || i END, i FROM n`,
      ).run();

      const run = async (cursor: number) => {
        const q = schemePageQuery(cursor > 0, true, false);
        const res = await d1.db.prepare(q.sql).bind(...(cursor > 0 ? [cursor] : []), ...q.extra).all();
        return { rows: res.results.length, read: res.meta.rows_read as number, last: (res.results.at(-1) as { rid: number } | undefined)?.rid ?? 0 };
      };
      const first = await run(0);
      const mid = await run(10_000);
      const late = await run(19_000);
      process.stdout.write(`SCHEME_PAGE_ROWS_READ first ${first.read} mid ${mid.read} late ${late.read} (table ${N}, page ${SCHEME_RUN_MAX_ENTRIES}, 1 in ${LONG_EVERY} long)\n`);
      // The page needs 40 matches at 1 in 29, so about 1,160 rows are examined; the whole table is 20,000.
      const budget = SCHEME_RUN_MAX_ENTRIES * LONG_EVERY + 2 * LONG_EVERY;
      for (const p of [first, mid]) {
        expect(p.rows).toBe(SCHEME_RUN_MAX_ENTRIES);
        expect(p.read, `rows_read ${p.read}`).toBeLessThanOrEqual(budget);
      }
      // The last page is short and reads only the tail.
      expect(late.read).toBeLessThanOrEqual((N - 19_000) * 1.1);

      // The statement it replaced sorted by (created_at, id) against an index that cannot serve that order.
      const stmt = await d1.db.prepare(
        `SELECT id, content FROM entries WHERE tags NOT LIKE '%"status:deprecated"%' AND (created_at > ? OR (created_at = ? AND id > ?))
           AND LENGTH(content) > 1500 ORDER BY created_at ASC, id ASC LIMIT ${SCHEME_RUN_MAX_ENTRIES}`,
      ).bind(10_000, 10_000, "r10000").all();
      process.stdout.write(`SCHEME_PAGE_OLD_ROWS_READ ${stmt.meta.rows_read}\n`);
      expect(stmt.meta.rows_read as number, "the old page read").toBeGreaterThan(mid.read * 3);
    } finally {
      await d1.close();
    }
  }, 300_000);
});
