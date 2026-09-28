/**
 * Validity windows (Track 2, T-0089.2.1; spec 14-t2-time-spec.md 5.3 and 5.4).
 *
 * A fact is true from COALESCE(valid_from, created_at) until valid_until (NULL = still true).
 * Validity decides WHETHER a row is true at T; record-time versions decide WHICH TEXT (P1).
 * Pure helpers and statement builders only: every generated statement numbers its placeholders
 * through Params, and every writer compare-and-sets the values it read.
 */
import type { Env } from "../env";
import type { ChangeContext } from "../lib/audit";
import type { Config } from "../config";
import type { MemoryStatus } from "./status";
import { zonedTimeMs } from "../when/timezone";
import { edgeEndpointsReadableSql } from "../graph/edges";
import { Params, pruneStatement, snapshotStatement } from "./versions";

/**
 * A stated start of "unknown": a fact told only with its end ("I lived in Boston until 2020"),
 * or an end earlier than an unstated start. Coalesces like any stated start, so the fact is true
 * at every T before its end. Readers show it as "until <date>" with no start.
 */
export const UNKNOWN_START = 0;

const DEPRECATED_LIKE = `'%"status:deprecated"%'`;

export const EFFECTIVE_FROM = (a: string) => `COALESCE(${a}.valid_from, ${a}.created_at)`;

/** Current: open, or ends after now. Stated starts are never in the future (P5), so no start check. */
export function currentValiditySql(p: Params, alias: string, now: number): string {
  return `(${alias}.valid_until IS NULL OR ${alias}.valid_until > ${p.add(now)})`;
}

/** Actually true at T: starts at or before T and ends after T. */
export function validAtSql(p: Params, alias: string, t: number): string {
  const at = p.add(t);
  return `(${EFFECTIVE_FROM(alias)} <= ${at} AND (${alias}.valid_until IS NULL OR ${alias}.valid_until > ${at}))`;
}

/**
 * The window a new memory is stored with, from what the caller stated. A fact told only with its end,
 * or with an end before the moment it is recorded and no start, starts at UNKNOWN_START.
 */
export function statedWindow(
  v: { from?: number | null; until?: number | null } | undefined, createdAt: number,
): { valid_from: number | null; valid_until: number | null } | { error: string } {
  const from = v?.from ?? null;
  const until = v?.until ?? null;
  if (until === null) return { valid_from: from, valid_until: null };
  if (from === null) return { valid_from: until < createdAt ? UNKNOWN_START : null, valid_until: until };
  if (until < from) return { error: "valid_until is before valid_from." };
  return { valid_from: from, valid_until: until };
}

/** A validity date in replies: "Jun 1, 2026", in the brain's TIMEZONE. */
export function formatValidityDate(ms: number, timezone: string): string {
  return new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: timezone });
}

/** The `remember` reply for a supersede (spec 14 5.4). `closed` is CaptureResult.supersede. */
export function supersedeReply(
  id: string, conflictId: string,
  closed: { at: number; direction: "older" | "newer"; conflictPreview: string }, timezone: string,
): string {
  const date = formatValidityDate(closed.at, timezone);
  return closed.direction === "older"
    ? `Stored. ID: ${id}. It replaces entry ${conflictId} ("${closed.conflictPreview}"), which is kept as history: true until ${date}. If that was wrong, undo(${conflictId}) makes ${conflictId} current again.`
    : `Stored. ID: ${id} as history: it was true until ${date}, when entry ${conflictId} began.`;
}

export interface Window { id: string; from: number; until: number | null; workspaceId: string; status: MemoryStatus | null }

export type SupersedePlan =
  | { action: "close-older"; olderId: string; at: number }
  | { action: "close-newer"; newerId: string; at: number }
  | { action: "none"; reason: "disjoint" | "already-closed-earlier" | "enclosed" };

/**
 * Compares effective windows, not arrival order (P4). Pure interval logic: canonical protection
 * is the caller's, and applies only to close-older.
 *
 * - newer starts later: close the older row at the newer start, unless the older one had already
 *   ended by then, or the newer fact is a closed episode inside the older window ("enclosed": a
 *   fact told as already over never ends a current one).
 * - newer starts at or before the older start (late-told, or a tie): close the newcomer at the
 *   older start, unless its stated end is at or before that start (disjoint).
 */
export function planSupersede(older: Window, newer: Window): SupersedePlan {
  if (newer.from > older.from) {
    if (older.until !== null && older.until <= newer.from) return { action: "none", reason: "already-closed-earlier" };
    if (newer.until !== null && (older.until === null || older.until >= newer.until)) return { action: "none", reason: "enclosed" };
    return { action: "close-older", olderId: older.id, at: newer.from };
  }
  if (newer.until !== null && newer.until <= older.from) return { action: "none", reason: "disjoint" };
  return { action: "close-newer", newerId: newer.id, at: older.from };
}

/**
 * The supersede batch for a plan: [validity snapshot, guarded UPDATE, prune, edge]. Empty for a
 * plan of none. The row closed is pinned to its window's workspace, compare-and-sets the
 * valid_until it was read with, and is never a deprecated row; `guard` (a system job's own CAS,
 * e.-qualified, values only through its Params) joins both the snapshot and the UPDATE. The edge
 * lands only if the window did close, so a lost CAS writes no version and no edge. Vectors and
 * updated_at are untouched: a superseded fact is history, not wrong (D2.1).
 */
export function supersedeStatements(
  env: Env, plan: SupersedePlan, older: Window, newer: Window, change: ChangeContext,
  cfg: Readonly<Config>, guard?: (p: Params) => string,
): D1PreparedStatement[] {
  if (plan.action === "none") return [];
  const [target, closer] = plan.action === "close-older" ? [older, newer] : [newer, older];
  const at = plan.at;
  const cas = (p: Params) => [
    `e.workspace_id = ${p.add(target.workspaceId)}`,
    `e.valid_until IS ${p.add(target.until)}`,
    `e.tags NOT LIKE ${DEPRECATED_LIKE}`,
    ...(guard ? [`(${guard(p)})`] : []),
  ].join(" AND ");

  const up = new Params();
  // versioning: snapshot
  // scope-exempt: by-id: the conflict row read pinned to the writer's workspace; the CAS re-pins it
  const updateSql = `UPDATE entries AS e SET valid_until = ${up.add(at)} WHERE e.id = ${up.add(target.id)} AND ${cas(up)}`;

  const ep = new Params();
  const edgeValues = [crypto.randomUUID(), closer.id, target.id, "supersedes", 1.0, "system", "{}", Date.now(), Date.now(), target.workspaceId].map(v => ep.add(v));
  const sameWorkspace = JSON.stringify([target.workspaceId]);
  const edgeSql =
    // scope-exempt: by-id: both endpoints pinned to the closed row's workspace; lands only if the window closed
    `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
     SELECT ${edgeValues.join(", ")}
      WHERE ${edgeEndpointsReadableSql(ep.add(closer.id), ep.add(target.id), ep.add(sameWorkspace))} AND ${windowClosedSql(ep, target.id, at)}
     ON CONFLICT(source_id, target_id, type) DO UPDATE SET weight = max(weight, excluded.weight), updated_at = excluded.updated_at`;

  return [
    snapshotStatement(env, {
      entryId: target.id, reason: "validity", change, content: { kind: "unchanged" }, nextTags: "unchanged",
      nextState: { valid_until: at }, meta: { cause: "supersede", by: closer.id }, now: Date.now(), guard: cas,
    }),
    env.DB.prepare(updateSql).bind(...up.values()),
    pruneStatement(env, target.id, cfg.VERSION_KEEP),
    env.DB.prepare(edgeSql).bind(...ep.values()),
  ];
}

/** True once `id`'s window is closed at `at`: a hook statement's "the write it rides on landed" guard. */
export function windowClosedSql(p: Params, id: string, at: number): string {
  // scope-exempt: by-id: the row this batch's own guarded UPDATE just wrote
  return `EXISTS (SELECT 1 FROM entries x WHERE x.id = ${p.add(id)} AND x.valid_until = ${p.add(at)})`;
}

// ── Date grammar ─────────────────────────────────────────────────────────────

const FUTURE_ERROR = "That date is in the future. Use when for plans and deadlines; valid dates are for what has already happened.";
const PARSE_ERROR = "Use a date like 2026-06-15, a month like 2026-06, or a year like 2026.";
const PERIOD_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
const OFFSET_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const BARE_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** The calendar date `ms` falls on in `timezone`. */
function zonedDate(ms: number, timezone: string): { y: number; m0: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(ms);
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0);
  return { y: get("year"), m0: get("month") - 1, d: get("day") };
}

const validDay = (y: number, m0: number, d: number) => {
  const probe = new Date(Date.UTC(y, m0, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m0 && probe.getUTCDate() === d;
};

/**
 * A validity date in the brain's TIMEZONE (spec 14 5.4). `start` is the first instant of the named
 * period: valid_from, and valid_until (the first day it was no longer true). `end` is its last
 * instant: as_of, which includes the whole day, month or year asked about, cut at the end of today.
 * Anything later than the end of today is refused (P5).
 */
export function parseValidityDate(raw: string, now: number, timezone: string, bound: "start" | "end"): number | { error: string } {
  const s = typeof raw === "string" ? raw.trim() : "";
  const today = zonedDate(now, timezone);
  const endOfToday = zonedTimeMs(today.y, today.m0, today.d + 1, 0, 0, 0, timezone) - 1;
  let start: number;
  let end: number;
  const period = PERIOD_RE.exec(s);
  const bare = BARE_DATETIME_RE.exec(s);
  if (period) {
    const y = Number(period[1]);
    const m0 = period[2] !== undefined ? Number(period[2]) - 1 : 0;
    const d = period[3] !== undefined ? Number(period[3]) : 1;
    if (m0 < 0 || m0 > 11 || !validDay(y, m0, d)) return { error: PARSE_ERROR };
    start = zonedTimeMs(y, m0, d, 0, 0, 0, timezone);
    const next = period[3] !== undefined ? [y, m0, d + 1] : period[2] !== undefined ? [y, m0 + 1, 1] : [y + 1, 0, 1];
    end = zonedTimeMs(next[0], next[1], next[2], 0, 0, 0, timezone) - 1;
  } else if (bare) {
    const [y, m0, d, h, mi, sec] = [Number(bare[1]), Number(bare[2]) - 1, Number(bare[3]), Number(bare[4]), Number(bare[5]), Number(bare[6] ?? 0)];
    if (!validDay(y, m0, d) || h > 23 || mi > 59 || sec > 59) return { error: PARSE_ERROR };
    start = end = zonedTimeMs(y, m0, d, h, mi, sec, timezone);
  } else if (OFFSET_DATETIME_RE.test(s)) {
    start = end = Date.parse(s);
    if (Number.isNaN(start)) return { error: PARSE_ERROR };
  } else {
    return { error: PARSE_ERROR };
  }
  if (start > endOfToday) return { error: FUTURE_ERROR };
  return bound === "start" ? start : Math.min(end, endOfToday);
}
