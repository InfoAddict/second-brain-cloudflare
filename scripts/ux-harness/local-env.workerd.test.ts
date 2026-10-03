/**
 * T-0101.6.2: the harness's local Vectorize double silently ignored `$in` metadata filters, which
 * is the ONLY filter shape the Worker ever builds (src/vectorize/scope.ts's workspaceFilter /
 * singleWorkspaceFilter -- confirmed by grep, nothing else in src/ constructs a Vectorize filter).
 * Every scoped duplicate/contradiction candidate query (src/capture/duplicate.ts) went through
 * that filter and silently came back empty, so no supersede could ever be seeded through the
 * harness: contradiction detection needs a same-workspace neighbour to even consider.
 *
 * This proves the fix end to end, through the real capture pipeline (src/capture/entry.ts), not by
 * calling matchesFilter directly: capture a fact, then capture a contradicting one, and check the
 * older fact's window actually closes -- exactly the codepath a walkthrough or chat scenario
 * exercises when it seeds one.
 */
import { describe, it, expect, afterAll } from "vitest";
import { openLocalBrain, resetLocalBrain } from "./local-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { captureEntry } from "../../src/capture/entry";
import type { WriteContext } from "../../src/lib/scope";
import { cleanTemp } from "../../test/helpers/tmp";

const BRAIN = "local-env-vectorize-filter-test";

function makeCtx(): { ctx: ExecutionContext; drain(): Promise<void> } {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => {})); } } as unknown as ExecutionContext;
  return { ctx, drain: async () => { while (pending.length) await Promise.allSettled(pending.splice(0, pending.length)); } };
}

// wrangler and Miniflare leave a miniflare-* dir behind even after dispose() (same as
// test/eval/d1.workerd.test.ts, which openLocalBrain's own docstring says it shares its mechanism with).
afterAll(cleanTemp);

// Opt-in, like every other workerd-backed test (boots a local workerd, never a remote binding): the
// harness's own commit deliberately keeps scripts/ux-harness/ out of the plain default suite.
describe.skipIf(!process.env.EVAL_WORKERD)("local Vectorize double: $in metadata filter (T-0101.6.2)", () => {
  afterAll(() => resetLocalBrain(BRAIN));

  it("seeds a real supersede through captureEntry, the same codepath a walkthrough drives", async () => {
    resetLocalBrain(BRAIN);
    resetDatabaseInit();
    const { env, close } = await openLocalBrain(BRAIN);
    const { ctx, drain } = makeCtx();
    try {
      await initializeDatabase(env);
      const roots = await ensureTenantBootstrap(env);
      const writeCtx: WriteContext = { workspaceId: roots.ownerPersonalWorkspaceId, actorId: roots.ownerUserId };

      const first = await captureEntry("I live in Austin.", [], "api", env, ctx, undefined, writeCtx);
      expect(first.status).toBe("stored");
      const firstId = first.status === "stored" ? first.id : "";

      // Same-workspace, topically identical, diverging fact: the exact shape src/capture/duplicate.ts's
      // own workspace-scoped Vectorize query (singleWorkspaceFilter -> { workspace_id: { $in: [id] } })
      // must find as a candidate for contradiction detection to run at all.
      const second = await captureEntry("I live in Denver now.", [], "api", env, ctx, undefined, writeCtx);
      expect(second.status).toBe("contradiction");
      if (second.status !== "contradiction") return;
      expect(second.supersede?.closedId).toBe(firstId);
      expect(second.supersede?.direction).toBe("older");

      const closed = await env.DB.prepare(`SELECT valid_until FROM entries WHERE id = ?`).bind(firstId).first<{ valid_until: number | null }>();
      expect(closed?.valid_until).not.toBeNull();

      const edge = await env.DB.prepare(`SELECT type FROM edges WHERE source_id = ? AND target_id = ?`).bind(second.id, firstId).first<{ type: string }>();
      expect(edge?.type).toBe("supersedes");
    } finally {
      await drain();
      await close();
    }
  });

  it("still returns no candidates across two different workspaces (the filter narrows, not just 'anything')", async () => {
    resetLocalBrain(BRAIN);
    resetDatabaseInit();
    const { env, close } = await openLocalBrain(BRAIN);
    const { ctx, drain } = makeCtx();
    try {
      await initializeDatabase(env);
      const roots = await ensureTenantBootstrap(env);
      const writeCtx: WriteContext = { workspaceId: roots.ownerPersonalWorkspaceId, actorId: roots.ownerUserId };

      await captureEntry("I live in Austin.", [], "api", env, ctx, undefined, writeCtx);
      // A workspace this brain's owner cannot write to directly is out of scope for this guard test;
      // an id that is simply never a member of the $in list is the narrowing property under test.
      const other = await captureEntry("I live in Denver now.", [], "api", env, ctx, undefined, { workspaceId: "some-other-workspace", actorId: roots.ownerUserId });
      expect(other.status).toBe("stored");
    } finally {
      await drain();
      await close();
    }
  });
});
