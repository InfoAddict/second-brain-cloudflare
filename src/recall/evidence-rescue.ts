export type EvidenceSlotSource = "omitted-root" | "related";

export interface EvidenceSlotCandidate {
  id: string;
  coverage: number;
  exactHighIdf: boolean;
  exactMatchCount: number;
  metadataAlignment: number;
  score: number;
  source: EvidenceSlotSource;
  semanticRank?: number;
  semanticEligible?: boolean;
}

export interface EvidenceSlotBaseline {
  coverage: number;
  semanticRank?: number;
  semanticAllowed?: boolean;
}

const compareEvidence = (a: EvidenceSlotCandidate, b: EvidenceSlotCandidate) =>
  b.coverage - a.coverage
  || Number(b.exactHighIdf) - Number(a.exactHighIdf)
  || b.exactMatchCount - a.exactMatchCount
  || b.metadataAlignment - a.metadataAlignment
  || b.score - a.score
  || a.id.localeCompare(b.id);

/**
 * Chooses one final-slot candidate using only evidence already computed during
 * the current recall. The gate is deliberately relative to the result it would
 * displace, so it is independent of any brain's score distribution.
 */
export function chooseEvidenceSlot(
  replacement: number | EvidenceSlotBaseline,
  candidates: readonly EvidenceSlotCandidate[],
): EvidenceSlotCandidate | undefined {
  const baseline = typeof replacement === "number" ? { coverage: replacement } : replacement;
  return candidates
    .filter(candidate => {
      const lexicalGain = candidate.coverage > baseline.coverage
        && (candidate.exactHighIdf || candidate.exactMatchCount >= 2);
      const semanticGain = candidate.source === "omitted-root"
        && baseline.semanticAllowed !== false
        && candidate.semanticEligible === true
        && candidate.semanticRank !== undefined
        && (baseline.semanticRank === undefined || candidate.semanticRank < baseline.semanticRank);
      return lexicalGain || semanticGain;
    })
    .slice()
    .sort(compareEvidence)[0];
}
