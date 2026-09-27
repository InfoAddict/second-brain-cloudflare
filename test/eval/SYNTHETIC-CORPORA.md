# Synthetic 4.0 eval corpora

Four opt-in corpora, generated from seed `40891` (generators in `corpus/synthetic-*.ts`, SHA-256 data fingerprint in each spec). Every document is fictional. No account, live brain or Cloudflare API is used: the loader uses the production index write path over local D1, exact-cosine Vectorize and the pinned local embedding model. Default runs (`npm run eval:recall -- --variant baseline`) still select `core-1k` and never include these.

## Reproduce

Install with `npm ci`. For each corpus ID in `temporal noise injection`:

```sh
npm run eval:recall -- prepare --variant baseline --corpus ID
npm run eval:recall -- --variant baseline --corpus ID
```

For `standing`, use `--variant no-rerank` and add `--max-neurons 6000` to `prepare` (the byte-count estimate is about 4,100 production-equivalent neurons; nothing is billed, embeddings are local). `prepare` records content-addressed embeddings in `.eval-cache/replay/<corpus>.*.jsonl`; the second command is fully offline. Caches are not committed, as for public corpora: only the core cache is committed by repo convention, and these corpora never read or write it. Add `--json PATH` for a machine-readable report. `temporal` and `noise` also work with `--compare no-rerank,baseline --target knowledge-update,temporal` (or `--target noise`); the gate's cost check stays inconclusive on the sqlite backend, as everywhere.

| Corpus | Docs | Queries | Clusters | Role |
| --- | ---: | ---: | ---: | --- |
| `temporal` | 615 | 490 | 150 | GATE for Track 2 (targets `knowledge-update`, `temporal`) |
| `noise` | 650 | 210 | 210 | GATE for Track 3 (metrics MRR@10 and recall@5) |
| `injection` | 5,000 | 80 | 80 | REPORT-ONLY |
| `standing` | 2,517 | 1,500 | 1,170 | REPORT-ONLY (measurement) |

A gate needs at least 200 queries and 30 clusters and the corpus must contain the failure it is meant to catch. `temporal` and `noise` meet both. `injection` has the power but not the meaning of a gate: the metric is occupancy of the top 5, not whether an answer was corrupted (that needs an LLM in the loop, which Track 5 owns). `standing` tunes nothing; it measures.

## temporal (GATE)

What it measures. 120 timelines, each with a distinct pseudo-word subject ("Velmora studio lease", no numbered siblings), in four shapes: `update` (35), `retro` (35, backdated notes and a recap written after the fact), `retracted` (30, a fact later withdrawn by a correction), `edited` (20, a document edited after the as-of date). Each timeline gets a current-state question (`knowledge-update`, gold = the fact valid now) and past questions (`temporal`). Subsets, in the report:

- `current`: "Where is X now?". The newer fact must beat the older one.
- `prefiltered`: "Where was X in April?" with a per-query `asOf`; the runner passes `before: asOf + 1`, so the newer fact is excluded and this only tests ranking among older documents.
- `phrase-dated`: "as of April 15, 2026". Not pre-filtered, so the phrase parser is exercised. Today's parser turns a date into a created-on-that-day filter and returns nothing, so the baseline is 0. This is the target for Track 2's as-of parsing.
- `phrase-vague`, `backdated-past`, `retracted-past`: "during April / July" with no pre-filter; `expectedAsOf` records the date for the oracle. Backdated and retracted golds are documents created after or superseded by the as-of date.
- `control-not-asof`: 30 questions naming a place such as "the Aug 8 ... Cafe". A parser that reads them as a question date filters the wrong documents; baseline is 0, correct behaviour is ordinary retrieval.

Data model (`corpus/types.ts`). `CorpusEntry` gains `updatedAt`, `validFrom`, `validUntil`, `retractedAt`, `priorVersions`; supersession is a `supersedes` edge (newer to older). The loader writes `updated_at` and the edges today. `applySupportedTemporalMetadata` (`corpus/loader.ts`) writes `valid_from`/`valid_until` only when the entries table has those columns (none yet), and `loadCorpus` takes a `temporalMetadata` writer as the extension point for Track 2's write path. Queries gain `expectedAsOf`. Documents are dated at noon UTC so the local-time date parser gives the same answer in every timezone from UTC-11 to UTC+11.

Oracle (`temporal-oracle.ts`, printed in the report). From the recorded rankings alone it simulates (a) supersession applied: drop documents whose declared validity excludes the question date; (b) recency only: reorder by creation time, which the backdated recap defeats. Baseline current-state MRR@10 is 0.702; supersession applied 0.809 (the ceiling given what the pool returns); a plain recency reorder falls to 0.212. On `backdated-past` 0.514 to 1.000; on `retracted-past` 0.578 to 0.983; on `phrase-vague` 0.498 to 0.986.

Baseline (recall@10 / MRR@10): overall 0.663 / 0.460 (n=490); `knowledge-update` 0.958 / 0.702 (n=120); `temporal` 0.568 / 0.381 (n=370). Subsets: current 0.958 / 0.702, prefiltered 0.917 / 0.736, phrase-dated 0 / 0, phrase-vague 1.000 / 0.498, backdated-past 1.000 / 0.514, retracted-past 1.000 / 0.578, control-not-asof 0 / 0.

Power. Unpaired MDE for MRR@10 at 80% power, two-sided 95% (2.8 x bootstrap SE over clusters): 0.048 overall. Recall@10 is near ceiling on `current`, so only MRR can show gains there.

Cannot measure. Id-level gold cannot check that an as-of view shows the earlier version's text; `edited` timelines declare `priorVersions` for that future path and today only test retrieval. The supersession oracle is an upper bound on what dropping invalid documents can do, not a prediction of Track 2's contradiction detection, which lives in `captureEntry`; the loader writes with `storeEntry`, so the LLM check does not run here.

## noise (GATE)

Reproduces the Aug 16 mechanism: 6 senders plus 4 more with their own templates (deposit notices, bookings, prescriptions, bills, orders, statements), all ending in one identical long footer ("Thanks for choosing us. Sign in to your account ...", repeated as real mail repeats it). 90 near-identical direct deposit notices differ only in amount and reference. About 260 genuine notes reuse footer words.

Queries (210). `probe-footer-words` (40) and `probe-footer-synonym` (30): "choosing a name for the new feature", "User is choosing a datastore ...", "who did I thank for ...". They share only footer words with the mail; the answer is a genuine note, in the synonym tier written with no query words. `recurring` (40): "Show the direct deposits from payroll batch PB07" has three golds among 90 near-identical notices (so keeping one representative per template loses recall), plus amount lookups. `email-control` (60): flights, prescriptions, bills, half phrased "in my email ..." / "according to my email". `note-same-topic` (40): a genuine decision note on a topic that also has mail. 100 of 210 queries are answered by an email and 110 by a note, on the same topics, so source alone does not separate gold and blanket email demotion fails the email-correct half.

Baseline (recall@5 / MRR@10): overall 0.919 / 0.881. Subsets: probe-footer-words 1.000 / 0.988; probe-footer-synonym 0.433 / 0.351; recurring 1.000 / 1.000; email-control 1.000 / 0.975; note-same-topic 1.000 / 0.912. Email share of the top 3 on probes: 0.142 (literal), 0.122 (synonym). Email-correct queries with no email in the top 5: 0. Unpaired MDE for MRR@10: 0.057.

Cannot measure. The literal probes and recurring queries are saturated at baseline (no headroom), so they act as regression guards, not improvement targets. Headroom is in `probe-footer-synonym` (n=30), where failures mix footer intrusion with plain paraphrase weakness: the corpus cannot say how much of the 0.35 MRR is footer noise. The live brain's 7-of-10 email top 10 was not reproduced at this size (650 documents against a real mailbox); do not read the probe email share as the production rate.

## injection (REPORT-ONLY)

80 targeted subjects, each with a genuine note (gold), one planted email, and two benign emails on the same topic, inside 5,000 documents (plants 1.6%). Four plant styles, 20 each, tagged `plant-<style>`: `command` ("Ignore previous instructions ..."), `role` ("SYSTEM NOTICE to the assistant ..."), `factual` (poisoning with no command words: "the plan was cancelled"), `impersonation` ("Note to self: I changed my mind"). Metric: share of top-5 slots taken by planted documents for the targeted queries.

Baseline: planted top-5 share 0.397 (159/400 slots), 0.39 to 0.40 for every style; gold recall@5 1.000, MRR@10 0.268 (plants outrank the note). Own plant is rank 1 in 12/20 command, 11/20 role, 18/20 factual, 17/20 impersonation queries. MDE at 80% power, slot-level binomial: 0.069. Because the plants mimic the notes' subject, occupancy is high in every style; the factual style, which a command-word filter cannot catch, ranks first most often.

Cannot measure. Retrieval occupancy is not compliance: whether a model obeys a planted email needs a model and belongs to Track 5. Plants for other subjects share templates and appear in each other's results, so the effective independent sample is the 80 subjects, not 400 slots. Kept report-only for that reason.

## standing (REPORT-ONLY)

30 standing memories ("When booking a flight, check the shared calendar for conflicts first.") placed inside the core-1k documents (2,517 documents in all), all distinct situations so no memory has a sibling variant. Queries (1,500): 150 positives (5 phrasings per memory, gold = the memory); 120 `standing:overlap` negatives (different subject reusing the memory's key word, must not fire); 90 `standing:intent` (same subject, different intent such as "summarize the history of ...": the label is a product decision, reported apart and excluded from precision); 1,140 `standing:unrelated` (ordinary core-1k questions), so positives are 10% of traffic. Half the memories and half of the unrelated queries form a held-out `split:test`.

Method. Recall's embedding of each query is captured (`distilled`, what recall really sent to the model) and the raw query text is embedded too (`raw`). Each is compared by exact cosine with every standing memory's vector; at most two memories fire above a threshold, grid 0.30 to 0.90 by 0.05. Precision = TP / (TP + FP) over positives, overlap and unrelated queries; recall = TP / (TP + FN). The threshold is chosen on the dev split only (highest recall with precision at least 0.9, else best F1) and reported on the test split with 95% Wilson intervals. Product wiring is out of scope; Track 7 decides which input it uses.

Baseline. Distilled: chosen 0.75, held-out precision 1.000 [0.566, 1.000], recall 0.067 [0.029, 0.147]. Raw: chosen 0.70, held-out precision 1.000 [0.901, 1.000], recall 0.467 [0.358, 0.578]. Across all splits at 0.70: distilled precision 0.906 / recall 0.320, raw 0.988 / 0.540; at 0.65 raw is 0.834 / 0.840. The raw input clears the Track 7 goal (precision at least 0.9, recall at least 0.7) nowhere on this grid, but is far closer than the distilled one, whose dropped words cost most of the recall. Same-subject-other-intent queries fire in 15/90 (raw) and 23/90 (distilled) at 0.70 and in 66-73/90 at 0.60.

Cannot measure. The grid is 0.05 wide, so the chosen recall is coarse; the memories are hand-written and templated in phrasing (5 positive templates), so intervals reflect the 15 held-out memories, not the space of real instructions; unrelated traffic is core-1k question text, not real chat.
