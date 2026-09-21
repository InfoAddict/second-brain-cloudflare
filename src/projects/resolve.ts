// Read-side project lookup shared by the HTTP routes and the MCP tools: turns a caller's
// `project` argument into registry rows, or into the exact failure both surfaces report.
import type { Env } from "../env";
import type { Identity } from "../lib/identity";
import { readScopeWorkspaces } from "../lib/scope";
import { projectSlugError } from "../tags/system";
import { MAX_PROJECT_PATTERNS, expandProjectFilter } from "./filter";
import { getProject, knownProjectSlugs, type ProjectRow } from "./registry";

export type ProjectResolution =
  | { ok: true; rows: ProjectRow[] }
  | { ok: false; status: 400 | 404; error: string; known_projects?: string[] };

/**
 * Registry rows for `slug` among the workspaces the caller may read (narrowed by
 * layer/team exactly as the entry read is). An unknown slug is a 404 that names the
 * closest known slugs; writes auto-create instead and never come through here.
 */
export async function resolveProjectRead(
  env: Env,
  identity: Identity,
  raw: string,
  opts?: { layer?: "personal" | "company"; teamId?: string },
): Promise<ProjectResolution> {
  const slug = raw.trim();
  const grammar = projectSlugError(slug);
  if (grammar) return { ok: false, status: 400, error: grammar };

  const workspaceIds = readScopeWorkspaces(identity, opts);
  const rows = await getProject(env.DB, workspaceIds, slug);
  if (!rows.length) {
    return { ok: false, status: 404, error: `unknown project "${slug}"`, known_projects: await knownProjectSlugs(env.DB, workspaceIds, 10) };
  }
  if (expandProjectFilter(rows).patterns.length > MAX_PROJECT_PATTERNS) {
    return { ok: false, status: 400, error: `project "${slug}" has too many aliases across workspaces to filter at once; pass workspace (and team) to narrow` };
  }
  return { ok: true, rows };
}
