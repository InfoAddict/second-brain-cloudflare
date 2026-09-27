import type { LoadedCorpus } from "./corpus/loader";
import type { GoldenQuery, VariantReport } from "./types";
import { cosine } from "./vectors";

export type StandingPair = { expected: Set<string>; scores: { id: string; value: number }[] };

export function scoreStandingPairs(scored: readonly StandingPair[], thresholds: readonly number[]): NonNullable<VariantReport["standing"]> {
  return thresholds.map(threshold => {
    let truePositive = 0, falsePositive = 0, falseNegative = 0;
    for (const q of scored) {
      const fired = q.scores.filter(x => x.value >= threshold).slice(0, 2);
      truePositive += fired.filter(x => q.expected.has(x.id)).length;
      falsePositive += fired.filter(x => !q.expected.has(x.id)).length;
      falseNegative += [...q.expected].filter(id => !fired.some(x => x.id === id)).length;
    }
    return { threshold, precision: truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : 0, recall: truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : 0, truePositive, falsePositive, falseNegative };
  });
}

export async function measureStanding(corpus: LoadedCorpus, queries: readonly GoldenQuery[], queryVectors: ReadonlyMap<string, number[]>): Promise<NonNullable<VariantReport["standing"]>> {
  const vectors = await corpus.vectorize.getByIds(corpus.standingIds);
  if (vectors.length !== corpus.standingIds.length) throw new Error(`standing vectors missing: ${vectors.length}/${corpus.standingIds.length}`);
  const scored: StandingPair[] = [];
  for (const q of queries) {
    const probe = queryVectors.get(q.id);
    if (!probe) throw new Error(`standing query ${q.id} has no replayed recall embedding`);
    scored.push({ expected: new Set(q.gold.map(g => g.id)), scores: vectors.map(v => ({ id: v.id, value: cosine(probe, v.values) })).sort((a, b) => b.value - a.value || a.id.localeCompare(b.id)) });
  }
  const thresholds = Array.from({ length: 13 }, (_, i) => Number((0.3 + i * 0.05).toFixed(2)));
  return scoreStandingPairs(scored, thresholds);
}
