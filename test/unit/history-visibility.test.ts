import { describe, it, expect } from "vitest";
import { visibleTimeline } from "../../src/memory/history-visibility";

const ev = (event: string, from?: string) => ({ event, payload: from === undefined ? {} : { fromWorkspaceId: from } });
const readable = (...ws: string[]) => (w: string) => ws.includes(w);

describe("visibleTimeline", () => {
  const newestFirst = [ev("updated"), ev("shared", "personal-a"), ev("updated"), ev("created")];

  it("the author sees every event, never cut", () => {
    const seen = visibleTimeline(newestFirst, { canRead: () => false, isAuthor: true });
    expect(seen.items).toEqual(newestFirst);
    expect(seen.cut).toBe(false);
  });

  it("a non-author sees events from the share event onward, including the share event, and cut is true", () => {
    const seen = visibleTimeline(newestFirst, { canRead: readable("company"), isAuthor: false });
    expect(seen.items.map(e => e.event)).toEqual(["updated", "shared"]);
    expect(seen.cut).toBe(true);
  });

  it("a pre-4.0 move event without fromWorkspaceId cuts everything older for a non-author", () => {
    const seen = visibleTimeline([ev("updated"), ev("shared"), ev("created")], { canRead: () => true, isAuthor: false });
    expect(seen.items.map(e => e.event)).toEqual(["updated", "shared"]);
    expect(seen.cut).toBe(true);
  });

  it("unshare then reshare: a non-author sees only from the reshare", () => {
    const events = [ev("updated"), ev("shared", "personal-a"), ev("updated"), ev("unshared", "company"), ev("updated"), ev("shared", "personal-a"), ev("created")];
    // The teammate reads "company" but not "personal-a": the reshare cuts.
    const seen = visibleTimeline(events, { canRead: readable("company"), isAuthor: false });
    expect(seen.items.map(e => e.event)).toEqual(["updated", "shared"]);
    expect(seen.cut).toBe(true);
  });

  it("continues past a move whose source the reader can read, and is not cut", () => {
    const events = [ev("updated"), ev("shared", "company-2"), ev("updated"), ev("created")];
    const seen = visibleTimeline(events, { canRead: readable("company-2"), isAuthor: false });
    expect(seen.items).toEqual(events);
    expect(seen.cut).toBe(false);
  });

  it("a memory created in the company workspace shows its whole timeline to members, and is not cut", () => {
    const events = [ev("updated"), ev("appended"), ev("created")];
    const seen = visibleTimeline(events, { canRead: () => false, isAuthor: false });
    expect(seen.items).toEqual(events);
    expect(seen.cut).toBe(false);
  });

  it("the identity-less owner sees everything, never cut", () => {
    // Callers pass isAuthor: true for an identity-less reader.
    const seen = visibleTimeline(newestFirst, { canRead: () => true, isAuthor: true });
    expect(seen.items).toEqual(newestFirst);
    expect(seen.cut).toBe(false);
  });

  it("R4-L1: no blanket exception for an absent fromWorkspaceId — cuts when there is no earlier move to infer a source from", () => {
    // 3.7 was already multi-user, so "the move predates fromWorkspaceId" is never sound grounds to
    // continue past it: with nothing earlier to infer a source from, the source is unknowable.
    const events = [ev("updated"), ev("shared"), ev("created")];
    const seen = visibleTimeline(events, { canRead: () => true, isAuthor: false });
    expect(seen.items.map(e => e.event)).toEqual(["updated", "shared"]);
    expect(seen.cut).toBe(true);
  });

  it("R4-L1: infers a pre-4.0 move's missing source from the next older move's own destination, and continues when it is readable", () => {
    const events = [
      { event: "unshared", payload: {} }, // no fromWorkspaceId: infer from the older "shared" below
      { event: "shared", payload: { workspaceId: "personal-a", fromWorkspaceId: "origin" } },
      { event: "created", payload: {} },
    ];
    const seen = visibleTimeline(events, { canRead: readable("personal-a", "origin"), isAuthor: false });
    expect(seen.items).toEqual(events);
    expect(seen.cut).toBe(false);
  });

  it("R4-L1: an inferred source that is not readable still cuts there", () => {
    const events = [
      { event: "unshared", payload: {} },
      { event: "shared", payload: { workspaceId: "bobs-personal" } },
      { event: "created", payload: {} },
    ];
    const seen = visibleTimeline(events, { canRead: readable("company"), isAuthor: false });
    expect(seen.items.map(e => e.event)).toEqual(["unshared"]);
    expect(seen.cut).toBe(true);
  });

  it("R3-4 (narrowed by R4-L1): treatAbsentFromAsReadable is the LAST resort, only when there is no earlier move to infer from at all", () => {
    const events = [ev("updated"), ev("shared"), ev("created")];
    const seen = visibleTimeline(events, { canRead: () => false, isAuthor: false, treatAbsentFromAsReadable: true });
    expect(seen.items).toEqual(events);
    expect(seen.cut).toBe(false);
  });

  it("R3-4 (narrowed by R4-L1): treatAbsentFromAsReadable never widens inference once an earlier move exists to infer from", () => {
    const events = [
      { event: "unshared", payload: {} }, // infer from "shared" below; the flag never gets consulted here
      { event: "shared", payload: { workspaceId: "bobs-personal" } },
      { event: "created", payload: {} },
    ];
    const seen = visibleTimeline(events, { canRead: readable("company"), isAuthor: false, treatAbsentFromAsReadable: true });
    expect(seen.items.map(e => e.event)).toEqual(["unshared"]);
    expect(seen.cut).toBe(true);
  });

  it("R3-4 (narrowed by R4-L1): treatAbsentFromAsReadable never widens a move that DOES carry a fromWorkspaceId", () => {
    const events = [ev("updated"), ev("shared", "bobs-personal"), ev("updated"), ev("created")];
    const seen = visibleTimeline(events, { canRead: () => false, isAuthor: false, treatAbsentFromAsReadable: true });
    expect(seen.items.map(e => e.event)).toEqual(["updated", "shared"]);
    expect(seen.cut).toBe(true);
  });
});
