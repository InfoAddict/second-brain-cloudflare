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

  // Reviewer probe (fix3b review, T-0052): a batch's own statement.run() can
  // spawn async work it does not await (a fire-and-forget .then chain). That
  // work still runs inside the batch's AsyncLocalStorage context, so once it
  // resumes it sees activeBatchConnection.getStore() === db and runs INLINE
  // instead of going through the FIFO queue — even though the batch that set
  // that context already closed. If a later, unrelated batch is open by the
  // time it resumes, it runs inside that batch's SAVEPOINT and gets rolled
  // back when that batch fails, even though it has nothing to do with it.
  it("queues async work spawned inside a batch that resumes after the batch closes", async () => {
    const s = makeSqliteD1();
    try {
      let fire!: () => void;
      let outsideDone!: () => void;
      let enteredSecond!: () => void;
      let releaseSecond!: () => void;
      const fireGate = new Promise<void>(resolve => { fire = resolve; });
      const outsideFinished = new Promise<void>(resolve => { outsideDone = resolve; });
      const secondStarted = new Promise<void>(resolve => { enteredSecond = resolve; });
      const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });

      // First batch: spawns unawaited work gated on fireGate, then closes
      // immediately (it does not wait for that work at all).
      await s.db.batch([{ run: async () => {
        void fireGate.then(async () => {
          await s.db.prepare("INSERT INTO entries (id,content,tags,source,created_at) VALUES ('outside','outside','[]','api',1)").run();
          outsideDone();
        });
        return { success: true, meta: { rows_written: 0 } };
      } }] as never);

      // Second, unrelated batch opens and suspends with its SAVEPOINT open.
      const second = s.db.batch([
        { run: async () => { await s.db.prepare("INSERT INTO entries (id,content,tags,source,created_at) VALUES ('inside','inside','[]','api',1)").run(); enteredSecond(); await secondGate; return { success: true, meta: { rows_written: 1 } }; } },
        { run: async () => { throw new Error("second fails"); } },
      ] as never);
      await secondStarted;

      // Release the first batch's spawned work now, while the second batch's
      // SAVEPOINT is still open. A correct fix queues it behind the second
      // batch instead of letting it run inside the second batch's SAVEPOINT.
      fire();
      const early = await Promise.race([
        outsideFinished.then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100)),
      ]);
      releaseSecond();

      await expect(second).rejects.toThrow("second fails");
      await outsideFinished;
      const persisted = s.rows().map(x => x.id);

      // If the spawned work ran inside the second batch's SAVEPOINT, it did
      // not finish before that batch was released (early === false) and its
      // row was rolled back with the batch's failure (persisted === []).
      expect(early).toBe(false);
      expect(persisted).toEqual(["outside"]);
    } finally { s.close(); }
  });
});
