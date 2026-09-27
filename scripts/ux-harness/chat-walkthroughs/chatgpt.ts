/**
 * UX-I chat walkthrough for AI_Instructions/CHATGPT_INSTRUCTIONS.md (spec section 6.4). Same
 * mechanics as claude.ts (see scenarios.ts and common.ts) with this file's own source ("chatgpt")
 * and response tag. Note: CHATGPT_INSTRUCTIONS.md:26 itself says "claude-response" rather than
 * "chatgpt-response" in its tag list - reproduced as-is in CHATGPT_PROFILE (common.ts) since this
 * harness plays the file literally rather than the tag it probably meant to say; flagged for the
 * lead builder rather than silently corrected here.
 *
 * Run standalone: node scripts/ux-run-ts.mjs scripts/ux-harness/chat-walkthroughs/chatgpt.ts
 * Run as part of the full suite: node scripts/ux-run-ts.mjs scripts/ux-harness/chat-walkthroughs/run-all.ts
 */
import { CHATGPT_PROFILE, setUpBrain } from "./common";
import { runAllScenarios } from "./scenarios";
import { hasHardFailure, printScenarios } from "./report";

async function main() {
  const { handle, identity, ctx, drain } = await setUpBrain("chat-chatgpt");
  try {
    const scenarios = await runAllScenarios(handle.env, ctx, identity, CHATGPT_PROFILE);
    printScenarios("CHATGPT (AI_Instructions/CHATGPT_INSTRUCTIONS.md)", scenarios);
    if (hasHardFailure(scenarios)) process.exitCode = 1;
  } finally {
    await drain();
    await handle.close();
  }
}

main().catch(e => { console.error("chatgpt walkthrough crashed:", e); process.exitCode = 1; });
