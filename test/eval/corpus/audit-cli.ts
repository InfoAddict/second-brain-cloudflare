// Audits a candidate golden set: the committed core data plus any part directories, on the chosen corpora.
// Usage: node scripts/eval-run-ts.mjs test/eval/corpus/audit-cli.ts [--parts dirA,dirB] [--scales core-1k,scale-5k,scale-20k]
// A part directory holds any of needles.jsonl, queries.jsonl, edges.jsonl. Long-context needles are regenerated from
// long-anchors.ts and identifier/rare-word queries from the needle keys, exactly as the committed data is.
import { QUERY_CATEGORIES } from "../types";
import { auditQueries, haystackVocabulary, staleRouteGaps } from "./audit";
import { CORPUS_IDS, buildCorpus, loadCoreData, type CoreCorpusId } from "./build";
import { DENSE_TOKENS } from "./haystack";
import { mergeData } from "./merge";

const flag = (name: string) => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; };
const parts = flag("--parts")?.split(",").filter(Boolean) ?? [];
const scales = (flag("--scales")?.split(",") ?? [...CORPUS_IDS]) as CoreCorpusId[];

async function main() {
  const data = mergeData(loadCoreData(), parts);
  const ids = data.needles.map(n => n.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  const problems: string[] = [];
  if (dup.length) problems.push(`duplicate needle ids: ${dup.slice(0, 10).join(", ")}`);
  const qids = data.queries.map(q => q.id);
  const qdup = qids.filter((id, i) => qids.indexOf(id) !== i);
  if (qdup.length) problems.push(`duplicate query ids: ${qdup.slice(0, 10).join(", ")}`);
  const needleIds = new Set(ids);
  for (const e of data.edges) if (!needleIds.has(e.source) || !needleIds.has(e.target)) problems.push(`edge ${e.source}->${e.target} names a missing needle`);
  for (const n of data.needles) if (n.importance !== undefined && !(Number.isInteger(n.importance) && n.importance >= 1 && n.importance <= 5)) problems.push(`${n.id}: importance ${n.importance}`);
  const goldIds = new Set(data.queries.filter(q => q.category === "common-word").map(q => q.gold[0].id));
  const isDense = (text: string) => DENSE_TOKENS.filter(word => text.toLowerCase().includes(word));
  for (const n of data.needles) if (!goldIds.has(n.id) && isDense(n.content).length > 2) problems.push(`${n.id}: ${isDense(n.content).length} dense words (${isDense(n.content).join(",")}), at most 2 outside common-word golds`);
  const dense = (text: string) => DENSE_TOKENS.filter(word => text.toLowerCase().includes(word)).sort().join(",");
  for (const q of data.queries.filter(q => q.category === "common-word")) {
    const gold = data.needles.find(n => n.id === q.gold[0].id);
    const triple = q.text.split(/\s+/).filter(word => (DENSE_TOKENS as readonly string[]).includes(word)).sort().join(",");
    if (!gold || dense(gold.content) !== triple) problems.push(`${q.id}: gold dense words (${gold ? dense(gold.content) : "missing"}) differ from the query triple (${triple})`);
    if (gold && gold.ageDays < 300) problems.push(`${q.id}: gold is ${gold.ageDays} days old, needs 300+`);
  }
  const vocab = haystackVocabulary();
  for (const n of data.needles.filter(n => n.purpose === "rare-word" || n.purpose === "identifier")) for (const key of n.keys ?? []) if (vocab.has(key.toLowerCase())) problems.push(`${n.id}: key ${key} is in the haystack vocabulary`);
  for (const n of data.needles) if (n.content.match(/[\w.+-]+@[\w-]+\.[\w.]+/g)?.some(m => !m.endsWith("@example.com"))) problems.push(`${n.id}: non-example.com email`);

  const specs = scales.map(id => buildCorpus(id, data));
  let total = 0;
  for (const spec of specs) {
    const findings = auditQueries({ entries: spec.entries, edges: spec.edges, queries: spec.queries, intent: spec.intent });
    total += findings.length;
    const byRule = new Map<string, typeof findings>();
    for (const f of findings) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
    console.log(`\n${spec.id}: ${spec.entries.length} entries, ${spec.queries.length} queries, ${findings.length} findings`);
    for (const [rule, list] of byRule) {
      console.log(`  ${rule} x${list.length}`);
      for (const f of list.slice(0, 12)) console.log(`    ${f.queryId}: ${f.detail}`);
    }
  }
  const stale = staleRouteGaps(specs);
  for (const f of stale) console.log(`stale gap ${f.queryId}: ${f.detail}`);
  const spec = specs[0];
  console.log("\ncategory: queries / clusters");
  for (const category of QUERY_CATEGORIES) {
    const qs = spec.queries.filter(q => q.category === category);
    console.log(`  ${category.padEnd(13)} ${String(qs.length).padStart(4)} / ${new Set(qs.map(q => q.clusterKey)).size}`);
  }
  for (const p of problems.slice(0, 40)) console.log(`PROBLEM ${p}`);
  console.log(`\n${total + stale.length + problems.length === 0 ? "AUDIT CLEAN" : `AUDIT FAILED: ${total} findings, ${stale.length} stale gaps, ${problems.length} problems`}`);
  process.exit(total + stale.length + problems.length === 0 ? 0 : 1);
}
await main();
