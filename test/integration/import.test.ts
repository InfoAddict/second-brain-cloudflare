import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function seedEntry(
  db: D1Mock,
  id: string,
  content: string,
  tags: string[] = [],
  created_at = 1000,
  opts: { source?: string; vector_ids?: string; recall_count?: number; importance_score?: number } = {},
) {
  db.entries.push({
    id,
    content,
    tags: JSON.stringify(tags),
    source: opts.source ?? "api",
    created_at,
    updated_at: created_at,
    vector_ids: opts.vector_ids ?? '["v1"]',
    recall_count: opts.recall_count ?? 0,
    importance_score: opts.importance_score ?? 0,
    contradiction_wins: 0,
    contradiction_losses: 0,
  });
}

function exportPayload(db: D1Mock) {
  return {
    version: 2,
    entries: db.entries.map(e => ({
      id: e.id,
      content: e.content,
      tags: JSON.parse(e.tags ?? "[]"),
      source: e.source,
      created_at: e.created_at,
      recall_count: e.recall_count ?? 0,
      importance_score: e.importance_score ?? 0,
      contradiction_wins: e.contradiction_wins ?? 0,
      contradiction_losses: e.contradiction_losses ?? 0,
    })),
    edges: db.edges.map(e => ({
      source_id: e.source_id,
      target_id: e.target_id,
      type: e.type,
      weight: e.weight,
      provenance: e.provenance,
      created_at: e.created_at,
    })),
  };
}

describe("POST /import", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("requires auth", async () => {
    const res = await worker.fetch(req("POST", "/import", { body: { version: 2, entries: [] }, token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("rejects invalid version", async () => {
    const res = await worker.fetch(req("POST", "/import", { body: { version: 1, entries: [] } }), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toMatch(/version must be 2/);
  });

  it("rejects missing entries array", async () => {
    const res = await worker.fetch(req("POST", "/import", { body: { version: 2 } }), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toMatch(/entries must be an array/);
  });

  it("round-trips export payload into an empty brain", async () => {
    seedEntry(db, "a", "Memory A", ["work", "kind:semantic"], 5000, { source: "phone", recall_count: 3, importance_score: 4 });
    seedEntry(db, "b", "Memory B", ["idea"], 4000);
    db.edges.push({ id: "edge-1", source_id: "a", target_id: "b", type: "relates_to", weight: 0.7, provenance: "inferred", metadata: "{}", created_at: 1, updated_at: 1 });

    const payload = exportPayload(db);
    db.reset();

    const res = await worker.fetch(req("POST", "/import", { body: payload }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.imported).toBe(2);
    expect(data.skipped).toBe(0);
    expect(data.failed).toBe(0);
    expect(data.edges_imported).toBe(1);
    expect(data.edges_failed).toBe(0);
    expect(data.remaining_entries).toBe(0);
    expect(data.remaining_edges).toBe(0);
    expect(data.vectorize_hint).toMatch(/vectorize-pending/);

    const a = db.entries.find(e => e.id === "a")!;
    expect(a.content).toBe("Memory A");
    expect(JSON.parse(a.tags)).toEqual(["work", "kind:semantic"]);
    expect(a.source).toBe("phone");
    expect(a.created_at).toBe(5000);
    expect(a.updated_at).toBe(5000);
    expect(a.recall_count).toBe(3);
    expect(a.importance_score).toBe(4);
    expect(a.vector_ids).toBe("[]");

    expect(db.edges).toHaveLength(1);
    expect(db.edges[0]).toMatchObject({ source_id: "a", target_id: "b", type: "relates_to", metadata: "{}" });
    expect(db.edges[0].created_at).toBe(1);
  });

  it("is idempotent — second import skips all entries", async () => {
    const payload = {
      version: 2,
      entries: [{ id: "x", content: "Note", tags: ["t"], source: "api", created_at: 100 }],
      edges: [],
    };

    const first = await worker.fetch(req("POST", "/import", { body: payload }), env, ctx);
    const firstData = await first.json() as any;
    expect(firstData.imported).toBe(1);

    const second = await worker.fetch(req("POST", "/import", { body: payload }), env, ctx);
    const secondData = await second.json() as any;
    expect(secondData.imported).toBe(0);
    expect(secondData.skipped).toBe(1);
    expect(secondData.results).toHaveLength(0);
    expect(db.entries).toHaveLength(1);
  });

  it("fails edges with missing endpoints but still imports entries", async () => {
    const payload = {
      version: 2,
      entries: [{ id: "a", content: "Only A", created_at: 1 }],
      edges: [{ source_id: "a", target_id: "missing", type: "relates_to" }],
    };

    const res = await worker.fetch(req("POST", "/import", { body: payload }), env, ctx);
    const data = await res.json() as any;
    expect(data.imported).toBe(1);
    expect(data.edges_imported).toBe(0);
    expect(data.edges_failed).toBe(1);
    expect(data.results).toContainEqual(expect.objectContaining({
      source_id: "a",
      target_id: "missing",
      status: "failed",
      reason: "missing_endpoint",
    }));
  });

  it("does not trigger capture duplicate detection for similar content with a new id", async () => {
    seedEntry(db, "existing", "The quick brown fox jumps over the lazy dog", ["note"]);

    const payload = {
      version: 2,
      entries: [{ id: "new-id", content: "The quick brown fox jumps over the lazy dog", tags: ["note"], created_at: 2000 }],
      edges: [],
    };

    const res = await worker.fetch(req("POST", "/import", { body: payload }), env, ctx);
    const data = await res.json() as any;
    expect(data.imported).toBe(1);
    expect(db.entries).toHaveLength(2);
    expect(db.entries.find(e => e.id === "new-id")?.vector_ids).toBe("[]");
  });

  it("reports failed entries with missing content", async () => {
    const res = await worker.fetch(req("POST", "/import", {
      body: { version: 2, entries: [{ id: "bad", content: "  " }], edges: [] },
    }), env, ctx);
    const data = await res.json() as any;
    expect(data.failed).toBe(1);
    expect(data.results).toContainEqual({ id: "bad", status: "failed", reason: "missing_content" });
  });

  it("reports invalid_id for non-string ids without aborting the request", async () => {
    const res = await worker.fetch(req("POST", "/import", {
      body: {
        version: 2,
        entries: [
          { id: 123, content: "bad id type" },
          { id: "good", content: "valid entry", created_at: 1 },
        ],
        edges: [],
      },
    }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.failed).toBe(1);
    expect(data.imported).toBe(1);
    expect(data.results).toContainEqual({ id: "123", status: "failed", reason: "invalid_id" });
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].id).toBe("good");
  });

  it("respects ?limit= and reports remaining_entries", async () => {
    const payload = {
      version: 2,
      entries: [
        { id: "e1", content: "One", created_at: 1 },
        { id: "e2", content: "Two", created_at: 2 },
        { id: "e3", content: "Three", created_at: 3 },
      ],
      edges: [],
    };

    const first = await worker.fetch(req("POST", "/import?limit=1", { body: payload }), env, ctx);
    const firstData = await first.json() as any;
    expect(firstData.imported).toBe(1);
    expect(firstData.remaining_entries).toBe(2);

    const second = await worker.fetch(req("POST", "/import?limit=10", { body: payload }), env, ctx);
    const secondData = await second.json() as any;
    expect(secondData.imported).toBe(2);
    expect(secondData.skipped).toBe(1);
    expect(secondData.remaining_entries).toBe(0);
    expect(db.entries).toHaveLength(3);
  });

  it("defers edges until all entries are processed", async () => {
    const payload = {
      version: 2,
      entries: [
        { id: "a", content: "A", created_at: 1 },
        { id: "b", content: "B", created_at: 2 },
      ],
      edges: [{ source_id: "a", target_id: "b", type: "relates_to" }],
    };

    const partial = await worker.fetch(req("POST", "/import?limit=1", { body: payload }), env, ctx);
    const partialData = await partial.json() as any;
    expect(partialData.imported).toBe(1);
    expect(partialData.remaining_entries).toBe(1);
    expect(partialData.remaining_edges).toBe(1);
    expect(partialData.edges_imported).toBe(0);
    expect(db.edges).toHaveLength(0);

    const finish = await worker.fetch(req("POST", "/import", { body: payload }), env, ctx);
    const finishData = await finish.json() as any;
    expect(finishData.edges_imported).toBe(1);
    expect(db.edges).toHaveLength(1);
  });

  it("rejects null entries without aborting the request", async () => {
    const res = await worker.fetch(req("POST", "/import", {
      body: {
        version: 2,
        entries: [null, { id: "good", content: "valid", created_at: 1 }],
        edges: [],
      },
    }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.failed).toBe(1);
    expect(data.imported).toBe(1);
    expect(data.results).toContainEqual({ id: "", status: "failed", reason: "invalid_entry" });
    expect(db.entries).toHaveLength(1);
  });

  it("rejects non-string tags", async () => {
    const res = await worker.fetch(req("POST", "/import", {
      body: {
        version: 2,
        entries: [{ id: "bad", content: "Note", tags: [42], created_at: 1 }],
        edges: [],
      },
    }), env, ctx);
    const data = await res.json() as any;
    expect(data.failed).toBe(1);
    expect(data.results).toContainEqual({ id: "bad", status: "failed", reason: "invalid_tag" });
    expect(db.entries).toHaveLength(0);
  });

  it("paginates edges under ?limit= with idempotent skip", async () => {
    const entries = [
      { id: "a", content: "A", created_at: 1 },
      { id: "b", content: "B", created_at: 2 },
      { id: "c", content: "C", created_at: 3 },
    ];
    const edges = [
      { source_id: "a", target_id: "b", type: "relates_to", created_at: 100 },
      { source_id: "b", target_id: "c", type: "relates_to", created_at: 200 },
    ];

    const seedEntries = await worker.fetch(req("POST", "/import", {
      body: { version: 2, entries, edges: [] },
    }), env, ctx);
    expect((await seedEntries.json() as any).imported).toBe(3);

    const payload = { version: 2, entries, edges };

    const firstEdge = await worker.fetch(req("POST", "/import?limit=1", { body: payload }), env, ctx);
    const firstEdgeData = await firstEdge.json() as any;
    expect(firstEdgeData.skipped).toBe(3);
    expect(firstEdgeData.edges_imported).toBe(1);
    expect(firstEdgeData.remaining_edges).toBe(1);
    expect(firstEdgeData.results).toHaveLength(1);
    expect(db.edges).toHaveLength(1);
    expect(db.edges[0].created_at).toBe(100);

    const secondEdge = await worker.fetch(req("POST", "/import?limit=1", { body: payload }), env, ctx);
    const secondEdgeData = await secondEdge.json() as any;
    expect(secondEdgeData.edges_imported).toBe(1);
    expect(secondEdgeData.edges_skipped).toBe(1);
    expect(secondEdgeData.remaining_edges).toBe(0);
    expect(db.edges).toHaveLength(2);
    expect(db.edges.find((e: any) => e.source_id === "b" && e.target_id === "c")?.created_at).toBe(200);
  });

  it("reports invalid_recall_count without aborting the request", async () => {
    const res = await worker.fetch(req("POST", "/import", {
      body: {
        version: 2,
        entries: [
          { id: "bad", content: "Note", recall_count: "lots", created_at: 1 },
          { id: "good", content: "valid", created_at: 2 },
        ],
        edges: [],
      },
    }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.failed).toBe(1);
    expect(data.imported).toBe(1);
    expect(data.results).toContainEqual({ id: "bad", status: "failed", reason: "invalid_recall_count" });
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].id).toBe("good");
  });

  it("imports edges when endpoints were imported in a prior request", async () => {
    const entriesRes = await worker.fetch(req("POST", "/import", {
      body: {
        version: 2,
        entries: [
          { id: "a", content: "Memory A", created_at: 1 },
          { id: "b", content: "Memory B", created_at: 2 },
        ],
        edges: [],
      },
    }), env, ctx);
    expect((await entriesRes.json() as any).imported).toBe(2);

    const edgesRes = await worker.fetch(req("POST", "/import", {
      body: {
        version: 2,
        entries: [],
        edges: [{ source_id: "a", target_id: "b", type: "relates_to", created_at: 100 }],
      },
    }), env, ctx);
    expect(edgesRes.status).toBe(200);
    const edgeData = await edgesRes.json() as any;
    expect(edgeData.edges_imported).toBe(1);
    expect(edgeData.edges_failed).toBe(0);
    expect(db.edges).toHaveLength(1);
  });

  it("imports edges when the payload has more than 50 distinct endpoints", async () => {
    const entries = Array.from({ length: 52 }, (_, i) => ({
      id: `n${i}`,
      content: `Memory ${i}`,
      created_at: i + 1,
    }));
    const edges = Array.from({ length: 51 }, (_, i) => ({
      source_id: `n${i}`,
      target_id: `n${i + 1}`,
      type: "relates_to",
      created_at: 1000 + i,
    }));

    const res = await worker.fetch(req("POST", "/import?limit=100", { body: { version: 2, entries, edges } }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.imported).toBe(52);
    expect(data.edges_imported).toBe(51);
    expect(data.edges_failed).toBe(0);
    expect(db.edges).toHaveLength(51);
  });
});
