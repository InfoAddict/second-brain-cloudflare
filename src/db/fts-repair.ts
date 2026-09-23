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
 * Ownership (v2.2): ENTRIES_FTS_TABLE_DDL has no IF NOT EXISTS, so a racing
 * creator's batch fails this way as a whole (verified against real
 * node:sqlite) — no partial effect, nothing to roll back by hand. The loser
 * treats it as proof the winner already finished and moves on.
 */
function isTableAlreadyExists(e: unknown): boolean {
  return /table entries_fts already exists/i.test(ftsErrorMessage(e));
}

/**
 * Repairs entries_fts after a write against `entries` failed with an
 * allowlisted error (isFtsFailure). Write-path isolation v2.2:
 *
 * INVARIANT: FTS is live only if entries_fts exists AND all three sync
 * triggers exist — recall checks this itself (src/recall/fts.ts) rather than
 * trusting KV, so this repair never needs to make the disabled state durable
 * or observable on its own. "Table present, triggers absent" already reads
 * as not-live to every other caller.
 *
 * OWNERSHIP: triggers are created only together with the table, in one
 * batch. Missing table, KV succeeded: run that batch. If it fails because
 * the table already exists (a racing isolate got there first), that is a
 * no-op, not an error. Every other case (corruption, wrong shape, or a
 * missing table while KV failed): DROP TRIGGER IF EXISTS on the three FTS
 * triggers only — no table drop, no rename, no new state. Recall's liveness
 * check (not KV) is what makes this safe to observe.
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
    try {
      await env.DB.batch(createFtsTableAndTriggers(env));
    } catch (e) {
      if (!isTableAlreadyExists(e)) throw e;
    }
    return;
  }

  await env.DB.batch(dropFtsTriggers(env));
}

/**
 * Nightly destructive rebuild (Task 5): invalidates KV FIRST — aborting
 * before any DDL if that fails — then drops the triggers and the table
 * (dropping the table alone does not drop them: they are defined ON
 * `entries`, not `entries_fts`, verified against real node:sqlite) and
 * recreates both, and resets the backfill cursor to "0" so it repopulates
 * from scratch. The ONLY destructive path in the write-isolation design —
 * never call this from a request path.
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
