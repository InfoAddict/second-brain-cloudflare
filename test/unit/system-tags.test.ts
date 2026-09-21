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
