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

`keywordSearch` (`recall/search.ts`) routes between two arms and reports which
one served the rows in `internal.diagnostics.ftsUsed`:

- **FTS arm** (`keywordSearchFts`): queries the `entries_fts` virtual table with
  `ORDER BY bm25(entries_fts)`, so candidates are the best matches rather than
  the newest ones. `ftsMatchQuery` (`recall/fts.ts`) double-quotes each token
  (internal quotes doubled, so user text cannot inject FTS syntax) and joins
  them with OR. The trigram tokenizer matches substrings, which keeps the LIKE
  semantics recall has always had, including CJK text and identifier-shaped
  tokens such as `#149` or `v1.9`. The read joins `entries` on both rowid and
  id, so a row whose rowid-to-id mapping has drifted is excluded and duplicate
  FTS rowids cannot consume the LIMIT window.
- **LIKE arm** (`keywordSearchLike`): the pre-FTS body, unchanged. Used when
  the readiness flag is not set, when any retrieval token is shorter than
  `FTS_MIN_TOKEN_LENGTH` (3 codepoints, the trigram floor; the whole query
  routes here so a short token is not silently dropped), when no token survives
  `ftsMatchQuery`, or when the FTS query throws (for example a missing table).
  Ordering is newest-first, as before.

Readiness lives in KV (`fts:ready`) and is cached in both directions for five
minutes, so a cleared flag reaches warm isolates quickly and isolates do not pay
a KV read on every recall. A brand-new brain latches ready at init because its
triggers cover every row from the start.

Schema objects (`db/init.ts`, mirrored in `db/schema.sql`): the virtual table
`entries_fts` (`fts5(id UNINDEXED, content, tokenize='trigram')`) plus triggers
`entries_fts_insert`, `entries_fts_update`, `entries_fts_delete`, which mirror
`entries.rowid` into `entries_fts.rowid`. A plain table, not external-content:
`entries` has a TEXT primary key, so the triggers sync by rowid (an O(1) delete
rather than a content-table scan). The update trigger fires only when rowid,
id, or content changes; a `recall_count`-only update writes nothing to the
index.

Nightly maintenance (`runFtsMaintenance` in `db/fts-backfill.ts`) runs after
the core nightly jobs. While the ready flag is unset it backfills rows that
predate the index in batches of `FTS_BACKFILL_BATCH` (2,000) behind a KV cursor,
deleting each batch's rowid range before inserting so re-runs are idempotent.
Once ready it checks integrity, count parity plus a spot check of the newest
rows' rowid-to-id mapping, and on drift deletes orphans and resets the cursor
and ready flag so the backfill re-covers the corpus over subsequent nights.
Recall stays on the LIKE arm until the rebuild finishes.

Cost: the FTS arm reads the index instead of scanning `entries`, so keyword
recall's `rows_read` stays flat as the corpus grows, protecting the D1 free-plan
daily read cap. Fusion and everything above candidate generation (MMR, the
graph, rerank heuristics) are unchanged; the JS boundary/IDF weight still
weights each keyword row's contribution.

## Tests

Tests import the worker default export only from `src/index`. Functions and types import from domain modules (e.g. `src/capture/entry`, `src/env`).
