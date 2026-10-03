/**
 * UX-I chat walkthrough for AI_Instructions/CODEX_INSTRUCTIONS.md (spec section 6.4). Same
 * mechanics as claude.ts (see scenarios.ts and common.ts) with this file's own source ("codex")
 * and response tag ("codex-response"). Codex is section 6.4's "strictest client" for the
 * tools/list size check, which run-all.ts measures once (the payload is identical for every
 * client - MCP tool registration does not vary by caller).
 *
 * Run standalone: node scripts/ux-run-ts.mjs scripts/ux-harness/chat-walkthroughs/codex.ts
 * Run as part of the full suite: node scripts/ux-run-ts.mjs scripts/ux-harness/chat-walkthroughs/run-all.ts
 */
import { CODEX_PROFILE, setUpBrain } from "./common";
import { runAllScenarios } from "./scenarios";
import { hasHardFailure, printScenarios } from "./report";

async function main() {
  const { handle, identity, ctx, drain } = await setUpBrain("chat-codex");
  try {
    const scenarios = await runAllScenarios(handle.env, ctx, identity, CODEX_PROFILE);
    printScenarios("CODEX (AI_Instructions/CODEX_INSTRUCTIONS.md)", scenarios);
    if (hasHardFailure(scenarios)) process.exitCode = 1;
  } finally {
    await drain();
    await handle.close();
  }
}

main().catch(e => { console.error("codex walkthrough crashed:", e); process.exitCode = 1; });
