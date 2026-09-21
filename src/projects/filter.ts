// The one place a project becomes a tag filter: its own `project:<slug>` tag plus every
// alias, OR-ed. Aliases are what let a project claim existing plain tags without a backfill.
import { TAG_LIKE_ESCAPE, tagLikePattern } from "../memory/tag-sql";
import { PROJECT_TAG_PREFIX } from "../tags/system";
import type { ProjectRow } from "./registry";

/**
 * LIKE patterns for `tags LIKE ? ESCAPE '\'`. `rows` are every readable row for one slug;
 * aliases merge across them, deduped case-insensitively (LIKE ignores ASCII case).
 */
export function expandProjectFilter(rows: readonly ProjectRow[]): { patterns: string[] } {
  if (!rows.length) return { patterns: [] };
  const seen = new Set<string>();
  const patterns: string[] = [];
  for (const tag of [`${PROJECT_TAG_PREFIX}${rows[0].id}`, ...rows.flatMap(r => r.aliases)]) {
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    patterns.push(tagLikePattern(tag));
  }
  return { patterns };
}

/** The OR group as a SQL clause. `0` (matches nothing) when there is no project to expand. */
export function projectFilterSql(rows: readonly ProjectRow[], column = "tags"): { clause: string; bindings: string[] } {
  const { patterns } = expandProjectFilter(rows);
  if (!patterns.length) return { clause: "0", bindings: [] };
  return { clause: `(${patterns.map(() => `${column} LIKE ? ${TAG_LIKE_ESCAPE}`).join(" OR ")})`, bindings: patterns };
}
