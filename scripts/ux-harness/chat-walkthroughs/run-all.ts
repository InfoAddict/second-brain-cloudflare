/**
 * UX-I: runs all four chat walkthroughs (spec section 6.4) in sequence, each against its own
 * fresh local brain (never shared state between clients), and prints one summary: which
 * scenarios passed, which are pending ("feature not built") and why, and any hard failure. Also
 * measures the `tools/list` payload size, the check 6.4 calls out against "the strictest client
 * (Codex)" - the payload itself does not vary by caller (MCP tool registration is not
 * identity-aware), so it is measured once.
 *
 * Run: node scripts/ux-run-ts.mjs scripts/ux-harness/chat-walkthroughs/run-all.ts
 * Or: node scripts/ux-chat.mjs
 */
import { ChatSession, CHATGPT_PROFILE, CLAUDE_PROFILE, CODEX_PROFILE, CURSOR_PROFILE, setUpBrain, summarize, type ClientProfile, type ClientReport } from "./common";
import { runAllScenarios } from "./scenarios";
import { runTrustScenarios } from "./trust-scenarios";
import { hasHardFailure, printScenarios } from "./report";

const CLIENTS: { label: string; profile: ClientProfile }[] = [
  { label: "CLAUDE (AI_Instructions/CLAUDE_INSTRUCTIONS.md)", profile: CLAUDE_PROFILE },
  { label: "CHATGPT (AI_Instructions/CHATGPT_INSTRUCTIONS.md)", profile: CHATGPT_PROFILE },
  { label: "CODEX (AI_Instructions/CODEX_INSTRUCTIONS.md)", profile: CODEX_PROFILE },
  { label: "CURSOR (AI_Instructions/CURSOR_INSTRUCTIONS.md)", profile: CURSOR_PROFILE },
];

async function measureToolsListSize(): Promise<number> {
  const { handle, identity, ctx, drain } = await setUpBrain("chat-tools-list-size");
  try {
    const s = new ChatSession(handle.env, ctx, identity, "tools-list-size");
    const tools = await s.listToolsRaw();
    await s.close();
    return Buffer.byteLength(JSON.stringify(tools.tools), "utf8");
  } finally {
    await drain();
    await handle.close();
  }
}

async function main() {
  const reports: ClientReport[] = [];
  for (const { label, profile } of CLIENTS) {
    const { handle, identity, ctx, drain } = await setUpBrain(`chat-${profile.label}`);
    try {
      const scenarios = await runAllScenarios(handle.env, ctx, identity, profile);
      printScenarios(label, scenarios);
      reports.push({ client: label, scenarios });
    } finally {
      await drain();
      await handle.close();
    }
  }

  const toolsListBytes = await measureToolsListSize();

  // The trust spec's own numbered walkthroughs that are MCP scenarios, not dashboard journeys
  // (16-t3-t4-trust-spec.md 7.8): W21 (chat trash), W22 and W25 (DCR client name). W24 has no
  // entry here -- see trust-scenarios.ts's file comment.
  const { handle: trustHandle, identity: trustIdentity, ctx: trustCtx, drain: trustDrain } = await setUpBrain("chat-trust-walkthroughs");
  let trustScenarios: Awaited<ReturnType<typeof runTrustScenarios>>;
  try {
    trustScenarios = await runTrustScenarios(trustHandle.env, trustCtx, trustIdentity);
    printScenarios("TRUST WALKTHROUGHS (W21, W22, W25 -- 16-t3-t4-trust-spec.md 7.8; W24 needs the adapters' own contract-test servers, not this runner)", trustScenarios);
    reports.push({ client: "TRUST WALKTHROUGHS (W21, W22, W25)", scenarios: trustScenarios });
  } finally {
    await trustDrain();
    await trustHandle.close();
  }

  console.log(`\n${"#".repeat(70)}\nSUMMARY\n${"#".repeat(70)}`);
  let anyFail = false;
  for (const r of reports) {
    const { pass, pending, fail } = summarize(r.scenarios);
    if (fail > 0) anyFail = true;
    console.log(`${r.client}: ${pass} pass, ${pending} pending, ${fail} fail`);
    if (pending > 0) {
      for (const s of r.scenarios.filter(s => s.status === "pending")) console.log(`  pending [${s.n}] ${s.name}: ${s.note}`);
    }
    if (hasHardFailure(r.scenarios)) {
      for (const s of r.scenarios.filter(s => s.status === "fail")) console.log(`  FAIL [${s.n}] ${s.name}: ${s.note}`);
    }
  }
  console.log(`\ntools/list payload: ${toolsListBytes} bytes (${(toolsListBytes / 1024).toFixed(1)} KB) - measured against the strictest client, Codex (spec 6.4's size check).`);

  process.exitCode = anyFail ? 1 : 0;
}

main().catch(e => { console.error("run-all crashed:", e); process.exitCode = 1; });
