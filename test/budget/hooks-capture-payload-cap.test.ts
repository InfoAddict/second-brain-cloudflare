/**
 * Budget guard for v4/hooks (7b7d8f5d): the client-side cap on a session-end
 * capture's payload size, and what that means for server-side embedding cost
 * once it reaches release/v4's /capture route.
 *
 * core.js's buildSessionCaptureBody (core.js:499-511) keeps only the last
 * CAPTURE_WANT_USER_TURNS (3) user turns, then hard-caps the assembled
 * `content` at CAPTURE_MAX_CONTENT_CHARS (2000) chars — regardless of how
 * large the transcript on disk is. A 200 KB transcript therefore sends at
 * most ~2 KB (2000 chars) of content, never the raw file.
 *
 * At ~4 chars/token, 2000 chars is ~500 tokens. bge-small-en-v1.5 costs 1,841
 * neurons per 1,000,000 input tokens, so one capture costs on the order of
 * (500 / 1_000_000) * 1841 ~= 0.92 neurons — trivial against the 10,000
 * neurons/day free cap, and unaffected by transcript size past 2000 chars.
 *
 * Contrast: release/v4's own /capture route (src/routes/capture.ts) has NO
 * server-side content-length cap — content is stored in full and chunked for
 * embedding at CHUNK_MAX_CHARS (src/constants.ts:64, 1600 chars, 200 char
 * overlap), one separate env.AI.run per chunk (src/capture/store.ts:55-84,
 * not batched through embedMany). A 200 KB paste sent directly to /capture
 * (not through a hook, which never sends that much) would chunk to roughly
 * 200,000 / 1400 ~= 143 chunks -> 143 separate AI.run calls in one request.
 * That stays under Vectorize's 1,000-vectors-per-upsert batch and the
 * 1,000-Cloudflare-subrequests/invocation cap, and the resulting ~50k tokens
 * is still only ~92 neurons — so this is a latency/CPU concern (143
 * sequential-ish AI.run round trips in one request), not a free-tier budget
 * breach, and it predates and is untouched by the hooks lane (verified: `git
 * diff f688bbf2 7b7d8f5d -- src/` touches only src/constants.ts, not
 * src/routes/capture.ts or src/capture/store.ts).
 */
import { describe, it, expect } from "vitest";

const core = require("../../integrations/agent-hooks-core/core.js");

const NEURONS_PER_MILLION_TOKENS = 1841;
const CHARS_PER_TOKEN_ESTIMATE = 4;

describe("buildSessionCaptureBody: client-side size cap", () => {
  it("caps content at 2000 chars regardless of a 200 KB transcript's worth of user turns", () => {
    const hugeTurn = "x".repeat(200_000); // stands in for one giant pasted user turn
    const body = core.buildSessionCaptureBody([hugeTurn], { hostLabel: "Codex", source: "codex-session", workspace: "personal" });

    expect(body.content.length).toBeLessThanOrEqual(core.CAPTURE_MAX_CONTENT_CHARS);
    expect(body.content.length).toBe(core.CAPTURE_MAX_CONTENT_CHARS);
  });

  it("keeps only the last 3 user turns even when many were extracted from a long session", () => {
    const turns = Array.from({ length: 50 }, (_, i) => `turn ${i} `.repeat(20));
    const body = core.buildSessionCaptureBody(turns, { hostLabel: "Codex", source: "codex-session", workspace: "personal" });

    expect(body.content).not.toContain("turn 0 ");
    expect(body.content).toContain(`turn ${49}`);
  });

  it("a capped capture costs a negligible fraction of the 10,000 neurons/day free cap", () => {
    const hugeTurn = "x".repeat(200_000);
    const body = core.buildSessionCaptureBody([hugeTurn], { hostLabel: "Codex", source: "codex-session", workspace: "personal" });

    const estimatedTokens = body.content.length / CHARS_PER_TOKEN_ESTIMATE;
    const estimatedNeurons = (estimatedTokens / 1_000_000) * NEURONS_PER_MILLION_TOKENS;

    expect(estimatedNeurons).toBeLessThan(5); // ~0.92 neurons at 2000 chars; 5 is a generous ceiling
  });
});
