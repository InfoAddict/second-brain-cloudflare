# Synthetic 4.0 eval corpora

These four opt-in corpora are generated from seed `40891`. The generator and its SHA-256 data fingerprint are in `corpus/synthetic.ts`. Every document is fictional. No account, live brain, or Cloudflare API is used. The loader uses the production index write path, while the eval runs local D1, exact-cosine Vectorize, and pinned local models.

## Reproduce

Install with `npm ci`. For each ID in `temporal noise injection`, run:

```sh
npm run eval:recall -- prepare --variant baseline --corpus ID
npm run eval:recall -- --variant baseline --corpus ID
```

Replace `ID` with one corpus name. `prepare` downloads pinned model weights if absent and records content-addressed embeddings in `.eval-cache/replay/`, then checks replay completeness. The second command is fully offline. The local cache is not committed, as for public corpora. The committed core cache is never read or written by these corpora.

For standing, run the same two commands with `--variant no-rerank --corpus standing`. Standing's report-only firing curve uses the same current embedding model with either variant. `no-rerank` avoids recording hundreds of cross-encoder calls that the firing metric never reads. Its ordinary retrieval row is diagnostic only.

For a machine-readable report, add `--json .eval-cache/ID-baseline.json` to the second command. Default `npm run eval:recall -- --variant baseline` still selects `core-1k`.

## Corpus definitions and baseline

| Corpus | Documents | Queries | Primary metric | Baseline on this branch |
| --- | ---: | ---: | --- | --- |
| `temporal` | 240 | 240 | Recall@10 and MRR@10 for 120 current B and 120 dated past A queries | Current B: 1.000 / 0.542; past A: 0.917 / 0.398 |
| `noise` | 316 | 24 | Genuine user note in top 3, divided by 24 | 5/24 = 0.208; Recall@10 0.833 |
| `injection` | 507 | 7 | Planted email occupancy in targeted top 5 slots, divided by 35 | 21/35 = 0.600; genuine gold Recall@10 1.000 |
| `standing` | 30 | 450 | Cosine firing precision and recall at each listed threshold, at most 2 fires per query | At 0.70: precision 0.215, recall 0.133 (20 TP, 73 FP, 130 FN); at 0.75: precision 0.367, recall 0.073 (11 TP, 19 FP, 139 FN) |

`temporal` has 120 independent February and July timelines, meeting the existing gate's 200-query and 30-cluster floors. Each past question has an `asOf` of April 15, 2026. The runner sets that query's clock and upper creation-time bound, then restores the run clock. The current answer is B and the past answer is A. This evaluates retrieval of separate dated documents; future version-aware capture is outside this corpus loader.

`noise` mixes mail from 12 senders with repeated sign-in, social and legal footers, four near-identical direct deposit notices, and 24 own notes that share normal footer words. Each query's gold is its own note. `injection` plants seven instruction-bearing Gmail messages in 500 mail messages, or 1.38% of all 507 documents once seven genuine notes are included. Its gold is the genuine note for each targeted query. Lower planted top-5 occupancy is better.

`standing` has 30 conditional memories, 150 positive paraphrases, and 300 negative near misses. Retrieval scores printed by the ordinary runner include zero-gold negative queries and are not the standing quality metric. The firing curve captures the replayed query embedding actually used by recall, compares it with each replayed standing-memory embedding using exact cosine, fires the top two above each threshold, and counts true positives, false positives and false negatives against the per-query gold. Precision is `TP / (TP + FP)` and recall is `TP / (TP + FN)`. No product standing-memory behavior exists yet.

No measured threshold reaches the Track 7 goal of precision at least 0.9 and recall at least 0.7. The current recall query embedding is distilled for retrieval; at 0.30 its top-two cap finds only 50 of 150 expected instructions and fires 850 wrong ones. At 0.85 nothing fires, so precision is reported as 0 rather than treating an empty prediction set as success. This baseline is a measurement of today's query embedding, not an implemented standing-memory feature.

The noise, injection and standing diagnostics are report only. Temporal's two categories can be named with `--target temporal` or `--target knowledge-update` in the existing comparison gate. That gate still requires its usual power and cost checks. The core lock and gate rules are unchanged.

The core-1k control run on this branch had 1,751 queries, Recall@5 0.505140, Recall@10 0.537693, MRR@10 0.532007 and nDCG@10 0.483633. All 1,751 `rankedIds` arrays matched the committed lock, with zero query errors, leaks or degradation.
