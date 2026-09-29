import type { Env } from "../env";
import { D1_MAX_BOUND_PARAMS } from "../constants";
import { edgeEndpointsReadableSql, isSymmetric, isValidEdgeType } from "../graph/edges";
import type { EdgeProvenance } from "../graph/types";
import { PROVENANCE_VALUES } from "../graph/types";
import { OWNER_WRITE_CONTEXT, type WriteContext } from "../lib/scope";
import type { ChangeContext } from "../lib/audit";
// MAX_ENTRY_ID_BYTES: the one bound on a caller-chosen entry id, applied through boundedEntryId.
import { boundedEntryId } from "../vectorize/ids";
import { parseImportedProject, type ImportedProject } from "../projects/registry";
import { isOverContentLimit } from "../lib/content-size";
import { resolveConfig, type Config } from "../config";
import { standingTouched } from "../standing/cache";
import { normalizeTagList, stripNewReservedTags } from "../tags/system";
import { heldReason, type HoldReason } from "../quarantine/tags";
import { scoreWrite, type SignalHit } from "../quarantine/score";
import { holdDecision, heldTagsFor, holdStatements } from "../quarantine/hold";
import { pruneStatement, snapshotStatement } from "../memory/versions";

/**
 * Default page size: array positions examined per call, inserts and skips alike.
 * Sized so a worst-case page (one existence lookup + one insert batch, then the
 * same again for edges) stays well inside this codebase's self-imposed D1
 * budget of ~50 calls per invocation (the platform's real ceiling is 1,000;
 * this stays tight for cost and 10 ms-CPU reasons), with room for the
 * schema-init probe on a cold isolate.
 */
export const IMPORT_DEFAULT_LIMIT = 40;
export const IMPORT_MAX_LIMIT = 1000;
/** D1 batch chunk size for inserts. */
export const IMPORT_D1_BATCH_SIZE = 50;
/** Edge endpoint lookups bind each id twice (source IN + target IN). */
export const EDGE_ENDPOINT_QUERY_BATCH = Math.floor(D1_MAX_BOUND_PARAMS / 2);

// Ids are unique across entries and entries_trash (T-0089.1.1): the pre-read skips ids it saw, and
// an id that turns up in either table after that read gets a fresh one here, checked in this same
// statement, so an import never lands on top of a live or trashed row. RETURNING says which id won.
// versioning: exempt: creation — an imported row has no prior state to keep
// scope-exempt: by-id existence probes across every workspace: an id is unique deployment-wide
const ENTRY_INSERT_SQL_TEMPLATE =
  `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, recall_count, importance_score, contradiction_wins, contradiction_losses, workspace_id, actor_id, valid_from, valid_until)
   SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM entries WHERE id = ?1) AND NOT EXISTS (SELECT 1 FROM entries_trash WHERE id = ?1) THEN ?1 ELSE lower(hex(randomblob(16))) END,
          ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15
   RETURNING id`;

function parseInsertColumns(sql: string): readonly string[] {
  const match = sql.match(/INSERT INTO entries \(([^)]+)\)/i);
  if (!match) throw new Error("INSERT INTO entries missing column list");
  return match[1].split(",").map(c => c.trim());
}

export const ENTRY_INSERT_COLUMNS = parseInsertColumns(ENTRY_INSERT_SQL_TEMPLATE);
export const ENTRY_INSERT_SQL = ENTRY_INSERT_SQL_TEMPLATE;

export type ImportEntryStatus = "imported" | "skipped" | "failed";
export type ImportEdgeStatus = "imported" | "skipped" | "failed";

export interface ImportEntryResult {
  id: string;
  status: ImportEntryStatus;
  reason?: string;
  detail?: string;
  /** Set when the export's id was taken by the time of the insert: the row was imported as `id`. */
  original_id?: string;
}

export interface ImportEdgeResult {
  source_id: string;
  target_id: string;
  type: string;
  status: ImportEdgeStatus;
  reason?: string;
  detail?: string;
}

export interface ImportProjectResult {
  project_id: string;
  status: "imported" | "skipped" | "failed";
  reason?: string;
  detail?: string;
}

export type ImportResultItem = ImportEntryResult | ImportEdgeResult | ImportProjectResult;

export interface ExportEntry {
  id: string;
  content: string;
  tags?: string[];
  source?: string;
  created_at?: number;
  updated_at?: number;
  recall_count?: number;
  importance_score?: number;
  contradiction_wins?: number;
  contradiction_losses?: number;
  /** Track 2 (T-0089.2.1): absent in exports taken before validity windows; restored as NULL. */
  valid_from?: number | null;
  valid_until?: number | null;
}

export interface ExportEdge {
  source_id: string;
  target_id: string;
  type?: string;
  weight?: number;
  provenance?: string;
  created_at?: number;
}

export interface ExportProject {
  id: string;
  name: string;
  description?: string;
  aliases?: string[];
  status?: string;
  created_at?: number;
  updated_at?: number | null;
}

export interface ExportPayload {
  version?: number;
  entries: ExportEntry[];
  edges?: ExportEdge[];
  /** Absent in exports taken before projects existed (version 2). */
  projects?: ExportProject[];
}

export interface ImportOptions {
  /** Page size — how many array positions of `entries` (then `edges`) one call examines. */
  limit?: number;
  /** Index into `entries` where this call's page starts. */
  offset?: number;
  /** Index into `edges` where this call's page starts. */
  edgeOffset?: number;
  /** Index into `projects` where this call's page starts. */
  projectOffset?: number;
  /**
   * Whose workspace/actor the imported rows and edges are stamped with. Defaults
   * to OWNER_WRITE_CONTEXT ('', '') so existing unit fixtures compile — routes
   * that have a real Identity must pass one resolved at the edge.
   */
  writeCtx?: WriteContext;
  /** Present, a standing:active row landing on this page invalidates the importer's own workspace cache (spec 15 2.6). */
  ctx?: ExecutionContext;
}

export interface ImportSummary {
  ok: true;
  imported: number;
  skipped: number;
  /** Of `skipped`, ids in the importer's own trash: restore them instead of importing over them. */
  skipped_in_trash: number;
  /** Rahil's decision (18-copy-deck.md 6.8): entries skipped for being over the 128 KB cap, a
   * subset of `skipped` broken out so the dashboard's "{n} memory was too long to import"
   * summary line has its own clear count. */
  skipped_too_large: number;
  failed: number;
  edges_imported: number;
  edges_skipped: number;
  edges_failed: number;
  projects_imported: number;
  projects_skipped: number;
  projects_failed: number;
  remaining_entries: number;
  remaining_edges: number;
  remaining_projects: number;
  /** Pass back as ?offset= to continue. Equals entries.length when entries are done. */
  next_offset: number;
  /** Pass back as ?edge_offset= to continue. Advances only once entries are done. */
  next_edge_offset: number;
  /** Pass back as ?project_offset= to continue. Advances only once entries are done. */
  next_project_offset: number;
  results: ImportResultItem[];
  vectorize_hint: string;
}

interface PendingEdge {
  source_id: string;
  target_id: string;
  type: string;
  weight: number;
  provenance: EdgeProvenance;
  created_at: number;
}

const DEFAULT_EDGE_WEIGHT = 0.5;

interface PendingInsert {
  id: string;
  /** The export's own id, when it was over MAX_ENTRY_ID_BYTES and the row takes a minted one instead. */
  originalId?: string;
  content: string;
  tags: string[];
  source: string;
  created_at: number;
  /** Validated payload value, defaulted to created_at — camelCase per the in-memory convention (see recall's updatedAt). */
  updatedAt: number;
  recall_count: number;
  importance_score: number;
  contradiction_wins: number;
  contradiction_losses: number;
  valid_from: number | null;
  valid_until: number | null;
  /** The export's own row was held under one of the five recognized reasons, before
   * stripNewReservedTags removed the quarantine: tag along with every other reserved one
   * (Codex review, T-0102 B1): a real hold must not silently become an ordinary row on import. */
  originalHoldReason: HoldReason | null;
  /** Set by importHoldPlan once content and tags are final; null for a row that imports ordinary. */
  holdPlan?: ImportHoldPlan | null;
}

function isValidProvenance(p: string): p is EdgeProvenance {
  return (PROVENANCE_VALUES as readonly string[]).includes(p);
}

export function isImportRecordObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseTags(
  tags: unknown,
): { ok: true; tags: string[] } | { ok: false; reason: "invalid_tag" } {
  if (tags === undefined || tags === null) return { ok: true, tags: [] };
  if (!Array.isArray(tags)) return { ok: false, reason: "invalid_tag" };
  if (!tags.every(t => typeof t === "string")) return { ok: false, reason: "invalid_tag" };
  // Codex review class B (T-0089.4.2): trimmed here, at the one place an import's tags first
  // become this row's stored tags — a leading/trailing space around a quarantine: tag would
  // otherwise still read as held in JS (isHeld trims) but miss the SQL LIKE filters that keep a
  // held row out of recall and re-indexing (NOT_HELD_SQL, INDEXABLE_SQL match the literal text).
  // Codex recheck (T-0089.4.2): an import is a caller-supplied tag path like any other -- the
  // same stripNewReservedTags guard captureEntry and updateEntryContent already apply, so an
  // import can no longer forge quarantine:*, edited-canonical:* or a Track 7 tag onto a row.
  return { ok: true, tags: stripNewReservedTags(normalizeTagList(tags)).kept };
}

export function normalizedEdgeKey(sourceId: string, targetId: string, type: string): string {
  let source = sourceId;
  let target = targetId;
  if (isValidEdgeType(type) && isSymmetric(type) && source > target) {
    [source, target] = [target, source];
  }
  return `${source}\0${target}\0${type}`;
}

export function parseRequiredString(
  value: unknown,
  missingReason: string,
  invalidReason: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  if (value === undefined || value === null || value === "") {
    return { ok: false, reason: missingReason };
  }
  if (typeof value !== "string") {
    return { ok: false, reason: invalidReason };
  }
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, reason: missingReason };
  return { ok: true, value: trimmed };
}

export function formatDbError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}

export function parseImportBody(
  body: unknown,
): { ok: true; payload: ExportPayload } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be an object" };
  const o = body as Record<string, unknown>;
  // 3 added projects; 2 (no projects) restores as before.
  if (o.version !== undefined && o.version !== 2 && o.version !== 3) return { ok: false, error: "version must be 2 or 3" };
  if (!Array.isArray(o.entries)) return { ok: false, error: "entries must be an array" };
  if (o.projects !== undefined && !Array.isArray(o.projects)) return { ok: false, error: "projects must be an array" };
  return {
    ok: true,
    payload: {
      version: o.version as number | undefined,
      entries: o.entries as ExportEntry[],
      edges: o.edges as ExportEdge[] | undefined,
      projects: o.projects as ExportProject[] | undefined,
    },
  };
}

export function parseImportOffset(raw: string | null): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export function parseImportLimit(raw: string | null): number {
  if (!raw) return IMPORT_DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return IMPORT_DEFAULT_LIMIT;
  return Math.min(n, IMPORT_MAX_LIMIT);
}

/** Ids already present, split into live entries and trashed ones (a trashed id is restored, never overwritten). */
async function loadExistingIds(env: Env, ids: string[], withTrash = true): Promise<{ live: Set<string>; trashed: Map<string, string> }> {
  const live = new Set<string>();
  /** id -> the trash row's workspace, so a skip only names the trash for the importer's own rows. */
  const trashed = new Map<string, string>();
  for (let i = 0; i < ids.length; i += D1_MAX_BOUND_PARAMS) {
    const batch = ids.slice(i, i + D1_MAX_BOUND_PARAMS);
    const placeholders = batch.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      // scope-exempt: by-id: primary-key existence check for dedupe; a collision is skipped, never read
      `SELECT id FROM entries WHERE id IN (${placeholders})`,
    ).bind(...batch).all() as { results: { id: string }[] };
    for (const row of results) live.add(row.id);
    if (!withTrash) continue;
    const { results: inTrash } = await env.DB.prepare(
      // scope-exempt: by-id: primary-key existence check for dedupe; a trashed id is skipped, never read
      `SELECT id, workspace_id FROM entries_trash WHERE id IN (${placeholders})`,
    ).bind(...batch).all() as { results: { id: string; workspace_id: string }[] };
    for (const row of inTrash) trashed.set(row.id, row.workspace_id);
  }
  return { live, trashed };
}

/** Versions left behind by an earlier life of an id are dropped in the same batch that inserts it,
 * unless the id is live or trashed now (then the insert takes a fresh id and this history is theirs). */
function orphanVersionsDelete(env: Env, ids: string[]) {
  return env.DB.prepare(
    // scope-exempt: by-id: history of ids this batch inserts fresh; an imported row starts with none
    `DELETE FROM entry_versions WHERE entry_id IN (SELECT value FROM json_each(?1))
       AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.id = entry_versions.entry_id)
       AND NOT EXISTS (SELECT 1 FROM entries_trash t WHERE t.id = entry_versions.entry_id)`,
  ).bind(JSON.stringify(ids));
}

/** Codex review, T-0102 B3 (MINOR), then director follow-up: the ids among `ids` that carry ANY
 * entry_events history, whatever became of the row they belonged to -- entry_events is a
 * permanent audit trail (unlike entry_versions, which a purge itself deletes), so a purged row's
 * events outlive it forever. Deleting them to make room for a reused id (the original B3 fix)
 * destroyed that permanent record; keeping them while reusing the id (the bug B3 set out to fix
 * in the first place) let the new row inherit events it never earned. Neither is right: an id
 * with any event history at all is never reused for a NEW row -- see the caller, which mints a
 * fresh id instead of proceeding to insert under one of these. */
async function loadEventHistoryIds(env: Env, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += D1_MAX_BOUND_PARAMS) {
    const batch = ids.slice(i, i + D1_MAX_BOUND_PARAMS);
    const { results } = await env.DB.prepare(
      // scope-exempt: by-id: existence check on the audit trail of ids this batch might insert fresh
      `SELECT DISTINCT entry_id FROM entry_events WHERE entry_id IN (${batch.map(() => "?").join(", ")})`,
    ).bind(...batch).all() as { results: { entry_id: string }[] };
    for (const row of results) found.add(row.entry_id);
  }
  return found;
}

/** The id the insert actually wrote (RETURNING); a fresh one means the export's id was taken. */
function importedResult(row: PendingInsert, res: { results?: unknown[] } | undefined): ImportEntryResult {
  const id = (res?.results?.[0] as { id?: string } | undefined)?.id ?? row.id;
  const original = row.originalId ?? (id === row.id ? undefined : row.id);
  return original === undefined ? { id, status: "imported" } : { id, status: "imported", original_id: original };
}

async function loadExistingEdgeKeys(env: Env, endpoints: string[]): Promise<Set<string>> {
  const keys = new Set<string>();
  if (!endpoints.length) return keys;
  for (let i = 0; i < endpoints.length; i += EDGE_ENDPOINT_QUERY_BATCH) {
    const batch = endpoints.slice(i, i + EDGE_ENDPOINT_QUERY_BATCH);
    const placeholders = batch.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      // scope-exempt: by-id: edge-key existence check for dedupe; endpoints are not read
      `SELECT source_id, target_id, type FROM edges WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
    ).bind(...batch, ...batch).all() as {
      results: { source_id: string; target_id: string; type: string }[];
    };
    for (const row of results) keys.add(normalizedEdgeKey(row.source_id, row.target_id, row.type));
  }
  return keys;
}

export function parseEdgeWeight(
  weight: unknown,
): { ok: true; value: number } | { ok: false; reason: "invalid_weight" } {
  if (weight === undefined || weight === null) return { ok: true, value: DEFAULT_EDGE_WEIGHT };
  if (typeof weight !== "number" || !Number.isFinite(weight)) return { ok: false, reason: "invalid_weight" };
  return { ok: true, value: Math.max(0, Math.min(1, weight)) };
}

type NumericFieldReason =
  | "invalid_recall_count"
  | "invalid_importance_score"
  | "invalid_contradiction_wins"
  | "invalid_contradiction_losses";

export function parseOptionalNumber(
  value: unknown,
  invalidReason: NumericFieldReason,
): { ok: true; value: number } | { ok: false; reason: NumericFieldReason } {
  if (value === undefined || value === null) return { ok: true, value: 0 };
  if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, reason: invalidReason };
  return { ok: true, value };
}

export function parseCreatedAt(
  value: unknown,
): { ok: true; value: number } | { ok: false; reason: "invalid_created_at" } {
  if (value === undefined || value === null) return { ok: true, value: Date.now() };
  if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, reason: "invalid_created_at" };
  return { ok: true, value };
}

function bindInsert(env: Env, row: PendingInsert, writeCtx: WriteContext) {
  return env.DB.prepare(ENTRY_INSERT_SQL).bind(
    row.id,
    row.content,
    JSON.stringify(row.tags),
    row.source,
    row.created_at,
    row.updatedAt,
    "[]",
    row.recall_count,
    row.importance_score,
    row.contradiction_wins,
    row.contradiction_losses,
    writeCtx.workspaceId,
    writeCtx.actorId,
    row.valid_from,
    row.valid_until,
  );
}

/**
 * Director follow-up MAJOR: `holdStatements` for every row this flush inserted with a hold plan --
 * the same real hold path captureEntry and mirror.ts use, run once the INSERT's own RETURNING id
 * (a fresh one when the export's id was taken) is known. Combines every held row's statements into
 * one batch, so a page with several held rows costs one extra round trip, not one per row.
 */
async function applyHoldPlans(
  env: Env, held: { id: string; row: PendingInsert }[], change: ChangeContext, config: Readonly<Config>, now: number,
): Promise<void> {
  if (!held.length) return;
  const stmts = held.flatMap(({ id, row }) => holdStatements(env, { snapshotStatement, pruneStatement, versionKeep: config.VERSION_KEEP }, {
    entryId: id, reasons: row.holdPlan!.reasons, score: row.holdPlan!.score, signals: row.holdPlan!.signals,
    change, heldTags: heldTagsFor(row.tags, row.holdPlan!.reasons), now,
  }));
  await env.DB.batch(stmts);
}

async function flushInsertBatch(
  env: Env,
  batch: PendingInsert[],
  existingIds: Set<string>,
  results: ImportResultItem[],
  counters: { imported: number; failed: number },
  writeCtx: WriteContext,
  config: Readonly<Config>,
): Promise<void> {
  if (!batch.length) return;

  const change: ChangeContext = { actorId: writeCtx.actorId, channel: "rest" };
  const now = Date.now();
  const orphanIds = batch.map(row => row.id);
  const stmts = [orphanVersionsDelete(env, orphanIds), ...batch.map(row => bindInsert(env, row, writeCtx))];
  try {
    const written = await env.DB.batch(stmts);
    const held: { id: string; row: PendingInsert }[] = [];
    batch.forEach((row, i) => {
      existingIds.add(row.id);
      counters.imported++;
      const result = importedResult(row, written[i + 1]);
      results.push(result);
      if (row.holdPlan) held.push({ id: result.id, row });
    });
    await applyHoldPlans(env, held, change, config, now);
  } catch {
    for (const row of batch) {
      try {
        const written = await env.DB.batch([orphanVersionsDelete(env, [row.id]), bindInsert(env, row, writeCtx)]);
        existingIds.add(row.id);
        counters.imported++;
        const result = importedResult(row, written[1]);
        results.push(result);
        if (row.holdPlan) await applyHoldPlans(env, [{ id: result.id, row }], change, config, now);
      } catch (e) {
        counters.failed++;
        results.push({
          id: row.id,
          status: "failed",
          reason: "insert_error",
          detail: formatDbError(e),
        });
      }
    }
  }
}

/** Endpoint ids the importer can read: an id outside its workspaces reads exactly like a missing one. */
async function loadReadableIds(env: Env, ids: string[], readable: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const step = D1_MAX_BOUND_PARAMS - 1;
  for (let i = 0; i < ids.length; i += step) {
    const batch = ids.slice(i, i + step);
    const { results } = await env.DB.prepare(
      // scope-checked: workspace_id IN the importer's readable workspaces, bound as one JSON array
      `SELECT id FROM entries WHERE id IN (${batch.map(() => "?").join(", ")}) AND workspace_id IN (SELECT value FROM json_each(?))`,
    ).bind(...batch, JSON.stringify(readable)).all() as { results: { id: string }[] };
    for (const row of results) found.add(row.id);
  }
  return found;
}

function bindEdgeInsert(env: Env, edge: PendingEdge, writeCtx: WriteContext, readable: string[]) {
  let source = edge.source_id;
  let target = edge.target_id;
  if (isValidEdgeType(edge.type) && isSymmetric(edge.type) && source > target) {
    [source, target] = [target, source];
  }
  const now = Date.now();
  const readableJson = JSON.stringify(readable);
  return env.DB.prepare(
    // scope-exempt: by-id: the guard reads only this edge's endpoints, scoped by the importer's readable workspaces
    `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE ${edgeEndpointsReadableSql("?", "?", "?")}
     ON CONFLICT(source_id, target_id, type) DO UPDATE SET weight = max(weight, excluded.weight), updated_at = excluded.updated_at`,
  ).bind(
    crypto.randomUUID(), source, target, edge.type, edge.weight, edge.provenance, "{}", edge.created_at, now,
    writeCtx.workspaceId, source, readableJson, target, readableJson,
  );
}

async function flushEdgeBatch(
  env: Env,
  batch: PendingEdge[],
  existingEdgeKeys: Set<string>,
  results: ImportResultItem[],
  counters: { imported: number; failed: number; skipped: number },
  writeCtx: WriteContext,
  readable: string[],
): Promise<void> {
  if (!batch.length) return;

  const stmts = batch.map(row => bindEdgeInsert(env, row, writeCtx, readable));
  try {
    const written = await env.DB.batch(stmts);
    for (const [i, row] of batch.entries()) {
      const key = normalizedEdgeKey(row.source_id, row.target_id, row.type);
      existingEdgeKeys.add(key);
      // The guard refused it (an endpoint left the importer's reach since the pre-read): a plain skip.
      if ((written[i]?.meta?.changes ?? 1) === 0) { counters.skipped++; continue; }
      counters.imported++;
      results.push({
        source_id: row.source_id,
        target_id: row.target_id,
        type: row.type,
        status: "imported",
      });
    }
  } catch {
    for (const row of batch) {
      try {
        const res = await bindEdgeInsert(env, row, writeCtx, readable).run();
        const key = normalizedEdgeKey(row.source_id, row.target_id, row.type);
        existingEdgeKeys.add(key);
        if ((res?.meta?.changes ?? 1) === 0) { counters.skipped++; continue; }
        counters.imported++;
        results.push({
          source_id: row.source_id,
          target_id: row.target_id,
          type: row.type,
          status: "imported",
        });
      } catch (e) {
        counters.failed++;
        results.push({
          source_id: row.source_id,
          target_id: row.target_id,
          type: row.type,
          status: "failed",
          reason: "create_failed",
          detail: formatDbError(e),
        });
      }
    }
  }
}

const PROJECT_INSERT_SQL =
  `INSERT INTO projects (id, workspace_id, name, description, aliases, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, id) DO NOTHING`;

async function loadExistingProjectIds(env: Env, workspaceId: string, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  // The workspace id takes one of the bound parameters.
  const chunk = D1_MAX_BOUND_PARAMS - 1;
  for (let i = 0; i < ids.length; i += chunk) {
    const batch = ids.slice(i, i + chunk);
    const { results } = await env.DB.prepare(
      `SELECT id FROM projects WHERE workspace_id = ? AND id IN (${batch.map(() => "?").join(", ")})`,
    ).bind(workspaceId, ...batch).all() as { results: { id: string }[] };
    for (const row of results) found.add(row.id);
  }
  return found;
}

function bindProjectInsert(env: Env, p: ImportedProject, writeCtx: WriteContext) {
  return env.DB.prepare(PROJECT_INSERT_SQL).bind(
    p.id, writeCtx.workspaceId, p.name, p.description, JSON.stringify(p.aliases), p.status, p.created_at, p.updatedAt,
  );
}

/**
 * One page of projects, into the caller's workspace. An existing (workspace, id) keeps
 * its row, as an existing entry id does. Nothing is queried for an empty page.
 */
async function importProjectsPage(
  env: Env,
  page: ExportProject[],
  writeCtx: WriteContext,
  results: ImportResultItem[],
): Promise<{ imported: number; skipped: number; failed: number }> {
  const counts = { imported: 0, skipped: 0, failed: 0 };
  if (!page.length) return counts;

  const parsed = page.map(raw => parseImportedProject(raw));
  const existing = await loadExistingProjectIds(env, writeCtx.workspaceId, parsed.flatMap(p => (p.ok ? [p.project.id] : [])));

  const pending: ImportedProject[] = [];
  for (const p of parsed) {
    if (!p.ok) {
      counts.failed++;
      results.push({ project_id: p.id, status: "failed", reason: "invalid_project", detail: p.detail });
    } else if (existing.has(p.project.id)) {
      counts.skipped++;
    } else {
      // Queued ids count as seen, so a duplicate later in the page is a skip.
      existing.add(p.project.id);
      pending.push(p.project);
    }
  }

  for (let i = 0; i < pending.length; i += IMPORT_D1_BATCH_SIZE) {
    const chunk = pending.slice(i, i + IMPORT_D1_BATCH_SIZE);
    const settle = (p: ImportedProject) => { counts.imported++; results.push({ project_id: p.id, status: "imported" }); };
    try {
      await env.DB.batch(chunk.map(p => bindProjectInsert(env, p, writeCtx)));
      chunk.forEach(settle);
    } catch {
      for (const p of chunk) {
        try {
          await bindProjectInsert(env, p, writeCtx).run();
          settle(p);
        } catch (e) {
          counts.failed++;
          results.push({ project_id: p.id, status: "failed", reason: "insert_error", detail: formatDbError(e) });
        }
      }
    }
  }
  return counts;
}

/**
 * One page of a restore. `offset`/`edgeOffset` are positions in the payload arrays (entries in
 * oldest-first order, see oldestFirst),
 * and a call examines exactly one page: entries[offset .. offset+limit), then — only
 * once the entries array is exhausted — edges[edgeOffset .. edgeOffset+limit).
 *
 * Positional paging is what keeps the cost flat against this codebase's
 * self-imposed D1 budget (~50 calls per invocation; the platform's real
 * ceiling is 1,000). Each page resolves only its own ids: one chunked existence lookup plus
 * one insert batch, so a default page costs 2-3 round trips whether the file holds
 * 40 entries or 50,000, and page 500 costs the same as page 1. The alternative —
 * scanning from the top and skipping — re-resolves every already-imported id on
 * every call, which is how a 5,000-entry restore spends its whole daily budget
 * before finishing.
 *
 * Re-running a page is safe: existing ids and edge keys are skipped, and the
 * ON CONFLICT upsert makes a re-inserted edge a weight merge rather than an error.
 * Projects page the same way once entries are done, and an existing project is kept.
 */
/**
 * Entries in insertion order for a restore: oldest created_at first, ties in file order, a missing
 * created_at last (it is stamped with now) and an unusable one last too (parseEntryRow will fail it anyway). rowids then follow time on a restored brain,
 * which the keyword AND tier's newest-first index scan relies on, whatever order the file is in
 * (exports before that order was fixed are newest first). Pages are positions in this order, so a
 * client must resend the same file for every page, which every client already does.
 */
function oldestFirst(entries: ExportEntry[]): ExportEntry[] {
  // Mirrors parseCreatedAt: null and undefined are stamped with the current time (newest), and anything
  // else that is not a finite number is rejected, so its position is moot; all of them sort last.
  const at = (entry: ExportEntry) => {
    const value = (entry as { created_at?: unknown } | null)?.created_at;
    return typeof value === "number" && Number.isFinite(value) ? value : Infinity;
  };
  return entries.map((entry, order) => ({ entry, order, at: at(entry) }))
    .sort((a, b) => a.at - b.at || a.order - b.order)
    .map(({ entry }) => entry);
}

export async function importExportPayload(
  env: Env,
  body: ExportPayload,
  opts: ImportOptions = {},
): Promise<ImportSummary> {
  const limit = opts.limit ?? IMPORT_DEFAULT_LIMIT;
  const entries = oldestFirst(body.entries);
  const edges = body.edges ?? [];
  const offset = Math.min(Math.max(opts.offset ?? 0, 0), entries.length);
  const edgeOffset = Math.min(Math.max(opts.edgeOffset ?? 0, 0), edges.length);
  const projects = body.projects ?? [];
  const projectOffset = Math.min(Math.max(opts.projectOffset ?? 0, 0), projects.length);
  const writeCtx = opts.writeCtx ?? OWNER_WRITE_CONTEXT;
  // Import edges are automatic (round 5): both endpoints in the importer's own workspace, where the
  // imported entries land and the edge is stamped. Anything else is skipped like a missing endpoint.
  const readable = [writeCtx.workspaceId];

  const results: ImportResultItem[] = [];
  let imported = 0;
  let skipped = 0;
  let skipped_too_large = 0;
  let failed = 0;
  let edges_imported = 0;
  let edges_skipped = 0;
  let edges_failed = 0;

  // ---- entries page ------------------------------------------------------------
  const page = entries.slice(offset, offset + limit);
  const next_offset = offset + page.length;

  // Codex review, T-0102 B1: an import is scored on the rest channel like any other REST write,
  // so genuinely suspicious imported content is held rather than landing straight into recall.
  // Resolved once, even for an empty page -- cheap, and cached the same as every other config read.
  const config: Readonly<Config> = await resolveConfig(env);

  // Parse the whole page before touching D1, so the existence lookup can be one
  // chunked query over exactly the ids that might insert.
  const parsedPage: ({ row: PendingInsert } | { failure: ImportEntryResult })[] = [];
  for (const entry of page) {
    const parsed = parseEntryRow(entry);
    // One rule for every caller-chosen id (T-0089.1.1): over MAX_ENTRY_ID_BYTES it would leave no room
    // for the per-upload vector suffix under Vectorize's 64-byte limit, so the row takes a minted id.
    if ("row" in parsed) {
      const bounded = await boundedEntryId(parsed.row.id);
      if (bounded !== parsed.row.id) parsed.row = { ...parsed.row, originalId: parsed.row.id, id: bounded };
      parsed.row = { ...parsed.row, holdPlan: importHoldPlan(parsed.row, config) };
    }
    parsedPage.push(parsed);
  }

  // Codex review, T-0102 B3, director follow-up (MINOR): an id with any entry_events history at
  // all -- the export's own id, or boundedEntryId's own length-based mint -- is never reused; see
  // loadEventHistoryIds for why deleting or inheriting that history are both wrong.
  const candidateIds = [...new Set(parsedPage.flatMap(p => ("row" in p ? [p.row.id] : [])))];
  const eventHistoryIds = await loadEventHistoryIds(env, candidateIds);
  for (const p of parsedPage) {
    if (!("row" in p) || !eventHistoryIds.has(p.row.id)) continue;
    p.row = { ...p.row, originalId: p.row.originalId ?? p.row.id, id: crypto.randomUUID() };
  }

  const pageIds = [...new Set(parsedPage.flatMap(p => ("row" in p ? [p.row.id] : [])))];
  const { live: existingIds, trashed: trashedIds } = await loadExistingIds(env, pageIds);
  let skipped_in_trash = 0;

  const pendingBatch: PendingInsert[] = [];
  const batchCounters = { imported: 0, failed: 0 };
  let importedStanding = false;
  for (const p of parsedPage) {
    if ("failure" in p) {
      // "skipped" (currently only the too_large case) is not a validation failure: the record
      // is well-formed, it is simply over Rahil's 128 KB cap, and the whole import must not
      // fail because of it — see the copy deck's own distinct import summary line for it.
      if (p.failure.status === "skipped") {
        skipped++;
        skipped_too_large++;
      } else {
        failed++;
      }
      results.push(p.failure);
      continue;
    }
    if (trashedIds.has(p.row.id)) {
      skipped++;
      // Only the importer's own trash is named (restore it instead); another workspace's trash row
      // is a plain skip, the same as a live id elsewhere, so the reply never says where an id lives.
      if (trashedIds.get(p.row.id) === writeCtx.workspaceId) {
        skipped_in_trash++;
        results.push({ id: p.row.id, status: "skipped", reason: "in_trash" });
      }
      continue;
    }
    if (existingIds.has(p.row.id)) {
      skipped++;
      continue;
    }
    // Marking the id as seen at queue time makes a duplicate later in the same page
    // a skip; letting it into the batch would be a PRIMARY KEY conflict that fails
    // the whole batch into the per-row fallback.
    existingIds.add(p.row.id);
    pendingBatch.push(p.row);
    if (p.row.tags.includes("standing:active")) importedStanding = true;

    if (pendingBatch.length >= IMPORT_D1_BATCH_SIZE) {
      await flushInsertBatch(env, pendingBatch.splice(0), existingIds, results, batchCounters, writeCtx, config);
    }
  }
  if (pendingBatch.length) {
    await flushInsertBatch(env, pendingBatch.splice(0), existingIds, results, batchCounters, writeCtx, config);
  }
  imported += batchCounters.imported;
  failed += batchCounters.failed;
  if (opts.ctx && importedStanding) standingTouched(env, opts.ctx, await resolveConfig(env), [writeCtx.workspaceId]);

  const remaining_entries = entries.length - next_offset;

  // ---- edges page --------------------------------------------------------------
  // Deferred until the entries array is exhausted, so every endpoint an edge can
  // name either predates this import or was written by an earlier page.
  let next_edge_offset = edgeOffset;
  let next_project_offset = projectOffset;
  let projectCounts = { imported: 0, skipped: 0, failed: 0 };
  if (remaining_entries === 0) {
    const edgePage = edges.slice(edgeOffset, edgeOffset + limit);
    next_edge_offset = edgeOffset + edgePage.length;

    type ParsedEdge = { edge: PendingEdge } | { failure: ImportEdgeResult };
    const parsedEdges: ParsedEdge[] = [];
    for (const edge of edgePage) {
      const parsed = parseEdgeRow(edge);
      // An endpoint over MAX_ENTRY_ID_BYTES was imported under its minted id: follow it there.
      if ("edge" in parsed) {
        const [source_id, target_id] = await Promise.all([boundedEntryId(parsed.edge.source_id), boundedEntryId(parsed.edge.target_id)]);
        parsed.edge = { ...parsed.edge, source_id, target_id };
      }
      parsedEdges.push(parsed);
    }

    // Endpoints the importer can READ, in one chunked scoped query. existingIds is not enough: it
    // also holds ids that exist in other workspaces (the entries page skips those), and an edge to
    // one would put a private id in this importer's export.
    const endpoints = [
      ...new Set(parsedEdges.flatMap(p => ("edge" in p ? [p.edge.source_id, p.edge.target_id] : []))),
    ];
    const readableIds = await loadReadableIds(env, endpoints, readable);
    const existingEdgeKeys = await loadExistingEdgeKeys(env, endpoints);

    const pendingEdgeBatch: PendingEdge[] = [];
    const edgeBatchCounters = { imported: 0, failed: 0, skipped: 0 };
    for (const p of parsedEdges) {
      if ("failure" in p) {
        edges_failed++;
        results.push(p.failure);
        continue;
      }
      const { source_id, target_id, type } = p.edge;
      // Missing or not readable: the same plain skip, so the reply never says an id exists elsewhere.
      if (!readableIds.has(source_id) || !readableIds.has(target_id)) {
        edges_skipped++;
        continue;
      }
      const edgeKey = normalizedEdgeKey(source_id, target_id, type);
      if (existingEdgeKeys.has(edgeKey)) {
        edges_skipped++;
        continue;
      }
      existingEdgeKeys.add(edgeKey);
      pendingEdgeBatch.push(p.edge);

      if (pendingEdgeBatch.length >= IMPORT_D1_BATCH_SIZE) {
        await flushEdgeBatch(env, pendingEdgeBatch.splice(0), existingEdgeKeys, results, edgeBatchCounters, writeCtx, readable);
      }
    }
    if (pendingEdgeBatch.length) {
      await flushEdgeBatch(env, pendingEdgeBatch.splice(0), existingEdgeKeys, results, edgeBatchCounters, writeCtx, readable);
    }
    edges_imported += edgeBatchCounters.imported;
    edges_failed += edgeBatchCounters.failed;
    edges_skipped += edgeBatchCounters.skipped;

    // Projects ride the same call as the edges page, on their own cursor, so a client
    // that only knows entries and edges still restores the first page of them.
    const projectPage = projects.slice(projectOffset, projectOffset + limit);
    next_project_offset = projectOffset + projectPage.length;
    projectCounts = await importProjectsPage(env, projectPage, writeCtx, results);
  }

  return {
    ok: true,
    imported,
    skipped,
    skipped_in_trash,
    skipped_too_large,
    failed,
    edges_imported,
    edges_skipped,
    edges_failed,
    projects_imported: projectCounts.imported,
    projects_skipped: projectCounts.skipped,
    projects_failed: projectCounts.failed,
    remaining_entries,
    remaining_edges: edges.length - next_edge_offset,
    remaining_projects: projects.length - next_project_offset,
    next_offset,
    next_edge_offset,
    next_project_offset,
    results,
    vectorize_hint: "POST /vectorize-pending until remaining is 0",
  };
}

/** Parse one entry row into an insertable record, or the failure to report. */
function parseEntryRow(entry: ExportEntry): { row: PendingInsert } | { failure: ImportEntryResult } {
  if (!isImportRecordObject(entry)) {
    return { failure: { id: "", status: "failed", reason: "invalid_entry" } };
  }
  const idParsed = parseRequiredString(entry.id, "missing_id", "invalid_id");
  if (!idParsed.ok) {
    const id = typeof entry.id === "string" ? entry.id : String(entry.id ?? "");
    return { failure: { id, status: "failed", reason: idParsed.reason } };
  }
  const id = idParsed.value;

  const contentParsed = parseRequiredString(entry.content, "missing_content", "invalid_content");
  if (!contentParsed.ok) return { failure: { id, status: "failed", reason: contentParsed.reason } };
  // Rahil's decision (18-copy-deck.md 6.8): 128 KB per note is the cap on a NEW capture. A 3.7
  // export can carry a note that was already over it (Codex review, T-0102 B2: skipping it here
  // silently lost real data on an upgrade). Import keeps the row instead, forced held too_long by
  // applyImportHold below -- the same state a too-long note reaches on a fresh 4.0 write, never
  // scanned or embedded until the owner reads it and releases it.

  // Read before parseTags strips it along with every other reserved tag: a real hold
  // (quarantine:<recognized reason>) on the exported row must survive the import, not silently
  // become an ordinary, indexable row (Codex review, T-0102 B1, then director follow-up: honored
  // unconditionally, matching isHeld/heldReason's own simplified rule -- a recognized reason is
  // never coincidental, whatever its other tags, status:draft included or not).
  const rawTags = Array.isArray(entry.tags) ? normalizeTagList(entry.tags) : [];
  const originalHoldReason = heldReason(rawTags);
  const tagsParsed = parseTags(entry.tags);
  if (!tagsParsed.ok) return { failure: { id, status: "failed", reason: tagsParsed.reason } };

  let source = "import";
  if (entry.source !== undefined && entry.source !== null) {
    if (typeof entry.source !== "string") {
      return { failure: { id, status: "failed", reason: "invalid_source" } };
    }
    source = entry.source.trim() || "import";
  }

  const createdAtParsed = parseCreatedAt(entry.created_at);
  if (!createdAtParsed.ok) return { failure: { id, status: "failed", reason: createdAtParsed.reason } };
  const created_at = createdAtParsed.value;

  // Absent in exports taken before /export carried the field; created_at is what the
  // column would have coalesced to anyway. A restore must not launder a bad value into
  // a "recently touched" ranking signal, so a malformed one fails the row instead.
  const rawUpdatedAt = entry.updated_at ?? created_at;
  if (typeof rawUpdatedAt !== "number" || !Number.isFinite(rawUpdatedAt)) {
    return { failure: { id, status: "failed", reason: "invalid_updated_at" } };
  }
  // Cap at now (R4-U1/U2/U3): every writer clamps updated_at to MAX(now, prev + 1) to keep it
  // strictly increasing, but that clamp is a no-op once prev is already >= now (a future date or
  // a huge exported value) — the next edit's own clamp can never move it, the digest guard then
  // treats every later edit as unseen, and entry_versions.created_at/valid_from (themselves
  // clamped against this column) inherit the poisoned value forever. An uncapped import launders
  // exactly the bad value the check above already refuses to accept unbounded.
  const updatedAt = Math.min(rawUpdatedAt, Date.now());

  const recallCountParsed = parseOptionalNumber(entry.recall_count, "invalid_recall_count");
  if (!recallCountParsed.ok) return { failure: { id, status: "failed", reason: recallCountParsed.reason } };
  const importanceParsed = parseOptionalNumber(entry.importance_score, "invalid_importance_score");
  if (!importanceParsed.ok) return { failure: { id, status: "failed", reason: importanceParsed.reason } };
  const winsParsed = parseOptionalNumber(entry.contradiction_wins, "invalid_contradiction_wins");
  if (!winsParsed.ok) return { failure: { id, status: "failed", reason: winsParsed.reason } };
  const lossesParsed = parseOptionalNumber(entry.contradiction_losses, "invalid_contradiction_losses");
  if (!lossesParsed.ok) return { failure: { id, status: "failed", reason: lossesParsed.reason } };

  return {
    row: {
      id,
      content: contentParsed.value,
      tags: tagsParsed.tags,
      source,
      created_at,
      updatedAt,
      recall_count: recallCountParsed.value,
      importance_score: importanceParsed.value,
      contradiction_wins: winsParsed.value,
      contradiction_losses: lossesParsed.value,
      originalHoldReason,
      ...importedWindow(entry.valid_from, entry.valid_until, created_at),
    },
  };
}

/** What a held imported row needs to write a real hold (holdStatements): the reasons, and the
 * score/signals a fresh scoreWrite computed regardless of which reason ultimately wins. */
interface ImportHoldPlan { reasons: HoldReason[]; score: number; signals: SignalHit[] }

/**
 * Codex review, T-0102 B1: an imported row is scored on the rest channel like any other REST
 * write (import previously reached storeEntry/scoreWrite never at all), and a real hold the
 * export's own tags carried (originalHoldReason, read before parseTags stripped it, honored
 * unconditionally -- director follow-up) survives the import rather than silently becoming an
 * ordinary, indexable row. Scoring wins the reason when both apply -- it is the richer,
 * freshly-computed signal; the export's own reason is the fallback when scoring alone would not
 * have held this content today.
 *
 * Director follow-up MAJOR: a held import used to be nothing more than these tags stamped
 * straight into the INSERT -- no hold version, no held event, so Release (which resolves through
 * a version chain) and the Held feed (which reads from entry_events) never worked on it. The plan
 * this returns is null for an ordinary row and the reasons/score/signals a held one needs; the
 * caller runs holdStatements for it once the INSERT's own RETURNING id is known (see
 * flushInsertBatch), the same real hold path captureEntry and mirror.ts use.
 */
function importHoldPlan(row: PendingInsert, config: Readonly<Config>): ImportHoldPlan | null {
  const score = scoreWrite(
    { content: row.content, tags: row.tags, source: row.source, channel: "rest", kind: "create" },
    config,
  );
  const decision = holdDecision(score);
  // Over the 128 KB cap is too_long regardless of what the scorer itself concluded (it would
  // already agree in practice -- the cap is well past the scorer's own 32 KB scan budget, so
  // this content is always `partial` -- but explicit here rather than relying on that overlap).
  const reasons: HoldReason[] | null = isOverContentLimit(row.content)
    ? ["too_long"]
    : decision.hold ? decision.reasons : row.originalHoldReason ? [row.originalHoldReason] : null;
  return reasons ? { reasons, score: score.score, signals: score.signals } : null;
}

/**
 * The validity window an exported row carried (T-0089.2.1). An import only inserts, so it never
 * supersedes anything; a malformed or inverted window is dropped (NULL, "since created_at, still
 * true") rather than failing the memory, since the writers' invariant is until >= effective start.
 * So is a date in the future: validity dates are for what has already happened (P5), and an export
 * only ever holds dates at or before the moment it was taken.
 */
function importedWindow(from: unknown, until: unknown, createdAt: number, now = Date.now()): { valid_from: number | null; valid_until: number | null } {
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= now ? v : v === undefined || v === null ? null : NaN;
  const f = num(from);
  const u = num(until);
  if (Number.isNaN(f) || Number.isNaN(u)) return { valid_from: null, valid_until: null };
  if (u !== null && u < (f ?? createdAt)) return { valid_from: null, valid_until: null };
  return { valid_from: f, valid_until: u };
}

/** Parse one edge row into an insertable record, or the failure to report. */
function parseEdgeRow(edge: ExportEdge): { edge: PendingEdge } | { failure: ImportEdgeResult } {
  if (!isImportRecordObject(edge)) {
    return { failure: { source_id: "", target_id: "", type: "", status: "failed", reason: "invalid_edge" } };
  }
  const sourceParsed = parseRequiredString(edge.source_id, "missing_endpoint", "invalid_endpoint");
  const targetParsed = parseRequiredString(edge.target_id, "missing_endpoint", "invalid_endpoint");
  const type = typeof edge.type === "string" ? edge.type.trim() || "relates_to" : "relates_to";

  if (!sourceParsed.ok || !targetParsed.ok) {
    const reason = !sourceParsed.ok ? sourceParsed.reason : !targetParsed.ok ? targetParsed.reason : "missing_endpoint";
    return {
      failure: {
        source_id: typeof edge.source_id === "string" ? edge.source_id : String(edge.source_id ?? ""),
        target_id: typeof edge.target_id === "string" ? edge.target_id : String(edge.target_id ?? ""),
        type,
        status: "failed",
        reason,
      },
    };
  }
  const source_id = sourceParsed.value;
  const target_id = targetParsed.value;

  if (!isValidEdgeType(type)) {
    return { failure: { source_id, target_id, type, status: "failed", reason: "invalid_type" } };
  }
  // The capture path never creates these (graph/edges.ts returns null), so one in a
  // payload is hand-edited data the graph should not inherit.
  if (source_id === target_id) {
    return { failure: { source_id, target_id, type, status: "failed", reason: "self_edge" } };
  }
  const weightParsed = parseEdgeWeight(edge.weight);
  if (!weightParsed.ok) {
    return { failure: { source_id, target_id, type, status: "failed", reason: weightParsed.reason } };
  }
  const provenance =
    edge.provenance && typeof edge.provenance === "string" && isValidProvenance(edge.provenance)
      ? edge.provenance
      : "explicit";

  return {
    edge: {
      source_id,
      target_id,
      type,
      weight: weightParsed.value,
      provenance,
      created_at: typeof edge.created_at === "number" ? edge.created_at : Date.now(),
    },
  };
}
