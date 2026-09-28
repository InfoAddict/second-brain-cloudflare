import type { CorpusSpec } from "./types";
import { SEED } from "./synthetic-common";
import { injection } from "./synthetic-injection";
import { noise } from "./synthetic-noise";
import { standing } from "./synthetic-standing";
import { temporal } from "./synthetic-temporal";

export const SYNTHETIC_CORPORA = ["temporal", "noise", "injection", "standing"] as const;
export type SyntheticId = (typeof SYNTHETIC_CORPORA)[number];

export function buildSyntheticCorpus(id: SyntheticId, seed = SEED): CorpusSpec {
  switch (id) {
    case "temporal": return temporal(seed);
    case "noise": return noise(seed);
    case "injection": return injection(seed);
    case "standing": return standing(seed);
  }
}
