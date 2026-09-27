import { describe, it, expect } from "vitest";
import { cpus, loadavg } from "node:os";
import { buildChain, VersionChainError, type VersionRow } from "../../src/memory/versions";

const row = (seq: number, over: Partial<VersionRow>): VersionRow => ({
  seq, workspace_id: "w", content: null, prior_length: null, prior_length_utf16: null, tags: "[]", state: "{}", actor_id: "u", channel: "rest",
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

  it("CPU: 1 MB ASCII, 20 deltas under 5 ms; 1 MB emoji-heavy under 10 ms", async (ctx) => {
    const scale = Number(process.env.VERSIONS_CPU_SCALE ?? 1);
    // CPU time, not wall time: process.cpuUsage() reports actual cycles this process was granted and
    // spent, so waiting for a scheduler turn (as opposed to running slowly once granted one) cannot
    // inflate the number the way it inflated the old wall-clock reading.
    const median = (fn: () => void) => {
      const t: number[] = [];
      for (let i = 0; i < 7; i++) {
        const before = process.cpuUsage();
        fn();
        const after = process.cpuUsage(before);
        t.push((after.user + after.system) / 1000); // microseconds -> ms
      }
      return t.sort((a, b) => a - b)[3];
    };
    const build = (base: string, n: number) => {
      const rows = Array.from({ length: 20 }, (_, i) => row(20 - i, { prior_length: n - i * 100 }));
      const chain = buildChain(base, rows, all);
      for (let s = 1; s <= 20; s++) chain.text(s).length;
    };
    const ascii = "a".repeat(1_000_000);
    const emoji = "😀a".repeat(500_000);
    const cores = cpus().length;
    // A loaded core still runs the instructions it's given at full speed — CPU time is immune to
    // waiting for a turn — but it does NOT run them as CHEAPLY: a shared cache or memory bus fought
    // over by a dozen other CPU-bound processes turns every access this loop makes into more real
    // work, and process.cpuUsage() correctly bills that as CPU time actually spent. That was measured
    // directly: 39 ms against this same 10 ms budget at load average 32 on a 12-core box, immune to
    // the CPU-time switch above. No timing technique run IN THIS PROCESS can separate "slow because
    // regressed" from "slow because eleven other processes are thrashing the cache"; only checking
    // whether the machine is in that state at all can. The O(n) complexity claim itself does not
    // depend on any of this: "one pass per base" above counts real scan units and asserts the bound
    // directly, contention or none. This budget is corroborating wall-cost evidence on top of that.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const before = loadavg()[0] / cores;
      const asciiMs = median(() => build(ascii, 1_000_000));
      const emojiMs = median(() => build(emoji, 900_000));
      const after = loadavg()[0] / cores;
      const contended = Math.max(before, after) > 1;
      const withinBudget = asciiMs < 5 * scale && emojiMs < 10 * scale;
      if (withinBudget) {
        expect(asciiMs).toBeLessThan(5 * scale);
        expect(emojiMs).toBeLessThan(10 * scale);
        return;
      }
      if (contended) {
        ctx.skip(
          true,
          `runner load average ${(Math.max(before, after) * cores).toFixed(1)} across ${cores} cores ` +
          `(measured ${asciiMs.toFixed(2)} ms / ${emojiMs.toFixed(2)} ms against a 5 ms / 10 ms budget) — ` +
          `a CPU-time budget cannot mean anything when the machine itself is this oversubscribed`,
        );
        return;
      }
      if (attempt === 3) {
        // Not contended by any measure we took, and still over budget: a real regression.
        expect(asciiMs).toBeLessThan(5 * scale);
        expect(emojiMs).toBeLessThan(10 * scale);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  });

  it("CPU: ADV-10 — an alternating full-copy/delta chain does not pay a full scan per delta", async (ctx) => {
    // Every run in "one pass per base" above shares its base across many deltas; an edit/append/edit/
    // append chain never does — each delta is the only member of its own run, over a fresh ~1.4 MB
    // emoji-heavy base every time. Without a stored boundary that is 20 O(base length) scans, not one.
    const scale = Number(process.env.VERSIONS_CPU_SCALE ?? 1);
    const memory = (salt: string) => (salt + "😀文a".repeat(200_000)).slice(0, 700_000);
    const current = memory("now");
    const buildRows = (): VersionRow[] => {
      const rows: VersionRow[] = [];
      let above = current;
      for (let i = 0; i < 20; i++) {
        const full = i % 2 === 1; // an update (full copy), then an append (delta), alternating
        // Trims a small UTF-16 suffix, 80 units (a whole number of "😀文a" blocks) off the end — the
        // shape a real append/edit retires, and what store.ts's writers persist as prior_length_utf16.
        const text = full ? memory(`v${i}`) : above.slice(0, above.length - 80);
        rows.push(row(20 - i, { content: full ? text : null, prior_length: full ? null : cp(text), prior_length_utf16: full ? null : text.length }));
        above = text;
      }
      return rows;
    };
    const rows = buildRows();
    const median = (fn: () => void) => {
      const t: number[] = [];
      for (let i = 0; i < 7; i++) {
        const before = process.cpuUsage();
        fn();
        const after = process.cpuUsage(before);
        t.push((after.user + after.system) / 1000);
      }
      return t.sort((a, b) => a - b)[3];
    };
    const build = () => {
      const chain = buildChain(current, rows, all);
      for (const r of chain.rows) chain.text(r.seq);
    };
    const cores = cpus().length;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const before = loadavg()[0] / cores;
      const ms = median(build);
      const after = loadavg()[0] / cores;
      const contended = Math.max(before, after) > 1;
      if (ms < 10 * scale) { expect(ms).toBeLessThan(10 * scale); return; }
      if (contended) {
        ctx.skip(
          true,
          `runner load average ${(Math.max(before, after) * cores).toFixed(1)} across ${cores} cores ` +
          `(measured ${ms.toFixed(2)} ms against a 10 ms budget) — a CPU-time budget cannot mean anything ` +
          `when the machine itself is this oversubscribed`,
        );
        return;
      }
      if (attempt === 3) { expect(ms).toBeLessThan(10 * scale); return; }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  });
});
