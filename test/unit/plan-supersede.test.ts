/** Track 2 Task A2 (T-0089.2.1): supersede plans by interval, not arrival order (spec 14 P4, 5.3). */
import { describe, it, expect } from "vitest";
import { planSupersede, type Window } from "../../src/memory/validity";

const w = (id: string, from: number, until: number | null = null, status: Window["status"] = null): Window =>
  ({ id, from, until, workspaceId: "w", status });

describe("planSupersede", () => {
  it("normal update: the newer fact starts later and the older one is open, so the older closes at the newer start", () => {
    expect(planSupersede(w("old", 100), w("new", 200))).toEqual({ action: "close-older", olderId: "old", at: 200 });
  });

  it("normal update over an older window that ends after the newer start closes it earlier", () => {
    expect(planSupersede(w("old", 100, 500), w("new", 200))).toEqual({ action: "close-older", olderId: "old", at: 200 });
  });

  it("an older fact that already ended before the newcomer began is left alone", () => {
    expect(planSupersede(w("old", 100, 200), w("new", 200))).toEqual({ action: "none", reason: "already-closed-earlier" });
    expect(planSupersede(w("old", 100, 150), w("new", 200))).toEqual({ action: "none", reason: "already-closed-earlier" });
  });

  it("a late-told older fact closes the newcomer at the older start", () => {
    // "I lived in Boston since 2018", told after "I live in Denver (since 2024)".
    expect(planSupersede(w("denver", 2024), w("boston", 2018))).toEqual({ action: "close-newer", newerId: "boston", at: 2024 });
  });

  it("a late-told fact whose stated end reaches past the older start still closes at the older start", () => {
    expect(planSupersede(w("denver", 2024), w("boston", 2018, 2025))).toEqual({ action: "close-newer", newerId: "boston", at: 2024 });
  });

  it("disjoint stated windows change nothing", () => {
    expect(planSupersede(w("denver", 2024), w("boston", 2018, 2020))).toEqual({ action: "none", reason: "disjoint" });
    expect(planSupersede(w("denver", 2024), w("boston", 2018, 2024))).toEqual({ action: "none", reason: "disjoint" });
  });

  it("a closed episode inside the older window never ends the current fact", () => {
    // "I lived in Austin from June to September", while "lives in Denver since 2024" is current.
    expect(planSupersede(w("denver", 2024), w("austin", 2025, 2026))).toEqual({ action: "none", reason: "enclosed" });
  });

  it("a closed newer fact that reaches past the older end still closes the older one", () => {
    expect(planSupersede(w("old", 100, 300), w("new", 200, 400))).toEqual({ action: "close-older", olderId: "old", at: 200 });
  });

  it("a tie takes the late-told branch and leaves the newcomer an empty window", () => {
    expect(planSupersede(w("old", 100), w("new", 100))).toEqual({ action: "close-newer", newerId: "new", at: 100 });
  });

  it("an empty newer window at the older start is disjoint", () => {
    expect(planSupersede(w("old", 100), w("new", 100, 100))).toEqual({ action: "none", reason: "disjoint" });
  });

  it("an empty older window is already closed", () => {
    expect(planSupersede(w("old", 100, 100), w("new", 200))).toEqual({ action: "none", reason: "already-closed-earlier" });
  });

  it("is pure interval logic: status does not change the plan (the caller applies canonical protection)", () => {
    expect(planSupersede(w("old", 100, null, "canonical"), w("new", 200))).toEqual({ action: "close-older", olderId: "old", at: 200 });
    expect(planSupersede(w("old", 200, null, "canonical"), w("new", 100))).toEqual({ action: "close-newer", newerId: "new", at: 200 });
  });
});
