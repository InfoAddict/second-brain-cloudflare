# Candidate-funnel recovery within Cloudflare Free budgets

**Release:** v2.4  
**Feature branch:** `feat/v2.4-graph-aware-recall`  
**Date:** 2026-08-21  
**Status:** Approved by Rahil in chat

## Dataset-independence release requirement

The template serves independently populated brains, so the implementation must
be corpus-agnostic. Production code and committed tests may not contain or key
off personal memory IDs, names, facts, benchmark wording, topic vocabularies,
or thresholds fitted to the live validation corpus. Tests use fictional,
synthetic memories and assert relative evidence properties and fixed resource
invariants. The personal deployment is an external validation corpus only; its
contents and diagnostic report remain untracked.

## Goal

Turn the six observable live candidate/root-availability misses into measurable
retrieval-stage diagnoses, then improve candidate availability without adding
Workers AI, embedding, Vectorize, D1 statement, D1 write, KV, Worker-request,
or graph/output cost per production recall.

The completed candidate-root phase is retained. It reduced live graph additions
from 20 to 10, doubled strictly useful graph precision from 10% to 20%,
preserved every comparable direct top-four ID, and added no neuron spend. It did
not improve live authoritative answer@5: both the previous Worker and v2.4
scored 14/20, with zero rescues. The follow-on must operate upstream of graph
scoring and receive credit only for real live rescues.

## Cloudflare Free budget envelope

These limits were verified from Cloudflare's official documentation on
2026-08-21 and are design inputs, not incidental deployment facts:

- Workers Free: 100,000 requests per day, 10 ms CPU per HTTP invocation,
  128 MB memory, 50 external subrequests, and 1,000 subrequests to Cloudflare
  services per invocation.
- D1 Free: 5 million rows read per day, 100,000 rows written per day, and 5 GB
  total storage. Daily limits reset at 00:00 UTC; exceeding a daily read or
  write limit makes further D1 queries fail until reset.
- Workers AI: 10,000 neurons per day. Free accounts cannot purchase overflow;
  further operations fail after the allocation is exhausted.
- Vectorize Free: 30 million queried vector dimensions per month and 5 million
  stored vector dimensions per account. Query result caps remain 50 with
  values/metadata and 100 without them.

References:

- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://developers.cloudflare.com/vectorize/platform/limits/
- https://developers.cloudflare.com/vectorize/platform/changelog/

The implementation must protect the daily budgets even when a user performs
many explicit recalls. A change that merely stays below one invocation limit
but materially increases per-recall D1 scans or CPU is not acceptable.

## Non-negotiable production cost contract

Relative to clean HEAD `6327971`, one normal recall may add:

| Resource | Maximum production delta |
|---|---:|
| Worker invocations | 0 |
| Workers AI calls | 0 |
| Embedding calls | 0 |
| Vectorize queries or `getByIds` calls | 0 |
| Vectorize `topK` | 0 |
| D1 statements | 0 |
| D1 rows written | 0 |
| KV reads or writes | 0 |
| Graph roots, fanout, hops, or expanded nodes | 0 |
| Rendered result slots or response cap | 0 |
| Persistent diagnostic logs | 0 |

Additional pure CPU work is bounded to at most `KEYWORD_MAX_TOKENS` (currently
16) tokens and deterministic `O(n log n)` ordering. The implementation should
reduce D1 rows read for single-date/time-bounded queries and must not increase
the number of rows returned by the existing keyword statement beyond
`KEYWORD_CANDIDATE_LIMIT`.

## Code-grounded diagnosis

### Existing diagnostics start too late

`RecallDiagnostics` currently records embedding mode, fused IDs, direct
reranked candidate IDs, root selections, expanded IDs, selected related IDs,
and rejection reasons. It does not record the raw dense IDs, raw keyword IDs,
eligible related IDs, final presented IDs, or Cloudflare operation/row-read
costs. A failed live question therefore cannot be assigned precisely to dense
retrieval, keyword retrieval, fusion, root selection, graph reach, evidence
eligibility, or final composition.

### Candidate discovery uses only distilled lexical tokens

`buildQueryProfile` already retains a bounded full-query `evidenceTokens`
channel, but `keywordSearch` receives only `profile.lexicalTokens`. Terms
discarded by rare-term distillation can contribute to graph evidence after a
candidate is found, but cannot help discover that candidate in the keyword
arm. This explains why better graph scoring cannot rescue an absent cluster.

### Time parsing and time filtering are incomplete upstream

`parseTimePhrase` recognizes relative phrases and `around <month> <day>`, but
not a single explicit phrase such as `on August 17`. It also deliberately
returns only one time range. The existing keyword candidate query and corpus
frequency scan do not receive parsed `after`/`before`; time filters are applied
only during final hydration. Date-specific questions can therefore spend their
candidate budget and D1 rows on the full corpus before irrelevant rows are
discarded.

### D1 daily rows, not statement count alone, are a product constraint

`distillToRareTerms` runs one corpus-wide aggregate over `entries`, and
`keywordSearch` runs another content query. Existing tests enforce D1 statement,
binding, and expression-depth ceilings but do not capture `meta.rows_read`.
Keeping the same number of statements is necessary but not sufficient for
Cloudflare Free longevity.

## Considered approaches

### A. In-place deterministic expansion — selected

Broaden the token set carried by the existing keyword statement, use the
already-paid document-frequency result to prioritize tokens, and push explicit
time bounds into the existing frequency and keyword statements. This adds no
Cloudflare operation and can reduce rows read for time-bounded queries.

### B. Conditional second indexed D1 query — rejected for this phase

A second lookup could recover more candidates but consumes another D1
subrequest and rows on every weak recall or introduces branching thresholds
that are difficult to size across brains. It is permitted only as a separately
measured future proposal.

### C. Second embedding, Vectorize query, or assessment LLM — rejected

This is likely to improve semantic recovery, but directly violates the neuron
and Vectorize budget constraints. Client-orchestrated iterative recall remains
available when a user explicitly chooses another recall; the server will not
perform it automatically.

## Design

### 1. Complete the internal candidate funnel

Extend `RecallDiagnostics` with bounded arrays and counters:

```ts
interface RecallOperationDiagnostics {
  aiCalls: number;
  embeddingCalls: number;
  vectorizeQueries: number;
  vectorizeGets: number;
  d1Statements: number;
  d1RowsRead: number;
  d1RowsWritten: number;
  kvReads: number;
  kvWrites: number;
}

interface RecallDiagnostics {
  denseIds?: string[];
  keywordIds?: string[];
  fusedIds?: string[];
  candidateIds?: string[];
  rootSelections?: { id: string; selectedBy: RootView }[];
  expandedIds?: string[];
  eligibleRelatedIds?: string[];
  selectedRelatedIds?: string[];
  finalIds?: string[];
  rejections?: { id: string; reason: string }[];
  operations?: RecallOperationDiagnostics;
}
```

Diagnostics remain reachable only through the existing internal fifth
argument to `recallEntries`. They are never serialized into HTTP/MCP output,
persisted, or enabled by a user-controlled parameter. Every ID list uses the
existing bounded pools; diagnostics cannot create an unbounded copy.

Operation counters are measured at existing call sites. When a D1 result
provides `meta.rows_read` or `meta.rows_written`, diagnostics accumulate it;
test facades supply the same fields. Absence of metadata is represented as
unknown, not zero, in reports. Diagnostic collection must not issue a query to
measure a query.

### 2. Temporary personal diagnostic deployment

The committed production code contains only the internal observer. To diagnose
the live personal brain, use a temporary compile-time-only route wiring change
that supplies an internal diagnostics object and emits one bounded structured
console record for authenticated recall requests. It does not alter the public
request or response schema.

Procedure:

1. capture the current Worker rollback version;
2. apply the temporary wiring without committing it;
3. deploy and attach `wrangler tail`;
4. run each of the six frozen failed questions exactly once;
5. save the bounded stage record outside the repository;
6. restore the clean worktree before any production implementation commit;
7. deploy the final clean HEAD after verification.

No query content or full memory content is logged. Only the frozen case number,
bounded IDs, rejection codes, and operation counters are emitted. If the
active Cloudflare account cannot tail the Worker, do not add a public debug
endpoint; fall back to fixture diagnostics and report the live-stage limitation.

### 3. Deterministic retrieval-token profile

Add `retrievalTokens` to `QueryProfile`. It is an ordered unique list capped at
the existing `KEYWORD_MAX_TOKENS`; the cap is not raised.

Priority order:

1. current distilled `lexicalTokens`, preserving their order;
2. identifier-shaped evidence tokens containing digits, `#`, or `.`, and
   hyphenated terms preserved by tokenization;
3. remaining full-query evidence tokens with known document frequency,
   ordered by ascending `df`, then original query position;
4. remaining evidence tokens without corpus frequency, in original query
   order.

The existing `DistilledQuery.df` is the only corpus-frequency source. No new
lookup or model call is allowed. Stable original position breaks ties.

`lexicalTokens` continue to control strict root/neighborhood precision.
`evidenceTokens` continue to control complementary coverage. The new
`retrievalTokens` affect candidate discovery and keyword fusion only; they do
not lower graph eligibility thresholds.

### 4. Use the existing keyword statement for expanded discovery

`keywordSearch` receives `retrievalTokens` instead of `lexicalTokens`, with the
same 16-token maximum and the same `KEYWORD_CANDIDATE_LIMIT`. The keyword
weighting step receives the same retrieval set so a candidate found only by an
additional anchor is not discarded before RRF fusion.

Exact word-boundary weighting, substring discounting, deterministic tie
breaking, dense parent deduplication, and RRF remain unchanged. Direct top-four
preservation is an explicit release gate because broader keyword discovery can
legitimately alter fusion.

### 5. Push single-range time bounds into existing reads

Extend temporal parsing to recognize one explicit month/day with an optional
year, including `on August 17` and `August 17, 2026`. A single explicit date
creates a one-day `[after, before)` range. Multiple explicit dates in one query
do not create a hard filter because change/comparison questions may need
memories around both dates; their date tokens remain retrieval evidence.

Thread resolved `after` and `before` into:

- the existing document-frequency aggregate in `distillToRareTerms`;
- the existing keyword candidate statement.

Both statements reserve their existing bind budget for the time values. The
created-at index already exists as `idx_entries_created_at`. Caller-supplied
filters and parsed filters remain authoritative. Final hydration continues to
reapply the same bounds as a correctness guard.

This must not add a statement. On time-bounded queries, tests should prove that
the SQL contains the indexed time predicates and the result metadata reports
no more rows read than the unbounded fixture. On unbounded queries, SQL shape
and statement count remain compatible except for retrieval-token contents.

### 6. Preserve all graph and public behavior

- `hops:0` still performs no graph root work or traversal.
- Embedding mode remains `distilled`.
- Direct presentation keeps recall-frequency behavior.
- Root selection remains frequency-neutral and uses the existing seed budget.
- Neighborhood thresholds, weights, 400-character windows, and abstention are
  unchanged.
- Only presented direct results increment `recall_count`.
- Public HTTP/MCP schemas and rendered provenance are unchanged.
- Tag/kind/date filters remain hard eligibility filters.
- Vectorize failure continues to degrade to keyword-only recall.

### 7. Bounded evidence-rescue composition

The live funnel diagnosis showed that some authoritative candidates were
already present in the fused and reranked pools but were omitted from the final
five. Final composition therefore gains one deterministic evidence slot. It
reuses already hydrated candidates and already computed query coverage; it does
not retrieve, expand, or synthesize anything new.

- The first four direct results are immutable.
- At most one omitted candidate may occupy the last result slot.
- It must have strictly greater query-evidence coverage than the displaced
  result and pass the same precision shape used by graph evidence: either an
  exact high-IDF match or at least two exact query-token matches.
- The candidate is selected by a stable, corpus-relative tuple: coverage,
  exact-high-IDF, exact-match count, metadata alignment, existing root score,
  then ID.
- An eligible graph result and an omitted direct candidate compete for the same
  bounded evidence slot on their query coverage; the stronger evidence wins.
- The rule is active only when `hops > 0` and `topK >= 5`; result count, graph
  caps, and direct top-four preservation remain unchanged.

No absolute score threshold is introduced. This avoids fitting the rule to one
brain's score distribution and adds no Cloudflare or neuron operation.

## Test strategy

Use strict RED-GREEN-REFACTOR development.

### Pure and unit tests

- Retrieval-token priority, deduplication, stable ties, and the unchanged
  16-token cap.
- Distilled tokens always precede supplemental anchors.
- Identifier/date/version tokens survive when common prose tokens are dropped.
- One explicit date parses to a one-day range; two explicit dates do not hard
  filter.
- Diagnostics types and bounded accumulation handle missing D1 metadata as
  unknown rather than zero.

### Integration tests

- A keyword-only authoritative memory absent under distilled tokens enters the
  fused candidate union through a supplemental anchor.
- Supplemental discovery cannot bypass strict graph evidence gates.
- Dense, keyword, fused, reranked, root, expanded, eligible, selected, and final
  stages contain the exact expected IDs.
- Every evidence-gate rejection has one stable reason.
- Single-date frequency and keyword SQL use the same time bounds and existing
  statements; multi-date comparison queries remain unbounded.
- AI, embedding, Vectorize, D1 statement/write, KV, graph, and output counts
  equal the clean-HEAD baseline.
- D1 bind parameters remain at or below 100 and expression depth at or below
  100.
- Time-bounded fixture `rows_read` is no greater than its unbounded equivalent.
- `hops:0`, explicit filters, tag escaping, and public MCP/HTTP contracts remain
  compatible.

### Benchmark and mutation proofs

- Run the existing generic 20-case benchmark and sealed hidden regression
  unchanged.
- Add stage assertions without changing authoritative labels or geometry.
- Mutate keyword discovery back to `lexicalTokens`; the new candidate recovery
  case must fail.
- Remove the time predicates from either existing statement; SQL and row-budget
  tests must fail.
- Add a second D1/Vectorize/embedding call; parity tests must fail.
- Expose diagnostics publicly; contract tests must fail.

## Live evaluation and release gates

After the temporary diagnostic run identifies the limiting stage, implement
only the approved in-place expansion above. Deploy the exact clean HEAD, wait
60–120 seconds, and run the frozen original ten plus untouched ten-question
holdout once with `topK:5, hops:1`.

| Gate | Required |
|---|---:|
| Original development questions | at least 8/10 |
| Overall live benchmark | at least 16/20 |
| Previously failed questions rescued | at least 2 |
| Previously correct questions regressed | 0 |
| Direct top-four set preservation | 100% |
| Strictly useful graph precision | at least 20% |
| Added AI/embedding/Vectorize operations | 0 |
| Added D1 statements/writes or KV operations | 0 |
| Added Worker requests per recall | 0 |
| D1 rows read on bounded fixtures | no increase; target decrease |
| Existing caps and public schemas | unchanged |
| Full typecheck/test suite | pass |

If the live diagnostic proves that the authoritative source is absent from both
the dense and expanded keyword arms after this change, stop. Do not add a
second Cloudflare operation without a separate measured design and explicit
approval.

## Deployment safety

The personal deploy script is still expected to capture a previous Worker
version and D1 Time Travel bookmark. The active Wrangler account previously
failed D1 bookmark capture with Cloudflare error 7403. This phase changes only
read behavior and introduces no schema or write path, but deployment may use
`SKIP_SNAPSHOT=1` only under the prior explicit authorization and must report
that no fresh D1 bookmark exists. Code rollback must remain available.

No merge or push occurs until Rahil reviews the new live benchmark report.
