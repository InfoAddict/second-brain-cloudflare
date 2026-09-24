/**
 * Embedding-migration surface for the desktop app (#248).
 *
 * The app orchestrates a model change — create the new index, redeploy the
 * binding at it, rebuild every vector, verify, then drop the old index — because
 * only the app holds Cloudflare credentials. These routes are the parts that
 * have to run inside the Worker: reading D1 for the estimate, and re-embedding.
 *
 * Authenticated with the same AUTH_TOKEN as the rest of the API.
 *
 * `POST /migration/reembed` does one bounded batch and returns `remaining`, so
 * the caller loops until it reaches zero — the same shape as
 * `POST /vectorize-pending` and the integration syncs. One request cannot do the
 * whole rebuild: Workers cap subrequests per invocation, and a brain of a few
 * thousand entries needs thousands of model calls.
 */
import type { Env } from "../env";
import { json, requireAuth } from "../lib/http";
import { resolveConfig } from "../config";
import {
  clearMigration,
  estimate,
  readMigration,
  readSchemeMigration,
  runBatch,
  runSchemeBatch,
} from "../migration/embedding";

export async function handleMigrationRoutes(
  request: Request,
  url: URL,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response | null> {
  // GET /migration/estimate — what a rebuild would cost, before anything is
  // created. The app shows this first; the price should be known before
  // committing, not discovered during.
  if (url.pathname === "/migration/estimate" && request.method === "GET") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    const cfg = await resolveConfig(env);
    const { entries, chunks } = await estimate(env, cfg);
    return json({
      ok: true,
      entries,
      // Exactly what a rebuild under the current config would write (contextual
      // focus chunks included). The name predates that and stays for callers.
      chunksAtLeast: chunks,
      model: cfg.EMBEDDING_MODEL,
    });
  }

  // GET /migration/status — the ledger. The app reads this to resume an
  // interrupted rebuild, and to tell the user where it got to.
  if (url.pathname === "/migration/status" && request.method === "GET") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    const state = await readMigration(env);
    const cfg = await resolveConfig(env);
    return json({
      ok: true,
      // null means no rebuild has ever been started for this brain.
      state,
      // The model currently in force, so the app can spot a ledger left over
      // from a different target.
      model: cfg.EMBEDDING_MODEL,
    });
  }

  // POST /migration/reembed — one bounded batch.
  if (url.pathname === "/migration/reembed" && request.method === "POST") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    const cfg = await resolveConfig(env);
    const result = await runBatch(env, cfg);
    return json({ ok: true, ...result });
  }

  // POST /migration/reset — forget the ledger so the next batch starts from the
  // beginning. Rebuilding is idempotent (vector ids are deterministic, and the
  // upsert overwrites), so this costs model calls but cannot corrupt anything.
  if (url.pathname === "/migration/reset" && request.method === "POST") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    await clearMigration(env);
    return json({ ok: true });
  }

  // GET /migration/scheme — where the in-place move to the configured embedding
  // scheme (contextual chunk text, pooling) has got to. null means every vector
  // is as old as the brain: nothing has ever needed moving.
  if (url.pathname === "/migration/scheme" && request.method === "GET") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    return json({ ok: true, state: await readSchemeMigration(env) });
  }

  // POST /migration/scheme — one bounded batch of that move. The nightly job
  // runs one a night; a caller in a hurry loops this until `done`. Resumable and
  // idempotent at every point, and recall works throughout (see runSchemeBatch).
  if (url.pathname === "/migration/scheme" && request.method === "POST") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    const cfg = await resolveConfig(env);
    return json({ ok: true, ...(await runSchemeBatch(env, cfg, { count: true })) });
  }

  return null;
}
