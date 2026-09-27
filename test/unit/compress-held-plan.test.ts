/**
 * The digest's two existence checks must stay off a workspace scan: the cooldown by its
 * created_at indexes, the held-draft check by the partial index on the conflict-held marker.
 */
import { afterEach, describe, expect, it } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { heldDigestSql } from "../../src/compression/digest";
import { TAG_LIKE_ESCAPE } from "../../src/memory/tag-sql";

let d1: SqliteD1 | undefined;
afterEach(() => d1?.close());

async function plan(sql: string, binds: unknown[]): Promise<string> {
  d1 = makeSqliteD1();
  const rows = (await d1.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all()).results as { detail: string }[];
  return rows.map(r => r.detail).join("\n");
}

describe("compressTag's existence checks are index-backed", () => {
  it("the held-draft check is served by idx_entries_conflict_held", async () => {
    const p = await plan(heldDigestSql(true), ["ws", '%"work"%']);
    expect(p).toContain("idx_entries_conflict_held");
    expect(p).not.toMatch(/SCAN entries(?! USING)/);
  });

  it("the scoped 24h cooldown check uses an index on entries", async () => {
    const p = await plan(`SELECT id FROM entries WHERE tags LIKE '%"synthesized"%' AND tags LIKE ? ${TAG_LIKE_ESCAPE} AND created_at > ? AND workspace_id = ? LIMIT 1`,
      ['%"work"%', 0, "ws"]);
    expect(p).toMatch(/SEARCH entries USING (COVERING )?INDEX idx_entries_/);
  });

  it("the nightly (unscoped) 24h cooldown check uses an index on entries", async () => {
    const p = await plan(`SELECT id FROM entries WHERE tags LIKE '%"synthesized"%' AND tags LIKE ? ${TAG_LIKE_ESCAPE} AND created_at > ? LIMIT 1`,
      ['%"work"%', 0]);
    expect(p).toMatch(/SEARCH entries USING (COVERING )?INDEX idx_entries_/);
  });
});
