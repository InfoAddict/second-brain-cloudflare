# Second Brain Worker — module layout

Incremental split of the former monolithic `index.ts`. Entry point remains `src/index.ts` (Wrangler `main`).

## Layers (import rules)

| Layer | Path | May import from |
|-------|------|-----------------|
| Pure | `memory/`, `text/`, `recall/math.ts`, `recall/rrf.ts` | `constants.ts` only |
| Infra | `env.ts`, `constants.ts`, `lib/`, `db/` | pure, same layer |
| Domain | `capture/`, `recall/`, `graph/`, `compression/`, `integrations/`, `projects/` | infra, pure, domain peers |
| Edge | `routes/`, `mcp/`, `oauth/` | domain, infra |
| Entry | `index.ts` | edge only (+ wiring) |

**Never:** pure/infra → domain/edge; domain → routes/mcp.

## Module map (original `index.ts` sections)

| Section | Module |
|---------|--------|
| Env, SB_VERSION | `env.ts` |
| Thresholds, models, chunk/vectorize/recall constants | `constants.ts` |
| CORS, json, auth | `lib/http.ts` |
| embed, readStreamText, graceMs | `lib/ai.ts` |
| actor label resolution | `lib/actors.ts` |
| initializeDatabase | `db/init.ts` |
| status/kind tags | `memory/status.ts`, `memory/kind.ts` |
| tag LIKE pattern + escaping | `memory/tag-sql.ts` |
| tag vocabulary cache | `tags/vocabulary.ts` |
| compression eligibility | `compression/eligibility.ts` |
| chunk, hashtags, temporal, tokenize | `text/*` |
| cosineSim, rerank, mmr | `recall/math.ts` |
| rrfFuse | `recall/rrf.ts` |
| vectorize health | `vectorize/health.ts` |
| graph edges/traverse/pass | `graph/*` |
| recall search pipeline | `recall/*` |
| FTS match-query builder + KV readiness gate | `recall/fts.ts` |
| FTS write guard + hot-path repair | `db/fts-write-guard.ts`, `db/fts-repair.ts` |
| FTS nightly backfill + integrity self-heal | `db/fts-backfill.ts` |
| capture write path | `capture/*` |
| compression nightly/digest | `compression/*` |
| staleness pass + classifier | `staleness/*` |
| integration mirror | `integrations/mirror.ts` |
| project registry, alias filter expansion, read-side resolution, auto-create | `projects/*` |
| OAuth pages/register/authorize | `oauth/*` |
| MCP server + sanitize | `mcp/*` |
| REST routes | `routes/*` |
| dbReady | `runtime/state.ts` |
| maintenance workspace rotation | `runtime/rotation.ts` |
| nightly summary written to KV for GET /stats/night | `runtime/night-summary.ts` |

## Recall keyword arm (FTS5)

Keyword recall serves its candidates from an FTS5 trigram index ranked by
`bm25(entries_fts)`, so the best matches become candidates instead of the
newest 500. Measured on local D1 through the real recall path: a search for
specific words reads about 66-193 rows whether the brain holds 5,700 or 20,700
memories, while the scan it replaced read the whole brain (20,766-41,541 rows
at 20.7k), roughly 200-300x cheaper at 20k, and the gap widens as the brain
grows. A query mixing a specific word with a very common one is still cheaper
(about 60% of the scan's cost at 20k), though unlike a specific-word search
that cost grows with the brain (1.83x from 5.7k to 20.7k). Saving a memory
writes one extra small row (7 rows instead of 6), flat — that row is the
per-workspace counter below, not the index itself, which was already
counted before.

`keywordSearch` (`recall/search.ts`) routes every query and reports the outcome
in `internal.diagnostics.ftsUsed` and `ftsRoute`:

- **FTS arm** (`keywordSearchFts`): queries the `entries_fts` virtual table,
  ordered by `bm25(entries_fts)`. `ftsMatchQuery` (`recall/fts.ts`) double-quotes
  each token (internal quotes doubled, so user text cannot inject FTS syntax)
  and joins them with OR. The trigram tokenizer matches substrings, which
  keeps the LIKE semantics recall has always had, including CJK text and
  identifier-shaped tokens such as `#149` or `v1.9`. The read joins `entries`
  on both rowid and id, so a row whose rowid-to-id mapping has drifted is
  excluded and duplicate FTS rowids cannot consume the LIMIT window.
- **Cost-aware router**: distillation's document frequencies, when they cover
  every term, estimate how many rows bm25 would have to score. Past
  `FTS_MATCH_BUDGET` (2,000) the query routes to the LIKE arm, which stops
  after `KEYWORD_CANDIDATE_LIMIT` (500) newest hits; bm25 scores every match,
  LIKE stops early. Single-word queries (no frequencies are computed for them)
  and queries with an uncounted term keep FTS.
- **LIKE arm** (`keywordSearchLike`): the pre-FTS body, unchanged, ordered
  newest-first. Serves the query when the readiness flag is not set, when the
  liveness check fails, when any retrieval token is under
  `FTS_MIN_TOKEN_LENGTH` (3 codepoints, the trigram floor: a token such as
  `v1` cannot match through the index, and the whole query routes here so it
  is not silently dropped), when a token contains NUL (SQLite truncates at `\0`
  and MATCH throws), or when the FTS query throws. The same fallback serves
  every recall until an existing brain's index is built and verified.

Two gates decide whether the FTS arm runs at all. `ftsReady` (`recall/fts.ts`)
reads the KV flag `fts:ready` and caches the answer in both directions for
`FTS_READY_CACHE_MS` (5 minutes). Separately, every FTS query carries
`FTS_LIVENESS_SQL` in the same `DB.batch` as the search itself: `entries_fts`
and all three sync triggers must be present with their exact definitions (a
right-named trigger with a drifted body reads as not live), or the arm throws
into the LIKE fallback. Correctness never depends on KV alone.

Term distillation (`recall/distill.ts`) counts through the index too:
`distillViaFts` batches the liveness check, the exact per-workspace total from
`entry_counts` (a trigger-maintained counter table, one row per workspace,
created and seeded in `db/init.ts`), and one capped MATCH count per term. A
term containing accented Latin counts through the LIKE scan instead
(`ftsCountSafeToken`: LIKE folds ASCII case only, trigram folds all of
Unicode, so the two could count differently). If every original term
saturated its cap, the counts are discarded and the LIKE scan counts exactly.

Fusion is unchanged above the keyword arm: `fuseDenseAndKeyword` still sorts by
the JS boundary/IDF weight, with the bm25 order surviving as the tiebreak
within equal weight tiers (`keywordPreRanked`); MMR, the graph, and rerank
heuristics do not change.

Schema (`db/init.ts`, mirrored in `db/schema.sql`): the virtual table
`entries_fts` (`fts5(id UNINDEXED, content, tokenize='trigram')`) plus triggers
`entries_fts_insert`, `entries_fts_update`, `entries_fts_delete`, which mirror
`entries.rowid` into `entries_fts.rowid`. A plain table, not external-content:
`entries` has a TEXT primary key, so the triggers sync by rowid (an O(1) delete
rather than a content-table scan). The update trigger fires only when rowid,
id, or content changes; a `recall_count`-only update writes nothing. Table and
triggers are created together in one batch and never repaired independently; a
missing trigger on an existing table reads as not live.

The write guard (`db/fts-write-guard.ts`, installed at the Worker entry for
every request and the nightly job) patches each statement that writes to
`entries`. It guards two dependencies, `entries_fts` and `entry_counts`: a D1
error naming one of them is checked, and the other (which threw nothing) is
probed live, so a single write that finds both missing repairs both.
`repairFtsIndex` (`db/fts-repair.ts`) deletes the ready flag, resets the
backfill cursor, recreates the table and triggers when the table is missing,
and otherwise drops only the three sync triggers, a non-destructive disabled
state every reader already sees as not live. `repairEntryCounts`
(`db/entry-counts-repair.ts`) recreates the counter table and its three
triggers and reseeds it from a `GROUP BY`, the same shape `applySchema` uses
the first time. The failed statement or batch is then retried exactly once;
a failed D1 statement or batch has no effect, so the retry is safe, and
saves never fail because of either dependency.

Nightly maintenance (`runFtsMaintenance` in `db/fts-backfill.ts`):

- **Not ready:** backfill 2,000 rows per night (`FTS_BACKFILL_BATCH`) behind the
  KV cursor `fts:backfill-cursor`, each batch deleting its rowid range before
  inserting so re-runs are idempotent. The ready flag latches only after exact
  parity in both directions (`entries` vs `entries_fts`, compared on rowid,
  id, and content) passes together with liveness; a single mismatching row
  restarts the backfill instead.
- **Ready:** FTS5's own `integrity-check` statement runs first; a throw there
  rebuilds. Count parity (`entries` vs `entries_fts`), a spot check of the
  newest rows' rowid-to-id mapping, and a rotating 200-row content check
  (`FTS_CONTENT_CHECK_WINDOW`) that compares (rowid, id, content) both ways and
  re-indexes exactly the mismatched rowids in place. `entry_counts` is checked
  separately and per workspace, not as one global total — a global sum can
  stay correct even while one workspace's count has drifted against
  another's — plus its three trigger bodies; either kind of drift drops and
  reseeds it from a fresh `GROUP BY`. Drift that FTS count parity catches
  resets the backfill; the destructive rebuild (`rebuildFtsIndex`: drop
  triggers and table, recreate, restart) runs only in this nightly job, never
  from a request path.

Upgrade is automatic. A brand-new brain latches ready at init (its triggers
cover every row from row one); an existing brain backfills over about N/2,000
nights while recall stays on LIKE until the backfill is complete and
verified, then switches — every server instance notices and starts using it
within `FTS_READY_CACHE_MS` (5 minutes) of the flag going live, since each
instance only checks periodically rather than on every request. No API or
MCP change.

## Recall eval (developer tooling)

`npm run eval:recall` lets a contributor prove that a retrieval change helps
before it ships, catch a change that quietly hurts some kind of query, and see
what the change costs in D1 statements, rows read, and AI calls. It runs the
real `recallEntries` against a fixed golden query set and ends in a
machine-checked verdict, so a reranker or a new embedding scheme ships on
measured evidence. It lives under `test/eval/` and is never part of the Worker
bundle.

**What it measures.** Real SQLite (the shipped schema, a real `entries_fts`
index, real `entry_counts`), the corpus indexed through the real write path
(`storeEntry`), and the top 10 scored per query: recall@5, recall@10, MRR@10,
and nDCG@10, overall and per category (identifier, CJK, rare word, common word,
short word, paraphrase, multi-hop, long context). Per query it also reports D1
statements, D1 `rows_read`, AI calls, neurons, and wall-clock (reported, never
gated). Neurons are projected from local token counts and the published rates,
not billed. `rows_read` is real only with `--d1 workerd`, which runs wrangler's
local workerd D1; the default `sqlite` backend cannot measure it. recall@5 is
read from the top-10 prefix, which is what production's `topK` 5 returns:
recall ranks from a fixed candidate pool (dense 15, graph seat budgets sized
for `topK` 5), diversified in blocks of five picks with each block ordered by
score, and the linked memories are placed against those blocks (the first in
the fifth place, the second at rank 10 or after the second block), never
against how many of a block's picks could be shown. **What is guaranteed:** for
one query, filters, scope and `hops` over an unchanged brain, the results of a
`topK` are the leading results of every larger `topK`, up to the API maximum
of 20, whether or not some indexed memories are hidden from the caller (an
`auto-*` or deprecated tag, another workspace, a filter, a deleted memory whose
vector is still indexed). A list can be shorter than `topK` when the picks of a
block do not all hydrate, as a `topK` 5 call always could; a larger `topK` then
continues it. When the diversified list runs out before `topK`, the rest comes
from a deeper dense query (50, the most Vectorize returns with values and
metadata), fetched only then and appended after everything else. Each recall
bumps `recall_count` on what it shows, which feeds later rankings, so two calls
made apart are only comparable if nothing was recalled between them (the eval
drops that write). `test/integration/recall-top-k-prefix.test.ts` sweeps this
over seeded corpora.

**Why the numbers can be trusted.** Runs are deterministic and need no network
and no Cloudflare account. Embeddings (and any reranker scores) come from pinned
open-weights models run locally with `@huggingface/transformers` (a dev
dependency): bge-small-en-v1.5, bge-m3, and bge-reranker-base, fetched
anonymously from Hugging Face into `.eval-cache/models/` and verified against
recorded hashes. They are computed once and stored in a content-addressed replay
cache; a cache miss during a run fails instead of computing. The committed
`core-1k` cache means a contributor needs neither an account nor a model
download to run that corpus. Every cached row records which model build produced
it, and reports from different producers never compare. Vectorize is an
exact-cosine emulator, the clock is frozen, and `recall_count` writes are
dropped, so one variant on one corpus ranks every query identically on every
run. Recall makes no query-tag LLM call (hashtags and literal tag matches only),
so the `--llm-tags` arms are inert for current code. They stay because a
comparison against a commit that still made the call needs both sides on one arm,
and because any LLM call recall grows again is answered by the stand-in (a
deterministic embedding-nearest pick, agreement with a real model unmeasured) or
fails the query loudly, never silently. `--llm-tags empty` answers as if the call
failed. Both sides of a comparison must use the same arm.

**Corpora** (`npm run eval:recall -- --list` names them). `core-1k`, `scale-5k`,
and `scale-20k` share one authored, fully synthetic set of golden memories and
queries inside a growing seeded haystack; the two larger ones push a common
token past the 500-row keyword window, which is what lets the eval tell the LIKE
and FTS keyword arms apart. `scifact` (about 5,200 abstracts, 693 judged claims)
and `miracl-ja` (about 13,500 Japanese passages, 860 queries) are public sets
for natural-language and CJK realism. `node scripts/eval-fetch-public.mjs
<scifact|miracl-ja>` downloads them into `.eval-cache/public/<id>/`, each file
pinned and verified by sha256 (miracl-ja fetches about 1 GB of shards). They are
local only: never committed, never locked, and always run with the model each
was recorded for (`scifact` with bge-small-en-v1.5, `miracl-ja` with bge-m3;
naming another model is refused). Running one before fetching fails with a
"MANIFEST.json not found" message. Licenses, for local evaluation use only and
nothing redistributed: SciFact claims are CC BY 4.0 and its abstracts ODC-By 1.0
(allenai/scifact upstream; attribution in the header of
`scripts/eval-fetch-public.mjs`); MIRACL annotations and corpus are Apache-2.0,
with passages that are Wikipedia text under CC BY-SA 4.0. There is no private
tier: nothing derived from a real brain is used. `test/eval/privacy.ts` keeps
the guards (ignore rules, an allowlist of the only files that may be tracked
under `test/eval/data/`, a canary scan, and a refusal to write any path git
would pick up) and documents how a private tier could be added without
redesigning them.

**Variants.** A change under test is a variant: query-time flags on
`RecallInternalOptions` (for example `variant.arms`), config overrides, or an
index-time hook that replaces `storeEntry`. Built in: `baseline` (shipped
recall), `like` (keyword arm on the LIKE fallback), `fts-orderless`, and the
ablations `dense-only` and `keyword-only`, which each must lose somewhere or the
golden set is too easy.

**The gate.** `npm run eval:recall -- --compare baseline,<variant>` ends in
PASS, FAIL, or INCONCLUSIVE. Rules, in order: the two reports are comparable;
hard invariants (zero cross-workspace leaks, errors, and degraded queries);
enough queries and clusters to judge (200 and 30); no regression (no headline
metric down 0.01 or more, none significantly down at any size, and no category
down beyond its noise floor); an improvement (recall@10, MRR@10, or nDCG@10 up
0.02 with a paired cluster bootstrap interval above zero, or up 0.05 in a
category declared with `--target`); and cost within budget (at most +2 D1
statements, +25 neurons, and +1 AI call per recall, and `rows_read` within 25%
plus 50 rows). A cost-only win with flat quality FAILs the improvement rule by
design. The report prints the minimum detectable effect (MDE), 2.8 times the
standard error of the same cluster bootstrap that draws the interval, so the two
share one estimator: whole clusters are resampled and each counts by its
queries. After the verdict it prints a `losers:` list of queries
that got worse, which a mean can hide behind a few winners.

A comparison is INCONCLUSIVE, meaning not proven rather than disproven, when:
`rows_read` is unmeasured (any `sqlite` run); the paired deltas are too noisy to
show a gain of the margin's size (the bootstrap MDE exceeds it); a targeted
category or known gap has too few queries or clusters to prove a gain; or the
reports are not comparable (different corpus, model, producer, D1 backend,
isolate mode, LLM tag arm, or golden data; a missing producer or data
fingerprint; a stale runner version). `--hash-embeddings` and `--limit` runs can
never PASS. So a `sqlite` comparison is a fast quality check, and reaching PASS
needs `--d1 workerd`, or `--allow-unmeasured-rows` for a deliberately cost-blind
run that skips only the `rows_read` check.

**Known gaps.** Some queries are tagged `known-gap` (plus `gap:<id>` for the
tracked issue): failures that are documented and measured but not yet fixed. The
headline `overall` row and the category rows exclude them, because a query no
variant can answer only dilutes every delta, and the report prints a `known
gaps:` block and an `all queries` row (so `overall n=318` and `all queries
n=338` appear together). Cost and the hard invariants always cover all queries.
A gap is corpus-conditional, so the gate decides by score, not by tag alone: a
gap query the baseline already answers stays in the regression rule. A variant
that claims to fix a gap declares it with `--target-gaps <id>`.

**Flags.** `--variant <name>` runs one variant; `--compare <a>,<b>` runs the
gate (either side may be a saved report `.json`); `--corpus <id>` (default
`core-1k`); `--d1 sqlite|workerd` (default `sqlite`); `--isolate warm|cold`
(cold resets the FTS-ready and Vectorize filter memos per query);
`--embedding-model <model>`; `--llm-tags stand-in|empty`; `--json <path>` writes
the report or comparison to a git-ignored path (never under `test/eval/data/`);
`--limit <n>` runs the first n queries and the gate refuses it;
`--hash-embeddings` uses fake vectors, for harness smoke tests only; `--target
<categories>` and `--target-gaps <ids>` (comma-separated) declare what a variant
claims to fix; `--allow-unmeasured-rows`; `--list`.

**Commands.** `prepare --variant <name> [--max-neurons <n>] [--concurrency <n>]`
computes and caches every missing embedding locally in three passes (dry run for
an estimate, record, then a replay pass that proves the cache is complete),
needs no credentials, and refuses to exceed `--max-neurons` (default 4000).
`export-cache` writes the committed `core-1k` replay layer from the local cache.
`stamp-cache --producer-from current|<cache file> --i-recorded-this [--layer
local|committed]` labels legacy rows of a cache with their producer, on the
operator's word alone (rows store only a hash, so it cannot be verified). `lock`
reruns the baseline on a core corpus and rewrites the committed baseline in
`test/eval/data/baselines/`; it refuses if the golden data changed since its
manifest unless `--accept-data-change "<reason>"` records the change in the
manifest history. Exit codes: 0 is PASS (or a healthy single run), 1 is FAIL (or
a single run with errors, leaks, or degraded queries), 3 is INCONCLUSIVE, and 2
is a usage or runtime error (a bad flag, a replay cache miss, a refused write, a
refused `lock`).

**Baseline lock.** A test (`test/eval/baseline-lock.test.ts`) reruns the
baseline on `core-1k` and fails if any query's ranking differs from the
committed lock, so every change to default recall ranking is deliberate: run the
comparison, run `lock`, and commit the new lock with the gate output. The lock
was recorded on `workerd`, so `test/eval/baseline-lock.workerd.test.ts` also
checks D1 statements (exactly) and `rows_read` (within 2 rows per query); it is
opt-in, run by `npm run test:eval:workerd` and by the `eval-workerd` CI job. The
locked headline (core-1k, `workerd`, `--llm-tags stand-in`) excludes known gaps:
over the 318 remaining queries, recall@5 is 0.741, recall@10 0.770, MRR@10
0.758, and nDCG@10 0.707. Over all 338 queries it is 0.756, 0.784, 0.771, and
0.723.

**How long it takes.** A `core-1k` comparison takes about 10 seconds on `sqlite`
and about 7 minutes on `workerd`, which runs each query against a real local D1.
A cold `prepare` for `scale-20k` takes about 25 minutes locally. `npm run
test:eval:workerd` runs the workerd-backed tests (including the workerd lock
tripwire), which the default suite skips; `npm run test:eval:public-download`
and `npm run test:eval:local-models` are the other opt-in checks.

## Tests

Tests import the worker default export only from `src/index`. Functions and types import from domain modules (e.g. `src/capture/entry`, `src/env`).
