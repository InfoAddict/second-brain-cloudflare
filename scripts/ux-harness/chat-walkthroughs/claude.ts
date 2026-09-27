/**
 * UX-I chat walkthrough for AI_Instructions/CLAUDE_INSTRUCTIONS.md (spec section 6.4). Plays the
 * agent literally following that file's own rules (recall + brief at session start, resolve on
 * a clear signal, forget only on an explicit ask, never a fabricated "permanent delete", source
 * "claude-desktop" on every write) against a fresh local brain, through the real MCP server
 * (buildMcpServer + an in-memory transport - see scenarios.ts and common.ts for the shared
 * mechanics all four client scripts run on).
 *
 * Run standalone: node scripts/ux-run-ts.mjs scripts/ux-harness/chat-walkthroughs/claude.ts
 * Run as part of the full suite: node scripts/ux-run-ts.mjs scripts/ux-harness/chat-walkthroughs/run-all.ts
 */
import { CLAUDE_PROFILE, setUpBrain } from "./common";
import { runAllScenarios } from "./scenarios";
import { hasHardFailure, printScenarios } from "./report";

async function main() {
  const { handle, identity, ctx, drain } = await setUpBrain("chat-claude");
  try {
    const scenarios = await runAllScenarios(handle.env, ctx, identity, CLAUDE_PROFILE);
    printScenarios("CLAUDE (AI_Instructions/CLAUDE_INSTRUCTIONS.md)", scenarios);
    if (hasHardFailure(scenarios)) process.exitCode = 1;
  } finally {
    await drain();
    await handle.close();
  }
}

main().catch(e => { console.error("claude walkthrough crashed:", e); process.exitCode = 1; });
