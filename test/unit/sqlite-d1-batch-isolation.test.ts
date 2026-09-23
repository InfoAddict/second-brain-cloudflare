/**
 * S2 (adversarial review of e32a2b0): the SqliteD1 test facade only
 * serialized batch() calls against each other. A standalone statement
 * issued while a batch's SAVEPOINT was still open ran INSIDE that savepoint
 * on the shared connection, and was rolled back with it if the batch later
 * failed — even though the statement had nothing to do with the batch.
 */
import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "../helpers/sqlite-d1";

describe("SqliteD1 batch isolation", () => {
  it("does not roll back an unrelated standalone write issued while a batch is suspended", async () => {
    const s = makeSqliteD1();
    try {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });

      const insertA = s.db.prepare("INSERT INTO entries (id,content,tags,source,created_at) VALUES ('a','a','[]','api',1)");
      const batch = s.db.batch([
        { run: async () => { await insertA.run(); entered(); await gate; return { success: true, meta: { rows_written: 1 } }; } },
        { run: async () => { throw new Error("batch failure"); } },
      ] as never);

      await started;
      // Started while the batch's SAVEPOINT is still open, but not awaited
      // yet: a correct fix makes this queue behind the batch rather than
      // run inside its open SAVEPOINT, so awaiting it here — before the
      // batch can possibly finish — would deadlock the test itself.
      const outside = s.db.prepare("INSERT INTO entries (id,content,tags,source,created_at) VALUES ('outside','outside','[]','api',1)").run();
      release();

      await expect(batch).rejects.toThrow("batch failure");
      await outside;
      const ids = s.rows().map(x => x.id).sort();
      expect(ids).toEqual(["outside"]);
    } finally { s.close(); }
  });

  it("still rolls back the batch's own statements on failure", async () => {
    const s = makeSqliteD1();
    try {
      const batch = s.db.batch([
        s.db.prepare("INSERT INTO entries (id,content,tags,source,created_at) VALUES ('inside','inside','[]','api',1)"),
        { run: async () => { throw new Error("batch failure"); } },
      ] as never);
      await expect(batch).rejects.toThrow("batch failure");
      expect(s.rows()).toEqual([]);
    } finally { s.close(); }
  });

  it("lets a standalone statement run before an unrelated batch starts", async () => {
    const s = makeSqliteD1();
    try {
      await s.db.prepare("INSERT INTO entries (id,content,tags,source,created_at) VALUES ('first','first','[]','api',1)").run();
      await s.db.batch([
        s.db.prepare("INSERT INTO entries (id,content,tags,source,created_at) VALUES ('second','second','[]','api',1)"),
      ]);
      expect(s.rows().map(x => x.id).sort()).toEqual(["first", "second"]);
    } finally { s.close(); }
  });
});
