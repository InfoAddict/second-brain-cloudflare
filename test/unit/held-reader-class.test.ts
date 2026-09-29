/**
 * Structural guard for the review's held-row class (T-0089.2.2 review, MAJOR): a statement that
 * joins INTO entries from another table (edges, entry_versions, insight_candidates) discovers rows
 * outside the normal id-bounded candidate pipeline, where recall's own NOT_HELD_SQL filter never
 * runs. If that statement also projects entries content (a preview, or the row's own content) to
 * the caller or to a model prompt, a quarantined row can surface disguised as an ordinary result,
 * breaking prompt-injection containment (review d9dceb64: as-of beliefs bypassed the held filter).
 *
 * A pure id/bookkeeping join (no content column) is not in scope — nothing it returns is prompt
 * or user-facing text. Each pinned exemption below says which of those two reasons applies.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { templateSpans } from "../../scripts/check-scope.mjs";

const ROOT = join(import.meta.dirname, "../..");

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (name.endsWith(".ts")) yield path;
  }
}

/** A statement that reaches entries via a JOIN (not a bounded `id IN (...)` off the candidate pipeline). */
const JOINS_ENTRIES = /\bJOIN entries\b/;
/**
 * Projects entries' own text to the caller: a content column (however aliased — `content AS text`,
 * `substr(content, ...) AS snippet`), or a preview substr of one. A bare substring match, not
 * anchored to a word boundary: a boundary-anchored pattern misses a rename that butts another
 * identifier straight against "content" with no separator. Over-matching is the safe direction —
 * it earns another pinned exemption, not a silent miss.
 */
export const PROJECTS_CONTENT = /content|preview/;
/**
 * The hold filter itself: the plain `${NOT_HELD_SQL}` constant, the aliased `${notHeldSql("a")}`
 * call (T-0102 MINOR fix -- a two-table JOIN needs every `tags` reference qualified, so it can no
 * longer use the bare constant with a manual alias-dot prefix), or the literal LIKE either expands to.
 */
const HOLD_FILTER = /\$\{NOT_HELD_SQL\}|\$\{notHeldSql\(|NOT LIKE '%"quarantine:/;

interface Hit { file: string; line: number; sql: string }

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const path of walk(join(ROOT, "src"))) {
    const text = readFileSync(path, "utf8");
    const spans = templateSpans(text) as unknown as { start: number; end: number; balanced: boolean } & { balanced: boolean };
    if (!(spans as unknown as { balanced: boolean }).balanced) continue;
    for (const span of spans as unknown as { start: number; end: number }[]) {
      const sql = text.slice(span.start + 1, span.end);
      if (JOINS_ENTRIES.test(sql) && PROJECTS_CONTENT.test(sql) && !HOLD_FILTER.test(sql)) {
        const line = text.slice(0, span.start).split("\n").length;
        hits.push({ file: relative(ROOT, path), line, sql: sql.replace(/\s+/g, " ").trim() });
      }
    }
  }
  return hits;
}

/**
 * Readers that join into entries and project content, but are not in scope: an admin- or
 * owner-facing activity log (not a model prompt or an agent-facing recall result), each with why.
 */
const EXEMPT: { file: string; has: string; why: string }[] = [
  { file: "src/brief/changes.ts", has: "entry_events INDEXED BY idx_entry_events_created", why: "the recent-changes feed deliberately lists 'held' events, with a preview, to the brain's own owner: surfacing a hold IS the point, not a bypass of it" },
  { file: "src/routes/admin.ts", has: "FROM admin_events ae", why: "the admin activity trail: a human admin's own audit log, not a model prompt or an agent-facing recall result" },
  { file: "src/routes/admin.ts", has: "FROM edges e LEFT JOIN entries m ON m.id = e.target_id", why: "insight review's source preview for a human admin reviewer; a held source renders as unreadable the same as a deleted one (see the comment above this query), never as ordinary content" },
];

describe("PROJECTS_CONTENT (review NIT)", () => {
  // The old, word-boundary-anchored pattern this replaced: content had to sit at a \b on both
  // sides. It happened to match `content AS text` and `substr(content, ...) AS snippet` (the
  // reviewer's own two examples: nothing else in either string touches "content" directly), but
  // missed a rename that butts straight up against "content" with no separator at all.
  const OLD_BOUNDARY_ANCHORED = /\b\w*\.?content\b|\bpreview\b/;

  it("matches a butted-up rename the boundary-anchored pattern missed", () => {
    const sql = "SELECT s.content_preview FROM edges g JOIN entries s ON s.id = g.source_id";
    expect(OLD_BOUNDARY_ANCHORED.test(sql)).toBe(false); // fails before this change
    expect(PROJECTS_CONTENT.test(sql)).toBe(true);
  });

  it("still matches the reviewer's own two examples", () => {
    expect(PROJECTS_CONTENT.test("SELECT s.content AS text FROM edges g JOIN entries s ON s.id = g.source_id")).toBe(true);
    expect(PROJECTS_CONTENT.test("SELECT substr(s.content, 1, 60) AS snippet FROM edges g JOIN entries s ON s.id = g.source_id")).toBe(true);
  });
});

describe("held-reader class guard (T-0089.2.2 review, MAJOR)", () => {
  const hits = scan();

  it("finds JOIN-entries content readers (the scan is not silently empty)", () => {
    expect(hits.length).toBeGreaterThan(0);
  });

  it("every content-projecting JOIN into entries carries the hold filter or is a pinned exemption", () => {
    const unexplained = hits.filter(h => !EXEMPT.some(e => e.file === h.file && h.sql.includes(e.has))).map(h => `${h.file}:${h.line}: ${h.sql.slice(0, 160)}`);
    expect(unexplained).toEqual([]);
    const stale = EXEMPT.filter(e => !hits.some(h => h.file === e.file && h.sql.includes(e.has))).map(e => `${e.file}: ${e.has}`);
    expect(stale).toEqual([]);
  });
});
