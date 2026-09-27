import { describe, expect, it } from "vitest";
import { bucketFor, calibrate, type DecisionOutcomeRow } from "../../src/decisions/calibration";
import { buildDecisionCapture, computeReviewAt, reviewLabel } from "../../src/decisions/capture";
import { zonedTimeMs } from "../../src/when/timezone";
import { calibrationQuery, decisionsActionable, parseDecisionOutcomeRow } from "../../src/decisions/queries";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import type { Identity } from "../../src/lib/identity";
import { scopeWhere } from "../../src/lib/scope";

const gates = { CALIBRATION_MIN_N: 10, CALIBRATION_MIN_BUCKET_N: 5, CALIBRATION_MIN_TOPIC_N: 5 };
const row = (confidence: number, outcome: "right" | "wrong"): DecisionOutcomeRow =>
  ({ confidence, source: "stated", outcome, tags: [] });

describe("Track 7 lane B review reproductions", () => {
  it("keeps empty and n=1 calibration unready, and rounds bucket edges in hundredths", () => {
    expect(calibrate([], gates)).toMatchObject({ ready: false, n: 0 });
    expect(calibrate([row(0.7, "right")], gates)).toMatchObject({ ready: false, n: 1 });
    expect(bucketFor(0.595)).toBe("60-69");
    expect(bucketFor(0.6)).toBe("60-69");
    expect(bucketFor(0.695)).toBe("70-79");
    expect(bucketFor(0.7)).toBe("70-79");
  });

  it("keeps all-stated and all-inferred sample counts attached to their own lines", () => {
    const stated = calibrate(Array.from({ length: 10 }, () => row(0.9, "wrong")), gates);
    const inferred = calibrate(Array.from({ length: 10 }, () => ({
      ...row(0.9, "wrong"), source: "inferred" as const,
    })), gates);
    expect(stated).toMatchObject({ ready: true, nStated: 10, nInferred: 0 });
    expect(inferred).toMatchObject({ ready: true, nStated: 0, nInferred: 10 });
    if (stated.ready) expect(stated.line).not.toContain("estimated from your wording");
    if (inferred.ready) expect(inferred.line).toContain("For 10 of them");
  });

  it("does not headline a bucket below the five-decision disclosure gate", () => {
    const rows = [0.5, 0.6, 0.7, 0.8, 0.9].flatMap(p => [row(p, "wrong"), row(p, "wrong")]);
    const result = calibrate(rows, gates);
    expect(result.ready).toBe(true);
    if (result.ready) {
      expect(result.buckets.every(bucket => !bucket.shown)).toBe(true);
      expect(result.line).not.toMatch(/\d+% calls came true/);
    }
  });

  it("breaks a headline-bucket count tie toward the higher confidence bucket", () => {
    const result = calibrate([
      ...Array.from({ length: 5 }, () => row(0.7, "wrong")),
      ...Array.from({ length: 5 }, () => row(0.9, "wrong")),
    ], gates);
    expect(result.ready).toBe(true);
    if (result.ready) expect(result.headlineBucket).toBe("90-95");
  });

  it("adds local calendar days across spring DST before anchoring at 09:00", () => {
    const now = zonedTimeMs(2026, 2, 7, 23, 30, 0, "America/New_York");
    const result = computeReviewAt({ now, timezone: "America/New_York", days: 2 });
    expect(result).toEqual({ at: zonedTimeMs(2026, 2, 9, 9, 0, 0, "America/New_York") });
  });

  it("does not double the prefix on an existing decision row's stored review label", () => {
    expect(reviewLabel("Review: hiring Dana")).toBe("Review: hiring Dana");
  });

  // The due-sheet cue for a bare decision label is covered in the SH lane by 690bf50a, which owns public/js/due.js.

  it("states that nothing was saved when an explicit review date is invalid", () => {
    const result = buildDecisionCapture(
      { decision: true, review_by: "next Thursday" },
      "Hire Dana", Date.UTC(2026, 8, 27), { reviewDefaultDays: 90, timezone: "UTC" },
    );
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("Nothing was saved.");
  });

  it("counts ten scored decisions even when 500 newer unknown outcomes occupy the query cap", async () => {
    const db = makeSqliteD1();
    try {
      for (let i = 0; i < 10; i++) db.seed({
        id: `scored-${i}`, content: "decision", createdAt: i,
        tags: ["ledger:decision", "confidence:0.70", "confidence-source:stated", "outcome:right"],
      });
      for (let i = 0; i < 500; i++) db.seed({
        id: `unknown-${i}`, content: "decision", createdAt: 1000 + i,
        tags: ["ledger:decision", "outcome:unknown"],
      });
      db.db.prepare("UPDATE entries SET workspace_id = 'personal', actor_id = 'u1'").run();
      const auth: Identity = {
        userId: "u1", role: "member", personalWorkspaceId: "personal",
        companyWorkspaceIds: [], defaultShare: "",
      };
      const { sql, bindings } = calibrationQuery(
        { clause: "workspace_id = ?", bindings: ["personal"] }, decisionsActionable(auth),
      );
      const queryRows = (await db.db.prepare(sql).bind(...bindings).all()).results as { tags: string }[];
      expect(queryRows).toHaveLength(500);
      const result = calibrate(queryRows.map(r => parseDecisionOutcomeRow(r.tags)), gates);
      expect(result.n).toBe(10);
    } finally {
      db.close();
    }
  });

  it("keeps calibration reads within D1's 100 bound-parameter limit for multi-team members", () => {
    const auth: Identity = {
      userId: "u1", role: "member", personalWorkspaceId: "personal",
      companyWorkspaceIds: Array.from({ length: 99 }, (_, i) => `team-${i}`), defaultShare: "",
    };
    const query = calibrationQuery(scopeWhere(auth), decisionsActionable(auth));
    expect(query.bindings.length).toBeLessThanOrEqual(100);
  });
});
