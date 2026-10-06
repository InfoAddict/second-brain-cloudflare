/**
 * UX-I: shared engine for the chat walkthroughs (spec section 6.4). Each client script
 * (claude.ts, chatgpt.ts, codex.ts, cursor.ts) plays "the agent" for its own AI_Instructions
 * file against a fresh local brain, through the REAL MCP server (buildMcpServer + an in-memory
 * transport, the same pattern test/integration/history-events-visibility.test.ts and
 * test/integration/merge-semantic-integration.test.ts use for `mcpCall`), never a mock server.
 *
 * The four instruction files are, tool-for-tool, the same contract (call recall then brief at
 * session start, call resolve on a clear done/snooze/insight signal, call forget only on an
 * explicit delete ask, never a "permanent delete", etc). They differ only in wording, the
 * `source` value a client should pass, and its own response tag (claude-response,
 * codex-response, cursor-response; see CHATGPT_INSTRUCTIONS.md's own tag line, which is a
 * pre-existing bug worth flagging: it says "claude-response", not "chatgpt-response"). So the
 * eleven scenarios live once here, parameterized per client, rather than pasted four times.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../../src/mcp/server";
import { initializeDatabase, resetDatabaseInit } from "../../../src/db/init";
import { ensureTenantBootstrap } from "../../../src/lib/tenancy";
import { resolveIdentityByUserId, type Identity } from "../../../src/lib/identity";
import { openLocalBrain, resetLocalBrain, type LocalEnvHandle } from "../local-env";
import type { Env } from "../../../src/env";
import type { McpClientProps } from "../../../src/mcp/client-label";

export const EM_DASH = "—";
export const hasEmDash = (text: string): boolean => text.includes(EM_DASH);

export interface ToolCallLog {
  tool: string;
  args: Record<string, unknown>;
  reply?: string;
  /** Set when the call failed because the tool itself is not registered on this branch yet
   * (McpError "Tool ... not found"): the "pending, fails clearly" contract, never faked. */
  notBuilt?: boolean;
  errorMessage?: string;
}

export type ScenarioStatus = "pass" | "pending" | "fail";

export interface ScenarioResult {
  n: number;
  name: string;
  status: ScenarioStatus;
  calls: ToolCallLog[];
  note: string;
}

/** One simulated chat session: one MCP client wired to one server instance over an in-memory
 * transport, mirroring test/integration's mcpCall helper exactly, just kept open across a
 * scenario's several calls so every call and reply can be logged in order. A "new session" in a
 * scenario (the agent has no memory of earlier calls) is a fresh ChatSession against the same
 * persistent env: the brain remembers, the conversation does not. */
export class ChatSession {
  private client: Client;
  private ready: Promise<void>;
  calls: ToolCallLog[] = [];

  /** `clientProps` (W22, W25): simulates the OAuth grant a real DCR-registered client would have
   * -- see trust-scenarios.ts's own note on why this, not a full DCR + authorize HTTP round trip. */
  constructor(env: Env, ctx: ExecutionContext, identity: Identity | undefined, label: string, clientProps?: McpClientProps) {
    const server = buildMcpServer(env, ctx, identity, clientProps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    this.client = new Client({ name: `ux-chat-${label}`, version: "1.0.0" });
    this.ready = Promise.all([this.client.connect(clientTransport), server.connect(serverTransport)]).then(() => {});
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<ToolCallLog> {
    await this.ready;
    const entry: ToolCallLog = { tool, args };
    try {
      const r = await this.client.callTool({ name: tool, arguments: args });
      entry.reply = String((r.content as { text?: string }[] | undefined)?.[0]?.text ?? "");
    } catch (e) {
      entry.errorMessage = e instanceof Error ? e.message : String(e);
    }
    // McpServer's own error for an unregistered name (see node_modules/@modelcontextprotocol/
    // sdk/dist/esm/server/mcp.js): `Tool ${name} not found`, ErrorCode.InvalidParams. This SDK
    // version does not throw that on the client: it lands as a normal CallToolResult whose own
    // text IS that error string, so both fields are checked, whichever one ended up holding it.
    const text = entry.reply ?? entry.errorMessage ?? "";
    if (new RegExp(`Tool "?${tool}"? not found`, "i").test(text)) entry.notBuilt = true;
    this.calls.push(entry);
    return entry;
  }

  async listToolsRaw() {
    await this.ready;
    return this.client.listTools();
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export const idFrom = (reply: string | undefined): string | null => {
  if (!reply) return null;
  const m = /ID:\s*([A-Za-z0-9-]+)/.exec(reply);
  return m ? m[1] : null;
};

export function pending(n: number, name: string, calls: ToolCallLog[], reason: string): ScenarioResult {
  return { n, name, status: "pending", calls, note: `feature not built: ${reason}` };
}
export function pass(n: number, name: string, calls: ToolCallLog[], note: string): ScenarioResult {
  return { n, name, status: "pass", calls, note };
}
export function fail(n: number, name: string, calls: ToolCallLog[], note: string): ScenarioResult {
  return { n, name, status: "fail", calls, note };
}

/** Any call whose reply contains an em dash fails the whole scenario outright (6.4's own pass
 * bar), unless the scenario is already pending for an unrelated missing feature: a pending
 * scenario's calls are the ones that actually ran before hitting the gap, and are worth keeping
 * visible, not reclassified as a fresh failure over copy this script does not own. */
export function emDashViolations(calls: ToolCallLog[]): ToolCallLog[] {
  return calls.filter(c => c.reply && hasEmDash(c.reply));
}

export interface ClientProfile {
  /** Short label used in the brain's on-disk state directory name and session names. */
  label: string;
  /** The `source` value this client's instructions tell it to pass on remember. */
  source: string;
  /** This client's own response tag, e.g. "claude-response" or "codex-response". */
  responseTag: string;
}

export interface ClientReport {
  client: string;
  scenarios: ScenarioResult[];
}

// One profile per AI_Instructions/*.md file, read straight off each file's own "Always set
// source to ..." line and its response-tag guidance. Kept here, not duplicated in each client
// script and again in run-all.ts, so there is exactly one place that could drift from the files.
export const CLAUDE_PROFILE: ClientProfile = { label: "claude", source: "claude-desktop", responseTag: "claude-response" };
// CHATGPT_INSTRUCTIONS.md:26 says "Tags: ... claude-response ... Source: chatgpt" - the response
// tag is copy-pasted from the Claude file rather than reading "chatgpt-response". Reproduced
// here as-is (not fixed) so this harness plays the file literally; flagged in the report instead.
export const CHATGPT_PROFILE: ClientProfile = { label: "chatgpt", source: "chatgpt", responseTag: "claude-response" };
export const CODEX_PROFILE: ClientProfile = { label: "codex", source: "codex", responseTag: "codex-response" };
export const CURSOR_PROFILE: ClientProfile = { label: "cursor", source: "cursor", responseTag: "cursor-response" };

export function summarize(scenarios: ScenarioResult[]): { pass: number; pending: number; fail: number } {
  return {
    pass: scenarios.filter(s => s.status === "pass").length,
    pending: scenarios.filter(s => s.status === "pending").length,
    fail: scenarios.filter(s => s.status === "fail").length,
  };
}

export interface BrainSetup {
  handle: LocalEnvHandle;
  identity: Identity;
  ctx: ExecutionContext;
  /** Waits for every background write this session's ctx.waitUntil queued (audit events,
   * re-embeds) before the brain is closed. Without this, disposing the platform proxy mid-flight
   * makes those background writes fail against a torn-down stub - harmless to a real Worker
   * (the isolate just recycles), but noisy console error output in a short-lived Node script that
   * closes its brain the moment the scenario loop finishes. */
  drain(): Promise<void>;
}

export async function setUpBrain(brainName: string): Promise<BrainSetup> {
  resetLocalBrain(brainName);
  resetDatabaseInit();
  const handle = await openLocalBrain(brainName);
  await initializeDatabase(handle.env);
  const roots = await ensureTenantBootstrap(handle.env);
  const identity = (await resolveIdentityByUserId(handle.env, roots.ownerUserId))!;
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => {})); },
  } as unknown as ExecutionContext;
  const drain = async () => {
    while (pending.length) await Promise.allSettled(pending.splice(0, pending.length));
  };
  return { handle, identity, ctx, drain };
}
