/**
 * The calibration read (src/decisions/queries.ts): the SQL builder, and its
 * row parser feeding straight into src/decisions/calibration.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { calibrationQuery, decisionsActionable, parseDecisionOutcomeRow } from "../../src/decisions/queries";
import { calibrate } from "../../src/decisions/calibration";
import type { Identity } from "../../src/lib/identity";
import type { ScopeClause } from "../../src/lib/scope";

let sq: SqliteD1 | null = null;
afterEach(() => {
  sq?.close();
  sq = null;
});

const GATES = { CALIBRATION_MIN_N: 10, CALIBRATION_MIN_BUCKET_N: 5, CALIBRATION_MIN_TOPIC_N: 5 };

const AUTH: Identity = {
  userId: "u1",
  role: "member",
  personalWorkspaceId: "ws-personal",
  companyWorkspaceIds: ["ws-company"],
  defaultShare: "",
};

const READ_SCOPE: ScopeClause = { clause: "workspace_id IN (?, ?)", bindings: ["ws-personal", "ws-company"] };

function seedDecision(
  s: SqliteD1,
  id: string,
  opts: { workspaceId?: string; actorId?: string; confidence?: number; source?: "stated" | "inferred"; outcome?: string; extraTags?: string[]; deprecated?: boolean },
) {
  const tags = ["ledger:decision", ...(opts.extraTags ?? [])];
  if (opts.confidence !== undefined) tags.push(`confidence:${opts.confidence.toFixed(2)}`);
  if (opts.source) tags.push(`confidence-source:${opts.source}`);
  if (opts.outcome) tags.push(`outcome:${opts.outcome}`);
  if (opts.deprecated) tags.push("status:deprecated");
  s.seed({ id, content: "a decision", createdAt: Date.now(), tags, source: "api" });
  if (opts.workspaceId || opts.actorId) {
    s.db.prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = ?`)
      .bind(opts.workspaceId ?? "", opts.actorId ?? "", id).run();
  }
}

describe("calibrationQuery", () => {
  it("uses the ledger tag expression, excludes deprecated rows, prioritizes scored outcomes, and carries the actionable clause", () => {
    const { sql, bindings } = calibrationQuery(READ_SCOPE, decisionsActionable(AUTH));
    expect(sql).toContain(`instr(lower(tags), '"ledger:decision"') > 0`);
    expect(sql).toContain(`tags LIKE '%"outcome:%'`);
    expect(sql).toContain(`tags NOT LIKE '%"status:deprecated"%'`);
    expect(sql).toContain(`ORDER BY (tags LIKE '%"outcome:unknown"%') ASC, created_at DESC`);
    expect(sql).toContain("(workspace_id IN (?, '') OR actor_id = ?)");
    expect(bindings).toEqual([JSON.stringify(READ_SCOPE.bindings), AUTH.personalWorkspaceId, AUTH.userId]);
  });

  it("collapses a multi-binding scope IN-list into one json_each binding, so total bindings never grow with team count", () => {
    const { sql, bindings } = calibrationQuery(READ_SCOPE, decisionsActionable(AUTH));
    expect(sql).toContain("workspace_id IN (SELECT value FROM json_each(?))");
    expect(sql).not.toContain(READ_SCOPE.clause);
    expect(bindings[0]).toBe(JSON.stringify(READ_SCOPE.bindings));
  });

  it("leaves a single-binding scope clause (a specific teamId) unchanged", () => {
    const teamScope: ScopeClause = { clause: "workspace_id = ?", bindings: ["ws-company"] };
    const { sql, bindings } = calibrationQuery(teamScope, decisionsActionable(AUTH));
    expect(sql).toContain("AND workspace_id = ? AND (workspace_id IN");
    expect(sql).not.toContain("SELECT value FROM json_each");
    expect(bindings).toEqual(["ws-company", AUTH.personalWorkspaceId, AUTH.userId]);
  });

  it("uses idx_entries_ledger (EXPLAIN QUERY PLAN)", async () => {
    sq = makeSqliteD1();
    const { sql, bindings } = calibrationQuery(READ_SCOPE, decisionsActionable(AUTH));
    const rows = (await sq.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...bindings).all())
      .results as { detail: string }[];
    const plan = rows.map(r => r.detail).join("\n");
    expect(plan).toContain("idx_entries_ledger");
  });
});

describe("decisionsActionable", () => {
  it("is the caller's personal workspace, or any workspace where they are the author", () => {
    const scope = decisionsActionable(AUTH);
    expect(scope.clause).toBe("(workspace_id IN (?, '') OR actor_id = ?)");
    expect(scope.bindings).toEqual(["ws-personal", "u1"]);
  });
});

describe("the calibration read against real SQLite", () => {
  it("reads only the caller's own decisions, never a teammate's, and feeds calibrate() correctly", async () => {
    sq = makeSqliteD1();
    // 10 of the caller's own resolved decisions, split 6 right / 4 wrong at 0.7.
    for (let i = 0; i < 6; i++) {
      seedDecision(sq, `mine-right-${i}`, { workspaceId: "ws-personal", actorId: "u1", confidence: 0.7, source: "stated", outcome: "right" });
    }
    for (let i = 0; i < 4; i++) {
      seedDecision(sq, `mine-wrong-${i}`, { workspaceId: "ws-personal", actorId: "u1", confidence: 0.7, source: "stated", outcome: "wrong" });
    }
    // A teammate's company decision: same company workspace, different author — must not count.
    seedDecision(sq, "teammate-1", { workspaceId: "ws-company", actorId: "u2", confidence: 0.9, source: "stated", outcome: "right" });
    // An unresolved decision of the caller's — no outcome tag, must be excluded by the query itself.
    seedDecision(sq, "mine-open", { workspaceId: "ws-personal", actorId: "u1", confidence: 0.6, source: "stated" });
    // A deprecated one of the caller's — must be excluded.
    seedDecision(sq, "mine-deprecated", { workspaceId: "ws-personal", actorId: "u1", confidence: 0.6, source: "stated", outcome: "right", deprecated: true });

    const { sql, bindings } = calibrationQuery(READ_SCOPE, decisionsActionable(AUTH));
    const { results } = (await sq.db.prepare(sql).bind(...bindings).all()) as { results: { tags: string }[] };

    expect(results.length).toBe(10);
    const rows = results.map((r) => parseDecisionOutcomeRow(r.tags));
    const result = calibrate(rows, GATES);
    expect(result.ready).toBe(true);
    if (result.ready) {
      expect(result.n).toBe(10);
      expect(result.nStated).toBe(10);
    }
  });
});

describe("parseDecisionOutcomeRow", () => {
  it("extracts confidence, source, outcome and keeps every tag for topic detection", () => {
    const row = parseDecisionOutcomeRow(JSON.stringify(["ledger:decision", "confidence:0.70", "confidence-source:stated", "outcome:right", "hiring"]));
    expect(row).toEqual({ confidence: 0.7, source: "stated", outcome: "right", tags: ["ledger:decision", "confidence:0.70", "confidence-source:stated", "outcome:right", "hiring"] });
  });

  it("is null-shaped when a decision has no confidence or outcome yet", () => {
    const row = parseDecisionOutcomeRow(JSON.stringify(["ledger:decision"]));
    expect(row.confidence).toBeNull();
    expect(row.source).toBeNull();
    expect(row.outcome).toBeNull();
  });

  it("ignores an unknown outcome value rather than throwing", () => {
    const row = parseDecisionOutcomeRow(JSON.stringify(["ledger:decision", "outcome:not-a-real-value"]));
    expect(row.outcome).toBeNull();
  });
});
