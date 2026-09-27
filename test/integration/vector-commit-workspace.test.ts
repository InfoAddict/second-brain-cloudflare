import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { resolveIdentityByUserId } from "../../src/lib/identity";
import { moveEntry } from "../../src/capture/share";
import { runNightlyVectorizePending } from "../../src/vectorize/pending";
import { runBatch } from "../../src/migration/embedding";
import { restoreRowVectors } from "../../src/capture/store";
import { DEFAULTS } from "../../src/config";
import { writerSpans } from "../../scripts/check-scope.mjs";

// T-0089.1.1 close-out round 5: a vector_ids write commits only if the row still has the content AND
// the workspace its vectors were stamped for; otherwise the stale upload is deleted (the row stays
// pending) or, if another writer committed meanwhile, the row is repaired as it stands.

let t: TrashEnv;
afterEach(() => { t?.close(); vi.restoreAllMocks(); });

const OLD = Date.now() - 60 * 60_000;
const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };
const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;
const indexed = async (id: string) =>
  JSON.parse((await t.one<{ vector_ids: string }>(`SELECT vector_ids FROM entries WHERE id = ?`, id))!.vector_ids).length > 0;

/** Shares `id` to the company workspace right after the first Vectorize upsert; records stamps and deletes. */
async function moveDuringUpload(id: string) {
  const owner = (await resolveIdentityByUserId(t.env, t.roots.ownerUserId))!;
  const stamped: { id: string; ws: string }[] = [];
  const deleted: string[] = [];
  const up = t.env.VECTORIZE.upsert.bind(t.env.VECTORIZE);
  const del = t.env.VECTORIZE.deleteByIds.bind(t.env.VECTORIZE);
  let moved = false;
  (t.env.VECTORIZE as any).upsert = async (vs: any[]) => {
    stamped.push(...vs.map((v) => ({ id: v.id, ws: v.metadata.workspace_id })));
    const r = await up(vs);
    if (!moved) { moved = true; expect((await moveEntry(id, "company", t.env, owner, { actorId: owner.userId, channel: "rest" })).status).toBe("shared"); }
    return r;
  };
  (t.env.VECTORIZE as any).deleteByIds = async (ids: string[]) => { deleted.push(...ids); return del(ids); };
  return { stamped, deleted, moved: () => moved };
}

describe("vector_ids commits check workspace and content", () => {
  it("POST /vectorize-pending: a row shared mid-embed keeps pending and the stale upload is deleted", async () => {
    t = await makeTrashEnv();
    t.seed("m", { content: "moving fact", created_at: OLD });
    const race = await moveDuringUpload("m");
    const res = await worker.fetch(new Request("http://localhost/vectorize-pending", { method: "POST", headers }), t.env, ctx);
    expect(race.moved()).toBe(true);
    expect(await res.json()).toMatchObject({ processed: 0, failed: 1 });
    expect(await indexed("m")).toBe(false);
    expect(race.deleted).toEqual(expect.arrayContaining(race.stamped.map((s) => s.id)));
  });

  it("migration re-embed: a row shared mid-embed is not counted done, and no vector it lists is left stamped for the old workspace", async () => {
    t = await makeTrashEnv();
    // A migration row already lists its (deterministic) ids, so the lost commit repairs it in place
    // under its current workspace instead of deleting vectors the row points at.
    t.seed("m", { content: "moving fact", created_at: OLD, vector_ids: '["m"]' });
    const race = await moveDuringUpload("m");
    const result = await runBatch(t.env, DEFAULTS);
    expect(race.moved()).toBe(true);
    expect(result.processed).toBe(0);
    const listed = JSON.parse((await t.one<{ vector_ids: string }>(`SELECT vector_ids FROM entries WHERE id = 'm'`))!.vector_ids) as string[];
    const last = new Map(race.stamped.map((x) => [x.id, x.ws]));
    for (const id of listed) if (!race.deleted.includes(id)) expect(last.get(id), id).toBe(t.roots.companyWorkspaceId);
  });

  it("restoreRowVectors: a move during its re-embed ends with vectors stamped for the row's current workspace", async () => {
    t = await makeTrashEnv();
    t.seed("r", { content: "repaired fact", created_at: OLD, vector_ids: '["r"]' });
    const race = await moveDuringUpload("r");
    await restoreRowVectors(t.env, "r", [], [], "api", DEFAULTS, { workspaceId: t.roots.ownerPersonalWorkspaceId, actorId: t.roots.ownerUserId });
    expect(race.moved()).toBe(true);
    const row = (await t.one<{ vector_ids: string; workspace_id: string }>(`SELECT vector_ids, workspace_id FROM entries WHERE id = 'r'`))!;
    expect(row.workspace_id).toBe(t.roots.companyWorkspaceId);
    const listed = JSON.parse(row.vector_ids) as string[];
    const last = new Map(race.stamped.map((s) => [s.id, s.ws]));
    for (const id of listed) expect(last.get(id), id).toBe(t.roots.companyWorkspaceId);
  });
});

describe("structural", () => {
  const SRC = join(__dirname, "../../src");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
  const all = files(SRC).map((p) => ({ file: p.slice(SRC.length + 1), src: readFileSync(p, "utf8") }));

  it("every UPDATE that writes new vector_ids pins the row's workspace_id (literally, or through a CAS guard that includes it)", () => {
    const sites: string[] = [];
    for (const f of all) {
      // The same template-literal lexer check:scope and the write-path inventory use (nested templates included).
      for (const span of writerSpans(f.src) as { start: number; end: number }[]) {
        const sql = f.src.slice(span.start + 1, span.end);
        if (!/^\s*UPDATE entries\b/.test(sql)) continue;
        const set = sql.split(/\bWHERE\b/)[0];
        if (!/\bvector_ids\s*=/.test(set) || /\bvector_ids\s*=\s*'\[\]'/.test(set)) continue;
        sites.push(f.file);
        const where = sql.slice(sql.search(/\bWHERE\b/));
        const guardVar = /buildCasGuard\(\w+, (\w+)\)/.exec(where)?.[1];
        const guardHasWorkspace = guardVar ? new RegExp(`const ${guardVar} = \\{[^}]*workspace_id:`).test(f.src) : false;
        const ok = /workspace_id = \?/.test(where) || guardHasWorkspace || /\$\{workspaceGuard\(/.test(where);
        expect(ok, `${f.file}: ${sql.slice(0, 100)}`).toBe(true);
      }
    }
    expect(sites.length).toBeGreaterThanOrEqual(10);
  });

});
