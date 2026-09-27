import type { Env } from "../env";
import type { Identity } from "../lib/identity";
import { ensureTenantBootstrap } from "../lib/tenancy";
import { getReadableEntry } from "../lib/entry-access";
import type { Config } from "../config";
import { lookupActorLabels, resolveActorLabel } from "../lib/actors";
import { getStatus } from "./status";
import {
  canRevert, loadHistory, getVersionsSince, type VersionReason,
} from "./versions";
import { readEntryTimeline } from "./history";

/** BE-7/BE-11 (T-0101.1.1, T-0101.3.1): contract 4.1's unified history for one entry — the
 * dashboard's `GET /entry` and chat's `history` both read through this, so the two surfaces cannot
 * disagree about which changes are pruned, which events are cut, or whose name to show for it. */

const PREVIEW_MAX_CHARS = 160;

/** First `max` characters of `text`, whitespace collapsed to single spaces, trimmed. */
function previewOf(text: string, max: number): string {
  return text.trim().replace(/\s+/g, " ").slice(0, max);
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/** An event whose own type is superseded by a version once one exists to describe it (the merge
 * rule, contract 4.1): shown only when it predates versions:since. Every other event always shows. */
const EVENTS_SUPERSEDED_BY_VERSIONS = new Set(["updated", "appended", "status_changed", "reverted"]);

export interface HistoryChangeItem {
  kind: "change";
  seq: number;
  at: number;
  reason: VersionReason;
  channel: string;
  client: string | null;
  actor_name: string;
  before_preview: string;
  before_status: string | null;
  can_undo: boolean;
  can_restore: boolean;
}

export interface HistoryEventItem {
  kind: "event";
  event: string;
  at: number;
  channel: string;
  client: string | null;
  actor_name: string;
}

export type EntryHistoryItem = HistoryChangeItem | HistoryEventItem;

export interface EntryHistoryFooter {
  /** versions:since, when this memory predates it; else null. */
  not_recorded_before: number | null;
  /** The oldest kept version has seq > 1 and the chain reached VERSION_KEEP rows. */
  pruned: boolean;
  kept: number;
  /** The author's display name, when D-SH cut the version chain or the event timeline for this
   * reader; else null. Never set for the author themselves, since neither walk cuts for them. */
  shared_cut_by: string | null;
}

export interface EntryHistoryResult {
  items: EntryHistoryItem[];
  footer: EntryHistoryFooter;
}

export interface EntryHistoryRow {
  id: string;
  workspace_id: string;
  actor_id: string;
  content: string;
  created_at: number;
}

/**
 * Contract 4.1: one entry's changes and events, merged into a single newest-first list. Cost is
 * loadHistory's one entry_versions read, readEntryTimeline's one entry_events read (both already
 * paid by today's callers), and one batched `users` read for every distinct actor across both —
 * reconstruction (buildChain's own text(seq)) runs only for the versions actually returned.
 */
export async function buildEntryHistory(
  env: Env, identity: Identity, row: EntryHistoryRow, config: Config,
): Promise<EntryHistoryResult> {
  const [chain, timelineResult, versionsSince] = await Promise.all([
    loadHistory(env, identity, { id: row.id, content: row.content }, config.VERSION_KEEP),
    readEntryTimeline(env, row.id, identity, row.actor_id, undefined, false, row.workspace_id),
    getVersionsSince(env),
  ]);

  const ownerUserId = chain.rows.some(r => r.workspace_id === "")
    ? (await ensureTenantBootstrap(env)).ownerUserId
    : undefined;
  const visibleSeqs = chain.rows.map(r => r.seq);
  const newestSeq = chain.rows[0]?.seq;
  const labelMap = await lookupActorLabels(env, [row.actor_id, ...chain.rows.map(r => r.actor_id)]);

  const changeItems: HistoryChangeItem[] = chain.rows.map(r => {
    const meta = parseJsonObject(r.meta);
    const verdict = canRevert(identity, { workspace_id: row.workspace_id, actor_id: row.actor_id }, r, newestSeq, visibleSeqs, { ownerUserId });
    const isNewest = r.seq === newestSeq;
    return {
      kind: "change",
      seq: r.seq,
      at: r.created_at,
      reason: r.reason,
      channel: r.channel,
      client: typeof meta.client === "string" ? meta.client : null,
      actor_name: resolveActorLabel(r.actor_id, labelMap, { viewerId: identity.userId }),
      before_preview: previewOf(chain.text(r.seq), PREVIEW_MAX_CHARS),
      before_status: getStatus(parseTags(r.tags)),
      can_undo: isNewest && verdict.ok,
      can_restore: !isNewest && verdict.ok,
    };
  });

  const eventItems: HistoryEventItem[] = timelineResult.timeline
    .filter(e => !EVENTS_SUPERSEDED_BY_VERSIONS.has(e.event) || e.created_at < versionsSince)
    .map(e => ({
      kind: "event",
      event: e.event,
      at: e.created_at,
      channel: typeof e.payload.channel === "string" ? e.payload.channel : "",
      client: typeof e.payload.client === "string" ? e.payload.client : null,
      actor_name: e.actor_name,
    }));

  const items: EntryHistoryItem[] = [...changeItems, ...eventItems].sort((a, b) => b.at - a.at);

  const oldestKeptSeq = chain.rows[chain.rows.length - 1]?.seq;
  const pruned = chain.rows.length === config.VERSION_KEEP && oldestKeptSeq !== undefined && oldestKeptSeq > 1 && chain.truncatedAt === "none";
  const sharedCutBy = chain.truncatedAt === "unreadable" || timelineResult.cut
    ? resolveActorLabel(row.actor_id, labelMap, { viewerId: identity.userId })
    : null;

  return {
    items,
    footer: {
      not_recorded_before: row.created_at < versionsSince ? versionsSince : null,
      pruned,
      kept: config.VERSION_KEEP,
      shared_cut_by: sharedCutBy,
    },
  };
}

export type EntryVersionResult =
  | {
      ok: true;
      id: string;
      seq: number;
      content: string;
      tags: string[];
      status: string | null;
      at: number;
      reason: VersionReason;
      channel: string;
      client: string | null;
      actor_name: string;
    }
  | {
      ok: false;
      /** "pruned": seq once existed but sits below the oldest kept row, and the chain was not cut
       * by D-SH. "not_visible": D-SH cut the chain before reaching seq, or the entry itself is
       * unreadable — deliberately one reason, not two, so a caller can never tell "hidden from you"
       * apart from "doesn't exist" (the same neutrality the rest of versions.ts already keeps).
       * "no_version": seq was never recorded at all. */
      reason: "pruned" | "not_visible" | "no_version";
    };

/**
 * Contract 4.2 (BE-8, T-0101.1.1/T-0101.3.2): the full text, tags and status one visible version
 * retired, for `GET /entry/version` and MCP `get(id, version)`. `content` is the text the entry
 * had BEFORE change `seq` — the same `text(seq)` buildEntryHistory previews, given here in full.
 * Cost: one entries read (authorize + scope), one entry_versions read (loadHistory), and one
 * single-row `users` read for the version's own actor — reconstruction runs only for this one seq.
 */
export async function readEntryVersion(
  env: Env, identity: Identity, entryId: string, seq: number, authorizedWorkspaceId: string, config: Config,
): Promise<EntryVersionResult> {
  const row = await getReadableEntry(env, identity, entryId, "id, workspace_id, actor_id, content");
  if (!row || row.workspace_id !== authorizedWorkspaceId) return { ok: false, reason: "not_visible" };

  const chain = await loadHistory(env, identity, { id: row.id, content: row.content ?? "" }, config.VERSION_KEEP);
  const target = chain.rows.find(r => r.seq === seq);
  if (!target) {
    if (chain.truncatedAt === "unreadable") return { ok: false, reason: "not_visible" };
    const oldestVisibleSeq = chain.rows[chain.rows.length - 1]?.seq;
    if (oldestVisibleSeq !== undefined && seq > 0 && seq < oldestVisibleSeq) return { ok: false, reason: "pruned" };
    return { ok: false, reason: "no_version" };
  }

  const labelMap = await lookupActorLabels(env, [target.actor_id]);
  const meta = parseJsonObject(target.meta);
  const tags = parseTags(target.tags);
  return {
    ok: true,
    id: row.id,
    seq: target.seq,
    content: chain.text(target.seq),
    tags,
    status: getStatus(tags),
    at: target.created_at,
    reason: target.reason,
    channel: target.channel,
    client: typeof meta.client === "string" ? meta.client : null,
    actor_name: resolveActorLabel(target.actor_id, labelMap, { viewerId: identity.userId }),
  };
}
