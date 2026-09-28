/**
 * Track 4 (self-protecting) contract commit: the quarantine tag namespace,
 * the canonical-edit label, and the config keys both tracks ship "off"
 * (16-t3-t4-trust-spec.md Task 0). Nothing here is wired into a write path
 * yet -- this pins the pure helpers' own contract so Track 4's later tasks
 * build on constants that already behave exactly as designed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { installI18n } from "../ui/_i18n-harness";
import { applyTagReplacement, isWorkerOwnedTag } from "../../src/tags/system";
import { isReservedTag, isTopicTag } from "../../src/compression/eligibility";
import { getStatus } from "../../src/memory/status";
import {
  EDITED_CANONICAL_TAG_PREFIX,
  NOT_HELD_SQL,
  QUARANTINE_TAG_PREFIX,
  editedCanonicalAt,
  heldReason,
  isHeld,
  withEditedCanonical,
  withHold,
} from "../../src/quarantine/tags";
import { DEFAULTS, RULES } from "../../src/config";

const ROOT = resolve(import.meta.dirname, "../..");

describe("isWorkerOwnedTag protects quarantine:* and edited-canonical:*", () => {
  it("is true for both namespaces, case-insensitively", () => {
    expect(isWorkerOwnedTag(`${QUARANTINE_TAG_PREFIX}instruction`)).toBe(true);
    expect(isWorkerOwnedTag("QUARANTINE:BURST")).toBe(true);
    expect(isWorkerOwnedTag(`${EDITED_CANONICAL_TAG_PREFIX}2026-09-26`)).toBe(true);
    expect(isWorkerOwnedTag("Edited-Canonical:2026-09-26")).toBe(true);
  });
});

describe("applyTagReplacement keeps a quarantine tag an update tries to drop", () => {
  it("survives a replacement that omits it", () => {
    const existing = [`${QUARANTINE_TAG_PREFIX}hidden`, "status:draft", "old-topic"];
    expect(applyTagReplacement(existing, ["new-topic"])).toEqual([`${QUARANTINE_TAG_PREFIX}hidden`, "status:draft", "new-topic"]);
  });
});

describe("neither prefix is a topic tag for digests", () => {
  it("isReservedTag and isTopicTag agree", () => {
    for (const tag of [`${QUARANTINE_TAG_PREFIX}instruction`, `${EDITED_CANONICAL_TAG_PREFIX}2026-09-26`]) {
      expect(isReservedTag(tag), tag).toBe(true);
      expect(isTopicTag(tag), tag).toBe(false);
    }
  });
});

describe("public/utils.js hides both prefixes", () => {
  function loadUtils(): any {
    const ctx: any = { console };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    installI18n(ctx, "en");
    vm.runInContext(readFileSync(resolve(ROOT, "public/utils.js"), "utf8"), ctx);
    return ctx;
  }

  it("isSystemTag is true for both", () => {
    const { isSystemTag } = loadUtils();
    expect(isSystemTag(`${QUARANTINE_TAG_PREFIX}instruction`)).toBe(true);
    expect(isSystemTag(`${EDITED_CANONICAL_TAG_PREFIX}2026-09-26`)).toBe(true);
  });
});

describe("NOT_HELD_SQL contains no LIKE wildcard other than the outer %", () => {
  it("matches the exact literal", () => {
    expect(NOT_HELD_SQL).toBe(`tags NOT LIKE '%"${QUARANTINE_TAG_PREFIX}%'`);
  });

  it("carries no underscore or bound placeholder", () => {
    expect(NOT_HELD_SQL).not.toContain("_");
    expect(NOT_HELD_SQL).not.toContain("?");
  });

  it("carries exactly two percent signs, the leading and trailing wildcards", () => {
    expect(NOT_HELD_SQL.match(/%/g)?.length).toBe(2);
  });
});

describe("isHeld / heldReason / withHold", () => {
  it("isHeld is false with no quarantine tag and true with one", () => {
    expect(isHeld(["work", "status:canonical"])).toBe(false);
    expect(isHeld(["work", `${QUARANTINE_TAG_PREFIX}instruction`])).toBe(true);
  });

  it("heldReason reads the recognized reason and is null otherwise", () => {
    expect(heldReason([`${QUARANTINE_TAG_PREFIX}instruction`])).toBe("instruction");
    expect(heldReason([`${QUARANTINE_TAG_PREFIX}hidden`])).toBe("hidden");
    expect(heldReason([`${QUARANTINE_TAG_PREFIX}burst`])).toBe("burst");
    expect(heldReason([`${QUARANTINE_TAG_PREFIX}capsule`])).toBe("capsule");
    expect(heldReason([`${QUARANTINE_TAG_PREFIX}too_long`])).toBe("too_long");
    expect(heldReason([`${QUARANTINE_TAG_PREFIX}bogus`])).toBeNull();
    expect(heldReason(["work"])).toBeNull();
  });

  it("withHold adds the hold tag and sets status:draft, replacing any earlier hold", () => {
    const next = withHold(["work", `${QUARANTINE_TAG_PREFIX}hidden`, "status:canonical"], "instruction");
    expect(next).toContain(`${QUARANTINE_TAG_PREFIX}instruction`);
    expect(next).not.toContain(`${QUARANTINE_TAG_PREFIX}hidden`);
    expect(getStatus(next)).toBe("draft");
    expect(next).toContain("work");
  });
});

describe("editedCanonicalAt and withEditedCanonical round-trip and replace an older label", () => {
  it("round-trips a fresh label", () => {
    const now = Date.UTC(2026, 8, 26, 12, 0, 0); // 2026-09-26
    const tags = withEditedCanonical(["work"], now);
    expect(editedCanonicalAt(tags)).toBe("2026-09-26");
  });

  it("replaces an older label rather than accumulating one", () => {
    const first = withEditedCanonical(["work"], Date.UTC(2026, 8, 1));
    const second = withEditedCanonical(first, Date.UTC(2026, 8, 26));
    expect(second.filter(t => t.startsWith(EDITED_CANONICAL_TAG_PREFIX))).toEqual([`${EDITED_CANONICAL_TAG_PREFIX}2026-09-26`]);
  });

  it("returns null when the row carries no label", () => {
    expect(editedCanonicalAt(["work", "status:canonical"])).toBeNull();
  });
});

describe("every new config key has a RULES entry, and the defaults are the off values", () => {
  const KEYS = [
    "SOURCE_WEIGHT_MIRROR",
    "SOURCE_WEIGHT_TRANSCRIPT",
    "SOURCE_WEIGHT_SYSTEM",
    "MIRROR_MAX_SHARE",
    "NOTICE_COLLAPSE",
    "QUARANTINE_THRESHOLD",
    "QUARANTINE_WRITE_BURST",
    "QUARANTINE_STATUS_BURST",
  ] as const;

  it("every key is declared with a rule", () => {
    for (const key of KEYS) expect(RULES, key).toHaveProperty(key);
  });

  it("the Track 3 weights and cap default to neutral (1.0, no-op)", () => {
    expect(DEFAULTS.SOURCE_WEIGHT_MIRROR).toBe(1.0);
    expect(DEFAULTS.SOURCE_WEIGHT_TRANSCRIPT).toBe(1.0);
    expect(DEFAULTS.SOURCE_WEIGHT_SYSTEM).toBe(1.0);
    expect(DEFAULTS.MIRROR_MAX_SHARE).toBe(1.0);
  });

  it("the near-duplicate collapse defaults to off", () => {
    expect(DEFAULTS.NOTICE_COLLAPSE).toBe("off");
  });

  it("every default satisfies its own rule", () => {
    for (const key of KEYS) {
      const rule = RULES[key];
      const value = DEFAULTS[key] as number | string;
      if (rule.kind === "string") {
        expect(typeof value, key).toBe("string");
      } else {
        expect(typeof value, key).toBe("number");
        expect(value as number, key).toBeGreaterThanOrEqual(rule.min);
        expect(value as number, key).toBeLessThanOrEqual(rule.max);
      }
    }
  });
});
