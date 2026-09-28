/**
 * Structural guard for the review's reader class (T-0089.2.1, spec 14 5.5): every SQL literal in src/
 * that drops deprecated, quarantined or conflict-held rows is deciding what is live, so it must also
 * drop replaced and ended rows, or be on the pinned list below of readers that deliberately read any
 * row, each with its reason. A new reader that filters those tags without the validity predicate fails
 * here, and so does a named fragment that loses it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { templateSpans } from "../../scripts/check-scope.mjs";
import { STALE_REVIEW_SQL } from "../../src/memory/stale";
import { PENDING_INSIGHT_SQL } from "../../src/memory/patterns";
import { dueSql } from "../../src/when/input";
import { openLoopSql } from "../../src/memory/loops";

const ROOT = join(import.meta.dirname, "../..");

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (name.endsWith(".ts")) yield path;
  }
}

/** Drops rows that are deprecated, quarantined or held: a "what is live" filter. */
const LIVENESS_FILTER = /NOT LIKE '%"status:deprecated"%'|NOT LIKE '%"quarantine:|NOT LIKE '%"conflict-held"%'|\$\{NOT_HELD_SQL\}/;
/** The validity predicate itself, or a named fragment that carries it (checked below). */
const VALIDITY = /valid_until|currentValidityAt\(|currentValiditySql\(|validAtSql\(|\$\{(STALE_REVIEW_SQL|PENDING_INSIGHT_SQL)\}|dueSql\(|openLoopSql\(|resurfaceFilter\(/;

interface Hit { file: string; sql: string }

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const path of walk(join(ROOT, "src"))) {
    const text = readFileSync(path, "utf8");
    for (const span of templateSpans(text) as unknown as { start: number; end: number }[]) {
      const sql = text.slice(span.start + 1, span.end);
      if (LIVENESS_FILTER.test(sql) && !VALIDITY.test(sql)) hits.push({ file: relative(ROOT, path), sql: sql.replace(/\s+/g, " ").trim() });
    }
  }
  return hits;
}

/**
 * Readers that filter liveness tags but read any row, current or not, on purpose. Keyed by file and a
 * fragment of the statement (not by line, which other lanes shift), each with the reason it is "any".
 */
const ANY_READERS: { file: string; has: string; why: string }[] = [
  { file: "src/capture/lifecycle.ts", has: "tags NOT LIKE '%\"status:deprecated\"%'", why: "INDEXABLE_SQL: superseded rows keep their vectors and must be re-indexed (P11)" },
  { file: "src/capture/lifecycle.ts", has: "x.tags NOT LIKE", why: "the un-retraction hook's landed guard over the retracted row itself, not a reader" },
  { file: "src/memory/trash.ts", has: "x.tags NOT LIKE", why: "restore's un-retraction landed guard over the restored row itself, not a reader" },
  { file: "src/compression/digest.ts", has: "INDEXED BY idx_entries_conflict_held", why: "held digests are bookkeeping for the digest writer, whatever their window" },
  { file: "src/decisions/queries.ts", has: "tags LIKE '%\"outcome:%'", why: "calibration scores every decision that had an outcome, including one later replaced" },
  { file: "src/graph/pass.ts", has: "id NOT IN (SELECT source_id FROM edges)", why: "nightly edge backfill links history too (spec 4.5: any)" },
  { file: "src/insight/candidates.ts", has: "WHERE (created_at > ? OR (created_at = ? AND id > ?)) AND ${NOT_HELD_SQL}", why: "seed scan fragment; isCurrent() drops replaced rows in JS on the rows it returns" },
  { file: "src/insight/candidates.ts", has: "WHERE ${NOT_HELD_SQL}", why: "seed scan fragment; isCurrent() drops replaced rows in JS on the rows it returns" },
  { file: "src/recall/search.ts", has: "${tagScopeSql} AND ${NOT_HELD_SQL}", why: "tag/project member ids; the final hydration's d1Filters is the current-only predicate" },
  { file: "src/staleness/pass.ts", has: "tags NOT LIKE '%\"status:deprecated\"%'", why: "SYSTEM_TAG_EXCLUSIONS fragment; the candidate query adds currentValidityAt itself" },
];

describe("current-reader class guard (5.5)", () => {
  const hits = scan();

  it("finds the liveness filters (the scan is not silently empty)", () => {
    const all: string[] = [];
    for (const path of walk(join(ROOT, "src"))) {
      const text = readFileSync(path, "utf8");
      for (const span of templateSpans(text) as unknown as { start: number; end: number }[]) {
        if (LIVENESS_FILTER.test(text.slice(span.start + 1, span.end))) all.push(path);
      }
    }
    expect(all.length).toBeGreaterThan(30);
  });

  it("every liveness filter without the validity predicate is a pinned 'any' reader, and every pin still matches", () => {
    const unexplained = hits.filter(h => !ANY_READERS.some(a => a.file === h.file && h.sql.includes(a.has))).map(h => `${h.file}: ${h.sql.slice(0, 140)}`);
    expect(unexplained).toEqual([]);
    const stale = ANY_READERS.filter(a => !hits.some(h => h.file === a.file && h.sql.includes(a.has))).map(a => `${a.file}: ${a.has}`);
    expect(stale).toEqual([]);
  });

  it("the named fragments that stand in for the predicate carry it", () => {
    for (const [name, sql] of [
      ["STALE_REVIEW_SQL", STALE_REVIEW_SQL], ["PENDING_INSIGHT_SQL", PENDING_INSIGHT_SQL],
      ["dueSql", dueSql(1)], ["openLoopSql", openLoopSql(1)],
    ] as const) {
      expect(sql, name).toMatch(/valid_until IS NULL OR valid_until >/);
    }
  });
});
