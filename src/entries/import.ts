import type { Env } from "../env";
import { D1_MAX_BOUND_PARAMS } from "../constants";
import { isSymmetric, isValidEdgeType } from "../graph/edges";
import type { EdgeProvenance } from "../graph/types";
import { PROVENANCE_VALUES } from "../graph/types";

/** Max new entry inserts attempted per request (skipped rows do not count). */
export const IMPORT_DEFAULT_LIMIT = 40;
export const IMPORT_MAX_LIMIT = 1000;
/** D1 batch chunk size for inserts. */
export const IMPORT_D1_BATCH_SIZE = 50;
/** Edge endpoint lookups bind each id twice (source IN + target IN). */
export const EDGE_ENDPOINT_QUERY_BATCH = Math.floor(D1_MAX_BOUND_PARAMS / 2);

const ENTRY_INSERT_SQL_TEMPLATE =
  `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, recall_count, importance_score, contradiction_wins, contradiction_losses) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

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
}

export interface ImportEdgeResult {
  source_id: string;
  target_id: string;
  type: string;
  status: ImportEdgeStatus;
  reason?: string;
  detail?: string;
}

export type ImportResultItem = ImportEntryResult | ImportEdgeResult;

export interface ExportEntry {
  id: string;
  content: string;
  tags?: string[];
  source?: string;
  created_at?: number;
  recall_count?: number;
  importance_score?: number;
  contradiction_wins?: number;
  contradiction_losses?: number;
}

export interface ExportEdge {
  source_id: string;
  target_id: string;
  type?: string;
  weight?: number;
  provenance?: string;
  created_at?: number;
}

export interface ExportPayload {
  version?: number;
  entries: ExportEntry[];
  edges?: ExportEdge[];
}

export interface ImportOptions {
  limit?: number;
}

export interface ImportSummary {
  ok: true;
  imported: number;
  skipped: number;
  failed: number;
  edges_imported: number;
  edges_skipped: number;
  edges_failed: number;
  remaining_entries: number;
  remaining_edges: number;
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
  content: string;
  tags: string[];
  source: string;
  created_at: number;
  recall_count: number;
  importance_score: number;
  contradiction_wins: number;
  contradiction_losses: number;
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
  return { ok: true, tags };
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
  if (o.version !== undefined && o.version !== 2) return { ok: false, error: "version must be 2" };
  if (!Array.isArray(o.entries)) return { ok: false, error: "entries must be an array" };
  return {
    ok: true,
    payload: {
      version: o.version as number | undefined,
      entries: o.entries as ExportEntry[],
      edges: o.edges as ExportEdge[] | undefined,
    },
  };
}

export function parseImportLimit(raw: string | null): number {
  if (!raw) return IMPORT_DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return IMPORT_DEFAULT_LIMIT;
  return Math.min(n, IMPORT_MAX_LIMIT);
}

async function loadExistingIds(env: Env, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  if (!ids.length) return found;
  for (let i = 0; i < ids.length; i += D1_MAX_BOUND_PARAMS) {
    const batch = ids.slice(i, i + D1_MAX_BOUND_PARAMS);
    const placeholders = batch.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `SELECT id FROM entries WHERE id IN (${placeholders})`,
    ).bind(...batch).all() as { results: { id: string }[] };
    for (const row of results) found.add(row.id);
  }
  return found;
}

async function loadExistingEdgeKeys(env: Env, endpoints: string[]): Promise<Set<string>> {
  const keys = new Set<string>();
  if (!endpoints.length) return keys;
  for (let i = 0; i < endpoints.length; i += EDGE_ENDPOINT_QUERY_BATCH) {
    const batch = endpoints.slice(i, i + EDGE_ENDPOINT_QUERY_BATCH);
    const placeholders = batch.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `SELECT source_id, target_id, type FROM edges WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
    ).bind(...batch, ...batch).all() as {
      results: { source_id: string; target_id: string; type: string }[];
    };
    for (const row of results) keys.add(normalizedEdgeKey(row.source_id, row.target_id, row.type));
  }
  return keys;
}

function collectPayloadEntryIds(entries: ExportEntry[]): string[] {
  const ids: string[] = [];
  for (const entry of entries) {
    if (!isImportRecordObject(entry)) continue;
    const parsed = parseRequiredString(entry.id, "missing", "invalid");
    if (parsed.ok) ids.push(parsed.value);
  }
  return ids;
}

function collectEdgeEndpoints(edges: ExportEdge[]): string[] {
  const endpoints = new Set<string>();
  for (const edge of edges) {
    if (!isImportRecordObject(edge)) continue;
    const sourceParsed = parseRequiredString(edge.source_id, "missing", "invalid");
    const targetParsed = parseRequiredString(edge.target_id, "missing", "invalid");
    if (sourceParsed.ok) endpoints.add(sourceParsed.value);
    if (targetParsed.ok) endpoints.add(targetParsed.value);
  }
  return [...endpoints];
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

async function flushPendingIdLookups(
  env: Env,
  pending: string[],
  existingIds: Set<string>,
): Promise<void> {
  while (pending.length) {
    const batch = pending.splice(0, D1_MAX_BOUND_PARAMS);
    const found = await loadExistingIds(env, batch);
    for (const id of found) existingIds.add(id);
  }
}

/** Resolve one id against D1, batching lookups to stay within query budget. */
export async function ensureIdResolved(
  env: Env,
  id: string,
  existingIds: Set<string>,
  pending: string[],
): Promise<void> {
  if (existingIds.has(id)) return;
  if (!pending.includes(id)) pending.push(id);
  while (pending.length >= D1_MAX_BOUND_PARAMS) {
    const batch = pending.splice(0, D1_MAX_BOUND_PARAMS);
    const found = await loadExistingIds(env, batch);
    for (const foundId of found) existingIds.add(foundId);
  }
  if (pending.includes(id)) {
    await flushPendingIdLookups(env, pending, existingIds);
  }
}

async function ensureIdsResolved(
  env: Env,
  ids: string[],
  existingIds: Set<string>,
  pending: string[],
): Promise<void> {
  for (const id of ids) {
    if (existingIds.has(id)) continue;
    if (!pending.includes(id)) pending.push(id);
  }
  await flushPendingIdLookups(env, pending, existingIds);
}

async function mergeExistingEdgeKeys(
  env: Env,
  endpoints: string[],
  into: Set<string>,
): Promise<void> {
  const found = await loadExistingEdgeKeys(env, endpoints);
  for (const key of found) into.add(key);
}

function countValidEdgesInPayload(edges: ExportEdge[]): number {
  let count = 0;
  for (const edge of edges) {
    if (!isImportRecordObject(edge)) continue;
    const type = typeof edge.type === "string" ? edge.type.trim() || "relates_to" : "relates_to";
    if (!isValidEdgeType(type)) continue;
    const sourceParsed = parseRequiredString(edge.source_id, "missing", "invalid");
    const targetParsed = parseRequiredString(edge.target_id, "missing", "invalid");
    if (!sourceParsed.ok || !targetParsed.ok) continue;
    count++;
  }
  return count;
}

function bindInsert(env: Env, row: PendingInsert) {
  return env.DB.prepare(ENTRY_INSERT_SQL).bind(
    row.id,
    row.content,
    JSON.stringify(row.tags),
    row.source,
    row.created_at,
    row.created_at,
    "[]",
    row.recall_count,
    row.importance_score,
    row.contradiction_wins,
    row.contradiction_losses,
  );
}

async function flushInsertBatch(
  env: Env,
  batch: PendingInsert[],
  existingIds: Set<string>,
  results: ImportResultItem[],
  counters: { imported: number; failed: number },
): Promise<void> {
  if (!batch.length) return;

  const stmts = batch.map(row => bindInsert(env, row));
  try {
    await env.DB.batch(stmts);
    for (const row of batch) {
      existingIds.add(row.id);
      counters.imported++;
      results.push({ id: row.id, status: "imported" });
    }
  } catch {
    for (const row of batch) {
      try {
        await bindInsert(env, row).run();
        existingIds.add(row.id);
        counters.imported++;
        results.push({ id: row.id, status: "imported" });
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

function bindEdgeInsert(env: Env, edge: PendingEdge) {
  let source = edge.source_id;
  let target = edge.target_id;
  if (isValidEdgeType(edge.type) && isSymmetric(edge.type) && source > target) {
    [source, target] = [target, source];
  }
  const now = Date.now();
  return env.DB.prepare(
    `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id, target_id, type) DO UPDATE SET weight = max(weight, excluded.weight), updated_at = excluded.updated_at`,
  ).bind(crypto.randomUUID(), source, target, edge.type, edge.weight, edge.provenance, "{}", edge.created_at, now);
}

async function flushEdgeBatch(
  env: Env,
  batch: PendingEdge[],
  existingEdgeKeys: Set<string>,
  results: ImportResultItem[],
  counters: { imported: number; failed: number },
): Promise<void> {
  if (!batch.length) return;

  const stmts = batch.map(row => bindEdgeInsert(env, row));
  try {
    await env.DB.batch(stmts);
    for (const row of batch) {
      const key = normalizedEdgeKey(row.source_id, row.target_id, row.type);
      existingEdgeKeys.add(key);
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
        await bindEdgeInsert(env, row).run();
        const key = normalizedEdgeKey(row.source_id, row.target_id, row.type);
        existingEdgeKeys.add(key);
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

export async function importExportPayload(
  env: Env,
  body: ExportPayload,
  opts: ImportOptions = {},
): Promise<ImportSummary> {
  const limit = opts.limit ?? IMPORT_DEFAULT_LIMIT;
  const results: ImportResultItem[] = [];
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  let edges_imported = 0;
  let edges_skipped = 0;
  let edges_failed = 0;
  let remaining_entries = 0;
  let remaining_edges = 0;

  const edges = body.edges ?? [];
  const existingIds = new Set<string>();
  const pendingIdLookups: string[] = [];
  const pendingBatch: PendingInsert[] = [];
  let newInsertAttempts = 0;
  const batchCounters = { imported: 0, failed: 0 };

  for (const entry of body.entries) {
    if (!isImportRecordObject(entry)) {
      failed++;
      results.push({ id: "", status: "failed", reason: "invalid_entry" });
      continue;
    }

    const idParsed = parseRequiredString(entry.id, "missing_id", "invalid_id");
    if (!idParsed.ok) {
      failed++;
      results.push({
        id: typeof entry.id === "string" ? entry.id : String(entry.id ?? ""),
        status: "failed",
        reason: idParsed.reason,
      });
      continue;
    }
    const id = idParsed.value;

    const contentParsed = parseRequiredString(entry.content, "missing_content", "invalid_content");
    if (!contentParsed.ok) {
      failed++;
      results.push({ id, status: "failed", reason: contentParsed.reason });
      continue;
    }

    if (newInsertAttempts >= limit) {
      remaining_entries++;
      continue;
    }

    await ensureIdResolved(env, id, existingIds, pendingIdLookups);

    if (existingIds.has(id)) {
      skipped++;
      continue;
    }

    const tagsParsed = parseTags(entry.tags);
    if (!tagsParsed.ok) {
      failed++;
      results.push({ id, status: "failed", reason: tagsParsed.reason });
      continue;
    }
    const tags = tagsParsed.tags;

    let source = "import";
    if (entry.source !== undefined && entry.source !== null) {
      if (typeof entry.source !== "string") {
        failed++;
        results.push({ id, status: "failed", reason: "invalid_source" });
        continue;
      }
      source = entry.source.trim() || "import";
    }

    const createdAtParsed = parseCreatedAt(entry.created_at);
    if (!createdAtParsed.ok) {
      failed++;
      results.push({ id, status: "failed", reason: createdAtParsed.reason });
      continue;
    }
    const created_at = createdAtParsed.value;

    const recallCountParsed = parseOptionalNumber(entry.recall_count, "invalid_recall_count");
    if (!recallCountParsed.ok) {
      failed++;
      results.push({ id, status: "failed", reason: recallCountParsed.reason });
      continue;
    }
    const importanceParsed = parseOptionalNumber(entry.importance_score, "invalid_importance_score");
    if (!importanceParsed.ok) {
      failed++;
      results.push({ id, status: "failed", reason: importanceParsed.reason });
      continue;
    }
    const winsParsed = parseOptionalNumber(entry.contradiction_wins, "invalid_contradiction_wins");
    if (!winsParsed.ok) {
      failed++;
      results.push({ id, status: "failed", reason: winsParsed.reason });
      continue;
    }
    const lossesParsed = parseOptionalNumber(entry.contradiction_losses, "invalid_contradiction_losses");
    if (!lossesParsed.ok) {
      failed++;
      results.push({ id, status: "failed", reason: lossesParsed.reason });
      continue;
    }

    pendingBatch.push({
      id,
      content: contentParsed.value,
      tags,
      source,
      created_at,
      recall_count: recallCountParsed.value,
      importance_score: importanceParsed.value,
      contradiction_wins: winsParsed.value,
      contradiction_losses: lossesParsed.value,
    });

    newInsertAttempts++;

    if (pendingBatch.length >= IMPORT_D1_BATCH_SIZE) {
      await flushInsertBatch(env, pendingBatch.splice(0), existingIds, results, batchCounters);
      imported += batchCounters.imported;
      failed += batchCounters.failed;
      batchCounters.imported = 0;
      batchCounters.failed = 0;
    }
  }

  if (pendingBatch.length) {
    await flushInsertBatch(env, pendingBatch.splice(0), existingIds, results, batchCounters);
    imported += batchCounters.imported;
    failed += batchCounters.failed;
  }

  await flushPendingIdLookups(env, pendingIdLookups, existingIds);

  if (remaining_entries > 0) {
    remaining_edges = countValidEdgesInPayload(edges);
  } else {
    const existingEdgeKeys = new Set<string>();
    let newEdgeAttempts = 0;
    const pendingEdgeBatch: PendingEdge[] = [];
    const edgeBatchCounters = { imported: 0, failed: 0 };

    for (const edge of edges) {
      if (!isImportRecordObject(edge)) {
        edges_failed++;
        results.push({
          source_id: "",
          target_id: "",
          type: "",
          status: "failed",
          reason: "invalid_edge",
        });
        continue;
      }

      const sourceParsed = parseRequiredString(edge.source_id, "missing_endpoint", "invalid_endpoint");
      const targetParsed = parseRequiredString(edge.target_id, "missing_endpoint", "invalid_endpoint");
      const type = typeof edge.type === "string" ? edge.type.trim() || "relates_to" : "relates_to";

      if (!sourceParsed.ok || !targetParsed.ok) {
        edges_failed++;
        let reason = "missing_endpoint";
        if (!sourceParsed.ok) reason = sourceParsed.reason;
        else if (!targetParsed.ok) reason = targetParsed.reason;
        results.push({
          source_id: typeof edge.source_id === "string" ? edge.source_id : String(edge.source_id ?? ""),
          target_id: typeof edge.target_id === "string" ? edge.target_id : String(edge.target_id ?? ""),
          type,
          status: "failed",
          reason,
        });
        continue;
      }

      const source_id = sourceParsed.value;
      const target_id = targetParsed.value;

      if (!isValidEdgeType(type)) {
        edges_failed++;
        results.push({ source_id, target_id, type, status: "failed", reason: "invalid_type" });
        continue;
      }

      if (newEdgeAttempts >= limit) {
        remaining_edges++;
        continue;
      }

      await ensureIdsResolved(env, [source_id, target_id], existingIds, pendingIdLookups);

      if (!existingIds.has(source_id) || !existingIds.has(target_id)) {
        edges_failed++;
        results.push({ source_id, target_id, type, status: "failed", reason: "missing_endpoint" });
        continue;
      }

      const edgeKey = normalizedEdgeKey(source_id, target_id, type);
      if (!existingEdgeKeys.has(edgeKey)) {
        await mergeExistingEdgeKeys(env, [source_id, target_id], existingEdgeKeys);
      }
      if (existingEdgeKeys.has(edgeKey)) {
        edges_skipped++;
        continue;
      }

      const weightParsed = parseEdgeWeight(edge.weight);
      if (!weightParsed.ok) {
        edges_failed++;
        results.push({ source_id, target_id, type, status: "failed", reason: weightParsed.reason });
        continue;
      }

      newEdgeAttempts++;

      const provenance = edge.provenance && typeof edge.provenance === "string" && isValidProvenance(edge.provenance)
        ? edge.provenance
        : "explicit";

      pendingEdgeBatch.push({
        source_id,
        target_id,
        type,
        weight: weightParsed.value,
        provenance,
        created_at: typeof edge.created_at === "number" ? edge.created_at : Date.now(),
      });

      if (pendingEdgeBatch.length >= IMPORT_D1_BATCH_SIZE) {
        await flushEdgeBatch(env, pendingEdgeBatch.splice(0), existingEdgeKeys, results, edgeBatchCounters);
        edges_imported += edgeBatchCounters.imported;
        edges_failed += edgeBatchCounters.failed;
        edgeBatchCounters.imported = 0;
        edgeBatchCounters.failed = 0;
      }
    }

    if (pendingEdgeBatch.length) {
      await flushEdgeBatch(env, pendingEdgeBatch.splice(0), existingEdgeKeys, results, edgeBatchCounters);
      edges_imported += edgeBatchCounters.imported;
      edges_failed += edgeBatchCounters.failed;
    }
  }

  return {
    ok: true,
    imported,
    skipped,
    failed,
    edges_imported,
    edges_skipped,
    edges_failed,
    remaining_entries,
    remaining_edges,
    results,
    vectorize_hint: "POST /vectorize-pending until remaining is 0",
  };
}
