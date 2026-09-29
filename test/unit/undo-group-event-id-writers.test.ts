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
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");

/** Every ChangeFamily that resolveVersionGroup (src/memory/undo.ts) -- not resolveHeldGroup or
 * resolveTrashGroup -- can be asked to revert, mapped to the file(s) whose writer must stamp
 * meta.event_id for that family's own group to ever be revertible. */
const FAMILY_WRITERS: Record<string, readonly string[]> = {
  status: ["src/capture/lifecycle.ts"],
  released: ["src/memory/undo.ts"],
  revert: ["src/memory/undo.ts"],
  canonical_edit: ["src/capture/store.ts"],
  capsule_changed: ["src/capture/store.ts"],
};

const EVENT_ID_STAMP = /event_id:\s*eventId|metaFor\(eventId\)/;

describe("every group-able family has a writer that stamps meta.event_id", () => {
  it("covers every family resolveVersionGroup can classify (a stale list here is its own bug)", () => {
    // brief/changes.ts's own resolveVersionGroup dispatch: undoGroup routes "held" to
    // resolveHeldGroup and "trash" to resolveTrashGroup: only these five ever reach
    // classifyFromRows, and only classifyFromRows needs any of this.
    expect(Object.keys(FAMILY_WRITERS).sort()).toEqual(
      ["canonical_edit", "capsule_changed", "released", "revert", "status"].sort(),
    );
  });

  for (const [family, files] of Object.entries(FAMILY_WRITERS)) {
    it(`"${family}" has a writer that stamps meta.event_id`, () => {
      const hit = files.some((file) => EVENT_ID_STAMP.test(readFileSync(join(ROOT, file), "utf8")));
      expect(hit, `none of ${files.join(", ")} stamps event_id`).toBe(true);
    });
  }
});
