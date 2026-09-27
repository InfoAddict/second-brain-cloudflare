import { describe, it, expect } from "vitest";
import { buildChain, VersionChainError, type VersionRow } from "../../src/memory/versions";

const row = (seq: number, over: Partial<VersionRow>): VersionRow => ({
  seq, workspace_id: "w", content: null, prior_length: null, tags: "[]", state: "{}", actor_id: "u", channel: "rest",
  reason: "update", meta: "{}", valid_from: null, created_at: seq, ...over,
});
const all = () => true;
const cp = (s: string) => [...s].length;

describe("buildChain", () => {
  it("a chain of three appends yields every prior state", () => {
    // live "abcdef" <- "abcd" <- "ab" <- "a"; each retired state is a prefix of the next newer one.
    const chain = buildChain("abcdef", [row(3, { prior_length: 4 }), row(2, { prior_length: 2 }), row(1, { prior_length: 1 })], all);
    expect(chain.text(3)).toBe("abcd");
    expect(chain.text(2)).toBe("ab");
    expect(chain.text(1)).toBe("a");
    expect(chain.truncatedAt).toBe("none");
  });

  it("an append after a replace", () => {
    const chain = buildChain("brand new and more", [
      row(3, { prior_length: 9 }),                  // "brand new" (prefix of live)
      row(2, { content: "old text" }),              // replaced
      row(1, { prior_length: 3 }),                  // "old" (prefix of "old text")
    ], all);
    expect(chain.text(3)).toBe("brand new");
    expect(chain.text(2)).toBe("old text");
    expect(chain.text(1)).toBe("old");
  });

  it("a tags-only version is the identity on text", () => {
    const chain = buildChain("same", [row(1, { prior_length: 4 })], all);
    expect(chain.text(1)).toBe("same");
  });

  it("a zero-length prior yields the empty string", () => {
    expect(buildChain("x", [row(1, { prior_length: 0 })], all).text(1)).toBe("");
  });

  it("emoji and CJK survive a delta", () => {
    const live = "a😀b日本語😀c";
    const chain = buildChain(live, [row(2, { prior_length: cp("a😀b日本") }), row(1, { prior_length: cp("a😀") })], all);
    expect(chain.text(2)).toBe("a😀b日本");
    expect(chain.text(1)).toBe("a😀");
  });

  it("a delta longer than its base throws VersionChainError", () => {
    expect(() => buildChain("abc", [row(1, { prior_length: 4 })], all).text(1)).toThrow(VersionChainError);
    // A later delta claiming more than the state above it also fails.
    expect(() => buildChain("abcdef", [row(2, { prior_length: 2 }), row(1, { prior_length: 3 })], all).text(1)).toThrow(VersionChainError);
    // Length is counted in code points, not UTF-16 units.
    expect(() => buildChain("😀😀", [row(1, { prior_length: 3 })], all).text(1)).toThrow(VersionChainError);
  });

  it("stops at the first seq gap", () => {
    const chain = buildChain("abc", [row(5, { prior_length: 2 }), row(4, { prior_length: 1 }), row(2, { prior_length: 1 })], all);
    expect(chain.rows.map(r => r.seq)).toEqual([5, 4]);
    expect(chain.truncatedAt).toBe("gap");
  });

  it("stops at the first unreadable workspace; older readable rows are not returned", () => {
    const chain = buildChain("abc", [
      row(4, { prior_length: 3, workspace_id: "company" }),
      row(3, { prior_length: 2, workspace_id: "personal" }),
      row(2, { prior_length: 2, workspace_id: "company" }),
    ], ws => ws === "company");
    expect(chain.rows.map(r => r.seq)).toEqual([4]);
    expect(chain.truncatedAt).toBe("unreadable");
  });

  it("text is built lazily", () => {
    let scans = 0;
    const base = "😀".repeat(50);
    const chain = buildChain(base, [row(2, { prior_length: 40 }), row(1, { prior_length: 10 })], all, { onScan: () => scans++ });
    expect(scans).toBe(0);
    chain.text(1);
    expect(scans).toBe(1);
    chain.text(2);
    expect(scans).toBe(1); // the run was resolved once
  });

  it("one pass per base: units scanned are at most the base length", () => {
    const base = "😀日".repeat(500_000);           // 1,000,000 code points
    const rows = Array.from({ length: 20 }, (_, i) => row(20 - i, { prior_length: 900_000 - i * 1000 }));
    let scanned = 0;
    let calls = 0;
    const chain = buildChain(base, rows, all, { onScan: u => { scanned += u; calls++; } });
    for (let s = 1; s <= 20; s++) chain.text(s);
    expect(calls).toBe(1);
    expect(scanned).toBeLessThanOrEqual(base.length);
  });

  it("CPU: 1 MB ASCII, 20 deltas under 5 ms; 1 MB emoji-heavy under 10 ms", () => {
    const scale = Number(process.env.VERSIONS_CPU_SCALE ?? 1);
    const median = (fn: () => void) => {
      const t: number[] = [];
      for (let i = 0; i < 5; i++) { const s = performance.now(); fn(); t.push(performance.now() - s); }
      return t.sort((a, b) => a - b)[2];
    };
    const build = (base: string, n: number) => {
      const rows = Array.from({ length: 20 }, (_, i) => row(20 - i, { prior_length: n - i * 100 }));
      const chain = buildChain(base, rows, all);
      for (let s = 1; s <= 20; s++) chain.text(s).length;
    };
    const ascii = "a".repeat(1_000_000);
    const emoji = "😀a".repeat(500_000);
    expect(median(() => build(ascii, 1_000_000))).toBeLessThan(5 * scale);
    expect(median(() => build(emoji, 900_000))).toBeLessThan(10 * scale);
  });
});
