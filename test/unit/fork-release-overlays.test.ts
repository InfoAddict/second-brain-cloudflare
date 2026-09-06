import { describe, expect, it } from "vitest";
import { applyForkOverlayText } from "../../scripts/apply-fork-release-overlays.mjs";

describe("fork release overlays", () => {
  it("corrects the ChatGPT response tag and is idempotent", () => {
    const source = "Tags: personal, work, claude-response + topic. Source: chatgpt.\n";
    const once = applyForkOverlayText("AI_Instructions/CHATGPT_INSTRUCTIONS.md", source);
    expect(once).toContain("chatgpt-response");
    expect(once).not.toContain("claude-response");
    expect(applyForkOverlayText("AI_Instructions/CHATGPT_INSTRUCTIONS.md", once)).toBe(once);
  });

  it("inserts the deep-link module immediately after auth", () => {
    const source = [
      '<script src="js/auth.js"></script>',
      '<script src="js/app.js"></script>',
    ].map((line) => `    ${line}`).join("\n");
    const result = applyForkOverlayText("public/index.html", source);
    expect(result).toContain(
      '<script src="js/auth.js"></script>\n    <script src="js/dashboard-entry-deep-link.js"></script>',
    );
    expect(applyForkOverlayText("public/index.html", result)).toBe(result);
  });

  it("keeps dashboard documentation aligned with the inserted module", () => {
    const source = [
      "| Shell | `js/auth.js`, `js/download-app.js` | feature |",
      "auth.js → download-app.js",
      "| Auth connect / showApp | `js/auth.js` |",
    ].join("\n");
    const result = applyForkOverlayText("docs/dashboard-architecture.md", source);
    expect(result.match(/dashboard-entry-deep-link\.js/g)).toHaveLength(3);
    expect(applyForkOverlayText("docs/dashboard-architecture.md", result)).toBe(result);
  });

  it("registers ChatGPT responses as assistant axis tags", () => {
    const source = [
      "export const AXIS_TAGS = new Set([",
      '  "codex-response", "cursor-response",',
      "]);",
    ].join("\n");
    const result = applyForkOverlayText("src/insight/eligibility.ts", source);
    expect(result).toContain('"cursor-response", "chatgpt-response",');
    expect(applyForkOverlayText("src/insight/eligibility.ts", result)).toBe(result);
  });

  it("fails closed when an upstream anchor changes unexpectedly", () => {
    expect(() => applyForkOverlayText(
      "AI_Instructions/CHATGPT_INSTRUCTIONS.md",
      "No tag line remains here.\n",
    )).toThrow("exactly one ChatGPT tag line");
  });
});
