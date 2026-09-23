import { describe, it, expect, vi, beforeEach } from "vitest";
import { ftsMatchQuery, ftsReady, resetFtsReadyMemo } from "../../src/recall/fts";
import { FTS_READY_KV_KEY } from "../../src/constants";

describe("ftsMatchQuery", () => {
  it("quotes each token and joins with OR", () => {
    expect(ftsMatchQuery(["dashboard", "redesign"])).toBe(`"dashboard" OR "redesign"`);
  });
  it("doubles internal quotes so user tokens cannot inject FTS syntax", () => {
    expect(ftsMatchQuery([`say "hi"`])).toBe(`"say ""hi"""`);
  });
  it("drops tokens below the trigram floor and returns null when none survive", () => {
    expect(ftsMatchQuery(["ab", "dashboard"])).toBe(`"dashboard"`);
    expect(ftsMatchQuery(["ab", "x"])).toBeNull();
    expect(ftsMatchQuery([])).toBeNull();
  });
  it("counts codepoints, not UTF-16 units", () => {
    expect(ftsMatchQuery(["日本語"])).toBe(`"日本語"`); // 3 codepoints: eligible
  });
});

describe("ftsReady", () => {
  beforeEach(() => resetFtsReadyMemo());
  const envWith = (value: string | null, fail = false) => ({
    OAUTH_KV: { get: fail ? vi.fn().mockRejectedValue(new Error("kv down")) : vi.fn().mockResolvedValue(value) },
  }) as any;

  it("is false until the KV flag is set, without memoizing false", async () => {
    const env = envWith(null);
    expect(await ftsReady(env)).toBe(false);
    expect(await ftsReady(env)).toBe(false);
    expect(env.OAUTH_KV.get).toHaveBeenCalledTimes(2); // false is re-checked
  });
  it("memoizes true so the flag costs one KV read per isolate", async () => {
    const env = envWith("1");
    expect(await ftsReady(env)).toBe(true);
    expect(await ftsReady(env)).toBe(true);
    expect(env.OAUTH_KV.get).toHaveBeenCalledTimes(1);
  });
  it("treats a KV failure as not ready", async () => {
    expect(await ftsReady(envWith(null, true))).toBe(false);
  });
});
