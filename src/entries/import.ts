import type { Env } from "../env";
import { createEdge, isValidEdgeType } from "../graph/edges";
import type { EdgeProvenance } from "../graph/types";
import { PROVENANCE_VALUES } from "../graph/types";

export type ImportEntryStatus = "imported" | "skipped" | "failed";
export type ImportEdgeStatus = "imported" | "failed";

export interface ImportEntryResult {
  id: string;
  status: ImportEntryStatus;
  reason?: string;
}

export interface ImportEdgeResult {
  source_id: string;
  target_id: string;
  type: string;
  status: ImportEdgeStatus;
  reason?: string;
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

export interface ImportSummary {
  ok: true;
  imported: number;
  skipped: number;
  failed: number;
  edges_imported: number;
  edges_failed: number;
  results: ImportResultItem[];
  vectorize_hint: string;
}

function isValidProvenance(p: string): p is EdgeProvenance {
  return (PROVENANCE_VALUES as readonly string[]).includes(p);
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

async function entryExists(env: Env, id: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT id FROM entries WHERE id = ?`).bind(id).first();
  return row !== null;
}

export async function importExportPayload(env: Env, body: ExportPayload): Promise<ImportSummary> {
  const results: ImportResultItem[] = [];
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  let edges_imported = 0;
  let edges_failed = 0;

  for (const entry of body.entries) {
    const id = entry.id?.trim();
    if (!id) {
      failed++;
      results.push({ id: String(entry.id ?? ""), status: "failed", reason: "missing_id" });
      continue;
    }
    const content = entry.content?.trim();
    if (!content) {
      failed++;
      results.push({ id, status: "failed", reason: "missing_content" });
      continue;
    }

    if (await entryExists(env, id)) {
      skipped++;
      results.push({ id, status: "skipped", reason: "already_exists" });
      continue;
    }

    const tags = Array.isArray(entry.tags) ? entry.tags : [];
    const source = entry.source?.trim() || "import";
    const created_at = typeof entry.created_at === "number" ? entry.created_at : Date.now();

    try {
      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, recall_count, importance_score, contradiction_wins, contradiction_losses) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id,
        content,
        JSON.stringify(tags),
        source,
        created_at,
        created_at,
        "[]",
        entry.recall_count ?? 0,
        entry.importance_score ?? 0,
        entry.contradiction_wins ?? 0,
        entry.contradiction_losses ?? 0,
      ).run();
      imported++;
      results.push({ id, status: "imported" });
    } catch {
      failed++;
      results.push({ id, status: "failed", reason: "insert_error" });
    }
  }

  for (const edge of body.edges ?? []) {
    const source_id = edge.source_id?.trim();
    const target_id = edge.target_id?.trim();
    const type = edge.type?.trim() || "relates_to";

    if (!source_id || !target_id) {
      edges_failed++;
      results.push({
        source_id: source_id ?? "",
        target_id: target_id ?? "",
        type,
        status: "failed",
        reason: "missing_endpoint",
      });
      continue;
    }

    if (!isValidEdgeType(type)) {
      edges_failed++;
      results.push({ source_id, target_id, type, status: "failed", reason: "invalid_type" });
      continue;
    }

    if (!(await entryExists(env, source_id)) || !(await entryExists(env, target_id))) {
      edges_failed++;
      results.push({ source_id, target_id, type, status: "failed", reason: "missing_endpoint" });
      continue;
    }

    const provenance = edge.provenance && isValidProvenance(edge.provenance)
      ? edge.provenance
      : "explicit";

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
  }

  return {
    ok: true,
    imported,
    skipped,
    failed,
    edges_imported,
    edges_failed,
    results,
    vectorize_hint: "POST /vectorize-pending until remaining is 0",
  };
}
