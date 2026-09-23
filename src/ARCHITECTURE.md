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
(about 60% of the scan's cost at 20k), though that cost grows with the brain.
Saving a memory writes one extra small row (7 rows instead of 6), flat.

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
`entries`: a D1 error naming `entries_fts` triggers `repairFtsIndex`
(`db/fts-repair.ts`), which deletes the ready flag, resets the backfill cursor,
recreates the table and triggers when the table is missing, and otherwise
drops only the three sync triggers, a non-destructive disabled state every
reader already sees as not live. The failed statement or batch is then
retried exactly once; a failed D1 statement or batch has no effect, so the
retry is safe, and saves never fail because of the index.

Nightly maintenance (`runFtsMaintenance` in `db/fts-backfill.ts`):

- **Not ready:** backfill 2,000 rows per night (`FTS_BACKFILL_BATCH`) behind the
  KV cursor `fts:backfill-cursor`, each batch deleting its rowid range before
  inserting so re-runs are idempotent. The ready flag latches only after exact
  parity in both directions (`entries` vs `entries_fts`, compared on rowid,
  id, and content) passes together with liveness; a single mismatching row
  restarts the backfill instead.
- **Ready:** FTS5's own `integrity-check` statement runs first; a throw there
  rebuilds. Count parity (including `entry_counts`), a spot check of the newest
  rows' rowid-to-id mapping, and a rotating 200-row content check
  (`FTS_CONTENT_CHECK_WINDOW`) that compares (rowid, id, content) both ways and
  re-indexes exactly the mismatched rowids in place. Drift that count parity
  catches resets the backfill; the destructive rebuild (`rebuildFtsIndex`:
  drop triggers and table, recreate, restart) runs only in this nightly job,
  never from a request path.

Upgrade is automatic. A brand-new brain latches ready at init (its triggers
cover every row from row one); an existing brain backfills over about N/2,000
nights while recall stays on LIKE, then switches. No API or MCP change.

## Tests

Tests import the worker default export only from `src/index`. Functions and types import from domain modules (e.g. `src/capture/entry`, `src/env`).
