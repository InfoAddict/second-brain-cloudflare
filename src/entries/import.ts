import type { Env } from "../env";
import { createEdge, isValidEdgeType } from "../graph/edges";
import type { EdgeProvenance } from "../graph/types";
import { PROVENANCE_VALUES } from "../graph/types";

/** Max new entry inserts attempted per request (skipped rows do not count). */
export const IMPORT_DEFAULT_LIMIT = 100;
export const IMPORT_MAX_LIMIT = 1000;
/** D1 batch chunk size for inserts. */
export const IMPORT_D1_BATCH_SIZE = 50;

// Matches `main` schema today (no `updated_at` — add that column when #263 lands).
export const ENTRY_INSERT_COLUMNS = [
  "id",
  "content",
  "tags",
  "source",
  "created_at",
  "vector_ids",
  "recall_count",
  "importance_score",
  "contradiction_wins",
  "contradiction_losses",
] as const;

export const ENTRY_INSERT_SQL = `INSERT INTO entries (${ENTRY_INSERT_COLUMNS.join(", ")}) VALUES (${ENTRY_INSERT_COLUMNS.map(() => "?").join(", ")})`;

export type ImportEntryStatus = "imported" | "skipped" | "failed";
export type ImportEdgeStatus = "imported" | "failed";

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
  edges_failed: number;
  remaining_entries: number;
  remaining_edges: number;
  results: ImportResultItem[];
  vectorize_hint: string;
}

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

async function loadExistingIds(env: Env): Promise<Set<string>> {
  const { results } = await env.DB.prepare(`SELECT id FROM entries`).all() as { results: { id: string }[] };
  return new Set(results.map(r => r.id));
}

function bindInsert(env: Env, row: PendingInsert) {
  return env.DB.prepare(ENTRY_INSERT_SQL).bind(
    row.id,
    row.content,
    JSON.stringify(row.tags),
    row.source,
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
  let edges_failed = 0;
  let remaining_entries = 0;
  let remaining_edges = 0;

  const existingIds = await loadExistingIds(env);
  const pendingBatch: PendingInsert[] = [];
  let newInsertAttempts = 0;
  const batchCounters = { imported: 0, failed: 0 };

  for (const entry of body.entries) {
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

    if (existingIds.has(id)) {
      skipped++;
      results.push({ id, status: "skipped", reason: "already_exists" });
      continue;
    }

    const tags = Array.isArray(entry.tags) ? entry.tags : [];
    let source = "import";
    if (entry.source !== undefined && entry.source !== null) {
      if (typeof entry.source !== "string") {
        failed++;
        results.push({ id, status: "failed", reason: "invalid_source" });
        continue;
      }
      source = entry.source.trim() || "import";
    }

    if (newInsertAttempts >= limit) {
      remaining_entries++;
      continue;
    }
    newInsertAttempts++;

    const created_at = typeof entry.created_at === "number" ? entry.created_at : Date.now();

    pendingBatch.push({
      id,
      content: contentParsed.value,
      tags,
      source,
      created_at,
      recall_count: entry.recall_count ?? 0,
      importance_score: entry.importance_score ?? 0,
      contradiction_wins: entry.contradiction_wins ?? 0,
      contradiction_losses: entry.contradiction_losses ?? 0,
    });

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

  const edges = body.edges ?? [];
  if (remaining_entries > 0) {
    remaining_edges = edges.length;
  } else {
    for (const edge of edges) {
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

      if (!existingIds.has(source_id) || !existingIds.has(target_id)) {
        edges_failed++;
        results.push({ source_id, target_id, type, status: "failed", reason: "missing_endpoint" });
        continue;
      }

      const provenance = edge.provenance && typeof edge.provenance === "string" && isValidProvenance(edge.provenance)
        ? edge.provenance
        : "explicit";

      try {
        const created = await createEdge(source_id, target_id, type, {
          weight: edge.weight,
          provenance,
        }, env);
        if (!created) {
          edges_failed++;
          results.push({ source_id, target_id, type, status: "failed", reason: "create_failed" });
          continue;
        }
        edges_imported++;
        results.push({ source_id, target_id, type, status: "imported" });
      } catch (e) {
        edges_failed++;
        results.push({
          source_id,
          target_id,
          type,
          status: "failed",
          reason: "create_failed",
          detail: formatDbError(e),
        });
      }
    }
  }

  return {
    ok: true,
    imported,
    skipped,
    failed,
    edges_imported,
    edges_failed,
    remaining_entries,
    remaining_edges,
    results,
    vectorize_hint: "POST /vectorize-pending until remaining is 0",
  };
}
