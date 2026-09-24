/**
 * Re-embedding every entry after an embedding-model change.
 *
 * Switching models changes the vector dimensions, and a Vectorize index fixes
 * its dimensions at creation. So a model change means a new index, a redeploy
 * pointing the binding at it, and every entry re-embedded into it. The desktop
 * app drives that; this module is the part that runs inside the Worker.
 *
 * # D1 is never written destructively
 *
 * `entries.content` is the source of truth and migration only reads it. Vectors
 * are derived data. The worst outcome here is a rebuild that has to be re-run,
 * never a lost memory.
 *
 * # Why this keeps its own ledger
 *
 * The obvious progress marker is `entries.vector_ids`, the way
 * `POST /vectorize-pending` uses it — select the rows that still read `'[]'`.
 * That does not work here, and the reason is worth stating because it is not
 * obvious: vector ids are **deterministic**. `storeEntry` derives them from the
 * entry id and chunk count, so re-embedding unchanged content into a brand new
 * index produces byte-identical id strings. `vector_ids` was already non-empty
 * before the migration and stays non-empty throughout.
 *
 * An entry the migration never reached therefore reads as "vectorized" in D1
 * while the live index holds nothing for it. `/vectorize-pending` cannot see it,
 * `/stats.unvectorized` reports zero, and the dashboard's repair prompt stays
 * hidden. So this ledger in KV is not merely a convenience for resuming — it is
 * the only record of what has actually been rebuilt.
 *
 * # Why it stops rather than pushing on
 *
 * Embedding is the one operation with a daily budget. If that budget runs out
 * part-way, every remaining entry fails for the same reason, and a loop that
 * kept going would burn the rest of the run producing identical errors while
 * reporting hundreds of distinct "failures". So a batch that achieves nothing
 * stops the run and keeps its cursor. The user is told to resume later, and
 * resuming costs nothing already paid for.
 */
import type { Env } from "../env";
import { DEFAULTS, type Config } from "../config";
import { deleteStaleVectors, storeEntry } from "../capture/store";
import { INDEXABLE_SQL } from "../capture/lifecycle";
import { chunkText } from "../text/chunk";
import { buildEmbeddingChunks, generateChunkContext, isContextEligible } from "../capture/contextual";
import { LEGACY_SCHEME, poolingOf, schemeOf } from "../embedding/scheme";
import {
  CONTEXT_LLM_CHUNKS_PER_NIGHT,
  CONTEXT_LLM_MAX_CHUNKS_PER_ENTRY,
  MIGRATION_CHUNK_BUDGET,
  MIGRATION_MAX_ENTRIES_PER_BATCH,
} from "../constants";

/**
 * Prefixed to coexist with workers-oauth-provider's `token:`/`grant:`/`client:`
 * keys, matching `config:overrides` and `integrations:<provider>`. Singular
 * because only one migration is ever in flight.
 */
export const MIGRATION_KEY = "migration:embedding";

/**
 * Where the rebuild has got to.
 *
 * The cursor is `(created_at, id)` rather than an offset. Capture stays live
 * during a migration — the nightly cron writes — so an offset would skip or
 * repeat rows as the table grows underneath it. A keyset cursor cannot.
 */
export interface MigrationState {
  /** The model being migrated *to*, recorded so a resumed run can detect that
   *  the target changed underneath it. */
  model: string;
  startedAt: number;
  /** Last entry successfully processed; null before the first batch. */
  cursorCreatedAt: number | null;
  cursorId: string | null;
  processed: number;
  failed: number;
  /** Entry count when the run started, for progress display only. `remaining`
   *  is always recomputed, because the table changes under us. */
  totalAtStart: number;
  finishedAt?: number;
}

export interface BatchResult {
  processed: number;
  failed: number;
  /** Recomputed every batch — callers loop until it reaches 0, the convention
   *  `/vectorize-pending` and the integration syncs already use. */
  remaining: number;
  total: number;
  done: boolean;
  /**
   * The batch achieved nothing and the run has stopped with its cursor kept.
   * Almost always the daily embedding budget; possibly a model name the account
   * cannot serve. Either way, pushing on would only repeat the failure.
   */
  stalled: boolean;
  /** Set when `stalled`, for the message the user sees. Never a raw error. */
  stalledReason?: string;
}

/**
 * Deprecated entries are excluded. Their vectors are deliberately deleted by
 * `deprecateEntry` and recall filters them out at hydration, so re-embedding
 * them would spend the scarce resource of the whole operation on rebuilding
 * something nothing reads.
 *
 * This was the only path that knew it. `/vectorize-pending` and the two
 * "not searchable" counts did not, so a dismissed pattern was reported as
 * broken and repaired back into the index.
 */
const NOT_DEPRECATED = INDEXABLE_SQL;

export async function readMigration(env: Env): Promise<MigrationState | null> {
  try {
    const raw = await env.OAUTH_KV.get(MIGRATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MigrationState;
    // A blob written by an older shape, or hand-edited: treat as absent rather
    // than trusting a cursor we cannot read. Restarting costs neurons; resuming
    // from a bad cursor could skip entries silently, which is worse.
    if (typeof parsed?.model !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeMigration(env: Env, state: MigrationState): Promise<void> {
  await env.OAUTH_KV.put(MIGRATION_KEY, JSON.stringify(state));
}

export async function clearMigration(env: Env): Promise<void> {
  await env.OAUTH_KV.delete(MIGRATION_KEY);
}

/** Entries that would be re-embedded, and the vectors they would produce. */
export async function estimate(
  env: Env,
): Promise<{ entries: number; chunks: number }> {
  const row = (await env.DB.prepare(
    // scope-exempt: one-time re-embed migration: admin-triggered, deployment-wide, returns counts only
    `SELECT COUNT(*) AS entries,
            COALESCE(SUM(MAX(1, (LENGTH(content) + ${
              CHUNK_STRIDE - 1
            }) / ${CHUNK_STRIDE})), 0) AS chunks
       FROM entries
      WHERE ${NOT_DEPRECATED}`,
  ).first()) as Record<string, number> | null;

  return {
    entries: Number(row?.entries ?? 0),
    chunks: Number(row?.chunks ?? 0),
  };
}

/**
 * How far `chunkText` advances per chunk: `CHUNK_MAX_CHARS - CHUNK_OVERLAP_CHARS`.
 *
 * Kept here as the one place the estimate's arithmetic is tied to the chunker,
 * and asserted against the real `chunkText` in the tests so the two cannot
 * drift. The projection is a lower bound: sentence-boundary snapping can only
 * shorten a chunk, never lengthen it, so the real count is sometimes higher.
 */
const CHUNK_STRIDE = 1400;

/** Rows after the cursor, oldest first. */
function pageSql(hasCursor: boolean): string {
  // Plain `?` placeholders, bound positionally, matching every other query in
  // this codebase — the created_at value is bound twice rather than reused as
  // ?1, because that is the style D1 is driven with here and the style the
  // SQLite-backed tests can exercise.
  const after = hasCursor
    ? `AND (created_at > ? OR (created_at = ? AND id > ?))`
    : "";
  // scope-exempt: one-time re-embed migration: admin-triggered and deployment-wide; the rows it selects go to the embedder, and only counts reach the response
  return `SELECT id, content, tags, source, created_at, vector_ids, workspace_id, actor_id
            FROM entries
           WHERE ${NOT_DEPRECATED} ${after}
           ORDER BY created_at ASC, id ASC
           LIMIT ${MIGRATION_MAX_ENTRIES_PER_BATCH}`;
}

async function countRemaining(
  env: Env,
  cursorCreatedAt: number | null,
  cursorId: string | null,
): Promise<number> {
  const sql =
    cursorCreatedAt === null
      // scope-exempt: one-time re-embed migration: count only
      ? `SELECT COUNT(*) AS count FROM entries WHERE ${NOT_DEPRECATED}`
      // scope-exempt: one-time re-embed migration: count only
      : `SELECT COUNT(*) AS count FROM entries WHERE ${NOT_DEPRECATED}
           AND (created_at > ? OR (created_at = ? AND id > ?))`;
  const stmt =
    cursorCreatedAt === null
      ? env.DB.prepare(sql)
      : env.DB.prepare(sql).bind(cursorCreatedAt, cursorCreatedAt, cursorId);
  const row = (await stmt.first()) as Record<string, number> | null;
  return Number(row?.count ?? 0);
}

/**
 * Best-effort recognition of "the budget ran out" versus "this one entry went
 * wrong".
 *
 * Deliberately not load-bearing. Cloudflare's error text is not a contract, so
 * the guarantee that actually protects the run is the no-progress stop in
 * [`runBatch`] — a batch that processed nothing halts whatever the message said.
 * This only sharpens what the user is told.
 */
export function looksLikeBudgetError(e: unknown): boolean {
  const text = String((e as Error)?.message ?? e).toLowerCase();
  return (
    text.includes("4006") ||
    text.includes("quota") ||
    text.includes("capacity") ||
    text.includes("rate limit") ||
    text.includes("too many requests")
  );
}

/**
 * Re-embeds one batch and advances the cursor.
 *
 * Calls `storeEntry` directly rather than going through `captureEntry`, which
 * would run dedupe (every entry matches itself at ~1.0 and would be blocked or
 * merged), classification, contradiction handling and edge inference — all of
 * which cost more model calls and have side effects that are wrong to re-run
 * over an entire brain.
 *
 * It passes each row's real `created_at` rather than now. `reembedOrThrow` looks
 * like the natural helper but hardcodes `Date.now()`, which would rewrite every
 * vector's `created_at` metadata to migration time — and recall's keyword fusion
 * reads that metadata.
 *
 * `deleteStaleVectors` is deliberately not called. The old vectors live in the
 * index being abandoned, so deleting them one by one would cost thousands of
 * calls to empty something that is about to be dropped whole.
 */
export async function runBatch(
  env: Env,
  config: Readonly<Config> = DEFAULTS,
): Promise<BatchResult> {
  const existing = await readMigration(env);

  // A target change mid-run invalidates the cursor: entries before it hold
  // vectors from the previous target. Start again rather than finish a rebuild
  // that would be half one model and half another.
  const state: MigrationState =
    existing && existing.model === config.EMBEDDING_MODEL
      ? existing
      : {
          model: config.EMBEDDING_MODEL,
          startedAt: Date.now(),
          cursorCreatedAt: null,
          cursorId: null,
          processed: 0,
          failed: 0,
          totalAtStart: await countRemaining(env, null, null),
        };

  const page = state.cursorCreatedAt === null
    ? await env.DB.prepare(pageSql(false)).all()
    : await env.DB.prepare(pageSql(true))
        .bind(state.cursorCreatedAt, state.cursorCreatedAt, state.cursorId)
        .all();

  const rows = (page.results ?? []) as Record<string, unknown>[];
  if (rows.length === 0) {
    const finished: MigrationState = { ...state, finishedAt: Date.now() };
    await writeMigration(env, finished);
    return {
      processed: 0,
      failed: 0,
      remaining: 0,
      total: state.totalAtStart,
      done: true,
      stalled: false,
    };
  }

  let processed = 0;
  let failed = 0;
  let chunkBudget = MIGRATION_CHUNK_BUDGET;
  let lastReached: { created_at: number; id: string } | null = null;
  let stalledReason: string | undefined;

  for (const row of rows) {
    const content = row.content as string;
    const cost = chunkText(content).length;
    // Always take the first entry even if it alone exceeds the budget, or a
    // single very long memory would stall the run forever.
    if (chunkBudget !== MIGRATION_CHUNK_BUDGET && cost > chunkBudget) break;
    chunkBudget -= cost;

    try {
      // Cron path, no request identity: the context comes from the row being
      // repaired, not the caller, so a re-embed can never relocate an entry
      // between workspaces.
      await storeEntry(
        env,
        row.id as string,
        content,
        JSON.parse((row.tags as string) ?? "[]"),
        row.source as string,
        row.created_at as number,
        config,
        { workspaceId: row.workspace_id as string, actorId: row.actor_id as string },
      );
      processed++;
      // Only advance past entries that actually succeeded. A failed entry stays
      // in front of the cursor so a later run retries it.
      lastReached = { created_at: row.created_at as number, id: row.id as string };
    } catch (e) {
      failed++;
      console.error("Migration re-embed failed for entry", row.id, e);
      if (looksLikeBudgetError(e)) {
        stalledReason = "budget";
        break;
      }
      // A single bad entry must not advance the cursor past itself, but it also
      // must not block the rest of the batch — so stop advancing and keep going
      // only while something is still succeeding.
      break;
    }

    if (chunkBudget <= 0) break;
  }

  const next: MigrationState = {
    ...state,
    cursorCreatedAt: lastReached?.created_at ?? state.cursorCreatedAt,
    cursorId: lastReached?.id ?? state.cursorId,
    processed: state.processed + processed,
    failed: state.failed + failed,
  };

  const remaining = await countRemaining(
    env,
    next.cursorCreatedAt,
    next.cursorId,
  );

  // Nothing moved. Keep the cursor, stop the run, and let the caller say so —
  // continuing would repeat one failure for every entry left.
  const stalled = processed === 0 && failed > 0;
  const done = remaining === 0 && !stalled;

  await writeMigration(
    env,
    done ? { ...next, finishedAt: Date.now() } : next,
  );
  // Every vector was just written under the current config, so the scheme
  // ledger has nothing left to migrate.
  if (done) {
    await env.OAUTH_KV.put(
      SCHEME_MIGRATION_KEY,
      JSON.stringify({
        model: config.EMBEDDING_MODEL, target: schemeOf(config), sources: [], startedAt: state.startedAt,
        cursorCreatedAt: null, cursorId: null, processed: 0, skipped: 0, failed: 0, finishedAt: Date.now(),
      } satisfies SchemeMigrationState),
    );
  }

  return {
    processed,
    failed,
    remaining,
    total: Math.max(next.totalAtStart, next.processed + remaining),
    done,
    stalled,
    ...(stalled ? { stalledReason: stalledReason ?? "failing" } : {}),
  };
}


// ── Embedding scheme migration (T-0042, T-0077) ──────────────────────────────
//
// A scheme change (contextual chunk text, pooling) keeps the model and the
// dimensions, so it happens in place, in the current index, one entry at a time,
// instead of into a new index the way a model change does. The batch machinery
// above is reused: the same keyset page, chunk budget, quota recognition and
// no-progress stop. Only the per-entry step differs.
//
// Why in place is safe:
//  - Vector ids are deterministic (`<id>` or `<id>-chunk-<i>`), so rewriting an
//    entry overwrites its vectors. A crash before the cursor moves just repeats
//    the entry; nothing is half-committed that a repeat does not finish.
//  - Old chunk ids the new set no longer uses are deleted only after the new set
//    and `entries.vector_ids` are written.
//  - Contextual text does not move the vector space, so mixed old and new
//    vectors rank against one query vector. Pooling does, so recall embeds the
//    query under every pooling still present (see `queryPoolings`).
//  - A user edit that lands while an entry is being rebuilt is detected by
//    re-reading its content and tags, and the entry is rebuilt again from the fresh row.

export const SCHEME_MIGRATION_KEY = "migration:embedding-scheme";

/** Chunk budget for one scheme batch. Smaller than MIGRATION_CHUNK_BUDGET so a nightly slice stays well inside the D1 statement budget. */
export const SCHEME_BATCH_CHUNK_BUDGET = 12;
/** A row edited while it is rebuilt is rebuilt again, this many times at most, before the batch gives up on it for now. */
const SCHEME_MAX_REBUILDS = 3;

export interface SchemeMigrationState {
  model: string;
  /** The scheme being migrated to. */
  target: number;
  /** Every scheme a vector may still be in. A run that starts over a half-finished one keeps the old sources. */
  sources: number[];
  startedAt: number;
  cursorCreatedAt: number | null;
  cursorId: string | null;
  processed: number;
  skipped: number;
  failed: number;
  /** Set when every vector is at `target`; the ledger then says what a brain's vectors are. */
  finishedAt?: number;
}

export interface SchemeBatchResult {
  processed: number;
  skipped: number;
  failed: number;
  chunks: number;
  remaining: number;
  done: boolean;
  stalled: boolean;
  stalledReason?: string;
  /** Nothing to do this run: a model migration is in flight, or the switch that would need a rewrite is off. */
  paused?: "model-migration";
}

export async function readSchemeMigration(env: Env): Promise<SchemeMigrationState | null> {
  try {
    const raw = await env.OAUTH_KV.get(SCHEME_MIGRATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SchemeMigrationState;
    if (typeof parsed?.model !== "string" || typeof parsed.target !== "number" || !Array.isArray(parsed.sources)) return null;
    return parsed;
  } catch {
    return null;
  }
}

const writeScheme = (env: Env, state: SchemeMigrationState) => env.OAUTH_KV.put(SCHEME_MIGRATION_KEY, JSON.stringify(state));

export const clearSchemeMigration = (env: Env) => env.OAUTH_KV.delete(SCHEME_MIGRATION_KEY);

const contextualOf = (scheme: number): boolean => scheme === 2 || scheme === 4;

/**
 * Does a vector written under `from` need rewriting to reach `to`? Pooling
 * always does. Contextual text does only when it is being gained: switching it
 * off stops new contextual vectors and leaves the old ones (the kill switch
 * never rewrites).
 */
function needsRewrite(from: number, to: number, ctxEligible: boolean): boolean {
  if (from === to) return false;
  if (poolingOf(from) !== poolingOf(to)) return true;
  return contextualOf(to) && !contextualOf(from) && ctxEligible;
}

/**
 * The poolings a query must be embedded under to reach every vector the brain
 * may hold right now. One entry (the overwhelmingly common case) when every
 * possible vector shares the configured pooling; two while a pooling change is
 * still being migrated.
 *
 * Mean-pooling brains that never enabled cls have no ledger and answer without
 * reading KV: `poolingOf(target)` is "mean" and so is every legacy vector.
 */
export function queryPoolings(state: SchemeMigrationState | null, config: Readonly<Config>): ("mean" | "cls")[] {
  const target = schemeOf(config);
  const want = poolingOf(target);
  const present = new Set<"mean" | "cls">([want]);
  if (state && state.model === config.EMBEDDING_MODEL) {
    if (!(state.target === target && state.finishedAt)) {
      present.add(poolingOf(state.target));
      for (const s of state.sources) present.add(poolingOf(s));
    }
  } else if (want !== "mean") {
    // No usable ledger under a non-default pooling: the brain may still hold legacy mean vectors.
    present.add("mean");
  }
  return [...present];
}

/** True when a query needs the ledger at all: only a pooling other than the legacy one can put two spaces in one index. */
export const schemeLedgerMatters = (config: Readonly<Config>): boolean => poolingOf(schemeOf(config)) !== poolingOf(LEGACY_SCHEME);

/**
 * One bounded batch of the in-place scheme migration. Safe to call any number
 * of times, from the nightly job and from the admin route: an idle call reads
 * one KV key and returns.
 */
export async function runSchemeBatch(
  env: Env,
  config: Readonly<Config> = DEFAULTS,
  opts: { chunkBudget?: number } = {},
): Promise<SchemeBatchResult> {
  const idle = (extra: Partial<SchemeBatchResult> = {}): SchemeBatchResult =>
    ({ processed: 0, skipped: 0, failed: 0, chunks: 0, remaining: 0, done: true, stalled: false, ...extra });

  const target = schemeOf(config);
  const prior = await readSchemeMigration(env);
  let state: SchemeMigrationState;
  if (prior && prior.model === config.EMBEDDING_MODEL && prior.target === target) {
    state = prior;
    if (state.finishedAt) return idle();
  } else {
    // A new target. Vectors may be at the old target, or (if that run never finished) anywhere in its sources.
    const sources = prior && prior.model === config.EMBEDDING_MODEL
      ? [...new Set([...(prior.finishedAt ? [] : prior.sources), prior.target])]
      : [LEGACY_SCHEME];
    state = {
      model: config.EMBEDDING_MODEL, target, sources: sources.filter(s => s !== target), startedAt: Date.now(),
      cursorCreatedAt: null, cursorId: null, processed: 0, skipped: 0, failed: 0,
    };
    if (state.sources.length === 0) {
      await writeScheme(env, { ...state, finishedAt: Date.now() });
      return idle();
    }
  }

  // Nothing any vector needs: the only differences are switches that never rewrite.
  if (!state.sources.some(s => needsRewrite(s, target, true))) {
    await writeScheme(env, { ...state, finishedAt: Date.now() });
    return idle();
  }

  // A model migration rebuilds every vector into a new index with the current
  // config; running both would rewrite the abandoned index. Checked only once
  // there is work, so an idle night does not pay for it.
  const model = await readMigration(env);
  if (model && !model.finishedAt && model.model === config.EMBEDDING_MODEL) return idle({ done: false, paused: "model-migration" });

  const page = state.cursorCreatedAt === null
    ? await env.DB.prepare(pageSql(false)).all()
    : await env.DB.prepare(pageSql(true)).bind(state.cursorCreatedAt, state.cursorCreatedAt, state.cursorId).all();
  const rows = (page.results ?? []) as Record<string, unknown>[];

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  let chunks = 0;
  const budget = opts.chunkBudget ?? SCHEME_BATCH_CHUNK_BUDGET;
  let reached: { created_at: number; id: string } | null = null;
  let stalledReason: string | undefined;

  for (const row of rows) {
    const id = row.id as string;
    const source = row.source as string;
    const content = row.content as string;
    const eligible = isContextEligible({ content, source });
    const mark = { created_at: row.created_at as number, id };

    if (!state.sources.some(s => needsRewrite(s, target, eligible))) {
      skipped++;
      reached = mark;
      continue;
    }

    const tags = JSON.parse((row.tags as string) ?? "[]") as string[];
    const cost = buildEmbeddingChunks({ id, content, tags, source, createdAt: row.created_at as number }, config).length;
    // The first rewrite always goes ahead, or one very long memory would wedge the cursor.
    if (chunks > 0 && chunks + cost > budget) break;
    chunks += cost;

    try {
      await rewriteEntry(env, row, config);
      processed++;
      reached = mark;
    } catch (e) {
      failed++;
      console.error("Scheme migration failed for entry", id, e);
      if (looksLikeBudgetError(e)) stalledReason = "budget";
      break;
    }
    if (chunks >= budget) break;
  }

  const next: SchemeMigrationState = {
    ...state,
    cursorCreatedAt: reached?.created_at ?? state.cursorCreatedAt,
    cursorId: reached?.id ?? state.cursorId,
    processed: state.processed + processed,
    skipped: state.skipped + skipped,
    failed: state.failed + failed,
  };
  const remaining = await countRemaining(env, next.cursorCreatedAt, next.cursorId);
  const stalled = processed === 0 && failed > 0;
  const done = remaining === 0 && !stalled;
  await writeScheme(env, done ? { ...next, finishedAt: Date.now() } : next);
  return { processed, skipped, failed, chunks, remaining, done, stalled, ...(stalled ? { stalledReason: stalledReason ?? "failing" } : {}) };
}

/**
 * Rebuilds one entry's vectors under `config`, then drops the chunk ids the new
 * set no longer uses. If the row's content or tags changed meanwhile, the edit's
 * own write may have been overwritten by this one's older content, so it is
 * rebuilt from the fresh row until it holds still. (Compared by value: updated_at
 * is nullable and never backfilled, so it cannot be relied on.)
 */
async function rewriteEntry(env: Env, first: Record<string, unknown>, config: Readonly<Config>, llmContexts?: readonly string[]): Promise<void> {
  let row = first;
  for (let attempt = 0; attempt < SCHEME_MAX_REBUILDS; attempt++) {
    const oldIds = JSON.parse((row.vector_ids as string) ?? "[]") as string[];
    const stored = await storeEntry(
      env,
      row.id as string,
      row.content as string,
      JSON.parse((row.tags as string) ?? "[]"),
      row.source as string,
      row.created_at as number,
      config,
      { workspaceId: row.workspace_id as string, actorId: row.actor_id as string },
      // Generated sentences describe the row as first read; a rebuild after an edit falls back to the deterministic prefix.
      attempt === 0 ? llmContexts : undefined,
    );
    const fresh = (await env.DB.prepare(
      // scope-exempt: one-time re-embed migration: by-id re-read of the row being rebuilt
      `SELECT id, content, tags, source, created_at, vector_ids, workspace_id, actor_id FROM entries WHERE id = ?`,
    ).bind(row.id).first()) as Record<string, unknown> | null;
    // Deleted while rebuilding: its own delete already removed the ids it knew; remove what this write added.
    if (!fresh) {
      await env.VECTORIZE.deleteByIds(stored.vectorIds);
      return;
    }
    if (fresh.content === row.content && fresh.tags === row.tags) {
      await deleteStaleVectors(env, oldIds, stored.vectorIds);
      return;
    }
    row = fresh;
  }
  throw new Error(`entry ${String(row.id)} kept changing while it was rebuilt`);
}


// ── Generated context tier (T-0042, off by default) ──────────────────────────
//
// Optional and nightly: replaces a long note's deterministic prefix with one
// model-written sentence per chunk (CONTEXTUAL_EMBEDDING_LLM). Bounded to
// CONTEXT_LLM_CHUNKS_PER_NIGHT model calls a night, whole entries only, and
// never before the deterministic scheme migration has finished, so a failure at
// any point leaves the deterministic vectors in place.

export const CONTEXT_LLM_BACKFILL_KV_KEY = "contextual-embedding:v1:llm-backfill";
/** Nights an entry may fail before the backfill steps past it. */
const LLM_MAX_FAILED_NIGHTS = 3;

interface LlmBackfillState {
  cursorCreatedAt: number | null;
  cursorId: string | null;
  upgraded: number;
  skipped: number;
  /** Failed nights per entry id, for the entry at the cursor only. */
  failedNights: number;
}

export interface LlmBatchResult { calls: number; upgraded: number; skipped: number; stalled: boolean; idle: boolean }

export async function runLlmContextBatch(env: Env, config: Readonly<Config> = DEFAULTS): Promise<LlmBatchResult> {
  const result: LlmBatchResult = { calls: 0, upgraded: 0, skipped: 0, stalled: false, idle: true };
  if (config.CONTEXTUAL_EMBEDDINGS !== "on" || config.CONTEXTUAL_EMBEDDING_LLM !== "on") return result;

  const scheme = await readSchemeMigration(env);
  if (!scheme?.finishedAt || scheme.target !== schemeOf(config) || scheme.model !== config.EMBEDDING_MODEL) return result;

  let state: LlmBackfillState = { cursorCreatedAt: null, cursorId: null, upgraded: 0, skipped: 0, failedNights: 0 };
  try {
    const raw = await env.OAUTH_KV.get(CONTEXT_LLM_BACKFILL_KV_KEY);
    if (raw) state = { ...state, ...(JSON.parse(raw) as Partial<LlmBackfillState>) };
  } catch { /* unreadable cursor restarts the backfill; an upgraded entry is simply upgraded again */ }

  const page = state.cursorCreatedAt === null
    ? await env.DB.prepare(pageSql(false)).all()
    : await env.DB.prepare(pageSql(true)).bind(state.cursorCreatedAt, state.cursorCreatedAt, state.cursorId).all();
  const rows = (page.results ?? []) as Record<string, unknown>[];

  for (const row of rows) {
    const id = row.id as string;
    const mark = { cursorCreatedAt: row.created_at as number, cursorId: id };
    const entry = { id, content: row.content as string, tags: JSON.parse((row.tags as string) ?? "[]") as string[], source: row.source as string, createdAt: row.created_at as number };
    const chunks = isContextEligible(entry) ? buildEmbeddingChunks(entry, config) : [];
    if (chunks.length < 2 || chunks.length > CONTEXT_LLM_MAX_CHUNKS_PER_ENTRY) {
      state = { ...state, ...mark, failedNights: 0 };
      continue;
    }
    // Never cross the nightly ceiling mid-entry; the first entry of a night always fits.
    if (result.calls > 0 && result.calls + chunks.length > CONTEXT_LLM_CHUNKS_PER_NIGHT) break;
    result.idle = false;

    const contexts: string[] = [];
    for (const c of chunks) {
      result.calls++;
      const sentence = await generateChunkContext(entry, c.rawContent, c.chunkIndex, c.totalChunks, env, config);
      if (!sentence) break;
      contexts.push(sentence);
    }
    let ok = contexts.length === chunks.length;
    if (ok) {
      try {
        await rewriteEntry(env, row, config, contexts);
      } catch (e) {
        console.error("Generated-context rewrite failed for entry", id, e);
        ok = false;
      }
    }
    if (ok) {
      state = { ...state, ...mark, upgraded: state.upgraded + 1, failedNights: 0 };
      result.upgraded++;
      continue;
    }
    // A failed entry stays in front of the cursor so tomorrow retries it; after a few nights it is stepped past.
    const failed = state.failedNights + 1;
    if (failed >= LLM_MAX_FAILED_NIGHTS) {
      state = { ...state, ...mark, skipped: state.skipped + 1, failedNights: 0 };
      result.skipped++;
    } else {
      state = { ...state, failedNights: failed };
    }
    result.stalled = true;
    break;
  }

  if (!result.idle || state.cursorId !== null) await env.OAUTH_KV.put(CONTEXT_LLM_BACKFILL_KV_KEY, JSON.stringify(state));
  return result;
}
