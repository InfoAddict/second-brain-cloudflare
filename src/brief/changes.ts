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
import { isHeld } from "../quarantine/tags";

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
  /** T-0102 MAJOR fix: the row's current held status, independent of `family`/`event` -- see Classified.heldNow. */
  heldNow: boolean;
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
  entry_workspace_id: string | null;
  source: string | null;
  preview: string | null;
  tags_json: string | null;
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

/** The row's current tags: `entries.tags` (live) or `entries_trash.row_json.$.tags` (trashed),
 * COALESCEd in SQL into one `tags_json` column -- null when the row is neither (purged). */
function parseTagsJson(tagsJson: string | null): string[] {
  if (!tagsJson) return [];
  try {
    const parsed = JSON.parse(tagsJson);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

interface Classified {
  id: string;
  /** entry_events.id -- this row's own event, not the entry it describes. groupCandidates threads
   * this through so undo.ts can link a version to exactly the event that produced it. */
  eventId: string;
  event: string;
  family: ChangeFamily;
  actorId: string;
  client: string | null;
  createdAt: number;
  preview: string | null;
  /** T-0102 MAJOR fix: the row's CURRENT held status (its live entries.tags, or its
   * entries_trash row_json tags once trashed) -- not the "held" event family, which only fires
   * for the moment a row was quarantined and says nothing about a later change to an already
   * (or still) held row. Preview masking keys off this, not off family. */
  heldNow: boolean;
  /** T-0102 MINOR fix (finding 7c): whether THIS reader can actually undo/release this row --
   * admin, their own personal-workspace row, or the row's own author -- not "yes" for every row
   * the "held" family's workspace-wide visibility (below) merely let them see. */
  canAct: boolean;
  reasons?: string[];
  source?: string | null;
  status?: string;
  capsuleChanged?: boolean;
}

const STATUS_VALUES = new Set(["canonical", "draft", "deprecated"]);

/** One row's classification, or null when it does not qualify for the line at all (5.8's "not listed"). */
function classify(row: RawRow, identity: Identity, cfg: Readonly<Config>): Classified | null {
  const payload = parsePayload(row.payload);
  const client = safeClient(payload.client, cfg);
  // Mirrors trash-list.ts's trashRestoreClauseFor / Q10: admin, their own personal workspace, or
  // the row's own author -- "held" being visible workspace-wide (the outer actor/author OR below)
  // is about being TOLD something was held, never a grant to act on someone else's memory.
  const canAct = identity.role === "admin"
    || row.entry_workspace_id === identity.personalWorkspaceId
    || row.author_id === identity.userId;
  const base = {
    id: row.entry_id, eventId: row.id, event: row.event, actorId: row.actor_id, client,
    createdAt: row.created_at, preview: row.preview, heldNow: isHeld(parseTagsJson(row.tags_json)), canAct,
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
        // T-0102 MINOR fix (finding 7c): "all" only if the reader can actually act on every
        // member, not "yes" for every group merely because it exists -- groupCandidates
        // re-derives the exact id list at execution time, but offering the button at all must
        // not promise something the reader cannot really do to any (or even most) of the group.
        ...(run.every(x => x.canAct) ? (family === "held" ? { canReleaseAll: true } : { canUndoAll: true }) : {}),
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
          heldNow: r.heldNow,
          ...(r.reasons ? { reasons: r.reasons } : {}),
          ...(r.source !== undefined ? { source: r.source } : {}),
          ...(r.status ? { status: r.status } : {}),
          ...(r.capsuleChanged ? { capsuleChanged: true } : {}),
          // T-0102 MINOR fix (finding 7c): real permission, not "yes" for every row the "held"
          // family's workspace-wide visibility merely let this reader see.
          ...(r.canAct ? (r.family === "held" ? { canRelease: true } : { canUndo: true }) : {}),
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
 * bounded by this constant regardless of deployment size.
 *
 * R22 (budget auditor MAJOR): a WORKSPACE filter cannot run before this cap without a join (that
 * was R22's own bug — see changeEventRows' comment), but entry_events DOES carry its own actor_id
 * natively, no join required, and every non-"held" row this reader can ever see is one where
 * actor_id already equals them (author_id-visible rows need the join too, and stay subject to
 * this cap the same as before — see changeEventRows). So the raw scan is pre-filtered by
 * `actor_id = reader OR event = 'held'` before the cap applies: a teammate's ordinary burst,
 * under a different actor_id, can no longer fill the cap's slots and crowd out this reader's own
 * changes or a workspace-wide held notice (cloud re-review MINOR, on top of 0b970baa). */
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
): Promise<{ rows: RawRow[]; rawCapped: boolean; innerCapped: boolean }> {
  const workspaces = readScopeWorkspaces(identity, { layer, teamId });
  const workspacesJson = JSON.stringify(workspaces);
  const baseFilter = `created_at > ?1 AND created_at <= ?2
       AND event IN ('held','released','updated','appended','status_changed','deleted','reverted')`;
  // A reused id's earlier life always ends with a `purged` event or a `deleted` event with
  // payload.trash false; everything at or before the latest such event belongs to the row that's
  // now gone. rowid, not created_at -- insertion order, immune to a backdated or future timestamp.
  //
  // R23 (budget auditor MAJOR): this used to be a correlated subquery inside baseFilter, so it ran
  // once per RAW row examined by all 4 capped scans (the count probe and the 3 UNION branches) --
  // ~4,000 extra rows read per brief. It now runs once per row in the outer query, after the cap
  // and the scope join have already cut that set down to at most a few hundred, and it is dropped
  // from the count probe entirely (an approximate "at least this many" count, same as before this
  // filter existed, never promised exact).
  //
  // round 8 re-review MINOR (upgrade safety): idx_entry_events_life_end's own predicate is
  // `event IN ('purged', 'deleted')`, no json_extract at all (a CREATE INDEX or an ordinary INSERT
  // must never throw on a row whose payload happens not to be valid JSON). `g.event IN ('purged',
  // 'deleted') AND (g.event = 'purged' OR json_extract(...) = 0)` is the same condition as
  // `g.event = 'purged' OR (g.event = 'deleted' AND json_extract(...) = 0)` (distributing the OR
  // over the AND), but written so its first conjunct is syntactically identical to the index's own
  // WHERE -- SQLite's partial-index matching does not reliably prove the two are equivalent from
  // the original OR/AND-nested form alone (confirmed with EXPLAIN QUERY PLAN: the original form
  // fell back to a full index scan here and a bare table scan in admin.ts).
  const lifeFilter = `e.event_rowid > COALESCE((SELECT MAX(g.rowid) FROM entry_events g WHERE g.entry_id = e.entry_id
             AND g.event IN ('purged', 'deleted') AND (g.event = 'purged' OR json_extract(g.payload, '$.trash') = 0)), 0)`;
  // R22 (budget auditor MAJOR, on top of T-0102 finding 7): the workspace scope is checked per
  // event row via a JOIN, not by matching entry_id against a subquery over the reader's WHOLE id
  // list -- the earlier `entry_id IN (SELECT id FROM entries WHERE workspace_id IN (...) UNION
  // ALL ...)` re-read every one of the reader's own entries/trash rows to build that list (twice
  // per brief: once for the count probe, once for the main query), so cost grew with the size of
  // the brain, not with RAW_EVENT_SCAN_LIMIT -- 20,158 rows at 10k memories with only 50 events in
  // the window. RAW_EVENT_SCAN_LIMIT now caps the RAW scan of entry_events itself (it carries no
  // workspace column to scope against directly), and the entries/entries_trash join that resolves
  // each of those rows' workspace runs strictly after, one PRIMARY KEY lookup per row -- cost is
  // bounded by the cap and by key lookups, never by brain size.
  //
  // Cloud re-review MINOR (on top of 0b970baa): a single unscoped cap can still be entirely filled
  // by a teammate's own ordinary burst (a different actor_id, no hold involved), crowding this
  // reader's own older changes and held notices out of the window before the join/visibility
  // filter ever sees them. Two more branches, each backed by its own index (idx_entry_events_actor,
  // idx_entry_events_held, db/init.ts) so each is a genuine index range scan -- NOT a full-table
  // scan filtered in date order, which would cost the same as no reservation at all once the
  // reader's own matches are sparse against the noise -- run alongside the original (unrestricted)
  // one and are UNIONed in. Those two categories can now never be crowded out by noise, at two
  // more flat, bounded scans: still O(RAW_EVENT_SCAN_LIMIT) each, not O(brain size) or O(noise).
  // The OTHER outer-visible category (author_id = reader: someone else's tool touched MY memory)
  // has no cheap pre-join handle -- author_id only exists on entries/entries_trash -- so it still
  // rides the unrestricted branch and remains subject to the ORIGINAL crowd-out risk this file has
  // always documented; only that narrower residual remains.
  const rawBranch = (indexedBy: string, extraFilter: string) => `
           SELECT * FROM (
             SELECT id, entry_id, event, payload, created_at, actor_id, rowid AS event_rowid
               FROM entry_events INDEXED BY ${indexedBy}
              WHERE ${baseFilter}${extraFilter}
              ORDER BY created_at ${order}
              LIMIT ${RAW_EVENT_SCAN_LIMIT}
           )`;
  // scope-checked: entry_workspace_id, COALESCEd by the join below, is filtered against the
  // reader's scope in the outer query's WHERE (json_each(?3)) -- deliberately not here, so each
  // inner branch's LIMIT bounds RAW rows examined, not rows matching that filter. event_rowid rides
  // along the same way, for lifeFilter to apply once in that same outer WHERE (R23).
  const scopedEvents = `
         SELECT e.id, e.entry_id, e.event, e.payload, e.created_at, e.actor_id, e.event_rowid,
                COALESCE(en.actor_id, t.actor_id) AS author_id,
                COALESCE(en.workspace_id, t.workspace_id) AS entry_workspace_id,
                COALESCE(en.source, json_extract(t.row_json, '$.source')) AS source,
                substr(COALESCE(en.content, t.content), 1, 160) AS preview,
                COALESCE(en.tags, json_extract(t.row_json, '$.tags')) AS tags_json,
                en.id AS live_id
         FROM (
           ${rawBranch("idx_entry_events_actor", " AND actor_id = ?4")}
           UNION
           ${rawBranch("idx_entry_events_held", " AND event = 'held'")}
           UNION
           ${rawBranch("idx_entry_events_created", "")}
         ) e
         LEFT JOIN entries en ON en.id = e.entry_id
         LEFT JOIN entries_trash t ON en.id IS NULL AND t.id = e.entry_id`;
  // Q10 (T-0102 finding 7): a "held" event is otherwise visible workspace-wide (below), but a
  // teammate's TRASHED row must still only surface to whoever could restore it -- the same rule
  // trash-list.ts's trashRestoreClauseFor applies, collapsed into one cross-workspace OR since
  // this query (unlike listTrash) is not decomposed per workspace: admin sees everything, anyone
  // else only their own personal trash or a company row they personally deleted.
  const isAdmin = identity.role === "admin";
  // Trash-only columns are coalesced away by the join above, but when live_id IS NULL the row
  // came from entries_trash, so entry_workspace_id/author_id ARE that trash row's own columns.
  const trashVisible = isAdmin ? "1=1" : "(e.entry_workspace_id = ?5 OR e.author_id = ?6)";
  const trashBindings = isAdmin ? [] : [identity.personalWorkspaceId, identity.userId];
  const [countResult, mainResult] = await env.DB.batch([
    // A cheap, bounded probe: capped at RAW_EVENT_SCAN_LIMIT + 1 so it can say "at least that
    // many raw events exist in the window" without ever reading more than that to say so. No join,
    // no workspace scope: it returns a bare count, no row content, so nothing here needs scoping
    // (scope.ts's rule is about rows reaching the response). Deliberately the unrestricted branch's
    // own filter (not the actor/held-reserved one): this only informs `rawCapped`/`truncated`, and
    // the unrestricted branch is the one that can still be capped by volume.
    // scope-exempt: count-only, no entry_id/content/tags leaves this statement.
    env.DB.prepare(
      `SELECT COUNT(*) as raw_count FROM (
         SELECT 1 FROM entry_events INDEXED BY idx_entry_events_created
         WHERE ${baseFilter} LIMIT ${RAW_EVENT_SCAN_LIMIT + 1}
       )`,
    ).bind(since, until),
    // scope-checked: inScope's COALESCE(...) IN (json_each(?3)) below, filtering the already-capped
    // and already-joined rows from scopedEvents above. lifeFilter (R23) wraps this as a separate
    // outer SELECT rather than another ANDed term in the same WHERE: SQLite does not reliably defer
    // an unindexed correlated subquery to run only after the cheap workspace/channel/actor terms
    // have already cut the row count down -- in the same WHERE it can run once per row of the
    // (still up to ~3,000-row) union, not once per row actually surviving to the LIMIT 200 output.
    env.DB.prepare(
      `SELECT * FROM (
         SELECT *, COUNT(*) OVER () AS inner_count FROM (
           SELECT e.id, e.entry_id, e.event, e.payload, e.created_at, e.actor_id,
                  e.author_id, e.entry_workspace_id, e.source, e.preview, e.tags_json, e.event_rowid
           FROM (${scopedEvents}) e
           WHERE e.entry_workspace_id IN (SELECT value FROM json_each(?3))
             AND (e.event = 'held' OR json_extract(e.payload, '$.channel') = 'mcp')
             AND (e.actor_id = ?4 OR e.author_id = ?4 OR e.event = 'held')
             AND (e.live_id IS NOT NULL OR ${trashVisible})
           ORDER BY e.created_at ${order}
           LIMIT 200
         ) e
       ) e
       WHERE ${lifeFilter}
       ORDER BY e.created_at ${order}`,
    ).bind(since, until, workspacesJson, identity.userId, ...trashBindings),
  ]);
  const rawCount = ((countResult.results as { raw_count: number }[] | undefined)?.[0]?.raw_count) ?? 0;
  const rows = (mainResult.results ?? []) as unknown as (RawRow & { inner_count: number })[];
  // round 8 re-review MINOR: inner_count is computed over the inner, pre-lifeFilter 200-row cap
  // (a window function evaluated before the outer WHERE strips old-life rows), so a surviving row
  // still carries the READ's own true size even after the filter drops some of them -- unlike
  // results.length, which only counts what's left, and would silently read "not truncated" if the
  // life filter's own noise happened to be what got cut off the true 200-row cap.
  const innerCount = rows[0]?.inner_count ?? rows.length;
  return { rows, innerCapped: innerCount === READ_LIMIT, rawCapped: rawCount > RAW_EVENT_SCAN_LIMIT };
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
  const { rows: results, rawCapped, innerCapped } = await changeEventRows(env, identity, since, now, "DESC", layer, teamId);

  const classified = results.map(row => classify(row, identity, cfg)).filter((c): c is Classified => c !== null);
  const held = classified.filter(c => c.family === "held").length;

  return {
    windowHours,
    count: classified.length,
    held,
    // Honest either way (R21 review): the read hit its own 200-row inner cap (innerCapped, round 8
    // re-review MINOR: taken from the inner, pre-lifeFilter row count, not results.length -- the
    // life filter can drop some of those 200 rows as another id's earlier life, which must not
    // read as "the window fit entirely"), or the raw pre-filter scan hit RAW_EVENT_SCAN_LIMIT
    // before it could see the whole window.
    truncated: innerCapped || rawCapped,
    items: group(classified, cfg).slice(0, OUTPUT_LIMIT),
  };
}

// ── Group membership (S3, 5.9) ──────────────────────────────────────────────

export const UNDO_GROUP_MAX = 50;
export const UNDO_GROUP_PAGE = 5;

export interface DecodedGroup { family: ChangeFamily; actorId: string; client: string | null; start: number; end: number }

// Exported so test/unit/undo-group-event-id-writers.test.ts can derive its family list from
// this one instead of keeping a second copy that could drift.
export const GROUP_FAMILIES: readonly ChangeFamily[] = ["held", "released", "canonical_edit", "capsule_changed", "status", "trash", "revert"];

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

export interface GroupCandidates {
  decoded: DecodedGroup;
  ids: string[];
  /** entry_id -> the exact set of entry_events.id this group's own read found for it (round 3
   * re-review MAJOR): what undoGroup's version walk-back matches against instead of a time window
   * or an actor/client re-check -- see classifyFromRows in src/memory/undo.ts. */
  eventIdsByEntry: Map<string, Set<string>>;
  capped: boolean;
}

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
  const classified = rows.map(row => classify(row, identity, cfg)).filter((c): c is Classified => c !== null);
  const ids: string[] = [];
  const eventIdsByEntry = new Map<string, Set<string>>();
  for (const c of classified) {
    if (c.family !== decoded.family || c.actorId !== decoded.actorId || c.client !== decoded.client) continue;
    let set = eventIdsByEntry.get(c.id);
    if (!set) { set = new Set(); eventIdsByEntry.set(c.id, set); ids.push(c.id); }
    set.add(c.eventId);
  }
  return { decoded, ids: ids.slice(0, UNDO_GROUP_MAX), eventIdsByEntry, capped: ids.length > UNDO_GROUP_MAX };
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
          // T-0102 MAJOR fix: masks on the row's CURRENT held status (heldNow), not on whether
          // THIS event's own family happens to be "held" -- a row can be held today via an
          // unrelated event (released-then-reheld, a status change on an already-held row, etc.).
          preview: row.heldNow && !revealHeld ? null : row.preview,
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
