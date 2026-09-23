import type { Env } from "../env";
import { FTS_BACKFILL_CURSOR_KV_KEY, FTS_READY_KV_KEY } from "../constants";
import { resetFtsReadyMemo } from "../recall/fts";
import {
  ENTRIES_FTS_TABLE_DDL,
  ENTRIES_FTS_INSERT_TRIGGER_DDL,
  ENTRIES_FTS_UPDATE_TRIGGER_DDL,
  ENTRIES_FTS_DELETE_TRIGGER_DDL,
} from "./init";

// Names entries_fts itself and its shadow tables (default FTS5 storage: data,
// idx, docsize, config, content). Anchored on the FTS table name so an
// unrelated SQLITE_ERROR or UNIQUE-constraint message never matches.
const FTS_OBJECT_NAME = /\bentries_fts(?:_(?:data|idx|docsize|config|content))?\b/;

export function isFtsFailure(e: unknown): boolean {
  const message = String((e as { message?: string } | null | undefined)?.message ?? e ?? "");
  return FTS_OBJECT_NAME.test(message);
}

/**
 * Recreates entries_fts and its three sync triggers after a write against
 * `entries` failed with an error naming entries_fts. Missing and broken
 * collapse to the same repair: every DDL string is already
 * IF (NOT) EXISTS, so dropping first (a no-op when the table was merely
 * missing) and recreating always converges on a working index.
 *
 * Must run against the UNWRAPPED `env` (never the write-guarded one from
 * src/db/fts-write-guard.ts) — otherwise a repair that itself hits an
 * entries_fts error would recurse into another repair.
 */
export async function repairFtsIndex(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DROP TRIGGER IF EXISTS entries_fts_insert`),
    env.DB.prepare(`DROP TRIGGER IF EXISTS entries_fts_update`),
    env.DB.prepare(`DROP TRIGGER IF EXISTS entries_fts_delete`),
    env.DB.prepare(`DROP TABLE IF EXISTS entries_fts`),
    env.DB.prepare(ENTRIES_FTS_TABLE_DDL),
    env.DB.prepare(ENTRIES_FTS_INSERT_TRIGGER_DDL),
    env.DB.prepare(ENTRIES_FTS_UPDATE_TRIGGER_DDL),
    env.DB.prepare(ENTRIES_FTS_DELETE_TRIGGER_DDL),
  ]);
  // Recall falls back to LIKE until the nightly backfill (or the next
  // integrity pass) re-covers the corpus; a freshly rebuilt index has no rows.
  await env.OAUTH_KV.delete(FTS_READY_KV_KEY);
  await env.OAUTH_KV.put(FTS_BACKFILL_CURSOR_KV_KEY, "0");
  resetFtsReadyMemo();
  console.error("Repaired entries_fts: an entries write failed against a missing or broken FTS index; recreated the table and its sync triggers");
}
