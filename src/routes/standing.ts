/**
 * Standing memory routes (Track 7, T-0089.7.1).
 *
 * Empty on purpose (Task 6: "indexes, config, mounts" only, no wiring): GET
 * /standing (Design 2.12) and POST /standing/stop (Design 2.2) land in a
 * later task. Mounted now so routes/index.ts's handler list is stable across
 * the tasks that fill this in.
 */
import type { Env } from "../env";

export async function handleStandingRoutes(
  _request: Request,
  _url: URL,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<Response | null> {
  return null;
}
