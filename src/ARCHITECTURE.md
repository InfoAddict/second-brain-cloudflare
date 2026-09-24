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

- **FTS arm** (`keywordSearchFts`): queries the `entries_fts` virtual table.
  A full plan is ordered by `bm25(entries_fts)`; a bounded plan's AND tier is
  ordered newest-first by rowid instead (below). `planFtsMatch`
  (`recall/fts.ts`) builds the MATCH strings: it double-quotes each token
  (internal quotes doubled, so user text cannot inject FTS syntax) and joins
  them with OR, or with a space for the AND tier. (`ftsMatchQuery` in the same
  file builds the single-term counts distillation uses.) The trigram tokenizer
  matches substrings, which keeps the LIKE semantics recall has always had,
  including CJK text and identifier-shaped tokens such as `#149` or `v1.9`.
  The read joins `entries` on both rowid and id, so a row whose rowid-to-id
  mapping has drifted is excluded and duplicate FTS rowids cannot consume the
  LIMIT window.
- **Cost-aware router**: the index serves every query that has at least one
  FTS-eligible token. Tokens under `FTS_MIN_TOKEN_LENGTH` (3 codepoints: `io`,
  `k8`, two-character CJK words) cannot be retrieved through a trigram index, so
  they no longer send the whole query to LIKE (T-0074); they rank instead. The
  bm25 query orders rows carrying them first, evaluated on rows the MATCH
  already read, and fusion still weighs them. Distillation's document
  frequencies, when they cover every eligible term, estimate how many rows bm25
  would have to score. Within `FTS_MATCH_BUDGET` (2,000) the query is one OR
  over every eligible token. Past it (T-0073) the plan is bounded, in two tiers
  merged in this order:
  1. **AND tier**: every eligible token, so only rows carrying every word. Its
     size is bounded by the rarest token's df, not by the budget (words that
     always co-occur match the whole partition), so it runs as
     `ORDER BY entries_fts.rowid DESC LIMIT ?`: a reverse index scan (rowid
     follows insertion, so newest first) that stops at the LIMIT with no sort.
     On workerd at 5k that read 1,111 rows against 2,503 for
     `ORDER BY created_at DESC`, which also needs a temp b-tree over every
     match. Insertion follows time on capture, and `POST /import` sorts a
     payload oldest first before paging (`GET /export` now emits oldest first
     too, but exports taken earlier are newest first), so a restored brain is
     chronological too. The one exception is an older archive merged into a
     brain that already holds newer rows: the archive is inserted after them,
     so when more than the limit rows carry every word this tier prefers the
     archived rows. It still returns rows carrying every word. Ordering by
     `created_at` would fix that at the cost of sorting every match.
     When the OR tier's matches all fit in the candidate limit the AND tier
     adds no candidate (its rows carry every token, so they are among the OR
     tier's) and is left out.
  2. **OR tier**: the rarest tokens whose df sums within `FTS_MATCH_BUDGET`
     (greedy), ranked by bm25, so bm25 scores at most the budget and picks the
     best `KEYWORD_CANDIDATE_LIMIT` of them. The budget is not tied to the
     limit: measured at 500 and 1,000 it cost fewer rows but lost answers that
     carry only a moderately common token (0 of 6 and 3 of 6 guard queries
     reachable, against 6 of 6). A token past the budget cannot join this tier.
  A token whose df is 0 is in no row, so it drops out of both tiers, and a
  query left with no plan goes straight to LIKE without an FTS batch. Common
  words the plan leaves out still weigh in fusion. Both tiers run in the same
  `DB.batch` as the liveness check, so it costs no extra subrequest.
  Single-word queries (no frequencies are computed for them) and queries with
  an uncounted term keep the full OR.
- **Short-token df**: the index cannot count a short token and the exact LIKE
  count reads the whole partition, so distillation estimates its df from the
  newest `FTS_SHORT_TOKEN_SAMPLE` (200) readable rows, Laplace-smoothed
  (`shortTermSampleStmt`). It feeds fusion's all-or-nothing IDF and the
  saturation test that keeps a substring like `io` out of the embedded query.
  The sample sees only recent rows, so it can be wrong about a corpus whose
  recent rows differ from the rest; that is why `rankAndRebuild` lets a short
  token fill only the slots the counted terms leave and never outrank one.
- **LIKE arm** (`keywordSearchLike`): the pre-FTS body, unchanged, ordered
  newest-first. It now serves only a query with no eligible token at all (every
  token under 3 codepoints, such as a two-word CJK query), a lone eligible token
  whose own df passes the budget (no bounded plan exists), a bounded plan that
  found nothing (the recency window is the floor), a token containing NUL
  (SQLite truncates at `\0` and MATCH throws), the readiness flag not set, the
  liveness check failing, or an FTS query that throws. The same fallback serves
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

## Recall cross-encoder reranker

`recall/model-reranker.ts` re-scores a bounded set of already fused candidates
with `@cf/baai/bge-reranker-base` (one nonstreaming `AI.run`, request
`{query, contexts: [{text}], top_k}`, answer `{response: [{id, score}]}` with raw
logits). It sits after `rerankWithTimeDecay` and before `mmrRerank` and graph-root
selection, so dense and keyword candidate generation, fusion, graph expansion,
evidence rescue, rendering and synthesis are untouched.

- **Candidates.** Up to 25 direct parents in heuristic order plus up to 5 extra
  graph-root parents (30 total, one batch). Only parents the scoped
  candidate-signal read returned are eligible. At hops 0 one extra by-id read
  fetches their text (at hops above 0 the text is already in hand); it omits the
  scope clause on purpose, because with it SQLite scans the whole workspace instead
  of doing 30 primary-key lookups. Vectorize and keyword metadata content never
  reach the model. Each passage is `queryRelevantWindow(content, ..., 400)`.
- **Blend.** Model scores become rank percentiles within the batch (ties keep
  baseline order; all-equal is neutral). Only parents the model scored are
  reordered: each has its heuristic score multiplied by
  `max(floor, 1 + w * (2p - 1))` (`w = 1.0`, `floor = 0.25`, so nothing is
  multiplied by zero), and the scored block is scaled, by one factor, just clear of the
  best unscored score. A scored candidate therefore never falls below one the model
  did not see, unscored candidates keep their positions, and the same parent factor
  scales the direct and the root view. `w` and `floor` were chosen on core-1k from
  a grid pre-registered in the commit message before it ran ({0.5, 0.75, 1.0} x
  {0.25, 0.5}; rule: best paraphrase mrr@10 among configs with no regression, cost
  within budget and overall recall@10 not below baseline) and then validated once
  on scale-20k and SciFact. At full weight the model's order dominates.
- **Keyword evidence.** A parent the keyword arm returned that holds every distilled
  query term is always scored (up to five), taking the seat of the lowest-ranked
  fused candidate, and enters the blend at the edge of the fused candidates. A
  single-term query counts only if its df is within the saturation fraction (the
  keyword rows holding the term over one `entry_counts` read, taken only when the
  model is about to be called and an evidence row lies outside the head), so a
  common word takes no seats. At hops 0 the batch is 25 wide, so evidence extras
  evict fused candidates while up to five seats stay empty; that is the
  pre-registered rule, chosen to keep cost flat, and worth revisiting once real
  Workers AI cost is measured.
- **Routing (no AI).** `RERANK_MODE` is `off`, `on` or `auto` (default `auto`;
  an unknown stored value reads as `off`). `on` needs at least three parents;
  `auto` also needs the top two heuristic scores within 15%. A lookup-shaped
  query token always skips: `#` or `_`, a digit next to a letter (`v1.2`,
  `abc123`, `40mg`), a dotted name (`config.yaml`), a multi-dot number
  (`10.0.0.1`). Prose does not: a sentence-final period, a plain hyphenated word,
  a bare year, a plain number or percentage, and a dotted abbreviation of segments
  of two letters or fewer (`U.S.`, `e.g.`). Skip rates on the eval's queries:
  core-1k 29 of 338, SciFact 195 of 693 (the rule was fixed after seeing SciFact,
  so SciFact is in-sample for routing and held out for the blend). `off` returns
  before any read of the latch.
- **Readiness.** A model never runs until `reranker:ready:bge-base-v1` says the
  probe passed. `probeReranker` sends a small ranking check (the relevant passage
  must lead two unrelated ones by two logits) and then a production-shaped request
  (30 passages of 400 characters, a 256-character query) that must come back
  complete; any rejection, truncation or wrong length latches "0". The first
  recall that would have used the model schedules the probe in `waitUntil` (one per
  isolate at a time; a passing verdict lives a week, a failing one six hours, and
  the isolate remembers the verdict even if the KV write fails), so the contract is
  re-proved lazily at no cost to the nightly cron's statement budget. The probe has
  its own 15 s timeout; a recall allows 1.5 s (a judgment, unverified against
  Workers AI). The probe also latches "0" if its full-batch leg takes longer than a recall may wait. Its Latin filler
  under-probes a token-based size limit by about 4x for CJK text (400 CJK characters are
  roughly 400 tokens, not 100), so the circuit breaker below is the runtime backstop.
- **Circuit breaker.** Three consecutive timeouts or errors in an isolate latch the
  model off for six hours (here and in KV) until the probe re-proves it. Every
  applied, timed-out or failed step logs one JSON line (route, ms, batch size) to
  the Worker's logs, so the first real deploy measures Workers AI latency itself
  (`wrangler tail` or Workers Logs); the same route and latency are in
  `RecallDiagnostics.rerankRoute` and `rerankMs`.
- **Failure.** A thrown error, quota (3036) or capacity (3040) failure, timeout,
  or malformed, truncated or duplicate-id answer returns the un-reranked matches
  exactly. `RecallDiagnostics.rerankRoute` records what happened.
- **Cost.** One AI call, one D1 statement at hops 0 (none above), and one KV read
  for the latch per reranked recall. At the published 283 neurons per million
  input tokens the eval projects about 0.35 neurons per reranked recall (the
  query is counted once per pair, so this is conservative).

What the persistent losers show (core-1k `q-para-047/043/028/042`, `q-rare-011-c`,
`q-long-003`; scale-20k `q-rare-015`; SciFact 169 and 500). For the short notes
(most of them) the excerpt the model reads is the whole note, so the model simply
disagrees: it ranks generic filler that shares a word with the query above the
right memory, and every score in those batches is a low logit (about -6 to -10),
so the percentile order is close to noise. Two causes are structural rather than
model disagreement: a note longer than the excerpt is read from its head (or a
keyword window), so `q-long-003` and SciFact 169 never show the model the sentence
that answers (it sits about 1,400 characters in); and a keyword-only exact match
that sits at the tail of the fused pool (`q-rare-032`, `q-rare-015`) is never scored,
reaches the top 10 without the reranker only through MMR's diversity term, and is
displaced when the scored block is ranked above it. Anchoring the excerpt at the
dense arm's best chunk was tried for the first and did not move core-1k (paraphrase
mrr@10 +0.097 either way, overall recall@10 +0.012 against +0.015), because the
answer still sits inside a 1,600-character chunk; it was not shipped.

The eval's `rerank` variant forces the mode on through the typed
`variant.rerank` flag (no route can set it); `no-rerank` pins it off,
`baseline` and `rerank-auto` are the shipped `auto`, and `rerank-auto` carries the
pre-registered target category (paraphrase only: multi-hop has no headroom, mrr@10 0.974). The ship decision is
`npm run eval:recall -- --compare no-rerank,rerank-auto --corpus core-1k --d1 workerd`
(no `--target` flag), repeated on `scale-20k` and `scifact` with
`--allow-unmeasured-rows`. What it shows: the improvement clears its bar on the
point estimate only (paraphrase mrr@10 +0.064 against a 0.05 bar, CI lower bound
0.006, on core-1k), overall recall@10 does not move beyond noise (+0.003, CI
[-0.006, 0.015]), and on scale-20k it does not clear the bar (+0.037, lower bound
0.001). It is an ordering gain (better rank among candidates already retrieved),
not a retrieval gain. A change made on top of the shipped pipeline compares with
`--compare baseline,<variant>`; one made before the reranker with
`--compare no-rerank,<variant>`. The runner fails a query, instead of scoring
the fallback order, whenever the reranker was expected and the step did not end
in a model answer or a legitimate skip, so a replay miss cannot pass as a
result. Graph-root quality with the reranker on is covered two ways: the default suite
(`test/eval/legacy-rerank.test.ts`) checks plumbing only, with a model that agrees
with the heuristic order and a scrambling one, so linked memories keep their slots
and every frozen gate holds; the quality pin against the real model (at least 14
authoritative answers and no fewer than without the reranker, at most one
authority-rank regression where the frozen gate says zero) runs only under
`EVAL_LOCAL_MODELS=1` (`npm run test:eval:local-models`). `prepare` is the only path that runs the model (locally, pinned open
weights). Real Workers AI latency and billing are unmeasured: no account is used.
## Contextual chunk embeddings and the embedding scheme

**Off by default** (`CONTEXTUAL_EMBEDDINGS`). The gate passes on `core-1k` for both
models but not yet at scale, so it ships off until the expanded golden set clears
it; off, nothing below reads, writes or runs (no migration, ledger, index-size
read or second duplicate comparison), and the baseline lock is the plain scheme.
There is no user-facing toggle and none is planned: the feature ships on or not at
all. The key stays an ordinary, unlocked config key because it is the operator's
kill switch (API only, in no UI): setting it off pauses the migration, stops new
contextual vectors and stops the generated tier without a redeploy, and setting it
back on resumes the same ledger without re-embedding what is already contextual.
Flipping the shipped default is a one-line change, with a rewrite of the CHANGELOG
entry, which is written for the opt-in state.

A memory over 1,600 characters is split into chunks and every chunk is its own
vector. A fact buried in the middle of a long note is a small part of one large
chunk, so its vector says little about it. `capture/contextual.ts` therefore
cuts eligible memories (more than one effective chunk, at most 24,000
characters and 16,000 estimated tokens, not a mirrored source) into **focus chunks** of about 500 characters
with 50 of overlap, and sends each to the embedder behind a transient prefix
built from the entry itself: `[Memory: <first line>. Project <p>. Topics <t>.
Source <s>. Saved <UTC date>. Part i of n.]`, capped at 180 characters. Only the
embedding input carries the prefix: `entries.content`, FTS, and Vectorize
`metadata.content` stay raw, so snippets, evidence scoring and lexical recall
never see it. Single-chunk, mirrored and over-limit entries embed
exactly as before, and a failure building context falls back to plain chunks
without failing the save. Under bge-small, no chunk may exceed the 512-token
window or the embedder silently drops its tail, so `estimateBgeSmallTokens`
models BERT's own pipeline and chunks are cut and, if need be, split until prefix
plus chunk is at most 480 by that estimate (32 tokens under the window). The
model: control, format and private-use characters, combining marks and U+FFFD
are deleted before words are split (so they cost nothing and glue the words
either side, which soft hyphens and zero-width spaces make routine in pasted
text); whitespace ends a word; punctuation and unified CJK ideographs are one
token each; everything else (letters of every script, digits, symbols, spacing
marks) is part of a word, charged one token per character it becomes after
lowercasing and NFD decomposition, which is 3 for a Hangul syllable and 2 for
some Bengali and Tamil vowel signs; and a run of ASCII letters that is a whole
word of the tokenizer's own vocabulary (21,745 words) is exactly one token.
Prose therefore measures close to exact.

*What is established, and how* (this is evidence, not a proof): (1) a sweep of
every Unicode code point, alone, inside a word, between two vocabulary words and
repeated, against the real tokenizer finds no undercount
(`npm run test:token-sweep`, about 90 seconds, needs the model cache; an earlier
version undercounted 1,260 Hangul syllables, two vowel signs and 141,000 code
points between words); (2) every vocabulary word is checked to be one token;
(3) 300 random vocabulary-word pairs joined by each of ten deleted characters
have real counts in a committed fixture and never undercount; and (4) every
chunk shipped from 38 adversarial and per-script notes has its real count in a
committed fixture: 1,014 chunks, the largest 474 real tokens, and the estimate
is at or above the real count for every one
(`test/unit/contextual-token-guard.test.ts`). Largest estimated / largest real
chunk tokens by script: Korean 478 / 331, NFD Korean 467 / 322, Japanese
458 / 452, Chinese 458 / 452, Arabic 465 / 452, Hebrew 479 / 474, Cyrillic
462 / 446, Greek 464 / 441, Devanagari 468 / 422, Thai 474 / 36, Bengali and
Tamil 465 / 310, Vietnamese (NFD) 462 / 344, NFD Latin 475 / 232, soft hyphens
470 / 141, zero-width and control characters 458 / 126, emoji ZWJ 465 / 104,
astral math 457 / 95, fullwidth 460 / 210, random short words 476 / 361, hex
ids 457 / 352, base64 458 / 356. What it does not cover is a tokenizer behavior
none of those exercise (an interaction between two rare characters, say); the
32-token margin is what would absorb that, and the fixture is where to add a
counterexample. The migration's neuron cap is counted from the same estimate,
so it cannot run below billed tokens for these scripts (tested for Korean); for
bge-m3, whose tokenizer is not in the fixture, the same estimate is a
conservative proxy for an accounting bound, not a billing figure. CPU: the builder
is linear (frame computed once, allocation-free estimator, one estimate per
chunk), and eligibility is capped on estimated tokens as well as characters,
because a token-dense note is many more chunks per character. `storeEntry`'s own
JavaScript is at most 1.5 ms for the worst eligible shape (24 KB of common
words), 0.5 ms for token-dense text at its limit and 1.0 ms for 24 KB of prose,
on a quiet machine, against 10 ms per invocation on the free plan; the perf
test asserts 3.3 ms, a third of the limit.

**What it costs, and how it is bounded.** Focus chunks turn a 2,700-character
note from 3 vectors into 7, and the write costs one embedding call per chunk
(2.7 to 7.1 calls and about 1.2 to 1.6 neurons for a note that size; a
short note is unchanged). Two bounds keep that from eating the free plan's
Vectorize storage (5M dimensions, about 13,000 bge-small vectors):

- A note gets at most 6 focus chunks from its head, the rest cut at the larger
  tail size (`CONTEXT_MAX_FOCUS_CHUNKS`; 6 is the smallest that still passes the
  long-context gate, 5 and 4 do not).
- Focus chunking is a budget (`capture/focus-budget.ts`). While the index holds
  fewer than `CONTEXTUAL_FOCUS_DIMENSION_BUDGET` stored dimensions (2,500,000,
  half the free allowance; read from Vectorize `describe`, remembered five
  minutes, failing open; 0 removes the limit) long notes get focus chunks; past
  it they are cut at the tail size and grow the index as plain chunking always
  did. So the loss depends on how much of a brain is long notes, and it is
  capped: simulated to a full index of 13,020 vectors with 2,700-character
  notes, capacity against plain chunking falls 5.8% with 3.5% long notes, 7.7%
  with 5%, 12.5% with 10%, 18.2% with 20% and 23.5% with 40% (11.6%, 15.4%,
  25.0%, 36.4% and 47.1% with the per-note cap alone).

**Scheme versioning.** `embedding/scheme.ts` derives a scheme id from config
(1 is the pre-T-0042 raw chunk with mean pooling; contextual adds 1, cls
pooling adds 2). Vectors written under any other scheme carry `metadata.scheme`,
plus `contextualized` and `contextSource` for contextual ones. `EMBEDDING_POOLING`
exists for the eval only: cls pooling was measured and rejected (see the eval
section), and it is not settable from KV or PATCH /config, because it changes
the vector space and a brain that flipped it without migrating would rank
queries against vectors from another space.

**In-place migration** (`runSchemeBatch` in `migration/embedding.ts`). Existing
brains keep plain vectors until the migration rewrites them, an entry at a time
in the live index, resuming from a ledger (`migration:embedding-scheme`: model,
target scheme, every scheme a vector may still be in, keyset cursor,
the entry's rowid).

- *Safety.* Ids are deterministic (`<id>` / `<id>-chunk-<i>`), so a crash before
  the cursor moves just repeats the entry; chunk ids the new set no longer uses
  are deleted only afterwards; the row is re-read by content, tags, workspace
  and actor afterwards and rebuilt from the fresh row if a user edit or a share
  landed in between. Vectors are always stamped with the row's own workspace.
  Recall needs no change while it runs: contextual text does not move the vector
  space, so plain and contextual vectors rank against one query vector, and
  chunks of one entry collapse by `parentId`.
- *Pace* (with the switch on). A change in contextual text only concerns long, non-mirrored entries,
  so the SQL page selects only those and the cursor jumps over everything else.
  The page is ordered by rowid, the table's own key: an ORDER BY the created_at index
  cannot serve (its tiebreak is the id) makes SQLite sort every remaining row, and
  D1 bills rows read. On workerd's D1 with 20,000 rows and a page of 40 (1 in 29
  long) a page reads 1,200 rows from the start, 1,176 from the middle and 1,034
  for the last, against 10,348 for the sorted form; `EXPLAIN QUERY PLAN` shows a
  range scan with no temp B-tree (`test/eval/scheme-page.workerd.test.ts`).
  The hourly cron (`30 * * * *`, the integration sync's) runs a budget of 80
  chunks and the nightly job 12 (`SCHEME_RUN_CHUNK_BUDGET`,
  `SCHEME_NIGHTLY_CHUNK_BUDGET`), and a UTC day may spend at most 1,500 estimated
  neurons (`SCHEME_DAILY_NEURON_CAP`, 15% of the 10,000 allowance, counted from a
  high token estimate). An idle run costs the config read and one ledger read.
  An entry that fails for its own reasons three runs in a row is stepped past;
  a quota failure never counts against it. A model migration pauses this one and
  settles its ledger when it finishes.
- *Time to finish* (6.3 vectors per long note, 12 notes a run, 289 notes a day
  from 24 hourly runs and the nightly one; about 500 neurons and 1,800 vector
  writes a day, at most 1,500 neurons):

  | Brain size | 3.5% long notes | 20% long notes |
  | --- | --- | --- |
  | 1,000 | 3 hours | 17 hours |
  | 5,000 | 15 hours | 3.5 days |
  | 20,000 | 2.4 days | 13.8 days |

  Each run is about 80 embedding calls plus four storage calls per rewritten
  note, well inside the free plan's 1,000 internal subrequests, and its own
  JavaScript measures 3 to 5 ms of CPU (builder plus write path, node, loaded
  machine). D1 rows read total about one pass over the table.
- *Switches.* Turning `CONTEXTUAL_EMBEDDINGS` off stops new contextual vectors
  and pauses the backfill; turning it on again resumes the same ledger without
  re-embedding what is already contextual.

`POST /migration/scheme` (bearer `AUTH_TOKEN`) runs one bounded batch on demand
and returns `{ ok, processed, skipped, failed, chunks, remaining, done, stalled,
stalledReason?, neurons, capped, paused? }`. `remaining` counts the entries still
to rewrite (the crons skip that count because it scans every later row, so it is
null there); `done` is true once every vector is current; `stalled` means the
batch achieved nothing (a quota or a failing entry) and kept its cursor;
`capped` means the day's neuron cap ended it; `paused` is `"model-migration"`
while a model migration is in flight. It is idempotent: call it in a loop until
`done`, or leave it to the crons. `GET /migration/scheme` returns the ledger
(`null` when nothing has ever needed moving). `GET /migration/estimate` counts
the chunks a rebuild would write exactly, with the same builder `storeEntry`
uses. The ledger's pooling branch (`queryPoolings`) is the design for a future
pooling change; recall does not use it yet because nothing that changes
pooling ships.

**Write-path neighbors.** One long note is up to seven vectors, so the duplicate
check, the graph pass and edge inference ask Vectorize for a window of 20 hits
and keep the five nearest distinct notes (`vectorize/parents.ts`). The duplicate
check compares a note that will be stored contextually as its first chunk,
embedded exactly as capture stores it, prefix (source and tags) included (a
start, middle and end sample scored 0.86 at the median against stored focus
chunks and 0.87 at worst even for the chunk when the prefix lacked source and
tags; with them it scores 0.998 or better at 0, 3 and 6 tags, against the 0.95
block threshold), and also as the sample, which is what finds notes stored
before contextual embeddings. A long capture therefore costs one more embedding
call, one more Vectorize query and, at most once per isolate per five minutes,
a Vectorize `describe`; short notes and everything with the switch off pay
nothing. `deleteByIds` is batched at the same 1,000 ceiling as upserts.

**A recurring loser, explained (q-long-024).** "What is the policy on recovering
costs after journeys" (answer: "the reimbursement form wants original receipts
within thirty days", at character 1,812 of a 3,186-character note titled
"Conference travel debrief") moves across the tenth place with the base it is run
on: on integration/recall 0adb4e8 it stayed inside the final ten on `core-1k`
(8th to 6th) and lost at `scale-5k` and `scale-20k`, and on 5336d6d (T-0081's
block layout) it loses on `core-1k` too (recall@10 1.0 to 0.0). It is not a
chunking artifact. The chunk holding the answer is one of ten small chunks and sits in
the dense arm's top five either way: dense rank 5 to 4 at scale-5k (4 to 0 on
core-1k at 0adb4e8), and its best-chunk cosine with the query rises from
0.603 to 0.627 with the prefix. What changes is the final cut, which is fed by
the graph and keyword arms and reshuffles near ties: at scale-5k the gold note
is 8th of the final ten without contextual chunks and drops out with them,
because the prefix also lifts another long note, "Trip planning session: the
northern island" (its best-chunk cosine with the query 0.541 to 0.554), and the
golden set's long notes share filler, so three of them (n-long-002, -015, -017)
now fill dense slots ahead of the haystack: the dense list holds 40 distinct
parents against 50, and n-long-002 takes a final slot the gold note held. One
query in twenty-four moving across the tenth place is what a paired bootstrap
over 24 long-context queries is too small to separate, which is why the scale
gates are inconclusive rather than negative; the expanded long-context set is
what settles it. The trace is `test/eval` diagnostics (`denseIds`, `fusedIds`,
`finalIds`) on `scale-5k`, baseline against `contextual-embed`.

The optional generated tier (`CONTEXTUAL_EMBEDDING_LLM`, off; model
`CONTEXTUAL_EMBEDDING_LLM_MODEL`, Granite Micro by default) replaces the
deterministic prefix with one model sentence per chunk. `runLlmContextBatch`
runs after the scheme batch in the nightly job, only when both switches are on
and the deterministic migration has finished, at most 20 model calls a night,
whole entries of 2 to 8 chunks only. Any failed call leaves the entry's
deterministic vectors untouched; after three failed nights the cursor steps past
the entry. It has no eval variant: the eval records no generation calls, so its
quality is unmeasured and it stays off.

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
`core-1k` cache (about 7.6 MB gzipped, 4,802 vectors; a test caps the committed layers at 8 MiB, which leaves 0.8 MB: contextual rows for the 1,088 chunks of the multi-chunk notes would add 1.7 MB, so T-0042's rows stay local unless the cap is raised deliberately) means a contributor needs neither an account nor a model
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
queries (1,636 memories, 1,586 queries in 1,433 independent clusters, weighted
to paraphrase, multi-hop, and long-context, because power scales with clusters)
inside a seeded haystack of 656 / 4,656 / 19,656 rows (the needles come on top;
haystack rows carry a seeded importance score skewed to 2-3 and every needle an
authored one); the two larger ones push a common
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

**What the golden set measures.** Read a category's number for what it counts.
Multi-hop measures root-finding: each query restates a root memory ("why did we
replace the chairs") and carries `gold = [answer grade 2, root grade 1]`. In the
locked baseline the root is in the top 10 for 150 of 150 queries and the answer
for 7 of 150, so recall@10 0.523 is about 96% "found the note the query
paraphrases" and MRR@10 0.974 leaves 0.026 of headroom against the 0.05 target
margin. Multi-hop is therefore not a valid target category for a reranker
(T-0041's `rerank` and `rerank-auto` variants declare it in `targetCategories`
and should drop it; that change is applied at integration), and a graph change
is judged by the answer's rank, not by this recall.

The paraphrase base rate fell when the set grew. The original 48 paraphrase
queries scored recall@10 0.375; the 440 now in the set score 0.109 (0.182 before
the coherent long-context notes added on-topic distractors). The new paraphrases
are harder, not the baseline worse: their queries share no content word with the
gold, and the note collection they compete against is far denser in the same
topics. Long-context moved the same way: the original 24 notes went from 0.083 to
0.000 as more notes competed, all 220 legacy notes score 0.055, and the 90
coherent notes 0.222. A target gain in paraphrase is therefore measured from a
base of about 0.11, not 0.375, and the +0.05 target margin is a 45% relative
gain.

**The overall improvement path is not evidence for T-0041 or T-0042.** The
0.02 `improvementMargin` was approved when paraphrase was 15% and long-context
7.5% of the non-gap queries. On the expanded set they are 27% and 19%, and the
overall path averages by query, so an overall +0.02 now needs an in-category
gain of about +0.075 in paraphrase and +0.106 in long-context, against +0.133
and +0.265 before: roughly half the bar for the reranker and 40% of it for
contextual embeddings. Each of those changes must pass through its target
category (paraphrase for T-0041, long-context for T-0042) with a bootstrap lower
bound above zero, and show no regression in any category; T-0042 must also show
no loss and a positive point estimate on the coherent-padding long-context
subset, reported apart from the 220 legacy notes. This is pre-registered on
T-0043.6 (the amended note of Sep 24 2026, written before any candidate ran on
the expanded set). The candidate-pool diagnostic (gold anywhere in the fused
pool, recall@30) is printed for every category so a target FAIL can be read as
"the reranker did not help" or "the gold was never a candidate".

**Variants.** A change under test is a variant: query-time flags on
`RecallInternalOptions` (for example `variant.arms`), config overrides, or an
index-time hook that replaces `storeEntry`. Built in: `baseline` (shipped
recall, including the reranker in its shipped `auto` mode), `no-rerank` (the same
with the reranker off), `rerank` (reranker forced on), `like` (keyword arm on the
LIKE fallback), `fts-orderless`, and the ablations `dense-only` and
`keyword-only`, which each must lose somewhere or the golden set is too easy. The
ablations run with the reranker off so each isolates one factor.

**The gate.** `npm run eval:recall -- --compare <reference>,<variant>` (`baseline` for the shipped pipeline, `no-rerank` for the one before the reranker) ends in
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
gaps:` block and an `all queries` row (so `overall` and `all queries` show different n whenever a gap is tagged;
the core set currently tags none, T-0072, T-0073 and T-0074 having been fixed). Cost and the hard invariants always cover all queries.
A gap is corpus-conditional, so the gate decides by score, not by tag alone: a
gap query the baseline already answers stays in the regression rule. A variant
that claims to fix a gap declares it with `--target-gaps <id>`.

**Router guards.** Fixed gaps stay in the set as untagged guards for the keyword
router. `over-budget` queries (ten `q-budget-*`) cross `FTS_MATCH_BUDGET` on
purpose. One `correlated` query (`q-corr-001`) prices the AND tier: three words
that only co-occur, in about 800 haystack rows at 5k and 20k, with a gold newer
than those rows. Six `subset` queries (`q-sub-*`) have a gold carrying only some
of the query's tokens, each a mid-df one, which is the shape the OR tier exists
for and which the usual all-tokens rule in the audit would hide. Fusion can bury
a gold the keyword arm retrieved, so each result also records `keywordGold`
(whether any gold id was among the arm's candidates); it is a diagnostic for
router changes and is never gated. The corpus inserts rows oldest first so
rowids follow time, as on a real brain. That insertion order is set in
`corpus/build.ts`, which the golden-data fingerprint does not hash, so a change
there does not trip `--accept-data-change`; the lock's `rankedIds` (and
`keywordGold`) comparison is what catches it.

The lock only covers core-1k, where no router guard is over budget, so
`test/eval/router-guards.scale.test.ts` pins `keywordGold` for the guard queries
at scale-5k and scale-20k against `data/baselines/router-guards.json`. It needs
the local scale replay caches, so it is opt-in (`npm run
test:eval:scale-guards`) and CI cannot run it.

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
locked headline (core-1k, `workerd`, `--llm-tags stand-in`) excludes known gaps;
with no gap tagged, all 345 queries are in the headline: recall@5 is 0.749,
recall@10 0.777, MRR@10 0.757, and nDCG@10 0.713.

**Power.** The MDE belongs to a comparison, not to the query set, so growing the
set lowers it only as far as the comparison's own spread allows. On the
1,433-cluster set the recall@10 MDE on `core-1k` is about 0.013-0.020 overall
for changes that move a few queries (the large ablations were 0.05-0.06 on 299
clusters and are now 0.03-0.035). The target-category rule needs +0.05 with a
lower bound above zero: multi-hop, long-context, and paraphrase reach an MDE of
about 0.009-0.038 on mild changes and 0.05 for a whole-arm ablation, so a
reranker (paraphrase, multi-hop) or contextual embeddings (long-context) that
moves part of a category can be proven. `node scripts/eval-run-ts.mjs
test/eval/mde-table.ts` prints the table per category.

**How long it takes.** A `core-1k` comparison takes under a minute on `sqlite`
and several minutes on `workerd` (about 25 on a heavily shared machine), which runs each query against a real local D1.
A cold `prepare` for `scale-20k` takes about 25 minutes locally. `npm run
test:eval:workerd` runs the workerd-backed tests (including the workerd lock
tripwire), which the default suite skips; `npm run test:eval:public-download`
and `npm run test:eval:local-models` are the other opt-in checks.

## Tests

Tests import the worker default export only from `src/index`. Functions and types import from domain modules (e.g. `src/capture/entry`, `src/env`).
