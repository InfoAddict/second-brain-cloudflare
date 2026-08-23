# Candidate-Funnel Free-Tier Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Diagnose and rescue real candidate-availability failures while adding no production Cloudflare operation and protecting Free-plan daily allotments.

**Architecture:** Complete the existing internal recall funnel through an opt-in binding observer, diagnose the six frozen live misses without a public debug surface, then broaden candidate discovery through a deterministic retrieval-token view carried by the existing keyword statement. Push single-date bounds into the already-existing frequency and keyword reads so bounded queries consume no more D1 rows, while leaving strict graph evidence gates, caps, public contracts, and the one-embedding/one-existing-Vectorize-path architecture unchanged.

**Tech Stack:** TypeScript 7, Cloudflare Workers, Workers AI, Vectorize, D1/SQLite, KV, MCP SDK, Vitest 4, Wrangler 4.

**Spec:** `docs/superpowers/specs/2026-08-21-candidate-funnel-free-tier-design.md`

## Global Constraints

- Work in the existing linked worktree on `feat/v2.4-graph-aware-recall`; starting implementation HEAD is the approved spec commit `349aded`.
- Code is authoritative; Second Brain memories support but do not override code or benchmark evidence.
- Production delta per recall is exactly zero Worker invocations, Workers AI calls, embeddings, Vectorize queries/gets, D1 statements/writes, KV operations, graph roots/hops/fanout/nodes, rendered slots, and persistent diagnostic logs.
- Keep `KEYWORD_MAX_TOKENS = 16`, `KEYWORD_CANDIDATE_LIMIT`, `VECTORIZE_TOP_K_MULTIPLIER`, Vectorize `topK`, D1's 100-binding/100-expression-depth ceilings, graph caps, and the 12,000-character response cap unchanged.
- Additional pure CPU work is bounded to at most 16 tokens with deterministic `O(n log n)` ordering.
- D1 rows read must not increase on bounded fixtures and should decrease for a single explicit date.
- Diagnostics remain reachable only through `RecallInternalOptions`; no HTTP or MCP schema, request parameter, or response field may expose them.
- The existing generic 20-case benchmark and sealed hidden regression remain frozen. Do not tune their fixtures, authoritative labels, thresholds, or digest.
- Live scoring excludes benchmark-recap memories and uses exactly one `recall(topK:5, hops:1)` per frozen question.
- No merge or push until Rahil reviews the final live benchmark.
- Production logic and committed fixtures must be brain-agnostic. Do not use
  personal memory IDs, names, facts, benchmark phrases, topic allowlists, or
  corpus-fitted thresholds. Personal data is external validation only.

---

### Task 1: Complete the opt-in candidate funnel

**Files:**
- Create: `src/recall/diagnostics.ts`
- Modify: `src/recall/types.ts`
- Modify: `src/recall/search.ts`
- Modify: `test/integration/recall-root-selection.test.ts`
- Modify: `test/integration/mcp-recall-insight.test.ts`
- Modify: `test/integration/recall.test.ts`

**Interfaces:**
- Consumes: the existing `RecallInternalOptions.diagnostics` object and current bounded recall pools.
- Produces:

```ts
export interface RecallOperationDiagnostics {
  aiCalls: number;
  embeddingCalls: number;
  vectorizeQueries: number;
  vectorizeGets: number;
  d1Statements: number;
  d1RowsRead: number | null;
  d1RowsWritten: number | null;
  kvReads: number;
  kvWrites: number;
}

export interface RecallDiagnostics {
  embeddingMode?: EmbeddingQueryMode;
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

export function observeRecallEnv(env: Env, diagnostics: RecallDiagnostics): Env;
```

`observeRecallEnv` returns `env` unchanged when no diagnostics object is supplied. When supplied, it wraps the existing bindings only: `AI.run`, `VECTORIZE.query`, `VECTORIZE.getByIds`, D1 statement execution, and KV reads/writes. It must never initiate an operation. D1 row totals become `null` if any executed statement does not expose the corresponding metadata, preventing an incomplete total from being reported as complete.

- [ ] **Step 1: Write failing stage and operation tests**

Add an integration case whose fixture has one dense root, one keyword-only root, one expanded eligible neighbor, and one rejected neighbor:

```ts
it("records the complete bounded candidate funnel without changing results", async () => {
  const diagnostics: RecallDiagnostics = {};
  const result = await recallEntries(
    { query: "why atlas ledger changed", topK: 5, hops: 1, synthesize: false },
    env,
    ctx,
    undefined,
    { diagnostics },
  );

  expect(diagnostics.denseIds).toEqual(["dense-root"]);
  expect(diagnostics.keywordIds).toContain("keyword-root");
  expect(diagnostics.fusedIds).toEqual(expect.arrayContaining(["dense-root", "keyword-root"]));
  expect(diagnostics.rootSelections?.map(x => x.id)).toContain("dense-root");
  expect(diagnostics.expandedIds).toEqual(expect.arrayContaining(["eligible", "weak"]));
  expect(diagnostics.eligibleRelatedIds).toContain("eligible");
  expect(diagnostics.rejections).toContainEqual({ id: "weak", reason: "weak-neighborhood" });
  expect(diagnostics.finalIds).toEqual(result.matches.map(x => x.id));
  expect(diagnostics.operations?.embeddingCalls).toBe(1);
});
```

Add public-contract tests asserting JSON/MCP output contains none of:
`denseIds`, `keywordIds`, `operations`, `eligibleRelatedIds`, or `finalIds`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run test/integration/recall-root-selection.test.ts test/integration/mcp-recall-insight.test.ts test/integration/recall.test.ts
```

Expected: FAIL because the new fields and binding observer do not exist.

- [ ] **Step 3: Implement the binding observer**

In `diagnostics.ts`, initialize counters once and use transparent proxies/wrappers. Count one D1 statement only when `.all()`, `.first()`, or `.run()` executes, not when `.prepare()` is called. Count a batch as one subrequest. Identify the embedding call using `EMBED_MODEL`; every `AI.run` increments `aiCalls`, while only that model increments `embeddingCalls`.

Use this accumulation rule for D1 metadata:

```ts
function addKnown(total: number | null, value: unknown): number | null {
  if (total === null || typeof value !== "number" || !Number.isFinite(value)) return null;
  return total + value;
}
```

Initialize `d1RowsRead` and `d1RowsWritten` to `0`; the first missing metadata changes that metric permanently to `null` for the invocation.

- [ ] **Step 4: Wire the observer and all funnel stages**

At the beginning of `recallEntries`:

```ts
const activeEnv = internal.diagnostics ? observeRecallEnv(env, internal.diagnostics) : env;
const cfg = config ?? await resolveConfig(activeEnv);
```

Use `activeEnv` for every downstream recall operation. Record parent IDs, not chunk IDs, and cap every diagnostic list to the bounded source array it mirrors. Populate `eligibleRelatedIds` after scoring and `finalIds` after direct/related composition.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: all tests pass and public output remains unchanged.

- [ ] **Step 6: Prove opt-in has no ordinary-path overhead**

Add a test that calls `recallEntries` once without diagnostics and once with diagnostics against separately reset mocks. Assert result IDs and all binding call counts are identical. The observer may count calls; it may not create them.

- [ ] **Step 7: Commit the complete funnel**

```bash
git add src/recall/diagnostics.ts src/recall/types.ts src/recall/search.ts \
  test/integration/recall-root-selection.test.ts \
  test/integration/mcp-recall-insight.test.ts test/integration/recall.test.ts
git commit -m "feat: observe the complete recall candidate funnel"
```

### Task 2: Add free-tier budget fidelity to test bindings

**Files:**
- Modify: `test/helpers/sqlite-d1.ts`
- Create: `test/helpers/recall-budget.ts`
- Modify: `test/integration/recall-d1-limits.test.ts`
- Create: `test/integration/recall-free-tier-budget.test.ts`

**Interfaces:**
- Consumes: `observeRecallEnv`, real SQLite statements, existing binding mocks, and `RecallOperationDiagnostics`.
- Produces:

```ts
export interface RecallBudgetSnapshot extends RecallOperationDiagnostics {
  workerRequests: number;
  graphSeeds: number;
  expandedNodes: number;
  renderedResults: number;
}

export function snapshotRecallBudget(
  diagnostics: RecallDiagnostics,
  result: RecallSearchResult,
): RecallBudgetSnapshot;
```

- [ ] **Step 1: Write failing clean-HEAD budget characterization tests**

Create two fixtures, ordinary and single-date. Each captures one recall with
`hops:0` and one with `hops:1`. Freeze the baseline call counts from clean HEAD
behavior by asserting relationships rather than incidental total numbers:

```ts
expect(after.embeddingCalls).toBe(before.embeddingCalls);
expect(after.aiCalls).toBe(before.aiCalls);
expect(after.vectorizeQueries).toBe(before.vectorizeQueries);
expect(after.vectorizeGets).toBe(before.vectorizeGets);
expect(after.d1Statements).toBe(before.d1Statements);
expect(after.d1RowsWritten).toBe(before.d1RowsWritten);
expect(after.kvReads).toBe(before.kvReads);
expect(after.kvWrites).toBe(before.kvWrites);
```

Add fixed platform ceilings:

```ts
expect(maxBindings).toBeLessThanOrEqual(100);
expect(maxExpressionDepth).toBeLessThanOrEqual(100);
expect(d1Statements).toBeLessThanOrEqual(30);
```

- [ ] **Step 2: Run the budget tests and verify RED**

Run:

```bash
npx vitest run test/integration/recall-free-tier-budget.test.ts test/integration/recall-d1-limits.test.ts
```

Expected: FAIL because the budget helper and D1 metadata fidelity do not exist.

- [ ] **Step 3: Add D1 metadata fidelity without inventing Cloudflare billing**

Extend `SqliteStatement.all()` and `.run()` to return a `meta` object with
fixture-measured `rows_read`/`rows_written` only where SQLite can determine it
reliably. Mark unsupported estimates absent so production diagnostics reports
`null`, never a fabricated zero. Keep `issued` semantics: one executed D1 call
per entry and one batch per subrequest.

- [ ] **Step 4: Implement the budget snapshot helper**

Copy operation counts, compute graph/result counts from existing diagnostics,
and set `workerRequests: 1`. The helper is test-only and performs no binding
operation.

- [ ] **Step 5: Run the budget tests and verify GREEN**

Run the Step 2 command. Expected: all tests pass.

- [ ] **Step 6: Commit budget fidelity**

```bash
git add test/helpers/sqlite-d1.ts test/helpers/recall-budget.ts \
  test/integration/recall-d1-limits.test.ts \
  test/integration/recall-free-tier-budget.test.ts
git commit -m "test: enforce Cloudflare Free recall budgets"
```

### Task 3: Diagnose the six frozen live misses

**Files:**
- Use ignored: `deploy-personal.sh`
- Use ignored: `wrangler.personal.jsonc`
- Create ignored: `.superpowers/sdd/2026-08-21-candidate-funnel/live-diagnostic-report.md`
- Temporary uncommitted modification: `src/routes/recall.ts`

**Interfaces:**
- Consumes: the committed internal diagnostics observer and the six frozen failed queries.
- Produces: one bounded stage classification per query and no tracked production change.

- [ ] **Step 1: Verify a clean committed observer and capture rollback state**

Run:

```bash
git status --short --branch
npm run typecheck
npx vitest run test/integration/recall-root-selection.test.ts \
  test/integration/recall-free-tier-budget.test.ts
```

Record current Worker version. Attempt the normal D1 bookmark preflight; if the
known Cloudflare 7403 account-access error recurs, record it and use the prior
authorized read-only `SKIP_SNAPSHOT=1` path.

- [ ] **Step 2: Add temporary authenticated diagnostic logging**

Temporarily construct a `RecallDiagnostics` object inside the already
authenticated `/recall` route, pass `{ diagnostics }` as the fifth argument,
and emit one record after recall:

```ts
console.log("[recall-funnel]", JSON.stringify({
  denseIds: diagnostics.denseIds,
  keywordIds: diagnostics.keywordIds,
  fusedIds: diagnostics.fusedIds,
  candidateIds: diagnostics.candidateIds,
  rootSelections: diagnostics.rootSelections,
  expandedIds: diagnostics.expandedIds,
  eligibleRelatedIds: diagnostics.eligibleRelatedIds,
  selectedRelatedIds: diagnostics.selectedRelatedIds,
  finalIds: diagnostics.finalIds,
  rejections: diagnostics.rejections,
  operations: diagnostics.operations,
}));
```

Do not log query text or memory content. Do not commit this change.

- [ ] **Step 3: Deploy, tail, and run the six questions exactly once**

Attach `wrangler tail`, wait 60–120 seconds after deployment, and invoke the
existing authenticated `/recall` endpoint once per frozen miss using
`topK=5&hops=1`. The six cases are anniversary reasoning, enterprise backend
direction, Product Hunt date change, first advocate `DO NOT SHIP`, August 17
no-PR state, and replacement star-chart risk.

If tail access is unavailable, stop the diagnostic attempt, restore the clean
tree, and record `live stage unavailable`; do not add an endpoint or response
field.

- [ ] **Step 4: Restore and prove the temporary surface is gone**

Use `apply_patch` to remove the temporary wiring. Verify:

```bash
git diff -- src/routes/recall.ts
git status --short --branch
```

Expected: no tracked diff. Redeploy the clean observer HEAD before continuing.

- [ ] **Step 5: Classify each miss**

For every case, record the first missing stage among dense, keyword, fused,
reranked, root, expanded, eligible, and final. This diagnosis determines which
Task 5 test cases receive credit; do not change thresholds or graph scoring.

### Task 4: Build deterministic retrieval tokens

**Files:**
- Modify: `src/recall/query-profile.ts`
- Modify: `test/unit/recall-query-profile.test.ts`

**Interfaces:**
- Consumes: `semanticQuery`, `DistilledQuery.query`, `DistilledQuery.df`, and existing tokenization.
- Produces:

```ts
export interface QueryProfile {
  semanticQuery: string;
  lexicalQuery: string;
  lexicalTokens: string[];
  evidenceTokens: string[];
  retrievalTokens: string[];
  intent: RecallIntent;
}

export function buildRetrievalTokens(
  semanticQuery: string,
  distilled: DistilledQuery,
): string[];
```

- [ ] **Step 1: Write failing priority and cap tests**

```ts
it("keeps distilled terms first and adds rare full-query anchors", () => {
  const df = new Map([["enterprise", 90], ["backend", 4], ["support", 8], ["skills", 12]]);
  const profile = buildQueryProfile(
    "why did the enterprise backend change for support skills",
    { query: "backend", df, total: 100 },
  );
  expect(profile.retrievalTokens).toEqual(["backend", "support", "skills", "enterprise"]);
});

it("preserves identifier-shaped anchors and never exceeds the existing cap", () => {
  const query = "why issue #311 changed v2.3.2 " + Array.from({ length: 30 }, (_, i) => `term${i}`).join(" ");
  const tokens = buildQueryProfile(query, { query: "changed", df: null, total: null }).retrievalTokens;
  expect(tokens).toEqual(expect.arrayContaining(["#311", "v2.3.2"]));
  expect(tokens).toHaveLength(KEYWORD_MAX_TOKENS);
});
```

- [ ] **Step 2: Run the unit test and verify RED**

Run: `npx vitest run test/unit/recall-query-profile.test.ts`

Expected: FAIL because `retrievalTokens` does not exist.

- [ ] **Step 3: Implement bounded stable ordering**

Build an original-position map from `tokenizeQuery(semanticQuery)`. Append
distilled tokens first, then identifier-shaped tokens, then known-DF tokens
sorted by `df` and position, then unknown-DF tokens by position. Deduplicate on
insert and slice exactly once at `KEYWORD_MAX_TOKENS`.

- [ ] **Step 4: Run tests and verify GREEN**

Run the Step 2 command. Expected: all query-profile tests pass.

- [ ] **Step 5: Commit retrieval tokens**

```bash
git add src/recall/query-profile.ts test/unit/recall-query-profile.test.ts
git commit -m "feat: derive bounded recall retrieval anchors"
```

### Task 5: Add single-date parsing and scope existing reads

**Files:**
- Modify: `src/text/temporal.ts`
- Modify: `src/recall/distill.ts`
- Modify: `src/recall/search.ts`
- Modify: `test/unit/temporal.test.ts`
- Modify: `test/unit/distill-query.test.ts`
- Modify: `test/integration/keyword-recall-quality.test.ts`
- Modify: `test/integration/recall-d1-limits.test.ts`

**Interfaces:**
- Consumes: resolved caller/parsed `after` and `before` values.
- Produces:

```ts
export interface TimeBounds { after?: number; before?: number }

export async function distillToRareTerms(
  query: string,
  env: Env,
  config?: Readonly<Config>,
  bounds?: Readonly<TimeBounds>,
): Promise<DistilledQuery>;

async function keywordSearch(
  tokens: string[],
  env: Env,
  limit: number,
  bounds: Readonly<TimeBounds>,
): Promise<KeywordRow[]>;
```

- [ ] **Step 1: Write failing explicit-date tests**

Freeze `now` and assert:

```ts
expect(parseTimePhrase("why were no PRs reviewed on August 17", now)).toEqual({
  after: new Date(2026, 7, 17).getTime(),
  before: new Date(2026, 7, 18).getTime(),
  cleanQuery: "why were no PRs reviewed",
});

expect(parseTimePhrase("why did launch move from June 3 to May 31", now)).toEqual({
  cleanQuery: "why did launch move from June 3 to May 31",
});
```

Also cover explicit year, punctuation, invalid dates, and caller-supplied bounds.

- [ ] **Step 2: Write failing SQL-shape and bounded-result tests**

Using real SQLite, seed an in-range authoritative row and newer out-of-range
decoys. Assert both the frequency aggregate and keyword query include
`created_at >= ?` and `created_at < ?`, use identical values, execute the same
number of statements as the unbounded path, and return only in-range candidates.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
npx vitest run test/unit/temporal.test.ts test/unit/distill-query.test.ts \
  test/integration/keyword-recall-quality.test.ts \
  test/integration/recall-d1-limits.test.ts
```

Expected: explicit dates are not parsed and existing reads lack bounds.

- [ ] **Step 4: Implement single-date parsing**

Match all explicit month/day occurrences. Apply a hard one-day range only when
exactly one valid date occurs. Infer the current year when omitted. When two or
more valid dates occur, return the original query and no hard range. Reject
calendar rollovers by comparing constructed year/month/day back to inputs.

- [ ] **Step 5: Thread bounds into the existing statements**

Build one shared clause helper returning `{ sql, bindings }` for `created_at`.
Use it in `distillToRareTerms`' existing aggregate and `keywordSearch`'s existing
candidate statement. Use `< before` consistently. Do not add a statement.

Call distillation with resolved bounds:

```ts
const distilled = await distillToRareTerms(
  semanticQuery,
  activeEnv,
  cfg,
  { after, before },
);
```

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the Step 3 command. Expected: all tests pass and D1 statement/bind ceilings remain green.

- [ ] **Step 7: Commit temporal scoping**

```bash
git add src/text/temporal.ts src/recall/distill.ts src/recall/search.ts \
  test/unit/temporal.test.ts test/unit/distill-query.test.ts \
  test/integration/keyword-recall-quality.test.ts \
  test/integration/recall-d1-limits.test.ts
git commit -m "feat: scope recall candidates to explicit dates"
```

### Task 6: Integrate expanded discovery and prove the budgets

**Files:**
- Modify: `src/recall/search.ts`
- Modify: `test/integration/keyword-recall-quality.test.ts`
- Modify: `test/integration/recall-root-selection.test.ts`
- Modify: `test/integration/recall-free-tier-budget.test.ts`
- Modify: `test/integration/recall-root-quality-benchmark.test.ts`
- Modify: `test/integration/recall-root-quality-hidden-validation.test.ts`

**Interfaces:**
- Consumes: `QueryProfile.retrievalTokens`, completed diagnostics, temporal bounds, and frozen benchmarks.
- Produces: expanded keyword candidate discovery inside the existing statement, with unchanged strict graph gates and Cloudflare operation counts.

- [ ] **Step 1: Write the failing authoritative-anchor recovery test**

Construct a query where distillation keeps `ledger`, while the authoritative
keyword-only memory contains `reconciliation` and no `ledger`. Dense results
must omit it. Assert the pre-change funnel lacks the ID and the new expected
funnel contains it through the keyword and fused stages.

```ts
expect(diagnostics.keywordIds).toContain("authoritative-reconciliation");
expect(diagnostics.fusedIds).toContain("authoritative-reconciliation");
expect(result.matches.map(x => x.id)).toContain("authoritative-reconciliation");
```

Add a negative fixture where a supplemental common token finds a weak linked
memory but the existing evidence gate still rejects it.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run test/integration/keyword-recall-quality.test.ts \
  test/integration/recall-root-selection.test.ts
```

Expected: authoritative supplemental-anchor ID is absent.

- [ ] **Step 3: Use retrieval tokens only at discovery/fusion**

Pass `profile.retrievalTokens` to `keywordSearch` and
`fuseDenseAndKeyword`. Continue passing `profile.lexicalTokens` and
`profile.evidenceTokens` to local evidence, coverage, snippets, and graph
eligibility. Do not alter thresholds, weights, or result caps.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: recovery passes and weak evidence still abstains.

- [ ] **Step 5: Run operation and D1 budget parity**

Run:

```bash
npx vitest run test/integration/recall-free-tier-budget.test.ts \
  test/integration/recall-d1-limits.test.ts \
  test/integration/tag-vocabulary-cache.test.ts
```

Expected: zero operation delta, no D1 write, no KV delta, bindings/expression
depth within 100, statements within 30, and bounded-query rows read no greater
than unbounded when metadata is available.

- [ ] **Step 6: Run frozen generic and hidden regressions unchanged**

Run:

```bash
npx vitest run test/integration/recall-root-quality-benchmark.test.ts \
  test/integration/recall-root-quality-hidden-validation.test.ts
```

Expected: existing gates pass, hidden digest remains
`319c2553d379d2bf215f97ae89018e01658de15f8ddaceb21feda38f67ee9462`,
direct regressions remain zero, and no fixture/threshold changes occur.

- [ ] **Step 7: Perform discriminating mutations**

Temporarily and one at a time:

1. pass `lexicalTokens` back to keyword discovery;
2. remove frequency-scan time predicates;
3. remove keyword-query time predicates;
4. add a second Vectorize query;
5. include diagnostics in HTTP or MCP output.

Run the smallest sentinel for each and record RED. Restore the exact production
implementation after every mutation and rerun GREEN. Do not commit mutations.

- [ ] **Step 8: Commit integrated recovery**

```bash
git add src/recall/search.ts test/integration/keyword-recall-quality.test.ts \
  test/integration/recall-root-selection.test.ts \
  test/integration/recall-free-tier-budget.test.ts \
  test/integration/recall-root-quality-benchmark.test.ts \
  test/integration/recall-root-quality-hidden-validation.test.ts
git commit -m "feat: recover recall candidates within existing budgets"
```

### Task 6A: Add the brain-agnostic evidence-rescue slot

**Files:**
- Create: `src/recall/evidence-rescue.ts`
- Create: `test/unit/recall-evidence-rescue.test.ts`
- Modify: `src/recall/search.ts`
- Modify: `test/integration/recall-root-selection.test.ts`

- [ ] Write synthetic failing tests proving that the first four direct IDs are
  preserved, at most one omitted strong candidate replaces only the weakest
  result, a common single-token match abstains, a stronger graph result keeps
  the evidence slot, ties are deterministic, and `topK < 5` does not rescue.
- [ ] Run the focused unit and integration tests and capture RED.
- [ ] Implement a pure selector using relative query coverage, exact-high-IDF,
  exact-match count, existing metadata alignment/root score, and stable ID
  ordering. Add no model, binding, graph, output, or absolute threshold.
- [ ] Integrate it after existing hydration so omitted root candidates and
  eligible related candidates compete for the one final evidence slot.
- [ ] Run focused tests GREEN and verify operation snapshots are byte-for-byte
  unchanged.
- [ ] Mutate the strict evidence-gain comparison and precision gate separately;
  each synthetic sentinel must fail before restoring GREEN.
- [ ] Scan the production/test diff for personal IDs, names, facts, benchmark
  phrases, and topic-specific branches. Any match is blocking.

### Task 7: Full review, clean deployment, and live release gate

**Files:**
- Modify ignored: `.superpowers/sdd/2026-08-21-candidate-funnel/progress.md`
- Create ignored: `.superpowers/sdd/2026-08-21-candidate-funnel/final-report.md`
- Use ignored: `deploy-personal.sh`
- Use ignored: `wrangler.personal.jsonc`

**Interfaces:**
- Consumes: reviewed clean HEAD and the frozen live manifest.
- Produces: final automated/free-tier/live statistics and a release decision; no merge or push.

- [ ] **Step 1: Run structural and cost audits**

Verify by `rg` and diff review:

- exactly one embed call site in recall;
- unchanged normal/widen Vectorize call sites and `topK`;
- no new `env.AI.run`, D1 statement, KV operation, graph cap, schema, route,
  MCP, config, or public asset surface;
- diagnostics reachable only from the internal fifth argument;
- query/time token work capped at 16.

- [ ] **Step 2: Run fresh typecheck and complete test suite**

```bash
npm run typecheck
npm test -- --reporter=dot
git diff --check 349aded...HEAD
```

Expected: typecheck exit 0, every test passes, and diff check is clean.

- [ ] **Step 3: Request independent whole-diff review**

Review `349aded...HEAD` against the approved spec and this plan. Treat any
Critical or Important finding as blocking. Apply fixes with RED-GREEN evidence
and rerun Step 2 after the final fix.

- [ ] **Step 4: Deploy exact clean HEAD**

Run `sh deploy-personal.sh`. Record previous Worker version and D1 bookmark. If
Cloudflare 7403 blocks the bookmark again, report it and use only the previously
authorized read-only `SKIP_SNAPSHOT=1` path. Wait 60–120 seconds in intervals no
longer than 20 seconds.

- [ ] **Step 5: Run the frozen live benchmark once**

Run original ten plus untouched ten-question holdout using exactly one
`recall(topK:5, hops:1)` call per question. Capture IDs, provenance, latency,
rendered size, strict answer credit, graph usefulness, rescues, regressions,
and domain results outside the tracked repository.

- [ ] **Step 6: Apply every release gate**

Require all:

- original development at least 8/10;
- overall at least 16/20;
- at least two previous misses rescued;
- zero previous-correct regressions;
- 100% direct top-four set preservation;
- at least 20% strictly useful graph precision;
- zero added AI/embedding/Vectorize/D1-statement/D1-write/KV/Worker operations;
- no bounded-fixture D1 row-read increase;
- all caps/contracts unchanged;
- full typecheck/tests green.

If a gate fails, do not merge or push. Keep the final Worker only if behavior
does not materially regress; otherwise roll back to the recorded Worker version.

- [ ] **Step 7: Record the final report and stop for Rahil's decision**

Report the complete funnel, automated benchmark, free-tier budget, live before/
after table, final Worker/rollback versions, D1 bookmark status, exact limiting
stage for remaining misses, and branch state. Preserve the worktree and branch.
