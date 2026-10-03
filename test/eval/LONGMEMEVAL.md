# LongMemEval phase A (T-0089.1.4)

Reproducible retrieval-quality benchmark, local only: no Cloudflare account, offline
Workers AI replay, recorded embeddings cached and never recomputed. See
`test/eval/longmemeval.ts` and `test/eval/longmemeval-cli.ts` for the code; this file
is the methodology write-up the spec's own deliverables ask for (01-foundations.md
T-0089.1.4, "A methodology write-up that ships with the numbers").

## Dataset

- **Source:** `xiaowu0162/longmemeval-cleaned` on Hugging Face, the "s" split
  (`longmemeval_s_cleaned.json`), pinned to commit `98d7416c24c778c2fee6e6f3006e7a073259d48f`
  and verified by sha256 before use (`scripts/eval-fetch-public.mjs`'s `longmemeval` pin).
- **License:** MIT (dataset card and the upstream `github.com/xiaowu0162/LongMemEval`
  LICENSE file both confirm it). Attribution: Wu et al., "LongMemEval: Benchmarking Chat
  Assistants on Long-Term Interactive Memory", ICLR 2025.
- **Not fetched:** the "m" split (~500 sessions/haystack, ~250k sessions total, roughly
  10x the "s" split's embedding cost) and the "oracle" split (evidence-only, nothing to
  retrieve). "s" alone matches the spec's own "about 25k sessions" cost estimate.
- 500 questions, 19,195 distinct sessions, 23,867 haystack slots (sessions are reused
  across questions' haystacks). Nothing from the dataset is committed; it lives under
  the git-ignored `.eval-cache/public/longmemeval/`.

## Method

- **Isolation.** Every LongMemEval question has its own haystack. Rather than build new
  per-question workspace/identity plumbing, `scoreQuestions` runs one small, freshly-built
  `CorpusSpec` per question (its own haystack only) through the shipped harness
  (`loadCorpus` + `runVariant`) — no other question's sessions ever exist in the D1
  instance that scores it.
- **Recording.** One `prepare()` pass per question, against that question's own isolated
  corpus — the exact shape scoring uses. An earlier version recorded against one large
  combined corpus for efficiency; that was wrong, because recall's own routing (which
  arms fire, whether the reranker or a keyword/tag call runs at all) depends on corpus
  size, so a 2,000+ entry combined corpus did not reliably record what each ~40-entry
  per-question corpus needs at score time (31/50 cache-miss errors on the first sample
  score attempt). Session and query text embeddings are still cached by content, so a
  text recorded once is never re-embedded just because a later question's corpus also
  contains it — only the size-routed calls (mainly the reranker) repeat per question.
- **Model:** `@cf/baai/bge-small-en-v1.5`, local (`test/eval/local-ai.ts`'s pinned ONNX
  weights, no Workers AI account, no neurons). Variant: `baseline` (shipped recall,
  reranker in its auto mode) — the closest real-world measurement.
- **Categories.** LongMemEval's six `question_type` values do not map onto this harness's
  closed `QUERY_CATEGORIES` 1:1. Each maps to the closest existing bucket for gate-shaped
  reporting (`CATEGORY_MAP` in `longmemeval.ts`); the original type is preserved verbatim
  as a `subset:` tag, which is what every report below actually breaks down by.
- **Metrics:** retrieval only (Recall@5, Recall@10), per LongMemEval question_type, with a
  95% Wilson interval per type (`test/eval/standing.ts`'s `wilson()`) — small per-type n
  means wide intervals; that is the honest picture, not a bug in the report. Phase B (QA
  accuracy with a local judge) is a 4.x follow-up, not built here.
- **Gate proof:** `test/eval/longmemeval.test.ts` proves the pipeline on a synthetic
  fixture (no download, no real model inference): isolation holds structurally, a real
  LongMemEval data quirk (a session id repeated within one question's own haystack) does
  not fail the load, and the gate works both ways — the real gold session outranks a
  wrong one on the same recorded cache.

## Sample validation run (50 questions, stratified)

Before committing machine time to the full 500-question embed, a 50-question run
(proportional across all 6 question types) validated the pipeline and gave a real
per-item embedding rate to estimate the full run from, rather than guessing.

- **Stratification:** knowledge-update=8, multi-session=13, single-session-assistant=6,
  single-session-preference=3, single-session-user=7, temporal-reasoning=13 (2026-09-28).
- **Record:** 2,329 distinct sessions, `taskset -c 0-3` + `nice -n 15`, 57.4 minutes
  measured (about 200 ms per embedded chunk) — faster than the pre-run estimate (~1.5h).
- **Score (0 errors after the per-question recording fix):**

  | | Recall@5 | Recall@10 |
  |---|---|---|
  | Overall (n=50) | 0.850 (95% CI 0.726-0.924) | 0.893 (95% CI 0.778-0.952) |
  | knowledge-update (n=8) | 1.000 (0.676-1.000) | 1.000 (0.676-1.000) |
  | multi-session (n=13) | 0.635 (0.372-0.836) | 0.801 (0.530-0.935) |
  | single-session-assistant (n=6) | 1.000 (0.610-1.000) | 1.000 (0.610-1.000) |
  | single-session-preference (n=3) | 0.667 (0.208-0.939) | 0.667 (0.208-0.939) |
  | single-session-user (n=7) | 1.000 (0.646-1.000) | 1.000 (0.646-1.000) |
  | temporal-reasoning (n=13) | 0.865 (0.599-0.965) | 0.865 (0.599-0.965) |

  **Sample results, not the full benchmark** — confidence intervals are wide by design at
  n=50 (and as low as n=3 per type); read the interval, not just the point estimate.

## Full run plan (all 500 questions)

- **Schedule:** started 11:00 PM ET, 2026-09-28 (via a session cron job), so it runs
  overnight rather than competing with other lanes' work on this machine during the day.
- **Resources:** `nice -n 19` (lower priority than the sample's `-15`, since this is an
  unattended overnight run with nobody waiting on it) on 4 cores (`taskset -c 0-3`).
- **Expected duration:** the first full embedding pass dominates the time. At the
  sample's measured rate (about 200 ms/chunk), the full 19,195 distinct sessions plus 500
  questions is estimated at roughly 8-9 hours — the same order of magnitude as the
  sample's own rate scaled up by session count (2,329 to 19,195, about 8.2x). Recorded
  once; every later score (or re-score) pass replays the cache and takes seconds.
- **Caching:** `.eval-cache/replay/longmemeval.bge-small-en-v1.5.jsonl`, content-keyed,
  never recomputed once present — the sample run's own recordings are already in it and
  are reused, not redone.
- **Publishing:** these numbers are for the benchmark page (Track 5, `05-proof.md`), but
  whether and when to publish is Rahil's call, not made here.
