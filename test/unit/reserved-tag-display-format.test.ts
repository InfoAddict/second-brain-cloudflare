/**
 * Codex cross-vendor review, MINOR (T-0102): a pre-existing user tag that
 * merely looks like a namespace this contract reserved (a genuine
 * `outcome:won` or `confidence:high` tagged before 4.0) must not vanish from
 * the dashboard. isRecognizedReservedTagFormat (src/tags/system.ts) is
 * stricter than the write-time guard on purpose: it checks the VALUE against
 * the system's own format, not just the prefix. public/utils.js mirrors it
 * in plain JS (isRecognizedNewReservedValue) since it cannot import
 * TypeScript; this file cross-checks the two against one table so they
 * cannot silently drift, the same pattern as reserved-tags-parity.test.ts.
 *
 * Stored data is never rewritten by either side -- this changes only what
 * the dashboard hides as a system chip versus shows as an ordinary tag.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { installI18n } from "../ui/_i18n-harness";
import { isRecognizedReservedTagFormat } from "../../src/tags/system";

const ROOT = resolve(import.meta.dirname, "../..");

function loadUtils(): any {
  const ctx: any = { console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  vm.runInContext(readFileSync(resolve(ROOT, "public/utils.js"), "utf8"), ctx);
  return ctx;
}

// [tag, recognized as the system's own value]
const CASES: [string, boolean][] = [
  // Real system values: recognized.
  ["quarantine:instruction", true],
  ["quarantine:hidden", true],
  ["quarantine:burst", true],
  ["quarantine:capsule", true],
  ["edited-canonical:2026-09-26", true],
  ["edited-canonical:2026-01-01", true],
  ["standing:active", true],
  ["ledger:decision", true],
  ["confidence:0.05", true],
  ["confidence:0.50", true],
  ["confidence:0.95", true],
  ["confidence-source:stated", true],
  ["confidence-source:inferred", true],
  ["outcome:right", true],
  ["outcome:wrong", true],
  ["outcome:mixed", true],
  ["outcome:unknown", true],
  ["review-rearms:1", true],
  ["review-rearms:2", true],
  ["counterparty:priya", true],
  ["counterparty:acme-corp", true],
  // Case-insensitive.
  ["Quarantine:Instruction", true],
  ["STANDING:ACTIVE", true],
  // Pre-existing user tags that merely look reserved: NOT recognized.
  ["quarantine:sample", false],
  ["quarantine:maybe", false],
  ["edited-canonical:not-a-date", false],
  ["edited-canonical:2026-9-6", false],
  ["standing:done", false],
  ["ledger:won", false],
  ["confidence:high", false],
  ["confidence:0.07", false],
  ["confidence:1.00", false],
  ["confidence-source:guessed", false],
  ["outcome:won", false],
  ["outcome:lost", false],
  ["review-rearms:3", false],
  ["review-rearms:many", false],
  ["counterparty:", false],
  ["counterparty:Has Space", false],
  // Not a reserved prefix at all.
  ["work", false],
  ["idea", false],
];

describe("isRecognizedReservedTagFormat (TS)", () => {
  for (const [tag, expected] of CASES) {
    it(`${tag} -> ${expected}`, () => {
      expect(isRecognizedReservedTagFormat(tag)).toBe(expected);
    });
  }
});

describe("public/utils.js mirrors the same table", () => {
  const { isSystemTag } = loadUtils();
  for (const [tag, expected] of CASES) {
    it(`isSystemTag(${tag}) -> ${expected}`, () => {
      expect(isSystemTag(tag)).toBe(expected);
    });
  }
});
