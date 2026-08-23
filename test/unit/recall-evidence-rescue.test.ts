import { describe, expect, it } from "vitest";
import {
  chooseEvidenceSlot,
  type EvidenceSlotCandidate,
} from "../../src/recall/evidence-rescue";

const candidate = (
  id: string,
  coverage: number,
  overrides: Partial<EvidenceSlotCandidate> = {},
): EvidenceSlotCandidate => ({
  id,
  coverage,
  exactHighIdf: false,
  exactMatchCount: 2,
  metadataAlignment: 0,
  score: 0,
  source: "omitted-root",
  ...overrides,
});

describe("brain-agnostic evidence slot", () => {
  it("selects at most one candidate with stronger relative evidence", () => {
    expect(chooseEvidenceSlot(0.4, [
      candidate("quartz", 0.7),
      candidate("ledger", 0.6),
    ])?.id).toBe("quartz");
  });

  it("requires a strict coverage gain over the displaced result", () => {
    expect(chooseEvidenceSlot(0.7, [candidate("equal", 0.7)])).toBeUndefined();
    expect(chooseEvidenceSlot(0.7, [candidate("weaker", 0.69)])).toBeUndefined();
  });

  it("rejects a common single-token coincidence", () => {
    expect(chooseEvidenceSlot(0.1, [candidate("common", 0.9, {
      exactMatchCount: 1,
      exactHighIdf: false,
    })])).toBeUndefined();
  });

  it("allows a single exact match only when corpus rarity proves precision", () => {
    expect(chooseEvidenceSlot(0.1, [candidate("rare", 0.9, {
      exactMatchCount: 1,
      exactHighIdf: true,
    })])?.id).toBe("rare");
  });

  it("allows a semantically selected root that outranks the displaced result", () => {
    expect(chooseEvidenceSlot({ coverage: 0.6, semanticRank: 8 }, [candidate("paraphrase", 0, {
      exactMatchCount: 0,
      semanticEligible: true,
      semanticRank: 3,
    })])?.id).toBe("paraphrase");
  });

  it("rejects semantic evidence that is weaker or was not independently selected", () => {
    expect(chooseEvidenceSlot({ coverage: 0.6, semanticRank: 3 }, [candidate("weaker", 0, {
      exactMatchCount: 0,
      semanticEligible: true,
      semanticRank: 4,
    })])).toBeUndefined();
    expect(chooseEvidenceSlot({ coverage: 0.6, semanticRank: 8 }, [candidate("unselected", 0, {
      exactMatchCount: 0,
      semanticRank: 2,
    })])).toBeUndefined();
  });

  it("does not use semantic rescue to displace an accepted graph result", () => {
    expect(chooseEvidenceSlot({ coverage: 0.2, semanticAllowed: false }, [candidate("paraphrase", 0, {
      exactMatchCount: 0,
      semanticEligible: true,
      semanticRank: 1,
    })])).toBeUndefined();
  });

  it("lets stronger graph evidence keep the shared slot", () => {
    expect(chooseEvidenceSlot(0.2, [
      candidate("root", 0.7),
      candidate("linked", 0.8, { source: "related" }),
    ])?.id).toBe("linked");
  });

  it("breaks complete ties deterministically by ID", () => {
    expect(chooseEvidenceSlot(0.2, [
      candidate("zeta", 0.8),
      candidate("alpha", 0.8),
    ])?.id).toBe("alpha");
  });
});
