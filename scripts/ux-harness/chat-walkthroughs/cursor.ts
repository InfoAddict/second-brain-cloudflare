/**
 * UX-I chat walkthrough for AI_Instructions/CURSOR_INSTRUCTIONS.md (spec section 6.4). Same
 * mechanics as claude.ts (see scenarios.ts and common.ts) with this file's own source ("cursor")
 * and response tag ("cursor-response"). CURSOR_INSTRUCTIONS.md also documents a `brain` CLI
 * fallback for when MCP tools are not in the tool list - out of scope here, since this harness
 * exercises the real MCP server directly and MCP is always present in these scenarios.
 *
 * Run standalone: node scripts/ux-run-ts.mjs scripts/ux-harness/chat-walkthroughs/cursor.ts
 * Run as part of the full suite: node scripts/ux-run-ts.mjs scripts/ux-harness/chat-walkthroughs/run-all.ts
 */
import { CURSOR_PROFILE, setUpBrain } from "./common";
import { runAllScenarios } from "./scenarios";
import { hasHardFailure, printScenarios } from "./report";

async function main() {
  const { handle, identity, ctx, drain } = await setUpBrain("chat-cursor");
  try {
    const scenarios = await runAllScenarios(handle.env, ctx, identity, CURSOR_PROFILE);
    printScenarios("CURSOR (AI_Instructions/CURSOR_INSTRUCTIONS.md)", scenarios);
    if (hasHardFailure(scenarios)) process.exitCode = 1;
  } finally {
    await drain();
    await handle.close();
  }
}

main().catch(e => { console.error("cursor walkthrough crashed:", e); process.exitCode = 1; });
