/**
 * Round 4 re-review MAJOR: "Undo all" is dead for a family whose own writer never stamps
 * meta.event_id -- classifyFromRows (src/memory/undo.ts) matches a version to a group by exact
 * membership in the group's own set of event ids, so a family with no stamping writer can never
 * be anything but changed_since, whatever getChanges groups it into. canonical_edit and
 * capsule_changed were exactly this gap (server.ts's update/append tools, capture/store.ts's
 * updateEntryContent/appendToEntry) until this round.
 *
 * A structural guard, not a behavioral one (see test/integration/undo-group.test.ts's own "3 real
 * MCP update calls" test for the end-to-end proof): every family src/brief/changes.ts's
 * GROUP_FAMILIES can classify into a group, and that actually reaches classifyFromRows (not
 * "held" or "trash", each resolved a different way, live-state-only, that never carries a stale
 * classification to revert), has a writer file that stamps event_id somewhere in it.
 *
 * Round 5 re-review NIT: the family list is derived from GROUP_FAMILIES itself now, not a second,
 * hand-maintained copy of it -- a family added there and never given here in FAMILY_WRITERS fails
 * this file's own first test instead of silently going unchecked.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GROUP_FAMILIES, type ChangeFamily } from "../../src/brief/changes";

const ROOT = join(import.meta.dirname, "../..");

/** undoGroup's own dispatch (src/memory/undo.ts): these two families are resolved a different
 * way entirely -- resolveHeldGroup and resolveTrashGroup, both live-state-only (a fresh read of
 * "is this still held" / "is this still in the trash" right before acting), never a stale
 * classification to revert. Every other family in GROUP_FAMILIES reaches classifyFromRows and so
 * needs a writer that stamps meta.event_id. */
const LIVE_STATE_ONLY_FAMILIES: ReadonlySet<ChangeFamily> = new Set(["held", "trash"]);

/** Every ChangeFamily that resolveVersionGroup (src/memory/undo.ts) can be asked to revert,
 * mapped to the file(s) whose writer must stamp meta.event_id for that family's own group to
 * ever be revertible. */
const FAMILY_WRITERS: Record<string, readonly string[]> = {
  status: ["src/capture/lifecycle.ts"],
  released: ["src/memory/undo.ts"],
  revert: ["src/memory/undo.ts"],
  canonical_edit: ["src/capture/store.ts"],
  capsule_changed: ["src/capture/store.ts"],
};

const EVENT_ID_STAMP = /event_id:\s*eventId|metaFor\(eventId\)/;

describe("every group-able family has a writer that stamps meta.event_id", () => {
  const revertible = GROUP_FAMILIES.filter((f) => !LIVE_STATE_ONLY_FAMILIES.has(f));

  it("FAMILY_WRITERS covers exactly the families GROUP_FAMILIES can classify into a group, minus the live-state-only ones (a stale list here is its own bug)", () => {
    expect(Object.keys(FAMILY_WRITERS).sort()).toEqual([...revertible].sort());
  });

  for (const family of revertible) {
    it(`"${family}" has a writer that stamps meta.event_id`, () => {
      const files = FAMILY_WRITERS[family];
      expect(files, `GROUP_FAMILIES names "${family}" but FAMILY_WRITERS does not`).toBeDefined();
      const hit = files.some((file) => EVENT_ID_STAMP.test(readFileSync(join(ROOT, file), "utf8")));
      expect(hit, `none of ${(files ?? []).join(", ")} stamps event_id`).toBe(true);
    });
  }
});
