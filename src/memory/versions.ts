import type { Env } from "../env";
import type { ChangeContext } from "../lib/audit";
import type { Identity } from "../lib/identity";
import { assertCanEditContent } from "../lib/entry-access";
import { readableWorkspaces } from "../lib/scope";
import { ensureTenantBootstrap } from "../lib/tenancy";
import { VERSIONS_SINCE_KV_KEY } from "../constants";

export type VersionReason = "update" | "append" | "merge" | "replace" | "rollup" | "status" | "due" | "mirror" | "revert";
export type ContentChange = { kind: "unchanged" } | { kind: "suffix" } | { kind: "next"; content: string };
/** when_* columns the batch's UPDATE writes, and to what; omitted keys are untouched. */
export type WhenChange = Partial<{ when_at: number | null; when_kind: string | null; when_source: string | null; when_label: string | null }>;

const WHEN_COLUMNS = ["when_at", "when_kind", "when_source", "when_label"] as const;

/**
 * Dense placeholder allocator. D1 rejects a statement whose numbered placeholders have gaps
 * ("Wrong number of parameter bindings") though node:sqlite accepts them, so every generated
 * statement takes its numbers from here: `?1..?n`, a repeated value reusing its number.
 */
export class Params {
  private readonly vals: unknown[] = [];
  private readonly seen = new Map<unknown, number>();

  add(value: unknown): string {
    const known = this.seen.get(value);
    if (known !== undefined) return `?${known}`;
    this.vals.push(value);
    this.seen.set(value, this.vals.length);
    return `?${this.vals.length}`;
  }

  values(): unknown[] {
    return [...this.vals];
  }
}

export interface SnapshotInput {
  entryId: string;
  reason: VersionReason;
  change: ChangeContext;
  content: ContentChange;
  nextTags: string[];
  nextWhen?: WhenChange;
  meta?: Record<string, unknown>;
  /** e.-qualified copy of the UPDATE's compare-and-set predicate; values only through p. */
  guard?: (p: Params) => string;
  /** Revert only: snapshot only if MAX(seq) still equals this. */
  expectNewestSeq?: number;
  /** Default true; a revert passes false (undo handles no-ops before the batch). */
  skipNoOp?: boolean;
  now: number;
}

export interface BuiltStatement { sql: string; bindings: unknown[] }

/** Tag set as SQLite will compare it: sorted, compact JSON, like JSON.stringify of a sorted array. */
const SORTED_TAGS = `(SELECT json_group_array(value) FROM (SELECT value FROM json_each(e.tags) ORDER BY value))`;
const NEWEST_SEQ = `COALESCE((SELECT MAX(v.seq) FROM entry_versions v WHERE v.entry_id = e.id), 0)`;

const INSERT_COLUMNS = `INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, state, actor_id, channel, reason, meta, valid_from, created_at)`;

/** SELECT list shared by the one-row and many-row snapshots. `delta` is a SQL boolean over e.content. */
function selectList(p: Params, delta: string, s: { reason: VersionReason; change: ChangeContext; meta?: Record<string, unknown>; now: number }): string {
  // scope-exempt: by-id: callers authorize the entry (or entries) before building the batch
  return `SELECT e.id, e.workspace_id,
       ${NEWEST_SEQ} + 1,
       CASE WHEN ${delta} THEN NULL ELSE e.content END,
       CASE WHEN ${delta} THEN length(e.content) ELSE NULL END,
       e.tags,
       json_object('when_at', e.when_at, 'when_kind', e.when_kind, 'when_source', e.when_source, 'when_label', e.when_label),
       ${p.add(s.change.actorId)}, ${p.add(s.change.channel)}, ${p.add(s.reason)}, ${p.add(JSON.stringify(s.meta ?? {}))},
       COALESCE((SELECT v.created_at FROM entry_versions v WHERE v.entry_id = e.id AND v.seq = (SELECT MAX(x.seq) FROM entry_versions x WHERE x.entry_id = e.id)),
                COALESCE(e.updated_at, e.created_at)),
       ${p.add(s.now)}
  FROM entries e`;
}

export function buildSnapshot(s: SnapshotInput): BuiltStatement {
  const p = new Params();
  const noNul = `instr(e.content, char(0)) = 0`;
  const tags = JSON.stringify([...new Set(s.nextTags)].sort());
  // Allocated only when used: a placeholder that never reaches the SQL leaves a gap D1 rejects.
  const whenSame = () => s.nextWhen
    ? WHEN_COLUMNS.filter(c => c in s.nextWhen!).map(c => `${p.add(s.nextWhen![c as keyof WhenChange] ?? null)} IS e.${c}`).join(" AND ") || "1"
    : "1";
  const tagsSame = () => `${p.add(tags)} = ${SORTED_TAGS}`;
  let delta: string;
  let skip: () => string;
  if (s.content.kind === "next") {
    const next = p.add(s.content.content);
    delta = `${noNul} AND instr(${next}, char(0)) = 0 AND substr(${next}, 1, length(e.content)) = e.content`;
    skip = () => `${next} IS e.content AND ${tagsSame()} AND ${whenSame()}`;
  } else if (s.content.kind === "suffix") {
    delta = noNul;
    skip = () => "0";
  } else {
    delta = noNul;
    skip = () => `${tagsSame()} AND ${whenSame()}`;
  }
  const list = selectList(p, delta, s);
  const conditions = [`e.id = ${p.add(s.entryId)}`];
  if (s.skipNoOp !== false) conditions.push(`NOT (${skip()})`);
  if (s.guard) conditions.push(`(${s.guard(p)})`);
  if (s.expectNewestSeq !== undefined) conditions.push(`${NEWEST_SEQ} = ${p.add(s.expectNewestSeq)}`);
  return {
    sql: `${INSERT_COLUMNS}\n${list}\n WHERE ${conditions.join("\n   AND ")}`,
    bindings: p.values(),
  };
}

export function snapshotStatement(env: Env, s: SnapshotInput): D1PreparedStatement {
  const b = buildSnapshot(s);
  return env.DB.prepare(b.sql).bind(...b.bindings);
}

export interface SnapshotManyInput {
  entryIds: string[];
  reason: VersionReason;
  change: ChangeContext;
  content: { kind: "unchanged" | "suffix" };
  meta?: Record<string, unknown>;
  now: number;
}

/** One statement for many rows: the id list is a single JSON parameter, whatever its length. Never skips a no-op. */
export function buildSnapshotMany(s: SnapshotManyInput): BuiltStatement {
  const p = new Params();
  const list = selectList(p, `instr(e.content, char(0)) = 0`, s);
  return {
    sql: `${INSERT_COLUMNS}\n${list}\n WHERE e.id IN (SELECT value FROM json_each(${p.add(JSON.stringify(s.entryIds))}))`,
    bindings: p.values(),
  };
}

export function snapshotManyStatement(env: Env, s: SnapshotManyInput): D1PreparedStatement {
  const b = buildSnapshotMany(s);
  return env.DB.prepare(b.sql).bind(...b.bindings);
}

/** Bottom-up: keeps exactly the `keep` newest versions, never leaving a gap above the oldest kept. */
export function buildPrune(entryId: string, keep: number): BuiltStatement {
  const p = new Params();
  const id = p.add(entryId);
  return {
    sql: `DELETE FROM entry_versions WHERE entry_id = ${id}
     AND seq <= (SELECT MAX(v.seq) FROM entry_versions v WHERE v.entry_id = ${id}) - ${p.add(keep)}`,
    bindings: p.values(),
  };
}

export function pruneStatement(env: Env, entryId: string, keep: number): D1PreparedStatement {
  const b = buildPrune(entryId, keep);
  return env.DB.prepare(b.sql).bind(...b.bindings);
}

export function buildPruneMany(entryIds: string[], keep: number): BuiltStatement {
  const p = new Params();
  return {
    sql: `DELETE FROM entry_versions WHERE entry_id IN (SELECT value FROM json_each(${p.add(JSON.stringify(entryIds))}))
     AND seq <= (SELECT MAX(v.seq) FROM entry_versions v WHERE v.entry_id = entry_versions.entry_id) - ${p.add(keep)}`,
    bindings: p.values(),
  };
}

export function pruneManyStatement(env: Env, entryIds: string[], keep: number): D1PreparedStatement {
  const b = buildPruneMany(entryIds, keep);
  return env.DB.prepare(b.sql).bind(...b.bindings);
}

/** Like prune, but only mirror versions below the oldest non-mirror version, so a user's version is never skipped over. */
export function buildMirrorPrune(entryId: string, keep: number): BuiltStatement {
  const p = new Params();
  const id = p.add(entryId);
  return {
    sql: `DELETE FROM entry_versions WHERE entry_id = ${id}
     AND seq <= (SELECT MAX(v.seq) FROM entry_versions v WHERE v.entry_id = ${id}) - ${p.add(keep)}
     AND seq < COALESCE((SELECT MIN(v.seq) FROM entry_versions v WHERE v.entry_id = ${id} AND v.reason <> 'mirror'), 9e18)`,
    bindings: p.values(),
  };
}

export function mirrorPruneStatement(env: Env, entryId: string, keep: number): D1PreparedStatement {
  const b = buildMirrorPrune(entryId, keep);
  return env.DB.prepare(b.sql).bind(...b.bindings);
}

/**
 * A compare-and-set predicate over `entries`, built once and shared VERBATIM between a snapshot's
 * guard and its UPDATE's WHERE clause (spec P3: "A snapshot of a CAS-guarded write carries the same
 * guard"). Passing the same `columns` object to two separate `Params` instances (the snapshot's own,
 * and the UPDATE's) cannot drift the two apart the way two hand-written fragments did (ADV-1: a guard
 * that checked fewer columns than its UPDATE let a miss the UPDATE correctly caught still commit a
 * version, under the caller's actor, for a change that never landed).
 *
 * `null` compares with `IS` (so an unset when_* column matches); everything else with `=`. The UPDATE
 * side aliases its table (`UPDATE entries AS e SET … WHERE …`, valid SQLite/D1) so the identical
 * `e.<col>` text works unmodified in both places.
 */
export function buildCasGuard(p: Params, columns: Record<string, unknown>): string {
  return Object.entries(columns)
    .map(([col, val]) => `e.${col} ${val === null ? "IS" : "="} ${p.add(val)}`)
    .join(" AND ");
}

/**
 * UPDATE guard for a revert: true only if THIS request's snapshot row exists (seq = expected + 1 and
 * meta.nonce = nonce). A timestamp is not an identity: Workers' Date.now() only advances after I/O.
 */
export function ownSnapshotLandedSql(p: Params, entryId: string, expectedNewestSeq: number, nonce: string): string {
  return `EXISTS (SELECT 1 FROM entry_versions ov WHERE ov.entry_id = ${p.add(entryId)} AND ov.seq = ${p.add(expectedNewestSeq + 1)} AND json_extract(ov.meta, '$.nonce') = ${p.add(nonce)})`;
}

/** Rows a batch statement changed. Unknown (a test double without meta) counts as one, so only a real zero reads as a lost write. */
export function changesOf(result: { meta?: { changes?: number; rows_written?: number } } | undefined): number {
  return result?.meta?.changes ?? result?.meta?.rows_written ?? 1;
}

/** When history began: the marker init writes, else a conservative MIN(created_at) (pruning can only raise it). */
export async function getVersionsSince(env: Env): Promise<number> {
  const stored = await env.OAUTH_KV.get(VERSIONS_SINCE_KV_KEY);
  const parsed = stored === null ? NaN : Number(stored);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  const row = await env.DB.prepare(`SELECT MIN(created_at) AS first FROM entry_versions`).first<{ first: number | null }>();
  const since = row?.first ?? Date.now();
  try {
    await env.OAUTH_KV.put(VERSIONS_SINCE_KV_KEY, String(since));
  } catch (e) {
    console.error("versions:since write failed (non-fatal):", e);
  }
  return since;
}

// ── Reconstruction ──

export interface VersionRow {
  seq: number;
  workspace_id: string;
  content: string | null;
  prior_length: number | null;
  tags: string;
  state: string;
  actor_id: string;
  channel: string;
  reason: VersionReason;
  meta: string;
  valid_from: number | null;
  created_at: number;
}

export class VersionChainError extends Error {}

export interface VersionChain {
  rows: VersionRow[];
  truncatedAt: "none" | "unreadable" | "gap";
  /** The text this entry had before the change version `seq` recorded. Built on demand. */
  text(seq: number): string;
}

const SURROGATES = /[\uD800-\uDFFF]/;

/**
 * Rows arrive newest first. A delta row's text is the first `prior_length` code points of the next
 * newer state, so a run of consecutive delta rows shares one base (the nearest newer full copy, or
 * the live text) and their lengths never grow. Boundaries for a whole run are found in one pass.
 */
export function buildChain(
  current: string,
  rowsNewestFirst: VersionRow[],
  canRead: (workspaceId: string) => boolean,
  opts: { onScan?: (units: number) => void } = {},
): VersionChain {
  const rows: VersionRow[] = [];
  let truncatedAt: VersionChain["truncatedAt"] = "none";
  for (const r of rowsNewestFirst) {
    if (!canRead(r.workspace_id)) { truncatedAt = "unreadable"; break; }
    if (rows.length && r.seq !== rows[rows.length - 1].seq - 1) { truncatedAt = "gap"; break; }
    rows.push(r);
  }
  const indexOf = new Map(rows.map((r, i) => [r.seq, i]));
  // seq -> UTF-16 end index in its base, filled one run at a time.
  const ends = new Map<number, { base: string; end: number }>();

  const resolveRun = (from: number): void => {
    // `from` is the newest delta row of a run; its base is the row above it, or the live text.
    let to = from;
    while (to + 1 < rows.length && rows[to + 1].content === null) to++;
    const base = from === 0 ? current : rows[from - 1].content!;
    // The base of a run whose newest member is not at index 0 is the full copy just above it.
    let previous = Infinity;
    const wanted: number[] = [];
    for (let i = from; i <= to; i++) {
      const length = rows[i].prior_length!;
      if (length > previous) throw new VersionChainError(`version ${rows[i].seq} claims ${length} characters of a ${previous}-character state`);
      previous = length;
      wanted.push(length);
    }
    const resolved = new Map<number, number>();
    if (!SURROGATES.test(base)) {
      for (const length of wanted) {
        if (length > base.length) throw new VersionChainError(`version claims ${length} characters of a ${base.length}-character base`);
        resolved.set(length, length);
      }
    } else {
      // Lengths are non-increasing, so walk once, ascending.
      let unit = 0;
      let count = 0;
      for (const length of [...new Set(wanted)].sort((a, b) => a - b)) {
        while (count < length) {
          if (unit >= base.length) throw new VersionChainError(`version claims ${length} characters of a shorter base`);
          const c = base.charCodeAt(unit);
          unit += c >= 0xd800 && c <= 0xdbff && unit + 1 < base.length && (base.charCodeAt(unit + 1) & 0xfc00) === 0xdc00 ? 2 : 1;
          count++;
        }
        resolved.set(length, unit);
      }
      opts.onScan?.(unit);
    }
    for (let i = from; i <= to; i++) ends.set(rows[i].seq, { base, end: resolved.get(rows[i].prior_length!)! });
  };

  return {
    rows,
    truncatedAt,
    text(seq: number): string {
      const i = indexOf.get(seq);
      if (i === undefined) throw new VersionChainError(`no version ${seq} in this chain`);
      const row = rows[i];
      if (row.content !== null) return row.content;
      if (!ends.has(seq)) {
        let start = i;
        while (start > 0 && rows[start - 1].content === null) start--;
        resolveRun(start);
      }
      const hit = ends.get(seq)!;
      return hit.base.slice(0, hit.end);
    },
  };
}

// ── Who may read and revert ──

/** Whether `reader` may see a version or event stamped with workspace `ws`. `ownerUserId` is needed only for "". */
export function workspaceReadable(reader: Identity | undefined, ws: string, ownerUserId?: string): boolean {
  if (!reader) return true;
  // readableWorkspaces gives "" to every admin, which is right for legacy rows and wrong for history.
  if (ws === "") return ownerUserId !== undefined && reader.userId === ownerUserId;
  return readableWorkspaces(reader).includes(ws);
}

const HISTORY_COLUMNS = `seq, workspace_id, content, prior_length, tags, state, actor_id, channel, reason, meta, valid_from, created_at`;

/** The one read of an entry's versions. Readability is enforced per row by buildChain (D-SH). */
export async function loadHistory(
  env: Env, reader: Identity | undefined, row: { id: string; content: string }, limit: number,
): Promise<VersionChain> {
  const capped = Math.min(500, Math.max(1, Math.floor(limit)));
  const { results } = await env.DB.prepare(
    // scope-checked: readability enforced per row by buildChain (D-SH)
    `SELECT ${HISTORY_COLUMNS} FROM entry_versions WHERE entry_id = ? ORDER BY seq DESC LIMIT ?`,
  ).bind(row.id, capped).all<VersionRow>();
  const rows = results ?? [];
  const ownerUserId = reader && rows.some(r => r.workspace_id === "") ? (await ensureTenantBootstrap(env)).ownerUserId : undefined;
  return buildChain(row.content, rows, ws => workspaceReadable(reader, ws, ownerUserId));
}

export type RevertVerdict = { ok: true } | { ok: false; code: "forbidden" | "stale" | "unreadable" };

/**
 * May `reader` revert the change version `target` recorded? Rule (1) is "R can read E and V is
 * visible to R (V is in loadHistory(R, E))" — checking only `target`'s own workspace is not enough
 * (ADV-6): a company-era version below a personal-era edit is unreadable to a non-author even though
 * its OWN workspace is one they could otherwise read, because `loadHistory`'s walk stops at the
 * intervening unreadable row and never reaches it. `visibleSeqs` is the seq set `loadHistory` (or
 * `revertEntry`'s own chain) actually returned, so this cannot be satisfied by a target the caller
 * never confirmed was in that walk.
 *
 * The author or an admin may revert any visible version (the normal content-edit rule); otherwise
 * the actor of the NEWEST version may revert exactly that one. The caller still guards the write
 * with the newest seq (M4), since this is checked on a read.
 */
export function canRevert(
  reader: Identity | undefined,
  entry: { workspace_id: string; actor_id: string },
  target: Pick<VersionRow, "seq" | "workspace_id" | "actor_id">,
  newestSeq: number,
  visibleSeqs: Iterable<number>,
  opts: { ownerUserId?: string } = {},
): RevertVerdict {
  if (!new Set(visibleSeqs).has(target.seq)) return { ok: false, code: "unreadable" };
  if (!workspaceReadable(reader, target.workspace_id, opts.ownerUserId)) return { ok: false, code: "unreadable" };
  if (!assertCanEditContent(reader, entry)) return { ok: true };
  if (!reader || target.actor_id === "" || target.actor_id !== reader.userId) return { ok: false, code: "forbidden" };
  return target.seq === newestSeq ? { ok: true } : { ok: false, code: "stale" };
}
