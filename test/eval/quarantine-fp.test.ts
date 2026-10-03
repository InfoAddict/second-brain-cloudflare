/**
 * Q2 (16-t3-t4-trust-spec.md Task Q2): the quarantine false-positive gate and
 * the shipped QUARANTINE_THRESHOLD.
 *
 * Every document the core-1k loader writes is scored twice, as an MCP write
 * (direct class) and as a mirror write (strictest). The noise corpus and the
 * injection corpus's benign documents are scored as mirror writes ("benign
 * mail"), and the tricky-benign fixtures with their own channel. Gate, at
 * the shipped threshold: core-1k under 0.5% in both modes, benign mail under
 * 0.5%, tricky benign 0 holds. The shipped value must be the lowest grid
 * value (0.8 to 1.6, step 0.1) that passes; if 1.0 fails, stop and report
 * rather than bend the weights.
 *
 * Reported, not gated: the injection plants' hold rate per style, and the
 * malicious fixtures' hold rate.
 *
 * Opt-in like the rest of the full eval (EVAL_FULL=1, npm run test:eval:full),
 * although scoring is pure and the whole file runs in about a second.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EVAL_FULL } from "./full";
import { buildCorpus } from "./corpus/build";
import { buildSyntheticCorpus } from "./corpus/synthetic";
import { PLANT_STYLES } from "./corpus/synthetic-injection";
import type { CorpusEntry } from "./corpus/types";
import { normalizeCaptureInput } from "../../src/capture/entry";
import { DEFAULTS } from "../../src/config";
import { scoreWrite, type QuarantineChannel, type ScoreResult, type SignalId } from "../../src/quarantine/score";

const ROOT = resolve(import.meta.dirname, "../..");
const FP_BOUND = 0.005;
const GRID = Array.from({ length: 9 }, (_, i) => Math.round((0.8 + i * 0.1) * 10) / 10);
// The threshold only decides `hold`; score everything once at an unreachable
// threshold and compare the scores against each grid value afterwards.
const SCORE_ONLY = { QUARANTINE_THRESHOLD: Infinity, QUARANTINE_WRITE_BURST: DEFAULTS.QUARANTINE_WRITE_BURST };

interface Scored { id: string; result: ScoreResult }

function scoreDocs(docs: readonly { id: string; content: string; tags: string[]; source: string }[], channel: QuarantineChannel): Scored[] {
  return docs.map(d => ({
    id: d.id,
    result: scoreWrite({ content: d.content, tags: d.tags, source: d.source, channel, kind: "create" }, SCORE_ONLY),
  }));
}
const held = (set: readonly Scored[], t: number) => set.filter(s => s.result.score >= t);
const rate = (set: readonly Scored[], t: number) => held(set, t).length / set.length;
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

function signalCounts(set: readonly Scored[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of set) for (const sig of s.result.signals) out[sig.id] = (out[sig.id] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort()) as Record<SignalId, number>;
}

interface Fixture {
  id: string; class: "malicious" | "benign"; text: string; channel: QuarantineChannel; source: string;
  tags?: string[]; burst?: number; capsule?: boolean;
}

describe.skipIf(!EVAL_FULL)("quarantine false-positive gate on core-1k and mail (Q2)", () => {
  const loaded = (entries: readonly CorpusEntry[]) =>
    entries.map(e => ({ id: e.id, source: e.source, ...normalizeCaptureInput(e.content, e.tags) }));
  const core = loaded(buildCorpus("core-1k").entries);
  const coreMcp = scoreDocs(core, "mcp");
  const coreMirror = scoreDocs(core, "system:mirror");

  const noise = scoreDocs(buildSyntheticCorpus("noise").entries, "system:mirror");
  const injection = buildSyntheticCorpus("injection").entries;
  const plants = injection.filter(e => e.id.startsWith("ij-plant-"));
  const injectionBenign = scoreDocs(injection.filter(e => !e.id.startsWith("ij-plant-")), "system:mirror");
  const benignMail = [...noise, ...injectionBenign];

  const fixtures: Fixture[] = readFileSync(resolve(ROOT, "test/fixtures/quarantine/signals.jsonl"), "utf8")
    .split("\n").filter(Boolean).map(l => JSON.parse(l));
  const scoreFixture = (f: Fixture): Scored => ({
    id: f.id,
    result: scoreWrite({
      content: f.text, tags: f.tags ?? [], source: f.source, channel: f.channel, kind: "create",
      ...(f.burst === undefined ? {} : { mcpWritesInWindow: f.burst }),
      ...(f.capsule === undefined ? {} : { capsuleTagsChanged: f.capsule }),
    }, SCORE_ONLY),
  });
  const tricky = fixtures.filter(f => f.class === "benign").map(scoreFixture);
  const malicious = fixtures.filter(f => f.class === "malicious").map(scoreFixture);

  const passes = (t: number) =>
    rate(coreMcp, t) < FP_BOUND && rate(coreMirror, t) < FP_BOUND && rate(benignMail, t) < FP_BOUND && held(tricky, t).length === 0;

  it("prints the grid", () => {
    const rows = GRID.map(t => [
      t.toFixed(1),
      `${held(coreMcp, t).length}/${coreMcp.length} (${pct(rate(coreMcp, t))})`,
      `${held(coreMirror, t).length}/${coreMirror.length} (${pct(rate(coreMirror, t))})`,
      `${held(benignMail, t).length}/${benignMail.length} (${pct(rate(benignMail, t))})`,
      `${held(tricky, t).length}/${tricky.length}`,
      `${held(malicious, t).length}/${malicious.length}`,
      passes(t) ? "pass" : "fail",
    ].join(" | "));
    console.log(["threshold | core-1k MCP | core-1k mirror | benign mail | tricky benign | malicious fixtures | gate", ...rows].join("\n"));
    expect(core.length).toBeGreaterThan(1000);
    expect(injectionBenign.length).toBe(4920);
    expect(plants.length).toBe(80);
  });

  it("the shipped QUARANTINE_THRESHOLD passes, and 1.0 passes", () => {
    const t = DEFAULTS.QUARANTINE_THRESHOLD;
    expect(passes(1.0), "1.0 fails the gate: stop and report to the director, do not bend the weights").toBe(true);
    expect(rate(coreMcp, t)).toBeLessThan(FP_BOUND);
    expect(rate(coreMirror, t)).toBeLessThan(FP_BOUND);
    expect(rate(benignMail, t)).toBeLessThan(FP_BOUND);
    expect(held(tricky, t).map(s => s.id)).toEqual([]);
  });

  it("the shipped threshold is the lowest passing grid value", () => {
    const lowest = GRID.find(passes);
    console.log(`lowest passing threshold on the grid: ${lowest}; shipped: ${DEFAULTS.QUARANTINE_THRESHOLD}`);
    expect(lowest).toBe(DEFAULTS.QUARANTINE_THRESHOLD);
  });

  it("reports holds per signal and the injection hold rate per style", () => {
    const t = DEFAULTS.QUARANTINE_THRESHOLD;
    const plantScores = plants.map(p => ({ style: p.id.split("-")[2], ...scoreDocs([p], "system:mirror")[0] }));
    const perStyle = Object.fromEntries(PLANT_STYLES.map(style => {
      const mine = plantScores.filter(p => p.style === style);
      return [style, `${mine.filter(p => p.result.score >= t).length}/${mine.length}`];
    }));
    const report = {
      threshold: t,
      signalsFired: {
        coreMcp: signalCounts(coreMcp), coreMirror: signalCounts(coreMirror), benignMail: signalCounts(benignMail),
        plants: signalCounts(plantScores),
      },
      heldSignals: {
        coreMcp: signalCounts(held(coreMcp, t)), coreMirror: signalCounts(held(coreMirror, t)),
        benignMail: signalCounts(held(benignMail, t)), plants: signalCounts(held(plantScores, t)),
      },
      heldIds: { coreMcp: held(coreMcp, t).map(s => s.id), coreMirror: held(coreMirror, t).map(s => s.id), benignMail: held(benignMail, t).map(s => s.id) },
      injectionHoldRateByStyle: perStyle,
      maliciousFixturesHeld: `${held(malicious, t).length}/${malicious.length}`,
      maliciousFixturesNotHeld: malicious.filter(s => s.result.score < t).map(s => s.id),
    };
    console.log(JSON.stringify(report, null, 2));
    expect(perStyle.command).toBe("20/20");
  });
});
