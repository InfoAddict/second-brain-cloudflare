import { describe, expect, it } from "vitest";
import { makeSqliteD1, positionalParams } from "../helpers/sqlite-d1";

describe("positionalParams", () => {
  it("expands numbered placeholders into plain ones, in order", () => {
    expect(positionalParams("SELECT ?, ?, ?3, ?3, ?4", ["a", "b", "c", "d"])).toEqual({ sql: "SELECT ?, ?, ?, ?, ?", args: ["a", "b", "c", "c", "d"] });
  });
  it("leaves quoted text and statements without numbers alone", () => {
    expect(positionalParams("SELECT '?1', ?", ["a"]).sql).toBe("SELECT '?1', ?");
    expect(positionalParams("SELECT 1 WHERE x = ?", ["a"])).toEqual({ sql: "SELECT 1 WHERE x = ?", args: ["a"] });
  });
  it("runs a statement that mixes both against real SQLite", async () => {
    const sqlite = makeSqliteD1();
    const { results } = await sqlite.db.prepare("SELECT ? AS a, ?3 AS b, ?2 AS c, ?3 AS d").bind("x", "y", "z").all();
    expect(results).toEqual([{ a: "x", b: "z", c: "y", d: "z" }]);
    sqlite.close();
  });
});
