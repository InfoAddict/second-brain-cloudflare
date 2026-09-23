import type { Env } from "../env";
import { ftsErrorMessage } from "./fts-repair";
import {
  ENTRY_COUNTS_TABLE_DDL,
  ENTRY_COUNTS_INSERT_TRIGGER_DDL,
  ENTRY_COUNTS_UPDATE_TRIGGER_DDL,
  ENTRY_COUNTS_DELETE_TRIGGER_DDL,
} from "./init";

// T-0065's write-path counterpart to src/db/fts-repair.ts. entry_counts'
// triggers fire inside the same guarded entries statement (src/db/fts-write-guard.ts),
// so a manually dropped table would otherwise fail every entries write in this
// isolate until it recycles or the nightly parity check rebuilds it — the
// smallest safe option is the one FTS already uses: repair on the hot path,
// retry once. Unlike FTS there is no corruption/shape allowlist to worry
// about: a trigger can only ever fail this way if the table itself is gone.
const MISSING_ENTRY_COUNTS_TABLE_PATTERN = /no such table:\s*(?:main\.)?entry_counts\b/i;

export function isEntryCountsFailure(e: unknown): boolean {
  return MISSING_ENTRY_COUNTS_TABLE_PATTERN.test(ftsErrorMessage(e));
}

/**
 * Ownership (T-0065, mirrors v2.2): the table and its three triggers are
 * recreated together, in ONE atomic batch, with a fresh GROUP BY seed — the
 * same shape applySchema uses to create it the first time. "Already exists"
 * (a racing isolate's own repair or applySchema's own creation batch won
 * first) is a no-op, not an error.
 */
export async function repairEntryCounts(env: Env): Promise<void> {
  try {
    await env.DB.batch([
      env.DB.prepare(ENTRY_COUNTS_TABLE_DDL),
      env.DB.prepare(ENTRY_COUNTS_INSERT_TRIGGER_DDL),
      env.DB.prepare(ENTRY_COUNTS_UPDATE_TRIGGER_DDL),
      env.DB.prepare(ENTRY_COUNTS_DELETE_TRIGGER_DDL),
      // scope-exempt: the reseed deliberately covers every workspace (a
      // GROUP BY over the whole table) — the read never reaches a response,
      // it only repopulates the exact counter each scoped read sums from.
      env.DB.prepare(`INSERT INTO entry_counts SELECT workspace_id, count(*) FROM entries GROUP BY workspace_id`),
    ]);
  } catch (e) {
    if (!/table entry_counts already exists/i.test(ftsErrorMessage(e))) throw e;
  }
}
