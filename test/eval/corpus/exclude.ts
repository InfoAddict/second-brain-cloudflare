import type { CorpusSpec } from "./types";

/** "n-lcoh-*"-style glob: `*` matches any run of characters, everything else is literal. */
export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}

/**
 * The corpus as if the matching entries had never been written: the entries go, so do the edges that touch them and the
 * queries whose grade-2 gold is one of them (their answer is gone). Used to report a gain with and without a family of
 * needles present; nothing gates on it.
 */
export function excludeNeedles(spec: CorpusSpec, patterns: readonly string[]): { spec: CorpusSpec; removedEntries: number; removedQueries: number } {
  const matchers = patterns.map(globToRegExp);
  const gone = (id: string) => matchers.some(re => re.test(id));
  const entries = spec.entries.filter(entry => !gone(entry.id));
  const queries = spec.queries.filter(query => !query.gold.some(gold => gold.grade === 2 && gone(gold.id)));
  const edges = spec.edges.filter(edge => !gone(edge.sourceId) && !gone(edge.targetId));
  return { spec: { ...spec, entries, queries, edges }, removedEntries: spec.entries.length - entries.length, removedQueries: spec.queries.length - queries.length };
}
