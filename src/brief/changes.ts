// S1 (T-0089.4.3, 16-t3-t4-trust-spec.md Lane S): the "what AI tools changed"
// query and grouping (5.8). New file only -- wiring into GET /brief, the MCP
// brief tool and the dashboard's changes line is S2/S3/S4, after Track 1 and
// Lane W (quarantine holds) merge. Nothing here is called from any route yet,
// and nothing here writes.
//
// One D1 statement, proven against real SQLite (test/integration/brief-changes.test.ts):
// entry_events joined by id against entries or entries_trash, scoped to the
// reader's readable workspaces as ONE JSON-bound parameter rather than one
// placeholder per workspace -- the same reason src/brief/compute.ts's
// briefWorkspaceScope does that: a member of many teams must not blow D1's
// 100-bound-parameter ceiling.
import type { Env } from "../env";
import type { Identity } from "../lib/identity";
import { readScopeWorkspaces } from "../lib/scope";
import { resolveConfig, type Config } from "../config";
import { scoreWrite } from "../quarantine/score";
import { INTEGRATION_PROVIDERS } from "../integrations";

/** Matches src/brief/compute.ts's RECENT_WINDOW_MS window. */
export const BRIEF_CHANGES_WINDOW_HOURS = 48;

const READ_LIMIT = 200;
const OUTPUT_LIMIT = 20;
const GROUP_WINDOW_MS = 10 * 60 * 1000;

// Group-collapse thresholds (5.8), now that Lane Q's real config keys exist
// on this branch: the status family's threshold and every other family's
// threshold, plus the scorer's own hold threshold for client names, are all
// read from Config below (see thresholdFor and safeClient) rather than
// compiled-in constants (the director's call, replacing S1's placeholder
// 10/5 once both keys were real).

export type ChangeFamily =
  | "held" | "released" | "canonical_edit" | "capsule_changed" | "status" | "trash" | "revert";

export interface ChangeItem {
  kind: "item";
  id: string;
  event: string;
  family: ChangeFamily;
  at: number;
  client: string | null;
  preview: string | null;
  reasons?: string[];
  source?: string | null;
  status?: string;
  capsuleChanged?: boolean;
  canUndo?: boolean;
  canRelease?: boolean;
}

export interface ChangeGroup {
  kind: "group";
  family: ChangeFamily;
  count: number;
  /** Oldest change in the group. */
  at: number;
  /** Newest change in the group. */
  until: number;
  client: string | null;
  /** Opaque key: base64url(JSON.stringify({f,a,c,s,e})). The server re-derives
   *  membership from it (5.9) -- a client cannot smuggle ids into it. */
  group: string;
  canUndoAll?: boolean;
  canReleaseAll?: boolean;
}

export type ChangeRow = ChangeItem | ChangeGroup;

export interface ChangesResult {
  windowHours: number;
  /** Memories affected, before grouping. */
  count: number;
  /** Held rows among them. */
  held: number;
  truncated: boolean;
  items: ChangeRow[];
}

interface RawRow {
  id: string;
  entry_id: string;
  event: string;
  payload: string;
  created_at: number;
  actor_id: string;
  author_id: string | null;
  source: string | null;
  preview: string | null;
}

/**
 * A client name that itself reads as an instruction to an AI tool is shown as
 * null (the brief renders that as "an AI tool") rather than put into agent
 * context verbatim -- a pure display-time check, no cost (5.8, Q5).
 *
 * BE-5 accepts any DCR client_name, and the brief puts names into agent
 * context at session start, so a forged name is scored exactly like any
 * other MCP-channel content: Lane Q's real scorer (src/quarantine/score.ts),
 * not a local approximation of it. `mcpWritesInWindow` and
 * `capsuleTagsChanged` are omitted on purpose -- a bare name can be neither
 * a burst nor a capsule edit, so those signals have nothing to read here.
 */
export function safeClient(rawClient: unknown, cfg: Readonly<Config>): string | null {
  if (typeof rawClient !== "string") return null;
  const name = rawClient.trim();
  if (!name) return null;
  const result = scoreWrite({ content: name, tags: [], source: undefined, channel: "mcp", kind: "create" }, cfg);
  return result.hold ? null : name;
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

interface Classified {
  id: string;
  event: string;
  family: ChangeFamily;
  actorId: string;
  client: string | null;
  createdAt: number;
  preview: string | null;
  reasons?: string[];
  source?: string | null;
  status?: string;
  capsuleChanged?: boolean;
}

const STATUS_VALUES = new Set(["canonical", "draft", "deprecated"]);

/** One row's classification, or null when it does not qualify for the line at all (5.8's "not listed"). */
function classify(row: RawRow, cfg: Readonly<Config>): Classified | null {
  const payload = parsePayload(row.payload);
  const client = safeClient(payload.client, cfg);
  const base = {
    id: row.entry_id, event: row.event, actorId: row.actor_id, client,
    createdAt: row.created_at, preview: row.preview,
  };

  switch (row.event) {
    case "held": {
      const reasons = Array.isArray(payload.reasons)
        ? payload.reasons.filter((r): r is string => typeof r === "string")
        : [];
      return { ...base, family: "held", reasons, source: row.source };
    }
    case "released":
      return { ...base, family: "released" };
    case "reverted":
      return { ...base, family: "revert" };
    case "updated":
    case "appended": {
      const wasCanonical = payload.was_canonical === true;
      const capsuleChanged = payload.capsule_changed === true;
      if (!wasCanonical && !capsuleChanged) return null; // an ordinary edit to a non-canonical memory: not listed
      return { ...base, family: wasCanonical ? "canonical_edit" : "capsule_changed", capsuleChanged };
    }
    case "status_changed": {
      const status = typeof payload.status === "string" ? payload.status : "";
      if (!STATUS_VALUES.has(status)) return null;
      return { ...base, family: "status", status };
    }
    case "deleted":
      if (payload.trash !== true) return null; // a permanent delete, not a trash move
      return { ...base, family: "trash" };
    default:
      return null;
  }
}

function toBase64Url(json: string): string {
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function groupKey(family: ChangeFamily, actorId: string, client: string | null, startMs: number, endMs: number): string {
  return toBase64Url(JSON.stringify({ f: family, a: actorId, c: client, s: startMs, e: endMs }));
}

function thresholdFor(family: ChangeFamily, cfg: Readonly<Config>): number {
  return family === "status" ? cfg.QUARANTINE_STATUS_BURST : cfg.QUARANTINE_WRITE_BURST;
}

/**
 * Groups consecutive same actor/client/family rows within GROUP_WINDOW_MS of
 * each other. `rows` must be newest-first, the order the query returns.
 * A run below its family's threshold stays as individual items.
 */
function group(rows: Classified[], cfg: Readonly<Config>): ChangeRow[] {
  const out: ChangeRow[] = [];
  let i = 0;
  while (i < rows.length) {
    let j = i + 1;
    while (
      j < rows.length
      && rows[j].family === rows[i].family
      && rows[j].actorId === rows[i].actorId
      && rows[j].client === rows[i].client
      && rows[j - 1].createdAt - rows[j].createdAt <= GROUP_WINDOW_MS
    ) j++;
    const run = rows.slice(i, j);
    const family = run[0].family;
    if (run.length >= thresholdFor(family, cfg)) {
      const at = run[run.length - 1].createdAt;
      const until = run[0].createdAt;
      out.push({
        kind: "group",
        family,
        count: run.length,
        at,
        until,
        client: run[0].client,
        group: groupKey(family, run[0].actorId, run[0].client, at, until),
        ...(family === "held" ? { canReleaseAll: true } : { canUndoAll: true }),
      });
    } else {
      for (const r of run) {
        out.push({
          kind: "item",
          id: r.id,
          event: r.event,
          family: r.family,
          at: r.createdAt,
          client: r.client,
          preview: r.preview,
          ...(r.reasons ? { reasons: r.reasons } : {}),
          ...(r.source !== undefined ? { source: r.source } : {}),
          ...(r.status ? { status: r.status } : {}),
          ...(r.capsuleChanged ? { capsuleChanged: true } : {}),
          ...(r.family === "held" ? { canRelease: true } : { canUndo: true }),
        });
      }
    }
    i = j;
  }
  return out;
}

/** entry_events carries no workspace column (5.8's own comment below), so nothing before the
 * join is scoped to this reader — a corpus-wide burst in the window used to cost a corpus-wide
 * scan before LIMIT 200 could apply (R21 review, MINOR: 5,101 rows read to return one item
 * against 5,000 unrelated events). Caps the pre-join, pre-filter read so the worst case is
 * bounded by this constant regardless of deployment size, not by how many OTHER people's events
 * landed in the window. */
const RAW_EVENT_SCAN_LIMIT = 1000;

/**
 * The 5.8 event read, shared by getChanges (a rolling window, newest first) and
 * groupCandidates below (an exact [since, until] bound, oldest first, for 5.9's
 * membership re-derivation). One D1 call either way: two plain statements in one
 * `.batch()`, which this codebase's D1 budget counts as a single call, same as
 * every other batched write elsewhere in src/.
 */
async function changeEventRows(
  env: Env, identity: Identity, since: number, until: number, order: "ASC" | "DESC",
  layer?: "personal" | "company", teamId?: string,
): Promise<{ rows: RawRow[]; rawCapped: boolean }> {
  const workspaces = readScopeWorkspaces(identity, { layer, teamId });
  const eventFilter = `created_at > ?1 AND created_at <= ?2
       AND event IN ('held','released','updated','appended','status_changed','deleted','reverted')`;
  const [countResult, mainResult] = await env.DB.batch([
    // A cheap, bounded probe: capped at RAW_EVENT_SCAN_LIMIT + 1 so it can say "at least that
    // many raw events exist in the window" without ever reading more than that to say so.
    env.DB.prepare(
      `SELECT COUNT(*) as raw_count FROM (
         SELECT 1 FROM entry_events INDEXED BY idx_entry_events_created
         WHERE ${eventFilter} LIMIT ${RAW_EVENT_SCAN_LIMIT + 1}
       )`,
    ).bind(since, until),
    env.DB.prepare(
      // scope-checked: the reader's scope clause is applied to COALESCE(en.workspace_id, t.workspace_id); entry_events has no workspace column
      `SELECT e.id, e.entry_id, e.event, e.payload, e.created_at, e.actor_id,
              COALESCE(en.actor_id, t.actor_id) AS author_id,
              COALESCE(en.source, json_extract(t.row_json, '$.source')) AS source,
              substr(COALESCE(en.content, t.content), 1, 160) AS preview
       FROM (
         SELECT id, entry_id, event, payload, created_at, actor_id FROM entry_events INDEXED BY idx_entry_events_created
         WHERE ${eventFilter}
         ORDER BY created_at ${order}
         LIMIT ${RAW_EVENT_SCAN_LIMIT}
       ) e
       LEFT JOIN entries en ON en.id = e.entry_id
       LEFT JOIN entries_trash t ON en.id IS NULL AND t.id = e.entry_id
       WHERE (e.event = 'held' OR json_extract(e.payload, '$.channel') = 'mcp')
         AND COALESCE(en.workspace_id, t.workspace_id) IN (SELECT value FROM json_each(?3))
         AND (e.actor_id = ?4 OR COALESCE(en.actor_id, t.actor_id) = ?4 OR e.event = 'held')
       ORDER BY e.created_at ${order}
       LIMIT 200`,
    ).bind(since, until, JSON.stringify(workspaces), identity.userId),
  ]);
  const rawCount = ((countResult.results as { raw_count: number }[] | undefined)?.[0]?.raw_count) ?? 0;
  return { rows: (mainResult.results ?? []) as unknown as RawRow[], rawCapped: rawCount > RAW_EVENT_SCAN_LIMIT };
}

/**
 * The "what AI tools changed" query and grouping (5.8). Exactly one D1
 * statement; pure JS grouping after. Read-only.
 */
export async function getChanges(
  env: Env,
  identity: Identity,
  windowHours: number = BRIEF_CHANGES_WINDOW_HOURS,
  config?: Readonly<Config>,
  layer?: "personal" | "company",
  teamId?: string,
): Promise<ChangesResult> {
  const cfg = config ?? await resolveConfig(env);
  const now = Date.now();
  const since = now - windowHours * 60 * 60 * 1000;
  const { rows: results, rawCapped } = await changeEventRows(env, identity, since, now, "DESC", layer, teamId);

  const classified = results.map(row => classify(row, cfg)).filter((c): c is Classified => c !== null);
  const held = classified.filter(c => c.family === "held").length;

  return {
    windowHours,
    count: classified.length,
    held,
    // Honest either way (R21 review): the filtered read hit its own 200-row output cap, or the
    // raw pre-filter scan hit RAW_EVENT_SCAN_LIMIT before it could see the whole window.
    truncated: results.length === READ_LIMIT || rawCapped,
    items: group(classified, cfg).slice(0, OUTPUT_LIMIT),
  };
}

// ── Group membership (S3, 5.9) ──────────────────────────────────────────────

export const UNDO_GROUP_MAX = 50;
export const UNDO_GROUP_PAGE = 5;

export interface DecodedGroup { family: ChangeFamily; actorId: string; client: string | null; start: number; end: number }

const GROUP_FAMILIES: readonly ChangeFamily[] = ["held", "released", "canonical_edit", "capsule_changed", "status", "trash", "revert"];

function fromBase64Url(key: string): string {
  return atob(key.replace(/-/g, "+").replace(/_/g, "/"));
}

/** The inverse of groupKey() above. Never trusts the decoded fields as-is beyond their shape --
 * groupCandidates below re-derives membership from the reader's own scoped read, so a tampered
 * key just narrows to nothing rather than reading anything it should not (5.9). */
export function decodeGroupKey(key: string): DecodedGroup | null {
  try {
    const parsed = JSON.parse(fromBase64Url(key)) as { f?: unknown; a?: unknown; c?: unknown; s?: unknown; e?: unknown };
    if (typeof parsed.f !== "string" || !GROUP_FAMILIES.includes(parsed.f as ChangeFamily)) return null;
    if (typeof parsed.a !== "string" || typeof parsed.s !== "number" || typeof parsed.e !== "number") return null;
    if (parsed.c !== null && typeof parsed.c !== "string") return null;
    return { family: parsed.f as ChangeFamily, actorId: parsed.a, client: (parsed.c as string | null) ?? null, start: parsed.s, end: parsed.e };
  } catch {
    return null;
  }
}

export interface GroupCandidates { decoded: DecodedGroup; ids: string[]; capped: boolean }

/**
 * Re-derives a group's membership from the reader's own scoped read of the 5.8 event window
 * (5.9): distinct entry_id, oldest change first, capped at UNDO_GROUP_MAX. The decoded actor and
 * client are matched, never trusted to select rows on their own -- changeEventRows applies the
 * same reader-scope and "whose changes" clause getChanges does, so a group key naming someone
 * else's actor or a workspace the reader cannot see simply matches nothing here.
 */
export async function groupCandidates(
  env: Env, identity: Identity, groupKeyStr: string, cfg: Readonly<Config>,
): Promise<GroupCandidates | null> {
  const decoded = decodeGroupKey(groupKeyStr);
  if (!decoded) return null;
  const { rows } = await changeEventRows(env, identity, decoded.start - 1, decoded.end, "ASC");
  const classified = rows.map(row => classify(row, cfg)).filter((c): c is Classified => c !== null);
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const c of classified) {
    if (c.family !== decoded.family || c.actorId !== decoded.actorId || c.client !== decoded.client) continue;
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    ids.push(c.id);
  }
  return { decoded, ids: ids.slice(0, UNDO_GROUP_MAX), capped: ids.length > UNDO_GROUP_MAX };
}

// ── Rendering (S2) ────────────────────────────────────────────────────────────

/** GET /brief's `changes` shape (contract 6.2, snake_case). Held items keep their preview here —
 * REST/dashboard is not agent context. */
/**
 * GET /brief's REST auth is a single bearer token per user (src/lib/identity.ts's extractToken)
 * with no separate dashboard-session concept -- the same token the dashboard's own JS holds is
 * exactly what a hook or an AI tool integration authenticates with too (every shipped hook calls
 * `GET /brief?lean=1`, which never reaches this function at all, but nothing stops some other
 * script from calling the non-lean path with that same token). `preview` above is an unrelated,
 * pre-existing dry-run flag (skip persisting resurface state), not a content-reveal one, so a
 * held item's own text is held back here by default regardless of it -- `revealHeld` is a
 * separate, purpose-named opt-in a future dashboard UI (S4) passes only from its own "reveal"
 * action, never a default any token-only caller gets for free (P7).
 */
export function changesToRestJson(result: ChangesResult, revealHeld = false): Record<string, unknown> {
  return {
    window_hours: result.windowHours,
    count: result.count,
    held: result.held,
    truncated: result.truncated,
    items: result.items.map(row => row.kind === "group"
      ? {
          kind: "group", family: row.family, count: row.count, at: row.at, until: row.until, client: row.client,
          group: row.group, ...(row.canUndoAll ? { can_undo_all: true } : {}), ...(row.canReleaseAll ? { can_release_all: true } : {}),
        }
      : {
          kind: "item", event: row.event, family: row.family, id: row.id, at: row.at, client: row.client,
          preview: row.family === "held" && !revealHeld ? null : row.preview,
          ...(row.reasons ? { reasons: row.reasons } : {}), ...(row.source !== undefined ? { source: row.source } : {}),
          ...(row.status ? { status: row.status } : {}), ...(row.capsuleChanged ? { capsule_changed: true } : {}),
          ...(row.canUndo ? { can_undo: true } : {}), ...(row.canRelease ? { can_release: true } : {}),
        }),
  };
}

/** The lean brief's `changes` shape (6.2, Q-H): counts and groups only, never items or preview. */
export function changesToLeanJson(result: ChangesResult): { count: number; held: number; groups: { family: ChangeFamily; count: number; client: string | null; at: number }[] } {
  return {
    count: result.count,
    held: result.held,
    groups: result.items.filter((r): r is ChangeGroup => r.kind === "group")
      .map(g => ({ family: g.family, count: g.count, client: g.client, at: g.at })),
  };
}

const GROUP_NOUN: Record<ChangeFamily, (n: number) => string> = {
  held: n => `${n} held (many memories in a short time)`,
  released: n => `${n} releases`,
  canonical_edit: n => `${n} trusted-memory edits`,
  capsule_changed: n => `${n} changes to what your AI tools see`,
  status: n => `${n} status changes`,
  trash: n => `${n} moved to the trash`,
  revert: n => `${n} undone changes`,
};

/** Provider display name for a held mirror row's "from Gmail" suffix (5.8). Non-mirror sources
 * (api, mcp writes) render no suffix at all. */
function providerLabel(source: string | null | undefined): string | null {
  if (!source) return null;
  return INTEGRATION_PROVIDERS[source]?.name ?? null;
}

function itemText(r: ChangeItem): string {
  switch (r.family) {
    case "held": {
      const reason = r.reasons?.length ? r.reasons.join(", ") : "unknown";
      const from = providerLabel(r.source);
      return `Held: ${reason}${from ? ` from ${from}` : ""}`;
    }
    case "released": return "Released a held memory";
    case "canonical_edit": return "Edited a trusted memory";
    case "capsule_changed": return "Changed what your AI tools always see";
    case "status": return r.status === "canonical" ? "Marked as trusted" : r.status === "deprecated" ? "Marked as wrong" : "Marked as unconfirmed";
    case "trash": return "Moved to the trash";
    case "revert": return "Undid a change";
  }
}

const clientLabel = (client: string | null): string => client ? `"${client}"` : "an AI tool";
const timeLabel = (ms: number, timezone: string): string =>
  new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timezone });

function rowText(r: ChangeRow, timezone: string): string {
  if (r.kind === "item") return `- ${itemText(r)} by ${clientLabel(r.client)}`;
  const action = r.family === "held" ? "Release all" : "Undo all";
  return `- ${GROUP_NOUN[r.family](r.count)} at ${timeLabel(r.until, timezone)} by ${clientLabel(r.client)} (group: ${r.group}) · ${action}`;
}

/**
 * The MCP brief's "What AI tools changed" block (5.8). Never touches `preview` -- every line is
 * built from the fixed English strings in the design table, never memory content, so a held row
 * cannot leak its text here even by omission bug (P7 is structural, not a special case below).
 * Empty result renders "" so callers can omit the section entirely (contract 6.2).
 */
export function renderChangesText(result: ChangesResult, timezone: string): string {
  if (!result.count) return "";
  return result.items.map(r => rowText(r, timezone)).join("\n");
}
