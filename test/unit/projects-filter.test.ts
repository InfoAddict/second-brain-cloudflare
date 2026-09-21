import { describe, it, expect } from "vitest";
import { expandProjectFilter, projectFilterSql } from "../../src/projects/filter";
import type { ProjectRow } from "../../src/projects/registry";
import { TAG_LIKE_ESCAPE, tagLikePattern } from "../../src/memory/tag-sql";
import { makeSqliteD1 } from "../helpers/sqlite-d1";

const row = (over: Partial<ProjectRow> = {}): ProjectRow => ({
  id: "site", workspace_id: "ws1", name: "Site", description: "", aliases: [], status: "active", created_at: 1, updated_at: null, ...over,
});

describe("expandProjectFilter", () => {
  it("starts with the project tag and follows with the aliases", () => {
    expect(expandProjectFilter([row({ aliases: ["hosting", "dns"] })]).patterns).toEqual([
      tagLikePattern("project:site"), tagLikePattern("hosting"), tagLikePattern("dns"),
    ]);
  });

  it("merges aliases across workspaces and dedupes case-insensitively", () => {
    const patterns = expandProjectFilter([
      row({ aliases: ["hosting", "dns"] }),
      row({ workspace_id: "ws2", aliases: ["DNS", "cdn"] }),
    ]).patterns;

    expect(patterns).toEqual([tagLikePattern("project:site"), tagLikePattern("hosting"), tagLikePattern("dns"), tagLikePattern("cdn")]);
  });

  it("escapes LIKE metacharacters in slugs and aliases", () => {
    expect(expandProjectFilter([row({ id: "my_app", aliases: ["q3_plan"] })]).patterns)
      .toEqual(["%\"project:my\\_app\"%", "%\"q3\\_plan\"%"]);
  });

  it("returns no patterns for no rows", () => {
    expect(expandProjectFilter([]).patterns).toEqual([]);
  });

  it("includes aliases of archived rows: read filters keep working", () => {
    expect(expandProjectFilter([row({ status: "archived", aliases: ["old"] })]).patterns).toContain(tagLikePattern("old"));
  });
});

describe("projectFilterSql", () => {
  it("builds one parenthesised OR group over the given column", () => {
    const { clause, bindings } = projectFilterSql([row({ aliases: ["hosting"] })], "e.tags");

    expect(clause).toBe(`(e.tags LIKE ? ${TAG_LIKE_ESCAPE} OR e.tags LIKE ? ${TAG_LIKE_ESCAPE})`);
    expect(bindings).toEqual(expandProjectFilter([row({ aliases: ["hosting"] })]).patterns);
  });

  it("defaults the column to tags and matches nothing for no rows", () => {
    expect(projectFilterSql([row()]).clause).toMatch(/^\(tags LIKE \?/);
    expect(projectFilterSql([])).toEqual({ clause: "0", bindings: [] });
  });

  it("selects members and alias matches, and nothing else, in real SQLite", async () => {
    const d1 = makeSqliteD1();
    try {
      d1.seed({ id: "member", content: "m", createdAt: 1, tags: ["project:site", "x"] });
      d1.seed({ id: "aliased", content: "a", createdAt: 2, tags: ["Hosting"] });
      d1.seed({ id: "other", content: "o", createdAt: 3, tags: ["project:site2", "hosting2"] });
      d1.seed({ id: "underscore", content: "u", createdAt: 4, tags: ["project:si_e"] });

      const { clause, bindings } = projectFilterSql([row({ aliases: ["hosting"] })]);
      const { results } = await d1.db.prepare(`SELECT id FROM entries WHERE ${clause} ORDER BY id`).bind(...bindings).all();

      expect((results as { id: string }[]).map(r => r.id)).toEqual(["aliased", "member"]);
    } finally {
      d1.close();
    }
  });
});
