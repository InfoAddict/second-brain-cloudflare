/**
 * Decision ledger routes (Track 7, T-0089.7.2).
 *
 * Empty on purpose (Task 6: "indexes, config, mounts" only, no wiring): GET
 * /decisions, GET /decisions/calibration (Design 4.4) and POST
 * /decisions/outcome (Design 4.2) land in later tasks. Mounted now so
 * routes/index.ts's handler list is stable across the tasks that fill this in.
 */
import type { Env } from "../env";

export async function handleLedgerRoutes(
  _request: Request,
  _url: URL,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<Response | null> {
  return null;
}
