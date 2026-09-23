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
const FTS_FAILURE_PATTERNS: RegExp[] = [
  /no such table:\s*(?:main\.)?entries_fts\b/i,
  /table entries_fts has no column named/i,
  /database disk image is malformed/i,
  /vtable constructor failed/i,
  /SQLITE_CORRUPT_VTAB/i,
  /fts5:\s*corrupt/i,
];

export function isFtsFailure(e: unknown): boolean {
  const message = String((e as { message?: string } | null | undefined)?.message ?? e ?? "");
  return FTS_FAILURE_PATTERNS.some(pattern => pattern.test(message));
}

/** True if entries_fts exists, has the right shape, and passes FTS5's own integrity check. */
async function isEntriesFtsHealthy(env: Env): Promise<boolean> {
  try {
    await env.DB.prepare(`SELECT id, content FROM entries_fts LIMIT 0`).all();
    // FTS5's own corruption check — catches internal btree damage that a
    // plain shape probe cannot see (same command named in the plan's Task 5
    // nightly-integrity note).
    await env.DB.prepare(`INSERT INTO entries_fts(entries_fts, rank) VALUES('integrity-check', 1)`).run();
    return true;
  } catch {
    return false;
  }
}

async function entriesFtsTableExists(env: Env): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'entries_fts'`,
    ).first<{ present: number }>();
    return row !== null;
  } catch {
    return false;
  }
}

// Coalesces concurrent repairs within this isolate: a second caller that
// arrives while a repair is already running awaits the SAME promise instead
// of starting its own, which is what let one repair's DROP TABLE erase a row
// a concurrent repair's retry had just inserted. A caller that arrives AFTER
// a repair has finished gets a fresh call, which re-runs the health check
// below and finds the index already healthy — so it never repeats the drop.
// The same health check is what protects against a cross-isolate race (a
// different isolate's repair already fixed the table by the time this one
// gets to run): it asks the database, not any isolate-local state.
let inFlightRepair: Promise<boolean> | null = null;

/**
 * Repairs entries_fts after a write against `entries` failed with an error
 * naming it. Returns whether a repair actually ran: false means the index
 * was already healthy, in which case the caller must treat the original
 * write failure as real and not retry.
 *
 * KV state is fixed BEFORE the table is touched, and only if both KV calls
 * succeed: a save that fails outright beats one that "succeeds" against a
 * freshly emptied index the ready flag still calls trustworthy. If either
 * KV call throws, this rethrows without issuing any DDL, so a missing or
 * broken table is left exactly as it was for the next attempt.
 *
 * Must run against the UNWRAPPED `env` (never the write-guarded one from
 * src/db/fts-write-guard.ts) — otherwise the DDL batch below would recurse
 * into this same guard.
 */
export async function repairFtsIndex(env: Env): Promise<boolean> {
  if (inFlightRepair) return inFlightRepair;
  const promise = doRepair(env);
  inFlightRepair = promise;
  try {
    return await promise;
  } finally {
    if (inFlightRepair === promise) inFlightRepair = null;
  }
}

async function doRepair(env: Env): Promise<boolean> {
  const exists = await entriesFtsTableExists(env);
  if (exists && (await isEntriesFtsHealthy(env))) return false;

  resetFtsReadyMemo();
  await env.OAUTH_KV.delete(FTS_READY_KV_KEY);
  await env.OAUTH_KV.put(FTS_BACKFILL_CURSOR_KV_KEY, "0");

  const rebuild = [
    env.DB.prepare(ENTRIES_FTS_TABLE_DDL),
    env.DB.prepare(ENTRIES_FTS_INSERT_TRIGGER_DDL),
    env.DB.prepare(ENTRIES_FTS_UPDATE_TRIGGER_DDL),
    env.DB.prepare(ENTRIES_FTS_DELETE_TRIGGER_DDL),
  ];
  // A missing table is created without a drop. An existing-but-broken one is
  // dropped first — every DDL string is already IF (NOT) EXISTS, so this
  // still converges cleanly even if the drop turns out to be redundant.
  const statements = exists
    ? [
        env.DB.prepare(`DROP TRIGGER IF EXISTS entries_fts_insert`),
        env.DB.prepare(`DROP TRIGGER IF EXISTS entries_fts_update`),
        env.DB.prepare(`DROP TRIGGER IF EXISTS entries_fts_delete`),
        env.DB.prepare(`DROP TABLE IF EXISTS entries_fts`),
        ...rebuild,
      ]
    : rebuild;

  await env.DB.batch(statements);
  console.error(`Repaired entries_fts (${exists ? "broken" : "missing"}): recreated the table and its sync triggers`);
  return true;
}
