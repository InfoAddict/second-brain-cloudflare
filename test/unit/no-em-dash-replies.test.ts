/**
 * CP-1 (T-0101.10): agent-facing replies read like a person wrote them, so an
 * em dash reaching a live MCP reply or a REST error string fails the build
 * immediately rather than waiting for a screenshot review to catch it - this
 * guard is what let the copy pass sweep src/mcp/server.ts's replies with
 * confidence that nothing was missed.
 *
 * Scoped to the two surfaces the copy deck names: every `text:` MCP reply in
 * src/mcp/server.ts, and every `error:`/`message:` string in src/routes/*.ts.
 * Tool descriptions, comments and unrelated fields are out of scope.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const EM_DASH = "—";

/** Literal string/template values assigned to one of `fieldNames`, e.g. `text: \`...\`` */
function literalsFor(src: string, fieldNames: string[]): string[] {
  const pattern = new RegExp(
    `\\b(?:${fieldNames.join("|")}):\\s*(\`(?:[^\`\\\\]|\\\\.)*\`|"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`,
    "g",
  );
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(src))) out.push(m[1]);
  return out;
}

describe("no em dash in MCP replies or REST error strings (CP-1)", () => {
  it("src/mcp/server.ts: every text: reply is dash-free", () => {
    const src = readFileSync(resolve(ROOT, "src/mcp/server.ts"), "utf8");
    const offenders = literalsFor(src, ["text"]).filter((s) => s.includes(EM_DASH));
    expect(offenders).toEqual([]);
  });

  it("src/routes/*.ts: every error: and message: string is dash-free", () => {
    const dir = resolve(ROOT, "src/routes");
    const offenders: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts")) continue;
      const src = readFileSync(resolve(dir, file), "utf8");
      for (const literal of literalsFor(src, ["error", "message"])) {
        if (literal.includes(EM_DASH)) offenders.push(`${file}: ${literal}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
