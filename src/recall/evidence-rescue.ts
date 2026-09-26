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
  /** An omitted root the dense arm never returned: it is in the root pool on keyword evidence alone. */
  lexicalOnly?: boolean;
}

export interface EvidenceSlotBaseline {
  coverage: number;
  semanticRank?: number;
  semanticAllowed?: boolean;
}

/**
 * How much of the query's weighted evidence a keyword-only root has to carry
 * before it may displace a ranked result.
 *
 * A "related" candidate reaches this slot through scoreLinkedEvidence, which
 * already applies a coverage floor, a precision gate and a gain margin. An
 * omitted root that the dense arm never returned has passed no such gate: it is
 * here purely because the keyword arm matched it, and the lexical test below is
 * relative to the row it would displace, which routinely covers nothing at all.
 * That lets a boilerplate row ("<topic> overview.") whose only merit is two
 * generic query words evict a strong dense answer from the last slot.
 *
 * Half the evidence weight is the bar: a majority of what the query asked for,
 * not a word or two. Candidates the dense arm did rank are unaffected — their
 * standing in the other arm is the evidence this floor stands in for.
 */
const MIN_LEXICAL_ONLY_COVERAGE = 0.5;

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
        && (candidate.exactHighIdf || candidate.exactMatchCount >= 2)
        && (!candidate.lexicalOnly || candidate.coverage >= MIN_LEXICAL_ONLY_COVERAGE);
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
