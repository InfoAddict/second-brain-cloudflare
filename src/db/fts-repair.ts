import type { Env } from "../env";
import { FTS_BACKFILL_CURSOR_KV_KEY, FTS_READY_KV_KEY } from "../constants";
import { resetFtsReadyMemo } from "../recall/fts";
import {
  ENTRIES_FTS_TABLE_DDL,
  ENTRIES_FTS_INSERT_TRIGGER_DDL,
  ENTRIES_FTS_UPDATE_TRIGGER_DDL,
  ENTRIES_FTS_DELETE_TRIGGER_DDL,
} from "./init";

// Only errors that genuinely mean entries_fts is missing or broken. A plain
// "no such column" (e.g. a malformed read naming an entries_fts column that
// does not exist) or an FTS5 query-syntax/constraint error must NOT match —
// those mean the caller's SQL is wrong, not that the index needs rebuilding.
// Each pattern below was checked against a real node:sqlite message (see the
// fix's report); "vtable constructor failed" is SQLite's documented text for
// a virtual-table module construction failure, kept for the same corruption
// family even though it was not independently reproduced.
const MISSING_TABLE_PATTERN = /no such table:\s*(?:main\.)?entries_fts\b/i;

const FTS_FAILURE_PATTERNS: RegExp[] = [
  MISSING_TABLE_PATTERN,
  /table entries_fts has no column named/i,
  /database disk image is malformed/i,
  /vtable constructor failed/i,
  /SQLITE_CORRUPT_VTAB/i,
  /fts5:\s*corrupt/i,
];

function ftsErrorMessage(e: unknown): string {
  return String((e as { message?: string } | null | undefined)?.message ?? e ?? "");
}

export function isFtsFailure(e: unknown): boolean {
  const message = ftsErrorMessage(e);
  return FTS_FAILURE_PATTERNS.some(pattern => pattern.test(message));
}

/** True only for the specific "entries_fts does not exist" error, never for the other allowlisted (corruption/shape) errors. */
export function isMissingFtsTable(e: unknown): boolean {
  return MISSING_TABLE_PATTERN.test(ftsErrorMessage(e));
}

const FTS_TRIGGER_NAMES = ["entries_fts_insert", "entries_fts_update", "entries_fts_delete"];

function dropFtsTriggers(env: Env): D1PreparedStatement[] {
  return FTS_TRIGGER_NAMES.map(name => env.DB.prepare(`DROP TRIGGER IF EXISTS ${name}`));
}

function createFtsTableAndTriggers(env: Env): D1PreparedStatement[] {
  return [
    env.DB.prepare(ENTRIES_FTS_TABLE_DDL),
    env.DB.prepare(ENTRIES_FTS_INSERT_TRIGGER_DDL),
    env.DB.prepare(ENTRIES_FTS_UPDATE_TRIGGER_DDL),
    env.DB.prepare(ENTRIES_FTS_DELETE_TRIGGER_DDL),
  ];
}

/**
 * Repairs entries_fts after a write against `entries` failed with an
 * allowlisted error (isFtsFailure). Write-path isolation v2: a live request
 * never destroys the index; only rebuildFtsIndex (nightly, Task 5) does.
 *
 * 1. Clears the isolate's readiness cache, then best-effort deletes the
 *    ready flag and resets the backfill cursor — failures are swallowed,
 *    not rethrown, and just steer step 2 below.
 * 2. Missing table AND both KV ops succeeded: CREATE VIRTUAL TABLE IF NOT
 *    EXISTS plus CREATE TRIGGER IF NOT EXISTS for all three triggers.
 *    Idempotent and safe under any concurrency — nothing is ever dropped.
 * 3. Every other case (corruption, wrong shape, or a missing table while KV
 *    failed): DROP TRIGGER IF EXISTS for the three FTS triggers only. No
 *    table drop, no data loss — entries writes stop failing because the
 *    trigger that failed is gone, and recall falls back to LIKE because
 *    either ready was cleared or the FTS query now throws.
 *
 * No health probe or integrity check: every action here is idempotent and
 * non-destructive, so nothing needs to be verified before it runs.
 *
 * Must run against the UNWRAPPED `env` (never the write-guarded one from
 * src/db/fts-write-guard.ts) — otherwise the DDL batch below would recurse
 * into this same guard.
 */
export async function repairFtsIndex(env: Env, error: unknown): Promise<void> {
  resetFtsReadyMemo();

  let kvOk = true;
  try {
    await env.OAUTH_KV.delete(FTS_READY_KV_KEY);
  } catch {
    kvOk = false;
  }
  try {
    await env.OAUTH_KV.put(FTS_BACKFILL_CURSOR_KV_KEY, "0");
  } catch {
    kvOk = false;
  }

  if (isMissingFtsTable(error) && kvOk) {
    await env.DB.batch(createFtsTableAndTriggers(env));
    return;
  }

  await env.DB.batch(dropFtsTriggers(env));
}

/**
 * Nightly destructive rebuild (Task 5): drops and recreates entries_fts and
 * its triggers unconditionally, deletes ready, and resets the backfill
 * cursor to "0" so the backfill repopulates it from scratch. The ONLY
 * destructive path in the write-isolation design — never call this from a
 * request path.
 */
export async function rebuildFtsIndex(env: Env): Promise<void> {
  resetFtsReadyMemo();
  await env.OAUTH_KV.delete(FTS_READY_KV_KEY);
  await env.OAUTH_KV.put(FTS_BACKFILL_CURSOR_KV_KEY, "0");
  await env.DB.batch([
    ...dropFtsTriggers(env),
    env.DB.prepare(`DROP TABLE IF EXISTS entries_fts`),
    ...createFtsTableAndTriggers(env),
  ]);
}
