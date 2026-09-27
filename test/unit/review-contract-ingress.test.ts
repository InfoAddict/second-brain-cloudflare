import { describe, expect, it } from "vitest";
import { normalizeCaptureInput } from "../../src/capture/entry";
import { applyTagReplacement } from "../../src/tags/system";

describe("reserved tag ingress", () => {
  it("rejects caller-supplied trust and Track 7 tags at capture normalization", () => {
    const tags = ["quarantine:instruction", "edited-canonical:2026-09-27", "standing:active", "owed-to-me", "work"];
    expect(normalizeCaptureInput("A note", tags).tags).toEqual(["work"]);
  });

  it("rejects caller-supplied trust and Track 7 tags in update replacement", () => {
    const tags = ["quarantine:instruction", "edited-canonical:2026-09-27", "standing:active", "owed-to-me", "work"];
    expect(applyTagReplacement([], tags)).toEqual(["work"]);
  });

  it("does not lock a forged quarantine tag onto later edits", () => {
    const original = normalizeCaptureInput("A note", ["quarantine:instruction"]).tags;
    expect(applyTagReplacement(original, ["work"])).toEqual(["work"]);
  });
});
