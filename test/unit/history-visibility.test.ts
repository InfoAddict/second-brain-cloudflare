import { describe, it, expect } from "vitest";
import { visibleTimeline } from "../../src/memory/history-visibility";

const ev = (event: string, from?: string) => ({ event, payload: from === undefined ? {} : { fromWorkspaceId: from } });
const readable = (...ws: string[]) => (w: string) => ws.includes(w);

describe("visibleTimeline", () => {
  const newestFirst = [ev("updated"), ev("shared", "personal-a"), ev("updated"), ev("created")];

  it("the author sees every event", () => {
    expect(visibleTimeline(newestFirst, { canRead: () => false, isAuthor: true })).toEqual(newestFirst);
  });

  it("a non-author sees events from the share event onward, including the share event", () => {
    const seen = visibleTimeline(newestFirst, { canRead: readable("company"), isAuthor: false });
    expect(seen.map(e => e.event)).toEqual(["updated", "shared"]);
  });

  it("a pre-4.0 move event without fromWorkspaceId cuts everything older for a non-author", () => {
    const seen = visibleTimeline([ev("updated"), ev("shared"), ev("created")], { canRead: () => true, isAuthor: false });
    expect(seen.map(e => e.event)).toEqual(["updated", "shared"]);
  });

  it("unshare then reshare: a non-author sees only from the reshare", () => {
    const events = [ev("updated"), ev("shared", "personal-a"), ev("updated"), ev("unshared", "company"), ev("updated"), ev("shared", "personal-a"), ev("created")];
    // The teammate reads "company" but not "personal-a": the reshare cuts.
    const seen = visibleTimeline(events, { canRead: readable("company"), isAuthor: false });
    expect(seen.map(e => e.event)).toEqual(["updated", "shared"]);
  });

  it("continues past a move whose source the reader can read", () => {
    const events = [ev("updated"), ev("shared", "company-2"), ev("updated"), ev("created")];
    const seen = visibleTimeline(events, { canRead: readable("company-2"), isAuthor: false });
    expect(seen).toEqual(events);
  });

  it("a memory created in the company workspace shows its whole timeline to members", () => {
    const events = [ev("updated"), ev("appended"), ev("created")];
    expect(visibleTimeline(events, { canRead: () => false, isAuthor: false })).toEqual(events);
  });

  it("the identity-less owner sees everything", () => {
    // Callers pass isAuthor: true for an identity-less reader.
    expect(visibleTimeline(newestFirst, { canRead: () => true, isAuthor: true })).toEqual(newestFirst);
  });

  it("R3-4: treatAbsentFromAsReadable continues past a pre-4.0 move instead of cutting there", () => {
    const events = [ev("updated"), ev("shared"), ev("created")];
    const seen = visibleTimeline(events, { canRead: () => false, isAuthor: false, treatAbsentFromAsReadable: true });
    expect(seen).toEqual(events);
  });

  it("R3-4: treatAbsentFromAsReadable never widens a move that DOES carry a fromWorkspaceId", () => {
    // A move recorded with a real origin (even the pre-tenancy "" marker, modeled here as a
    // string canRead rejects) still goes through the ordinary cut regardless of the flag.
    const events = [ev("updated"), ev("shared", "bobs-personal"), ev("updated"), ev("created")];
    const seen = visibleTimeline(events, { canRead: () => false, isAuthor: false, treatAbsentFromAsReadable: true });
    expect(seen.map(e => e.event)).toEqual(["updated", "shared"]);
  });
});
