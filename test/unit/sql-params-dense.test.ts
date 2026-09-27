import { describe, it, expect } from "vitest";
import {
  Params, buildSnapshot, buildSnapshotMany, buildPrune, buildPruneMany, buildMirrorPrune, ownSnapshotLandedSql,
  type SnapshotInput,
} from "../../src/memory/versions";
import { denseProblem } from "../helpers/sql-dense";

const change = { actorId: "u1", channel: "rest" as const };
const base: SnapshotInput = { entryId: "e1", reason: "update", change, content: { kind: "unchanged" }, nextTags: ["a", "b"], now: 5 };

describe("every generated statement numbers its placeholders densely", () => {
  const contents: SnapshotInput["content"][] = [{ kind: "unchanged" }, { kind: "suffix" }, { kind: "next", content: "new text" }];
  for (const content of contents) {
    for (const withGuard of [false, true]) {
      for (const withWhen of [false, true]) {
        for (const withSeq of [false, true]) {
          it(`snapshot ${content.kind} guard=${withGuard} when=${withWhen} seq=${withSeq}`, () => {
            const b = buildSnapshot({
              ...base, content,
              guard: withGuard ? p => `e.tags = ${p.add("[\"a\"]")} AND e.content = ${p.add("x")}` : undefined,
              nextWhen: withWhen ? { when_at: 9, when_kind: null, when_source: "cleared", when_label: null } : undefined,
              expectNewestSeq: withSeq ? 4 : undefined,
              skipNoOp: withSeq ? false : undefined,
              meta: { nonce: "n" },
            });
            expect(denseProblem(b.sql, b.bindings)).toBeNull();
          });
        }
      }
    }
  }

  it("the many-row forms bind one parameter for the ids", () => {
    const ids = Array.from({ length: 101 }, (_, i) => `e${i}`);
    for (const b of [buildSnapshotMany({ entryIds: ids, reason: "status", change, content: { kind: "unchanged" }, now: 1 }),
      buildSnapshotMany({ entryIds: ids, reason: "rollup", change, content: { kind: "suffix" }, now: 1 }),
      buildPruneMany(ids, 20)]) {
      expect(denseProblem(b.sql, b.bindings)).toBeNull();
      expect(b.bindings.filter(v => typeof v === "string" && v.startsWith("[\"e0\""))).toHaveLength(1);
    }
  });

  it("prune and mirror prune", () => {
    for (const b of [buildPrune("e1", 20), buildMirrorPrune("e1", 3)]) expect(denseProblem(b.sql, b.bindings)).toBeNull();
  });

  it("ownSnapshotLandedSql", () => {
    const p = new Params();
    const sql = `UPDATE entries SET content = ${p.add("c")} WHERE id = ${p.add("e1")} AND ${ownSnapshotLandedSql(p, "e1", 4, "nonce")}`;
    expect(denseProblem(sql, p.values())).toBeNull();
  });

  it("Params reuses the number of a repeated value", () => {
    const p = new Params();
    expect([p.add("a"), p.add("b"), p.add("a"), p.add(1), p.add(null), p.add(null)]).toEqual(["?1", "?2", "?1", "?3", "?4", "?4"]);
    expect(p.values()).toEqual(["a", "b", 1, null]);
  });

  it("a guard returning a bare ? fails the density check", () => {
    const b = buildSnapshot({ ...base, guard: () => "e.tags = ?" });
    expect(denseProblem(b.sql, b.bindings)).toBe("bare ? placeholder");
  });

  it("a gap in the numbering is reported", () => {
    expect(denseProblem("SELECT ?1, ?3", ["a", "b"])).toMatch(/not 1\.\./);
    expect(denseProblem("SELECT ?1", ["a", "b"])).toMatch(/bindings/);
  });
});
