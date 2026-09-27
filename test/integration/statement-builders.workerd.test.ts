/**
 * Every generated versions statement, run once on a real workerd D1 (local wrangler, no Cloudflare
 * account). node:sqlite accepts numbered placeholders with gaps and D1 does not, so the dense-numbering
 * unit test is only half the guard; this is the other half. Opt in with EVAL_WORKERD=1.
 * Later tasks add their builders (trash insert tiers, restore, purge, deleteForever, member-removal
 * chunk, import orphan delete) to `builders` below.
 */
import { describe, it, expect, afterAll } from "vitest";
import { openD1 } from "../eval/d1";
import { cleanTemp } from "../helpers/tmp";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import {
  Params, snapshotStatement, snapshotManyStatement, pruneStatement, pruneManyStatement, mirrorPruneStatement, ownSnapshotLandedSql,
} from "../../src/memory/versions";
import type { Env } from "../../src/env";

afterAll(cleanTemp);

describe.runIf(process.env.EVAL_WORKERD === "1")("statement builders on workerd D1", () => {
  it("every versions builder runs against real D1", async () => {
    const d1 = await openD1("workerd");
    try {
      resetDatabaseInit();
      const env = makeTestEnv(undefined, { DB: d1.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
      await initializeDatabase(env);
      for (const id of ["e1", "e2"]) {
        await d1.db.prepare(`INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, 'hello', '["a"]', 'api', 1, 1, '[]', 'w', 'u')`).bind(id).run();
      }
      const change = { actorId: "u", channel: "rest" as const };
      const builders: Record<string, () => D1PreparedStatement> = {
        "snapshot unchanged": () => snapshotStatement(env, { entryId: "e1", reason: "status", change, content: { kind: "unchanged" }, nextTags: ["a", "b"], now: 5 }),
        "snapshot next with guard and when": () => snapshotStatement(env, {
          entryId: "e1", reason: "due", change, content: { kind: "next", content: "hello world" }, nextTags: ["a"], nextWhen: { when_at: 9, when_kind: null },
          guard: p => `e.tags = ${p.add('["a"]')}`, meta: { x: 1 }, now: 6,
        }),
        "snapshot suffix": () => snapshotStatement(env, { entryId: "e1", reason: "append", change, content: { kind: "suffix" }, nextTags: ["a"], now: 7 }),
        "snapshot revert with seq and nonce": () => snapshotStatement(env, {
          entryId: "e1", reason: "revert", change, content: { kind: "next", content: "x" }, nextTags: [], skipNoOp: false, expectNewestSeq: 3, meta: { nonce: "n" }, now: 8,
        }),
        "snapshot many": () => snapshotManyStatement(env, { entryIds: ["e1", "e2"], reason: "rollup", change, content: { kind: "suffix" }, now: 9 }),
        "prune": () => pruneStatement(env, "e1", 20),
        "prune many": () => pruneManyStatement(env, ["e1", "e2"], 20),
        "mirror prune": () => mirrorPruneStatement(env, "e1", 3),
        "own snapshot landed": () => {
          const p = new Params();
          return d1.db.prepare(`SELECT ${ownSnapshotLandedSql(p, "e1", 3, "n")} AS landed`).bind(...p.values());
        },
      };
      for (const [name, build] of Object.entries(builders)) {
        await expect(build().run(), name).resolves.toBeDefined();
      }
    } finally {
      await d1.close();
    }
  }, 120_000);
});
