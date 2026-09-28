/**
 * Codex review class B (T-0089.4.2): `isHeld` (JS, trims each tag before checking) and
 * NOT_HELD_SQL / INDEXABLE_SQL (a literal LIKE match against the stored JSON) must agree on
 * every row this Worker ever writes. They can only agree if a tag never reaches storage with a
 * leading or trailing space — normalizeTagList is the one normalization every external tag
 * source (import, trash restore, mirror sync) passes through before that happens.
 *
 * This runs the SAME tag-array inputs through both checks, against real SQLite, so the SQL
 * side is a real LIKE match, not a string a mock merely recognises.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Env } from "../../src/env";
import { isHeld, NOT_HELD_SQL, withHold } from "../../src/quarantine/tags";
import { INDEXABLE_SQL } from "../../src/capture/lifecycle";
import { normalizeTagList } from "../../src/tags/system";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

let sq: SqliteD1 | null = null;
afterEach(() => { sq?.close(); sq = null; resetDatabaseInit(); });

function dbOf(s: SqliteD1) {
  return { prepare: (sql: string) => s.db.prepare(sql), exec: (sql: string) => s.db.exec(sql), batch: (stmts: any[]) => s.db.batch(stmts) };
}
async function migrated(): Promise<SqliteD1> {
  const s = makeSqliteD1();
  resetDatabaseInit();
  await initializeDatabase({ DB: dbOf(s) } as unknown as Env);
  return s;
}

/** True if the SQL filters (NOT_HELD_SQL and INDEXABLE_SQL's own quarantine clause) would treat
 * this stored row as NOT held — i.e. as recall- and index-eligible. */
async function sqlSaysNotHeld(s: SqliteD1, id: string): Promise<{ notHeld: boolean; indexable: boolean }> {
  const notHeldRow = await s.db.prepare(`SELECT 1 AS ok FROM entries WHERE id = ? AND ${NOT_HELD_SQL}`).bind(id).first();
  const indexableRow = await s.db.prepare(`SELECT 1 AS ok FROM entries WHERE id = ? AND ${INDEXABLE_SQL}`).bind(id).first();
  return { notHeld: !!notHeldRow, indexable: !!indexableRow };
}

const CASES: { name: string; tags: string[] }[] = [
  { name: "ordinary held tag", tags: withHold(["work"], "instruction") },
  { name: "ordinary unheld tags", tags: ["work", "status:canonical"] },
  { name: "empty tags", tags: [] },
  { name: "held with an unrelated leading-space tag elsewhere", tags: [" work", ...withHold([], "hidden")] },
  { name: "too_long hold", tags: withHold(["work"], "too_long") },
];

describe("isHeld and the SQL held filters agree, for every tag array normalizeTagList produces", () => {
  for (const { name, tags } of CASES) {
    it(name, async () => {
      sq = await migrated();
      // Every write path normalizes before storing (class B): this is what actually reaches D1.
      const stored = normalizeTagList(tags);
      sq.seed({ id: "e1", content: "x", createdAt: 1000, tags: stored });

      const jsHeld = isHeld(stored);
      const { notHeld, indexable } = await sqlSaysNotHeld(sq, "e1");

      expect(notHeld).toBe(!jsHeld);
      expect(indexable).toBe(!jsHeld);
    });
  }
});

describe("an unnormalized tag is exactly the gap normalization closes", () => {
  it("a leading space on the quarantine tag desyncs isHeld from the raw SQL match (documents the bug the fix prevents)", async () => {
    sq = await migrated();
    // Deliberately NOT normalized: what a write boundary that skipped normalizeTagList would have stored.
    const raw = [" quarantine:instruction", "status:draft"];
    sq.seed({ id: "e2", content: "x", createdAt: 1000, tags: raw });

    expect(isHeld(raw)).toBe(true);
    const { notHeld, indexable } = await sqlSaysNotHeld(sq, "e2");
    // The raw LIKE pattern requires a `"` immediately followed by `quarantine:`; a leading space
    // inside the JSON string breaks that match, so the SQL side wrongly reads this as NOT held.
    expect(notHeld).toBe(true);
    expect(indexable).toBe(true);

    // normalizeTagList closes the gap: the same content, normalized, agrees on both sides.
    const normalized = normalizeTagList(raw);
    sq.seed({ id: "e3", content: "x", createdAt: 1000, tags: normalized });
    const afterFix = await sqlSaysNotHeld(sq, "e3");
    expect(isHeld(normalized)).toBe(true);
    expect(afterFix.notHeld).toBe(false);
    expect(afterFix.indexable).toBe(false);
  });
});
