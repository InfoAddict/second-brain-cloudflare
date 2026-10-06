/**
 * Shared fixtures for Task B3's as-of tests (spec 14 5.7): a direct insert into entry_versions,
 * bypassing the write path so a test can pin its version history to exact, arbitrary timestamps.
 * Every inserted version is a full copy (`content` set, `prior_length` NULL — schema's own CHECK
 * constraint requires exactly one), which is enough for buildChain's `text(seq)` to resolve it with
 * no delta/UTF-16 machinery involved (see VersionChain.text in src/memory/versions.ts).
 */
import type { SqliteD1 } from "./sqlite-d1";

export interface VersionFixture {
  entryId: string;
  seq: number;
  content: string;
  createdAt: number;
  tags?: string[];
  workspaceId?: string;
  reason?: string;
  actorId?: string;
  /** e.g. `{ hold: { reasons: ["instruction"], score: 1, signals: [] } }` for a hold-transition version. */
  meta?: Record<string, unknown>;
}

export function insertVersion(sqlite: SqliteD1, v: VersionFixture): void {
  sqlite.db.prepare(
    `INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, state, actor_id, channel, reason, meta, valid_from, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, '{}', ?, 'rest', ?, ?, NULL, ?)`,
  ).bind(
    v.entryId, v.workspaceId ?? "", v.seq, v.content, JSON.stringify(v.tags ?? []), v.actorId ?? "", v.reason ?? "update",
    JSON.stringify(v.meta ?? {}), v.createdAt,
  ).run();
}

/** A `supersedes` edge from `sourceId` (the newer, replacing row) onto `targetId` (the older one it replaced). */
export function insertSupersedesEdge(sqlite: SqliteD1, id: string, sourceId: string, targetId: string, createdAt: number, workspaceId = ""): void {
  sqlite.db.prepare(
    `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, created_at, updated_at, workspace_id)
     VALUES (?, ?, ?, 'supersedes', 1, 'system', ?, ?, ?)`,
  ).bind(id, sourceId, targetId, createdAt, createdAt, workspaceId).run();
}

export function setWorkspace(sqlite: SqliteD1, id: string, workspaceId: string): void {
  sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(workspaceId, id).run();
}
