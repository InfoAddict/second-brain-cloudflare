/**
 * As-of recall core (Track 2, T-0089.2.2; spec 14-t2-time-spec.md 5.7).
 *
 * What was actually true at a past moment T, with every correction made since applied: the text
 * and status a memory had at T (Track 1's buildChain, reused here), and any belief that was true
 * then but has since been retracted, listed underneath every actually-true result and never above
 * one. One extra D1 execution beyond a normal recall: a batch of two reads over the ids recall
 * already hydrated — recall's own candidate generation and hydration predicates are the caller's
 * job (search.ts), not this module's.
 */
import type { Env } from "../env";
import type { Identity } from "../lib/identity";
import { scopeWhereForIdRead, scopeWhereForRead } from "../lib/scope";
import { ensureTenantBootstrap } from "../lib/tenancy";
import { getStatus, type MemoryStatus } from "../memory/status";
import { buildChain, workspaceReadable, type VersionRow } from "../memory/versions";
import { currentValidityAt, EFFECTIVE_FROM } from "../memory/validity";
import { isHeld, NOT_HELD_SQL } from "../quarantine/tags";
import type { RecallMatch, RetractedBelief } from "./types";

/** Beliefs shown under/after actually-true results: at most this many, newest retraction first (spec 14 5.7 item 7). */
export const AS_OF_BELIEFS_MAX = 3;

/**
 * The as-of candidate predicate (spec 14 5.7 items 2-3): valid at T, or a deprecated belief
 * candidate created at or before T (confirmed later by enrichWithAsOf's belief batch). Built on
 * lane A's R16 helpers (src/memory/validity.ts) — EFFECTIVE_FROM and currentValidityAt(alias, "?"),
 * the same "still open" shape currentValidityAt gives every current-only reader, just handed a
 * bound placeholder instead of SQL_NOW_MS — so this predicate and "current" never drift apart.
 * The one place this SQL is spelled out: every call site in search.ts calls this rather than
 * inlining its own copy.
 */
export function asOfPredicateSql(alias = ""): string {
  const col = (name: string) => (alias ? `${alias}.${name}` : name);
  // Branch A requires NOT deprecated explicitly: a deprecated row can still have an open
  // valid_until (not every deprecation closes the window), and without this guard such a row
  // would satisfy both branches — true-at-T AND a belief candidate — at once.
  // EFFECTIVE_FROM always needs a table qualifier; the unaliased callers' FROM is literally
  // `FROM entries`, so "entries." is valid there too even though col() itself omits it.
  return `((${col("tags")} NOT LIKE '%"status:deprecated"%' AND ${EFFECTIVE_FROM(alias || "entries")} <= ? AND ${currentValidityAt(alias, "?")}) OR (${col("tags")} LIKE '%"status:deprecated"%' AND ${col("created_at")} <= ?))`;
}

/** Three bindings for asOfPredicateSql's three placeholders, all the same T. */
export function asOfPredicateBindings(t: number): [number, number, number] {
  return [t, t, t];
}

export interface AsOfVersionRow extends VersionRow {
  entry_id: string;
}

interface BeliefRow {
  id: string;
  content: string;
  created_at: number;
  tags: string;
  attached_to: string | null;
  retracted_at: number | null;
}

function parseTagsSafe(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/** A `reason: "status"` version whose meta records a hold (5.4): the same structural check
 * undo.ts's/history-view.ts's own `isHoldVersion` make (duplicated here rather than imported --
 * lane ownership, and each caller's own Pick<> keeps this from depending on the others' imports). */
function isHoldVersion(v: Pick<AsOfVersionRow, "reason" | "meta">): boolean {
  if (v.reason !== "status") return false;
  try { return !!(JSON.parse(v.meta || "{}") as Record<string, unknown>).hold; } catch { return false; }
}

/**
 * Cross-vendor re-review MAJOR (T-0102, on top of 0b970baa): a hold-transition version's OWN tags
 * are the pre-hold (unheld) state -- a hold never changes content, only tags -- so isHeld(tags)
 * alone misses exactly the version whose reconstructed content IS the sensitive text.
 */
function textHeldAt(v: Pick<AsOfVersionRow, "reason" | "meta" | "tags">): boolean {
  return isHeld(parseTagsSafe(v.tags)) || isHoldVersion(v);
}

export interface AtT { content: string; tags: string[]; changedAt: number | null; statusAt: MemoryStatus | null; pruned: boolean; textHidden: boolean; heldAtT: boolean }

/**
 * `text`/`tags` a match had at T, from its full stored version chain (buildChain, Track 1): the
 * newest contiguous run whose `created_at > T` are the changes made after T (item 6), so the text
 * just before the oldest of them is the text at T. `pruned` marks a chain that ran out of stored
 * history (VERSION_KEEP eviction) before crossing T; `textHidden` marks one D-SH cut first.
 *
 * `heldAtT` (Codex cross-vendor review MAJOR, T-0102): the current row may be releasable and
 * unheld today, but the text this rebuilds is whatever it was at T -- which can be a version that
 * WAS held then (update(X), held; edited to Y while held; released -- only Y was ever approved).
 * Nothing downstream re-checks isHeld on version-rebuilt tags, and synthesize defaults to true, so
 * an unguarded `content` here would put unreviewed historical text into a model prompt and the
 * caller's own reply. `content` is redacted to "" whenever the resolved tags were held: the one
 * choke point every as-of output (matches, synthesis, the MCP/REST reply) flows through.
 */
export function resolveAtT(match: RecallMatch, rowsNewestFirst: AsOfVersionRow[], canRead: (ws: string) => boolean, asOf: number): AtT {
  const chain = buildChain(match.content, rowsNewestFirst, canRead);
  let cut = 0;
  while (cut < chain.rows.length && chain.rows[cut].created_at > asOf) cut++;
  const retired = chain.rows.slice(0, cut);
  const crossedT = cut < chain.rows.length; // a kept row exists with created_at <= T
  if (!retired.length) {
    const textHidden = chain.truncatedAt === "unreadable" && chain.rows.length === 0;
    // match.tags is the CURRENT row's tags, already filtered NOT_HELD_SQL by recall's own
    // candidate SQL -- no version was rebuilt here, so there is nothing to re-check.
    return { content: match.content, tags: match.tags, changedAt: null, statusAt: getStatus(match.tags), pruned: false, textHidden, heldAtT: false };
  }
  const oldestRetired = retired[retired.length - 1];
  const tags = parseTagsSafe(oldestRetired.tags);
  const historicalText = chain.text(oldestRetired.seq);
  // Cloud re-review NIT (T-0102, on top of 0b970baa): a hold-transition version's text, released
  // with no edit since, reconstructs to exactly the row's own CURRENT content -- match.content,
  // already past the outer candidate SQL's NOT_HELD_SQL filter, so already visible, reviewed, and
  // searchable today. Hiding it here adds no protection (an ordinary, non-as-of recall of the same
  // row shows the same text plainly); it only confuses with a blank where the text is not a secret.
  const heldAtT = textHeldAt(oldestRetired) && historicalText !== match.content;
  return {
    content: heldAtT ? "" : historicalText,
    tags,
    changedAt: oldestRetired.created_at,
    statusAt: getStatus(tags),
    heldAtT,
    pruned: !crossedT && chain.truncatedAt === "none" && oldestRetired.seq > 1,
    textHidden: !crossedT && chain.truncatedAt === "unreadable",
  };
}

export interface AsOfResult {
  /** `trueMatches`, in the same order, each augmented with its text/status/markers at T. */
  trueMatches: RecallMatch[];
  /** At most AS_OF_BELIEFS_MAX belief entries, newest `retractedAt` first — never ranked above a true match. */
  beliefMatches: RecallMatch[];
}

/**
 * The one extra D1 execution (item 5): a batch of two reads over `trueMatches` (recall's own
 * validity-at-T hydration) and `standaloneBeliefs` (deprecated rows that same hydration already
 * let through because the keyword arm found them, per item 3's second predicate branch). Attached
 * beliefs — a live `supersedes` edge from a deprecated row onto one of `trueMatches` — are
 * discovered fresh here, whether or not the candidate pipeline ever saw them.
 */
export async function enrichWithAsOf(
  trueMatches: RecallMatch[],
  standaloneBeliefs: RecallMatch[],
  asOf: number,
  env: Env,
  identity: Identity | undefined,
  opts: { workspaceFilter?: "personal" | "company"; teamId?: string } = {},
): Promise<AsOfResult> {
  if (!trueMatches.length && !standaloneBeliefs.length) return { trueMatches, beliefMatches: [] };
  const trueIds = trueMatches.map(m => m.id);
  const deprecatedIds = standaloneBeliefs.map(m => m.id);

  // R18 (budget audit): scopeWhereForIdRead's unary `+` blocks SQLite from using it to drive the
  // plan off a workspace index — both branches must be reached from the edges/id join, not a
  // workspace-wide scan, the same reasoning as R16's supersededBySql fix.
  const sScope = identity ? scopeWhereForIdRead(scopeWhereForRead(identity, { layer: opts.workspaceFilter, teamId: opts.teamId }, "s.workspace_id")) : null;
  const eScope = identity ? scopeWhereForIdRead(scopeWhereForRead(identity, { layer: opts.workspaceFilter, teamId: opts.teamId }, "e.workspace_id")) : null;
  // scope-checked: both branches ARE scoped — sScope/eScope apply the caller's clause to s/e in the ternaries below, invisible to the lexer; the entry_versions subqueries and the edges join are pinned to s.id/e.id, already-scoped ids the caller may read
  // validity: as-of: a belief is, by definition, a deprecated row — never a current-facts answer (5.7 item 5)
  // KNOWN GAP (review NIT, documented in 21-t2-lane-a-notes.md, not fixed here): retracted_at is
  // the newest SURVIVING entry_versions row whose prior tags were not deprecated. Once VERSION_KEEP
  // evicts that row, retracted_at silently reports a later (or absent) moment than the real one.
  const beliefsSql = `
    SELECT s.id, s.content, s.created_at, s.tags, g.target_id AS attached_to,
           (SELECT MAX(v.created_at) FROM entry_versions v WHERE v.entry_id = s.id AND v.tags NOT LIKE '%"status:deprecated"%') AS retracted_at
      FROM edges g CROSS JOIN entries s ON s.id = g.source_id
     WHERE g.type = 'supersedes' AND g.target_id IN (SELECT value FROM json_each(?))
       AND s.tags LIKE '%"status:deprecated"%' AND s.created_at <= ? AND ${NOT_HELD_SQL}${sScope ? ` AND ${sScope.clause}` : ""}
    UNION ALL
    SELECT e.id, e.content, e.created_at, e.tags, NULL,
           (SELECT MAX(v.created_at) FROM entry_versions v WHERE v.entry_id = e.id AND v.tags NOT LIKE '%"status:deprecated"%')
      FROM entries e
     WHERE e.id IN (SELECT value FROM json_each(?))${eScope ? ` AND ${eScope.clause}` : ""}`;

  const versionsStmt = env.DB.prepare(
    // scope-checked: entry_id comes from trueMatches, recall's own already-scoped hydration; D-SH (workspaceReadable) gates every row below, not a workspace clause here — the same shape loadHistory uses
    `SELECT entry_id, seq, workspace_id, content, prior_length, prior_length_utf16, tags, state, actor_id, channel, reason, meta, valid_from, created_at
       FROM entry_versions WHERE entry_id IN (SELECT value FROM json_each(?))
      ORDER BY entry_id, seq DESC`,
  ).bind(JSON.stringify(trueIds));
  const beliefsStmt = env.DB.prepare(beliefsSql).bind(
    JSON.stringify(trueIds), asOf, ...(sScope?.bindings ?? []),
    JSON.stringify(deprecatedIds), ...(eScope?.bindings ?? []),
  );
  const [versionsResult, beliefsResult] = await env.DB.batch([versionsStmt, beliefsStmt]);
  const versionRows = (versionsResult.results ?? []) as unknown as AsOfVersionRow[];
  const beliefRows = (beliefsResult.results ?? []) as unknown as BeliefRow[];

  const versionsByEntry = new Map<string, AsOfVersionRow[]>();
  for (const row of versionRows) {
    const list = versionsByEntry.get(row.entry_id);
    if (list) list.push(row); else versionsByEntry.set(row.entry_id, [row]);
  }
  const ownerUserId = identity && versionRows.some(r => r.workspace_id === "")
    ? (await ensureTenantBootstrap(env)).ownerUserId
    : undefined;
  const canRead = (ws: string) => workspaceReadable(identity, ws, ownerUserId);

  const enrichedTrue = trueMatches.map((match): RecallMatch => {
    const resolved = resolveAtT(match, versionsByEntry.get(match.id) ?? [], canRead, asOf);
    return {
      ...match,
      content: resolved.content,
      tags: resolved.tags,
      asOfTextChangedAt: resolved.changedAt,
      statusAt: resolved.statusAt,
      recordedAfterAsOf: match.createdAt > asOf,
      asOfPruned: resolved.pruned,
      asOfTextHidden: resolved.textHidden,
      asOfHeld: resolved.heldAtT,
      retractedBelief: null,
    };
  });

  const byId = new Map<string, BeliefRow>();
  for (const row of beliefRows) {
    if (row.retracted_at === null || row.retracted_at <= asOf) continue; // never believed, or still believed at T (not retracted yet)
    const existing = byId.get(row.id);
    if (!existing || (existing.attached_to === null && row.attached_to !== null)) byId.set(row.id, row);
  }
  const beliefs = [...byId.values()].sort((a, b) => (b.retracted_at as number) - (a.retracted_at as number));

  const trueIdSet = new Set(enrichedTrue.map(m => m.id));
  const beliefMatches: RecallMatch[] = [];
  for (const belief of beliefs) {
    if (beliefMatches.length >= AS_OF_BELIEFS_MAX) break;
    // Only the belief entry itself carries retractedBelief; a renderer pairs it with its true
    // result by scanning beliefMatches for attachedTo, rather than this mirroring onto that match.
    const attachedTo = belief.attached_to && trueIdSet.has(belief.attached_to) ? belief.attached_to : null;
    const retractedBelief: RetractedBelief = { retractedAt: belief.retracted_at as number, attachedTo };
    const tags = parseTagsSafe(belief.tags);
    const source = standaloneBeliefs.find(m => m.id === belief.id);
    beliefMatches.push({
      ...(source ?? {
        id: belief.id, content: belief.content, score: 0, createdAt: belief.created_at, updatedAt: belief.created_at,
        tags, source: "", isUpdate: false, hop: 0,
        validFrom: belief.created_at, validFromStated: false, validUntil: belief.retracted_at, validityState: "wrong", supersededBy: null, retractedSource: false,
      }),
      content: belief.content,
      tags,
      retractedBelief,
    });
  }

  return { trueMatches: enrichedTrue, beliefMatches };
}
