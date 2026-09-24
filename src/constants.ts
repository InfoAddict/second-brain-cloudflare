export const LLM_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

/**
 * Escape a literal value before placing it inside a SQL LIKE pattern.
 * Pair the result with LIKE_ESCAPE: without it, backslashes are literal and
 * the pattern matches nothing instead of too much.
 */
export function escapeLikeMeta(value: string): string {
  return value.replace(/([%_\\])/g, "\\$1");
}

/**
 * Pair with every LIKE pattern built using escapeLikeMeta. Without ESCAPE,
 * backslashes are literal and the pattern matches nothing instead of too much.
 */
export const LIKE_ESCAPE = `ESCAPE '\\'`;

/**
 * Model for `reasonOverPair` (src/insight/reason.ts) only — every other call
 * (classification, contradiction detection, smart merge, digests, recall
 * synthesis) keeps using `LLM_MODEL` above. Insight reasoning is a harder
 * judgment task than any of those: it has to read two memories written
 * months apart and decide whether there is a real, specific tension or
 * connection between them, not just extract or summarize. That deserves a
 * stronger model, but repointing the shared `LLM_MODEL` would change cost
 * and behaviour for five unrelated features for every user, so this is a
 * separate setting instead.
 *
 * Cost, worked from Cloudflare's published Workers AI neuron pricing (one
 * neuron per ~$0.011, at time of writing):
 *
 *   - LLM_MODEL default, @cf/meta/llama-4-scout-17b-16e-instruct:
 *     24,545 neurons/M input tokens, 77,273 neurons/M output tokens.
 *   - @cf/openai/gpt-oss-120b: 31,818 neurons/M input, 68,182 neurons/M output.
 *
 * gpt-oss-120b costs MORE per input token and LESS per output token. This
 * pass's shape (~550 input tokens, 200 output tokens per candidate, from the
 * ENTRY_EXCERPT_CHARS-bounded prompt in reason.ts) is output-light, so the
 * two effects mostly cancel:
 *
 *   scout:   550 * 24545/1e6 + 200 * 77273/1e6 ≈ 13.5 + 15.5 ≈ 29.0 neurons
 *   gpt-oss: 550 * 31818/1e6 + 200 * 68182/1e6 ≈ 17.5 + 13.6 ≈ 31.1 neurons
 *
 * ~7% more neurons for a model with roughly seven times the parameters. The
 * weekly pass reasons over at most WEEKLY_CANDIDATE_LIMIT (10) candidates —
 * see src/insight/weekly.ts — so a full week costs ~311 neurons, about 0.44%
 * of the 10,000-neuron/day free allocation. Re-derive rather than trust this
 * if either model's price or `ENTRY_EXCERPT_CHARS` / `INSIGHT_PASS_MAX_TOKENS`
 * below change.
 */
export const INSIGHT_LLM_MODEL = "@cf/openai/gpt-oss-120b";

export const DUPLICATE_BLOCK_THRESHOLD = 0.95;
export const DUPLICATE_FLAG_THRESHOLD = 0.85;
export const CANDIDATE_SCORE_THRESHOLD = 0.45;
export const TAG_BOOST_STEP = 0.15;
export const TAG_BOOST_MAX = 1.5;
// Each net contradiction (win or loss) shifts a memory's effective importance by
// log1p(|net|) * this step, clamped to the [1,5] importance band. Tunable.
export const CONTRADICTION_IMPORTANCE_STEP = 1.0;

export const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";

export const CHUNK_MAX_CHARS = 1600;

// Sources that mirror an external system rather than record a thought.
//
// Lives here, not in `integrations/`, because `capture/store.ts` reads it and
// `integrations/mirror.ts` already imports `capture/store.ts` — the dependency
// must not run both ways. `test/unit/store-mirrored-chunks.test.ts` asserts this
// covers every id in INTEGRATION_PROVIDERS, which a test may import from both
// sides freely; that guard exists because the equivalent hand-written list in
// `insight/eligibility.ts` had silently fallen three providers behind.
//
// `git-hook` and `obsidian` are external clients that write memories rather than
// registered providers, so they are named here and cannot be derived.
export const MIRRORED_SOURCES: ReadonlySet<string> = new Set([
  "calendar-google", "calendar-outlook", "calendar-icloud",
  "email-gmail", "email-icloud",
  "notion", "git-hook", "obsidian",
]);

// Sources that record a conversation rather than a thought — a client pasting
// in the tail of a session. A transcript restates whatever was said, including
// memories the same session stored deliberately, so it will score as a near
// duplicate or a contradiction of them. It must never be the thing that
// rewrites or deprecates a memory another source wrote. Same-source collisions
// (a resumed session superseding its own earlier capture) are still allowed.
//
// Not MIRRORED_SOURCES: those index the first chunk only because the record
// leads with signal and trails with boilerplate; a transcript is the inverse.
export const TRANSCRIPT_SOURCES: ReadonlySet<string> = new Set(["claude-code"]);

// ── Embedding migration (#248) ───────────────────────────────────────────────
// Budgeted in chunks rather than entries because storeEntry fires one model call
// per chunk, all concurrently: 25 single-chunk entries is already ~75 binding
// calls, and a handful of long memories in one batch would be far more. The
// entry cap is a second ceiling so a page of tiny entries cannot balloon either.
export const MIGRATION_CHUNK_BUDGET = 20;
export const MIGRATION_MAX_ENTRIES_PER_BATCH = 25;

export const CHUNK_OVERLAP_CHARS = 200;

export const CLASSIFY_MAX_TOKENS = 80;
export const CONTRADICTION_MAX_TOKENS = 80;
export const SMART_MERGE_MAX_TOKENS = 250;
export const INSIGHT_MAX_TOKENS = 300;
// max_tokens is a CEILING, not a target. A non-reasoning model stops at its
// own natural answer length well under this cap, so raising it costs that
// model nothing extra. But INSIGHT_LLM_MODEL's default, @cf/openai/gpt-oss-120b,
// is a reasoning model: it spends tokens on chain-of-thought (streamed as
// `delta.reasoning` / `delta.reasoning_content`, see readStreamText in
// src/lib/ai.ts) before it ever emits an answer. At 200 it could burn the
// entire budget thinking and reach the cap without emitting an answer at
// all — the pass would then silently return nothing. 1200 gives it enough
// headroom to finish reasoning and still answer.
export const INSIGHT_PASS_MAX_TOKENS = 1200;
// Same reasoning-model headroom as INSIGHT_PASS_MAX_TOKENS above: WHEN_LLM_MODEL
// defaults to the same gpt-oss-120b, which spends tokens on chain-of-thought
// before it answers, and this pass's JSON answer is tiny either way.
export const WHEN_PASS_MAX_TOKENS = 1200;
export const DIGEST_MAX_TOKENS = 400;

export const VECTORIZE_FIX_HINT =
  "run `npx wrangler vectorize create second-brain-vectors --dimensions=384 --metric=cosine`, or grant the build token Vectorize Edit and redeploy";

// Shared by REST and MCP recall so the two never diverge in what they claim:
// a failed Vectorize call does not establish WHY it failed, so the assertion
// is neutral and the missing-index diagnosis is offered only as a possibility.
export const SEMANTIC_UNAVAILABLE_DETAIL =
  `This is often temporary; if it persists, the Vectorize index may be missing (fix: ${VECTORIZE_FIX_HINT}).`;

// Durable marker written once, by src/recall/search.ts and src/capture/duplicate.ts,
// the first time this isolate's workspace-filter latch (src/vectorize/scope.ts)
// trips to unsupported. GET /health reads it back so the signal survives isolate
// churn — the in-memory latch alone would look healthy again on every cold start.
export const VECTORIZE_WORKSPACE_FILTER_UNSUPPORTED_KV_KEY = "vectorize:workspace-filter-unsupported";

export const VECTORIZE_TOP_K_MULTIPLIER = 3;
// Dense candidate pool for every recall, whatever topK is asked for, so a larger
// topK only extends the ranked list and never reorders its head. It is what a
// default topK 5 call always used (3 x 5). A weak best match still widens the
// dense query to 50.
export const RECALL_POOL_SIZE = 15;
// The deeper dense list a call draws on when the diversified one is shorter than its topK, and what a weak best
// match widens to. 50 is the most Vectorize returns with values and metadata (the ceiling this code has always used).
export const RECALL_DEEP_POOL_SIZE = 50;
// Results are ordered by score within blocks of this many MMR picks.
export const RECALL_BLOCK = 5;
// The most results one recall call can ask for (MCP tool and GET /recall both cap topK here).
export const RECALL_MAX_TOP_K = 20;
// getByIds batch size for tag-scoped recall — Vectorize rejects more than 20 IDs
// per call (VECTOR_GET_ERROR, code 40007)
export const VECTORIZE_GET_BY_IDS_BATCH = 20;
// D1 allows at most 100 bound parameters per query
export const D1_MAX_BOUND_PARAMS = 100;

export const RRF_K = 60;
// Candidate fetch window for the keyword arm. The query is still newest-first
// (LIKE has no relevance ordering), so this bounds how far back a keyword match
// can be found at all — 100 proved able to bury a genuine old match under
// fresher substring noise once a term crossed 100 occurrences.
export const KEYWORD_CANDIDATE_LIMIT = 500;
// IDF fraction granted to a token that matches only as a substring of a longer
// word ("cat" inside "concatenate"). Re-weighting rather than filtering: plural
// and hyphenated near-matches stay retrievable, they just stop outranking
// genuine word-boundary matches.
export const SUBSTRING_MATCH_WEIGHT = 0.25;
export const KEYWORD_MIN_TOKEN_LEN = 2;
// The most LIKE terms this codebase will put into a single D1 statement: the
// frequency scan's SUM columns (distill.ts) and the keyword arm's OR chain
// (search.ts). The keyword arm needs the ceiling because distillToRareTerms
// normally hands it MAX_QUERY_TERMS but two of its exits return the query
// whole, and one of those needs nothing worse than an empty corpus to fire — so
// a fresh install's first long query built a clause D1 rejected outright
// (#276). Both of D1's limits bind at 99 terms: one parameter per term plus the
// row limit against a budget of D1_MAX_BOUND_PARAMS, and an OR chain one
// expression node deep per term against a tree-depth ceiling of 100 (measured:
// 99 terms accepted, 100 rejected on depth first). 16 leaves 6x margin for a
// future predicate, and keeps the two call sites agreeing by construction — the
// widest set the scan ranks is the widest set the clause can carry, so no query
// distillation can rank is ever truncated by the backstop.
export const KEYWORD_MAX_TOKENS = 16;
export const QUERY_SATURATION_FRACTION = 0.3;
export const MAX_QUERY_TERMS = 3;

// FTS5 lexical arm. Ready flag set once the backfill has covered every
// pre-FTS row; until then recall stays on the LIKE fallback.
export const FTS_READY_KV_KEY = "fts:ready";
export const FTS_BACKFILL_CURSOR_KV_KEY = "fts:backfill-cursor";
// Per-night ceiling: bounds FTS shadow-row writes against the 100k/day cap.
export const FTS_BACKFILL_BATCH = 2000;
// Trigram tokenizer floor: shorter tokens can never match.
export const FTS_MIN_TOKEN_LENGTH = 3;
// Readiness cache lifetime. Bounds both the KV read rate and how long a warm
// isolate keeps using FTS after the integrity check clears the flag.
export const FTS_READY_CACHE_MS = 5 * 60 * 1000;
// Cross-encoder reranker (src/recall/model-reranker.ts). The readiness latch is
// written only by the model probe: "1" once the model answers in the documented
// shape and ranks a known relevant passage first, "0" after a failed probe.
export const RERANK_MODEL = "@cf/baai/bge-reranker-base";
export const RERANK_READY_KV_KEY = "reranker:ready:bge-base-v1";
// A ready verdict is re-proved after a week, a failed one retried after six hours.
export const RERANK_READY_TTL_S = 7 * 24 * 3600;
export const RERANK_NOT_READY_TTL_S = 6 * 3600;
// Warm-isolate cache for the latch, both directions, like FTS_READY_CACHE_MS.
export const RERANK_READY_CACHE_MS = 5 * 60 * 1000;
// One batch: up to 25 direct parents plus up to 5 extra graph-root parents.
export const RERANK_MAX_CANDIDATES = 30;
export const RERANK_MAX_DIRECT = 25;
export const RERANK_EXCERPT_CHARS = 400;
export const RERANK_QUERY_MAX_CHARS = 256;
// Unverified against Workers AI (no account here). The reranker sits on the recall critical path, and the rest of
// a recall (embedding, D1, Vectorize) finishes well under a second, so a batch that has not answered in 1.5 s
// costs more in waiting than a reordering is worth. The circuit breaker below stops paying that wait repeatedly.
export const RERANK_TIMEOUT_MS = 1500;
// Consecutive timeouts or errors in one isolate that latch the reranker off (for RERANK_NOT_READY_TTL_S).
export const RERANK_BREAKER_FAILURES = 3;
// The probe runs off the hot path and may hit a cold model, so it waits longer than a recall does.
export const RERANK_PROBE_TIMEOUT_MS = 15000;
// `auto` reranks only when the runner-up is within this fraction of the leader.
export const RERANK_AMBIGUITY_MARGIN = 0.15;
// A heuristic score is scaled by 1 + weight * (2p - 1), p the model's rank percentile (1 = best). Chosen on
// core-1k from {0.25, 0.5, 0.75, 1.0} (pre-registered); at 1.0 the model's order dominates: the worst-ranked
// candidate scores 0 and the best doubles.
export const RERANK_BLEND_WEIGHT = 1.0;

// Rows spot-checked nightly for rowid-mapping drift; newest rows move first.
export const FTS_INTEGRITY_SPOT_CHECK = 5;
// Rotating content check: rowid window compared nightly (both directions)
// behind its own cursor, covering every row within ceil(N / window) nights.
export const FTS_CONTENT_CHECK_WINDOW = 200;
// Above this many estimated matches, bm25 must score them all while LIKE
// stops at KEYWORD_CANDIDATE_LIMIT recency-ordered hits, so LIKE is cheaper.
export const FTS_MATCH_BUDGET = 2000;
export const FTS_CONTENT_CHECK_CURSOR_KV_KEY = "fts:content-check-cursor";
export const KEYWORD_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "were", "be", "been",
  "i", "me", "my", "we", "you", "it", "this", "that", "these", "those", "with", "about", "from", "at", "as", "by",
  "do", "did", "does", "what", "when", "where", "who", "whom", "how", "why", "which",
]);

// Function words for the scripts Intl.Segmenter splits without spaces (#326).
// KEYWORD_STOPWORDS never matches them, and without this a Japanese question
// spends its keyword slots on auxiliaries and particles (した, ている, ため)
// that occur in nearly every note. One-character particles (は, を, の) need no
// entry: they fall to KEYWORD_MIN_TOKEN_LEN. Segmenter mis-splits of the most
// common request forms (教えて → 教え|て, ください → くだ|さい) are listed so
// they do not surface as content words.
export const CJK_STOPWORDS = new Set([
  // Japanese
  "した", "して", "する", "します", "しました", "され", "された", "される", "です", "でした", "ます", "ません",
  "ない", "なく", "ある", "あり", "いる", "いた", "ている", "ていた", "なる", "なった", "できる",
  "こと", "もの", "これ", "それ", "あれ", "この", "その", "あの", "ここ", "そこ", "どこ",
  "ため", "から", "まで", "など", "より", "また", "でも", "けど", "ので", "のに", "について", "という",
  "ください", "くだ", "さい", "教えて", "教え", "なぜ", "どう", "どの", "いつ", "だれ", "なに", "ような", "ように",
  // Chinese
  "什么", "怎么", "为什么", "没有", "可以", "一个", "我们", "你们", "他们", "这个", "那个", "这些", "那些",
  "因为", "所以", "但是", "如果", "已经", "还是", "或者", "以及", "关于",
]);
