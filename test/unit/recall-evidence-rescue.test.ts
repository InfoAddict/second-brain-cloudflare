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

  // T-0057.7: a 3-word boilerplate row ("<topic> overview.") that the dense arm never
  // returned used to take this slot off two generic query words, evicting a 0.95-dense
  // authoritative answer whose own coverage was near zero.
  it("refuses a keyword-only root that covers a minority of the query", () => {
    expect(chooseEvidenceSlot(0.014, [candidate("boilerplate", 0.18, { lexicalOnly: true })])).toBeUndefined();
    expect(chooseEvidenceSlot(0.014, [candidate("boilerplate", 0.49, { lexicalOnly: true })])).toBeUndefined();
  });

  it("admits a keyword-only root that carries most of the query", () => {
    expect(chooseEvidenceSlot(0.014, [candidate("decisive", 0.5, { lexicalOnly: true })])?.id).toBe("decisive");
  });

  it("holds a root the dense arm ranked to the relative test alone", () => {
    expect(chooseEvidenceSlot(0.014, [candidate("ranked", 0.18, { semanticRank: 9 })])?.id).toBe("ranked");
  });

  // A linked candidate cleared scoreLinkedEvidence's coverage, precision and gain floors
  // before it got here; the keyword-only floor stands in for a gate it already passed.
  it("leaves graph-linked evidence to its own upstream floors", () => {
    expect(chooseEvidenceSlot(0.014, [candidate("linked", 0.18, { source: "related" })])?.id).toBe("linked");
  });

  it("does not let a keyword-only root reach the semantic branch", () => {
    expect(chooseEvidenceSlot({ coverage: 0.6, semanticRank: 8 }, [candidate("keywordOnly", 0.1, {
      exactMatchCount: 0,
      semanticEligible: true,
      lexicalOnly: true,
    })])).toBeUndefined();
  });

  it("breaks complete ties deterministically by ID", () => {
    expect(chooseEvidenceSlot(0.2, [
      candidate("zeta", 0.8),
      candidate("alpha", 0.8),
    ])?.id).toBe("alpha");
  });
});
