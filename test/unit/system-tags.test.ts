import { describe, expect, it } from "vitest";
import {
  applyTagReplacement,
  CAPSULE_SLOT_TAG_PREFIX,
  CAPSULE_TAG_PREFIX,
  isWorkerOwnedTag,
  PROJECT_SLUG_RE,
  PROJECT_TAG_PREFIX,
  projectTagError,
} from "../../src/tags/system";
import {
  CONFIDENCE_SOURCE_TAG_PREFIX,
  CONFIDENCE_TAG_PREFIX,
  COUNTERPARTY_TAG_PREFIX,
  LEDGER_TAG,
  LEDGER_TAG_PREFIX,
  OUTCOME_TAG_PREFIX,
  OWED_TO_ME_TAG,
  REVIEW_REARMS_TAG_PREFIX,
  STANDING_TAG,
  STANDING_TAG_PREFIX,
  T7_TAG_PREFIXES,
} from "../../src/tags/t7";

// Codex review, T-0102 A: isWorkerOwnedTag now recognizes T7 prefixes by their exact written
// format, not by prefix alone, so a generic `${prefix}sample` probe no longer matches. One
// realistic value per prefix, in the format the system actually writes.
const T7_REALISTIC_VALUES: Record<string, string> = {
  [STANDING_TAG_PREFIX]: STANDING_TAG,
  [LEDGER_TAG_PREFIX]: LEDGER_TAG,
  [CONFIDENCE_TAG_PREFIX]: "confidence:0.70",
  [CONFIDENCE_SOURCE_TAG_PREFIX]: "confidence-source:stated",
  [OUTCOME_TAG_PREFIX]: "outcome:right",
  [REVIEW_REARMS_TAG_PREFIX]: "review-rearms:1",
  [COUNTERPARTY_TAG_PREFIX]: `${COUNTERPARTY_TAG_PREFIX}priya`,
};

describe("Prompt Capsule system tags", () => {
  it("reserves capsule namespaces case-insensitively", () => {
    expect(isWorkerOwnedTag(`${CAPSULE_TAG_PREFIX}core`)).toBe(true);
    expect(isWorkerOwnedTag("Capsule:Project:p-123")).toBe(true);
    expect(isWorkerOwnedTag(`${CAPSULE_SLOT_TAG_PREFIX}constraints`)).toBe(true);
    expect(isWorkerOwnedTag("CAPSULE-SLOT:CURRENT-STATE")).toBe(true);
  });

  it("preserves capsule definitions when user-editable tags are replaced", () => {
    expect(applyTagReplacement([
      "capsule:project:p-123",
      "capsule-slot:current-state",
      "status:canonical",
      "old-topic",
    ], ["new-topic"])).toEqual([
      "capsule:project:p-123",
      "capsule-slot:current-state",
      "status:canonical",
      "new-topic",
    ]);
  });

  it("drops the old capsule tags when a replacement re-slots the entry", () => {
    expect(applyTagReplacement([
      "capsule:core",
      "capsule-slot:identity",
      "status:canonical",
      "kind:semantic",
      "old-topic",
    ], ["Capsule:Core", "capsule-slot:preferences", "new-topic"])).toEqual([
      "status:canonical",
      "kind:semantic",
      "Capsule:Core",
      "capsule-slot:preferences",
      "new-topic",
    ]);
  });

  it("drops both capsule namespaces when the replacement names only one of them", () => {
    expect(applyTagReplacement([
      "capsule:core",
      "capsule-slot:identity",
      "status:canonical",
    ], [" capsule:project:p-1 "])).toEqual([
      "status:canonical",
      "capsule:project:p-1",
    ]);
  });

  it("keeps the capsule tags when the replacement names none", () => {
    expect(applyTagReplacement([
      "capsule:core",
      "capsule-slot:identity",
      "status:canonical",
    ], ["new-topic"])).toEqual([
      "capsule:core",
      "capsule-slot:identity",
      "status:canonical",
      "new-topic",
    ]);
  });
});

describe("project tag namespace", () => {
  it("exports the prefix and the shared slug grammar", () => {
    expect(PROJECT_TAG_PREFIX).toBe("project:");
    expect(PROJECT_SLUG_RE.source).toBe("^[a-z0-9][a-z0-9_-]{0,63}$");
    for (const ok of ["a", "my-app", "app_2", "0day", "a".repeat(64)]) expect(PROJECT_SLUG_RE.test(ok), ok).toBe(true);
    for (const bad of ["", "-x", "_x", "My-App", "has space", "a".repeat(65), "x!"]) expect(PROJECT_SLUG_RE.test(bad), bad).toBe(false);
  });

  it("accepts valid project tags and ignores every other tag", () => {
    expect(projectTagError(["project:my-app", "work", "kind:semantic", "project"])).toBeNull();
    expect(projectTagError([])).toBeNull();
  });

  it("rejects a malformed slug with the exact contract string", () => {
    expect(projectTagError(["work", "project:Bad Slug!"]))
      .toBe('invalid project tag "Bad Slug!": must match [a-z0-9][a-z0-9_-]{0,63}');
    expect(projectTagError(["project:"])).toBe('invalid project tag "": must match [a-z0-9][a-z0-9_-]{0,63}');
    expect(projectTagError([`project:${"a".repeat(65)}`])).toContain("must match [a-z0-9][a-z0-9_-]{0,63}");
  });

  it("matches the prefix case-insensitively and trims, as capture does", () => {
    expect(projectTagError(["PROJECT:Bad!"])).toBe('invalid project tag "Bad!": must match [a-z0-9][a-z0-9_-]{0,63}');
    expect(projectTagError([" project:ok "])).toBeNull();
  });

  it("is not worker-owned: replacement drops it unless the caller resends it", () => {
    expect(isWorkerOwnedTag("project:website")).toBe(false);
    expect(applyTagReplacement(["project:website", "kind:semantic", "old"], ["new"])).toEqual(["kind:semantic", "new"]);
    expect(applyTagReplacement(["project:website"], ["project:other"])).toEqual(["project:other"]);
  });
});

// Track 7 (standing memory, decision ledger, commitments): the namespaces are
// worker-owned so they survive applyTagReplacement, but the bare words
// "decision" and "standing" stay ordinary user tags (P7.2).
describe("Track 7 reserved tag namespaces", () => {
  it("reserves every T7 prefix, case-insensitively, for the format the system actually writes", () => {
    for (const prefix of T7_TAG_PREFIXES) {
      const value = T7_REALISTIC_VALUES[prefix];
      expect(value, `no realistic sample registered for ${prefix}`).toBeDefined();
      expect(isWorkerOwnedTag(value), value).toBe(true);
      expect(isWorkerOwnedTag(value.toUpperCase()), value).toBe(true);
    }
  });

  it("does not reserve a value that merely shares a T7 prefix but isn't the system's own format", () => {
    // Codex review, T-0102 A: precision fix -- counterparty: accepts any grammar-valid slug by
    // design, so it is exempt from this negative case.
    for (const prefix of T7_TAG_PREFIXES) {
      if (prefix === COUNTERPARTY_TAG_PREFIX) continue;
      expect(isWorkerOwnedTag(`${prefix}sample`), prefix).toBe(false);
    }
  });

  it("reserves the bare owed-to-me marker", () => {
    expect(isWorkerOwnedTag(OWED_TO_ME_TAG)).toBe(true);
    expect(isWorkerOwnedTag("OWED-TO-ME")).toBe(true);
  });

  it("an ordinary user tag named decision or standing is not reserved", () => {
    expect(isWorkerOwnedTag("decision")).toBe(false);
    expect(isWorkerOwnedTag("standing")).toBe(false);
  });

  it("applyTagReplacement keeps standing:active and ledger:decision through a replacement", () => {
    expect(applyTagReplacement([STANDING_TAG, LEDGER_TAG, "old-topic"], ["new-topic"]))
      .toEqual([STANDING_TAG, LEDGER_TAG, "new-topic"]);
  });

  it("a caller-supplied counterparty: tag cannot be injected through a replacement", () => {
    // Fixed after the Codex cross-vendor review (T-0102): applyTagReplacement
    // now drops any tag in a namespace this contract reserved from the
    // replacement list, via stripNewReservedTags (src/tags/system.ts). See
    // test/unit/reserved-tags-write-guard.test.ts for the structural guard
    // across every caller write path.
    expect(applyTagReplacement(["old"], [`${COUNTERPARTY_TAG_PREFIX}priya`])).toEqual([]);
  });
});
