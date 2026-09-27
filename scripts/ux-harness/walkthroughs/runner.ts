/**
 * UX-I: runs the map's scripted dashboard journeys (W1 onward, section 6.2) against a fresh local
 * brain each, in a real headless Chrome, capturing a screenshot at each meaningful step.
 *
 * A journey that hits a feature this branch has not built yet is reported PENDING, not FAILED —
 * see types.ts's NotBuilt. That is expected today: UX-A (history/undo), UX-B (trash) and UX-D
 * (settings) are other lanes' work in flight. Every journey still runs its real backend setup
 * through the actual Worker code, so the moment a lane ships the missing UI, the same script
 * turns green with no rewrite.
 */
import { openBrowser } from "../browser";
import { startDevServer } from "../dev-server";
import { openLocalBrain, resetLocalBrain } from "../local-env";
import { initializeDatabase, resetDatabaseInit } from "../../../src/db/init";
import { startRun } from "../screenshots";
import { NotBuilt, type Journey } from "./types";

export interface RunResult { id: string; title: string; status: "pass" | "pending" | "fail"; detail?: string }

export async function runJourneys(journeys: Journey[], opts: { runId?: string } = {}): Promise<RunResult[]> {
  const rec = startRun(opts.runId);
  const session = await openBrowser();
  const results: RunResult[] = [];
  try {
    for (const journey of journeys) {
      const brainName = `walkthrough-${journey.id}`;
      resetLocalBrain(brainName);
      resetDatabaseInit();
      const { env, close } = await openLocalBrain(brainName);
      let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
      try {
        await initializeDatabase(env);
        await journey.setup(env);
        // Re-open a server against the SAME on-disk state journey.setup just wrote to, so the
        // dashboard sees exactly what the journey prepared.
        await close();
        // Journeys run one at a time, each closing its server before the next opens one, so a
        // fixed port is safe and keeps startDevServer simple (no ephemeral-port plumbing needed).
        server = await startDevServer({ brain: brainName, port: 8788 });
        const page = await session.newPage({ baseUrl: server.url, token: "ux-harness-local-token" });
        let stepCount = 0;
        const ctx = {
          env,
          baseUrl: server.url,
          page,
          viewport: "desktop" as const,
          locale: "en" as const,
          theme: "light" as const,
          async shot(slug: string, caption: string) {
            stepCount++;
            await rec.shot(page, `${journey.id}-${String(stepCount).padStart(2, "0")}-${slug}`, `${journey.title}: ${caption}`);
          },
        };
        await journey.run(ctx);
        results.push({ id: journey.id, title: journey.title, status: "pass" });
        console.log(`PASS  ${journey.id}  ${journey.title}`);
      } catch (e) {
        if (e instanceof NotBuilt) {
          results.push({ id: journey.id, title: journey.title, status: "pending", detail: e.message });
          console.log(`PEND  ${journey.id}  ${journey.title}  (${e.message})`);
        } else {
          const detail = e instanceof Error ? e.message : String(e);
          results.push({ id: journey.id, title: journey.title, status: "fail", detail });
          console.log(`FAIL  ${journey.id}  ${journey.title}  (${detail})`);
        }
      } finally {
        if (server) await server.close();
      }
    }
  } finally {
    await session.close();
  }
  const pass = results.filter((r) => r.status === "pass").length;
  const pending = results.filter((r) => r.status === "pending").length;
  const fail = results.filter((r) => r.status === "fail").length;
  console.log(`\n${pass} passed, ${pending} pending, ${fail} failed. Screenshots and index.md: ${rec.dir}`);
  return results;
}
