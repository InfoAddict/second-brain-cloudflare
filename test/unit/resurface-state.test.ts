/**
 * Resurface v2's seen/dismissed KV state, isolated from the /brief wiring
 * (test/integration/resurface.test.ts covers that end to end).
 */
import { describe, it, expect, vi } from "vitest";
import {
  excludedIds, readResurfaceState, resurfaceStateKey, withDismissed, withShown, writeResurfaceState,
} from "../../src/runtime/resurface-state";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";

describe("readResurfaceState / writeResurfaceState", () => {
  it("returns empty state when nothing was ever recorded", async () => {
    const env = makeTestEnv(undefined, { OAUTH_KV: makeMemoryKV() });
    expect(await readResurfaceState(env, "ws-a")).toEqual({ day: -1, shownId: null, recent: [], dismissed: [] });
  });

  it("round-trips a written state under resurface:<workspaceId>", async () => {
    const kv = makeMemoryKV();
    const env = makeTestEnv(undefined, { OAUTH_KV: kv });
    const state = { day: 100, shownId: "m1", recent: [{ id: "m1", day: 100 }], dismissed: ["m0"] };

    await writeResurfaceState(env, "ws-a", state);

    expect(JSON.parse((await kv.get(resurfaceStateKey("ws-a"))) as string)).toEqual(state);
    expect(await readResurfaceState(env, "ws-a")).toEqual(state);
  });

  it("keys each workspace separately", async () => {
    const kv = makeMemoryKV();
    const env = makeTestEnv(undefined, { OAUTH_KV: kv });

    await writeResurfaceState(env, "ws-a", { day: 1, shownId: "a", recent: [], dismissed: [] });
    await writeResurfaceState(env, "ws-b", { day: 2, shownId: "b", recent: [], dismissed: [] });

    expect((await readResurfaceState(env, "ws-a")).shownId).toBe("a");
    expect((await readResurfaceState(env, "ws-b")).shownId).toBe("b");
  });

  it("swallows a failing read and returns empty state", async () => {
    const get = vi.fn().mockRejectedValue(new Error("KV unavailable"));
    const env = makeTestEnv(undefined, { OAUTH_KV: { get, put: vi.fn(), delete: vi.fn(), list: vi.fn() } as any });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await readResurfaceState(env, "ws-a")).toEqual({ day: -1, shownId: null, recent: [], dismissed: [] });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("returns empty state for unparseable stored JSON rather than throwing", async () => {
    const get = vi.fn().mockResolvedValue("not json");
    const env = makeTestEnv(undefined, { OAUTH_KV: { get, put: vi.fn(), delete: vi.fn(), list: vi.fn() } as any });
    expect(await readResurfaceState(env, "ws-a")).toEqual({ day: -1, shownId: null, recent: [], dismissed: [] });
  });

  it("swallows a failing write and never throws", async () => {
    const put = vi.fn().mockRejectedValue(new Error("KV unavailable"));
    const env = makeTestEnv(undefined, { OAUTH_KV: { get: vi.fn(), put, delete: vi.fn(), list: vi.fn() } as any });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(writeResurfaceState(env, "ws-a", { day: 1, shownId: "x", recent: [], dismissed: [] }))
      .resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("withShown", () => {
  it("sets day and shownId, and folds the id into recent", () => {
    const state = withShown({ day: -1, shownId: null, recent: [], dismissed: [] }, "m1", 100);
    expect(state).toEqual({ day: 100, shownId: "m1", recent: [{ id: "m1", day: 100 }], dismissed: [] });
  });

  it("caps recent at 30, dropping the oldest", () => {
    let state = { day: 0, shownId: null as string | null, recent: [] as { id: string; day: number }[], dismissed: [] as string[] };
    for (let day = 0; day < 35; day++) state = withShown(state, `m${day}`, day);
    expect(state.recent).toHaveLength(30);
    expect(state.recent[0].id).toBe("m5"); // oldest 5 (m0..m4) dropped
    expect(state.recent.at(-1)?.id).toBe("m34");
  });

  it("de-duplicates by id, moving a repeat to the end", () => {
    let state = withShown({ day: 0, shownId: null, recent: [], dismissed: [] }, "m1", 1);
    state = withShown(state, "m2", 2);
    state = withShown(state, "m1", 3);
    expect(state.recent).toEqual([{ id: "m2", day: 2 }, { id: "m1", day: 3 }]);
  });
});

describe("withDismissed", () => {
  it("adds the id to dismissed", () => {
    const state = withDismissed({ day: 1, shownId: null, recent: [], dismissed: [] }, "m1");
    expect(state.dismissed).toEqual(["m1"]);
  });

  it("clears shownId when the dismissed id is today's pick", () => {
    const state = withDismissed({ day: 1, shownId: "m1", recent: [], dismissed: [] }, "m1");
    expect(state.shownId).toBeNull();
  });

  it("leaves shownId alone when dismissing a different id", () => {
    const state = withDismissed({ day: 1, shownId: "m1", recent: [], dismissed: [] }, "m2");
    expect(state.shownId).toBe("m1");
  });

  it("does not add the same id twice", () => {
    let state = withDismissed({ day: 1, shownId: null, recent: [], dismissed: [] }, "m1");
    state = withDismissed(state, "m1");
    expect(state.dismissed).toEqual(["m1"]);
  });

  it("caps dismissed at 60, dropping the oldest", () => {
    let state = { day: 0, shownId: null as string | null, recent: [] as { id: string; day: number }[], dismissed: [] as string[] };
    for (let i = 0; i < 65; i++) state = withDismissed(state, `d${i}`);
    expect(state.dismissed).toHaveLength(60);
    expect(state.dismissed[0]).toBe("d5");
  });
});

describe("excludedIds", () => {
  it("combines dismissed and recently-shown ids, deduplicated", () => {
    const state = { day: 10, shownId: "m3", recent: [{ id: "m1", day: 8 }, { id: "m2", day: 9 }], dismissed: ["m1", "m4"] };
    expect(new Set(excludedIds(state, 10, 30))).toEqual(new Set(["m1", "m2", "m4"]));
  });

  it("drops a recent id once it falls outside the window", () => {
    const state = { day: 10, shownId: null, recent: [{ id: "old", day: 10 - 31 }, { id: "fresh", day: 10 - 5 }], dismissed: [] };
    expect(excludedIds(state, 10, 30)).toEqual(["fresh"]);
  });

  it("puts dismissed ids first, then recently-shown ids most-recent-first", () => {
    // Dismissed ids must be the last thing a bound-parameter truncation drops
    // (see the comment on this function): a fixed-size `recent` window means
    // recency-based exclusions accumulate and eventually crowd out an explicit
    // "never show this again" if it were not prioritized ahead of them.
    const state = {
      day: 10,
      shownId: null,
      recent: [{ id: "older", day: 5 }, { id: "newer", day: 9 }],
      dismissed: ["was-dismissed"],
    };
    expect(excludedIds(state, 10, 30)).toEqual(["was-dismissed", "newer", "older"]);
  });

  it("keeps a dismissed id ahead of 25 more-recently-shown ids", () => {
    // The truncation-boundary case: brief.ts's caller only binds so many of
    // these into a query, so ordering here is what decides which ids survive.
    const recent = Array.from({ length: 25 }, (_, i) => ({ id: `recent-${i}`, day: i }));
    const state = { day: 25, shownId: null, recent, dismissed: ["dismissed-1"] };

    const ids = excludedIds(state, 25, 30);

    expect(ids[0]).toBe("dismissed-1");
    expect(ids.slice(0, 6)).toContain("dismissed-1");
  });
});
