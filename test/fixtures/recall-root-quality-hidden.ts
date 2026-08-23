import type {
  CandidateFixture,
  EdgeFixture,
  RootQualityCase,
  RootQualityDomain,
} from "./recall-root-quality";

export const HIDDEN_VALIDATION_SERIALIZATION = "UTF-8 JSON.stringify insertion-order v1";
export const HIDDEN_VALIDATION_SHA256 = "319c2553d379d2bf215f97ae89018e01658de15f8ddaceb21feda38f67ee9462";

type HiddenShape = RootQualityCase["failureShape"];

interface HiddenGeometry {
  readonly total: number;
  readonly raw: number;
  readonly dense: number;
  readonly keyword: number;
  readonly rootDenseRank: number | null;
  readonly rootKeywordRank?: number;
  readonly scores: readonly number[];
  readonly recall: readonly number[];
}

type HiddenTopologyRow = readonly [
  string,
  string,
  EdgeFixture["type"],
  number,
  EdgeFixture["provenance"],
];

interface HiddenCaseManifest {
  readonly id: string;
  readonly domain: RootQualityDomain;
  readonly shape: HiddenShape;
  readonly available: boolean;
  readonly intent: RootQualityCase["intent"];
  readonly query: string;
  readonly authority: readonly string[];
  readonly roots: readonly string[];
  readonly answer: string;
  readonly local?: string;
  readonly parentPollution?: string;
  readonly weak?: readonly string[];
  readonly nouns: readonly string[];
  readonly geometry: HiddenGeometry;
  readonly topology: readonly HiddenTopologyRow[];
}

interface HiddenManifest {
  readonly version: string;
  readonly canonicalization: string;
  readonly topK: number;
  readonly invariants: readonly string[];
  readonly cases: readonly HiddenCaseManifest[];
}

/**
 * Sealed before production commit 2e49656. JSON.stringify over this object in
 * insertion order, encoded as UTF-8 with no trailing newline, is the digest input.
 */
export const HIDDEN_VALIDATION_MANIFEST = {
  "version": "second-brain-v2.4-fresh-hidden-validation-v1",
  "canonicalization": "UTF-8 JSON.stringify insertion-order v1",
  "topK": 5,
  "invariants": [
    "query-local-evidence",
    "precise-multi-token-graph-evidence",
    "abstention",
    "direct-top-four-preservation",
    "no-extra-ai-or-vectorize-calls"
  ],
  "cases": [
    {
      "id": "fh-personal-crowded-kestrel",
      "domain": "personal",
      "shape": "crowded-lexical-root",
      "available": true,
      "intent": "causal",
      "query": "why was the kestrel rehearsal pickup reassigned",
      "authority": [
        "fh-personal-kestrel-authority-7c1"
      ],
      "roots": [
        "fh-personal-kestrel-root-a2e"
      ],
      "answer": "The kestrel rehearsal pickup was reassigned because the accompanist changed the load-in window.",
      "local": "kestrel rehearsal pickup reassigned",
      "nouns": [
        "kestrel",
        "rehearsal",
        "pickup",
        "accompanist",
        "load-in"
      ],
      "geometry": {
        "total": 23,
        "raw": 20,
        "dense": 11,
        "keyword": 9,
        "rootDenseRank": 11,
        "scores": [
          0.998,
          0.976,
          0.951,
          0.927,
          0.889,
          0.857,
          0.824,
          0.788,
          0.749,
          0.701,
          0.643
        ],
        "recall": [
          0,
          2,
          17,
          0,
          41
        ]
      },
      "topology": [
        [
          "root",
          "authority",
          "caused_by",
          0.67,
          "explicit"
        ],
        [
          "root",
          "decoy-a",
          "drawn_from",
          0.93,
          "system"
        ],
        [
          "decoy-b",
          "root",
          "relates_to",
          0.38,
          "inferred"
        ]
      ]
    },
    {
      "id": "fh-architecture-crowded-sundial",
      "domain": "architecture",
      "shape": "crowded-lexical-root",
      "available": true,
      "intent": "chronology",
      "query": "what followed the sundial lease epoch rollover",
      "authority": [
        "fh-architecture-sundial-authority-91b"
      ],
      "roots": [
        "fh-architecture-sundial-root-d44"
      ],
      "answer": "The sundial lease epoch rollover was followed by fencing stale writers before reconciliation.",
      "local": "sundial lease epoch rollover",
      "nouns": [
        "sundial",
        "lease",
        "epoch",
        "rollover",
        "fencing",
        "reconciliation"
      ],
      "geometry": {
        "total": 19,
        "raw": 16,
        "dense": 9,
        "keyword": 7,
        "rootDenseRank": 8,
        "scores": [
          0.991,
          0.963,
          0.934,
          0.906,
          0.861,
          0.816,
          0.774,
          0.719,
          0.668
        ],
        "recall": [
          5,
          0,
          29,
          1
        ]
      },
      "topology": [
        [
          "authority",
          "root",
          "follows",
          0.58,
          "inferred"
        ],
        [
          "root",
          "decoy-a",
          "part_of_project",
          0.91,
          "explicit"
        ],
        [
          "decoy-b",
          "root",
          "relates_to",
          0.46,
          "system"
        ]
      ]
    },
    {
      "id": "fh-enterprise-popular-tamarind",
      "domain": "enterprise",
      "shape": "popular-broad-summary",
      "available": true,
      "intent": "current",
      "query": "which tarmac escalation charter is still authoritative",
      "authority": [
        "fh-enterprise-tarmac-authority-3f8"
      ],
      "roots": [
        "fh-enterprise-tarmac-root-b10"
      ],
      "answer": "The authoritative tarmac escalation charter assigns the incident commander to the regional duty lead.",
      "local": "tarmac escalation charter authoritative",
      "nouns": [
        "tarmac",
        "escalation",
        "charter",
        "incident commander",
        "regional duty lead"
      ],
      "geometry": {
        "total": 18,
        "raw": 15,
        "dense": 13,
        "keyword": 3,
        "rootDenseRank": 10,
        "scores": [
          0.996,
          0.972,
          0.944,
          0.918,
          0.887,
          0.851,
          0.812,
          0.779,
          0.741,
          0.706,
          0.673,
          0.628,
          0.592
        ],
        "recall": [
          320000,
          73,
          11,
          4,
          0
        ]
      },
      "topology": [
        [
          "root",
          "authority",
          "decided",
          0.62,
          "system"
        ],
        [
          "popular",
          "decoy-a",
          "relates_to",
          0.99,
          "inferred"
        ],
        [
          "decoy-b",
          "popular",
          "about_person",
          0.71,
          "explicit"
        ]
      ]
    },
    {
      "id": "fh-product-popular-willow",
      "domain": "product",
      "shape": "popular-broad-summary",
      "available": true,
      "intent": "current",
      "query": "what willow invitation sequence remains preferred now",
      "authority": [
        "fh-product-willow-authority-e6d"
      ],
      "roots": [
        "fh-product-willow-root-5a4"
      ],
      "answer": "The preferred willow invitation sequence sends a sandbox preview before requesting teammate invites.",
      "local": "willow invitation sequence preferred",
      "nouns": [
        "willow",
        "invitation",
        "sequence",
        "sandbox preview",
        "teammate invites"
      ],
      "geometry": {
        "total": 22,
        "raw": 19,
        "dense": 15,
        "keyword": 4,
        "rootDenseRank": 13,
        "scores": [
          0.999,
          0.981,
          0.959,
          0.936,
          0.907,
          0.881,
          0.852,
          0.826,
          0.793,
          0.761,
          0.733,
          0.702,
          0.664,
          0.631,
          0.603
        ],
        "recall": [
          9137,
          9137,
          2048,
          32,
          6,
          0
        ]
      },
      "topology": [
        [
          "authority",
          "root",
          "supersedes",
          0.74,
          "explicit"
        ],
        [
          "root",
          "decoy-a",
          "relates_to",
          0.88,
          "system"
        ],
        [
          "popular",
          "root",
          "drawn_from",
          0.43,
          "inferred"
        ]
      ]
    },
    {
      "id": "fh-personal-long-cardinal",
      "domain": "personal",
      "shape": "long-parent-pollution",
      "available": true,
      "intent": "direct",
      "query": "cardinal recital seating invoice archive",
      "authority": [
        "fh-personal-cardinal-authority-02e"
      ],
      "roots": [
        "fh-personal-cardinal-root-c73"
      ],
      "answer": "The cardinal recital seating invoice archive is filed under the north balcony reimbursement record.",
      "local": "cardinal recital seating",
      "parentPollution": "invoice archive appears only in an unrelated insurance appendix",
      "nouns": [
        "cardinal",
        "recital",
        "seating",
        "invoice",
        "archive",
        "north balcony"
      ],
      "geometry": {
        "total": 14,
        "raw": 11,
        "dense": 10,
        "keyword": 1,
        "rootDenseRank": 7,
        "scores": [
          0.994,
          0.968,
          0.939,
          0.901,
          0.864,
          0.828,
          0.791,
          0.746,
          0.694,
          0.639
        ],
        "recall": [
          0,
          8,
          3,
          0
        ]
      },
      "topology": [
        [
          "root",
          "decoy-a",
          "relates_to",
          0.97,
          "inferred"
        ],
        [
          "root",
          "authority",
          "decided",
          0.54,
          "explicit"
        ],
        [
          "decoy-b",
          "root",
          "about_person",
          0.35,
          "system"
        ]
      ]
    },
    {
      "id": "fh-architecture-long-pinion",
      "domain": "architecture",
      "shape": "long-parent-pollution",
      "available": true,
      "intent": "direct",
      "query": "pinion snapshot shard ledger seal recovery",
      "authority": [
        "fh-architecture-pinion-authority-44f"
      ],
      "roots": [
        "fh-architecture-pinion-root-8d2"
      ],
      "answer": "The pinion snapshot recovery verifies the shard ledger seal before replaying the retained segment.",
      "local": "pinion snapshot recovery",
      "parentPollution": "shard ledger seal occurs only in a remote observability appendix",
      "nouns": [
        "pinion",
        "snapshot",
        "shard",
        "ledger",
        "seal",
        "recovery",
        "retained segment"
      ],
      "geometry": {
        "total": 20,
        "raw": 16,
        "dense": 14,
        "keyword": 3,
        "rootDenseRank": 12,
        "scores": [
          0.997,
          0.974,
          0.948,
          0.923,
          0.895,
          0.866,
          0.839,
          0.807,
          0.778,
          0.751,
          0.714,
          0.681,
          0.649,
          0.618
        ],
        "recall": [
          44,
          0,
          12,
          1,
          0
        ]
      },
      "topology": [
        [
          "authority",
          "root",
          "drawn_from",
          0.79,
          "system"
        ],
        [
          "root",
          "decoy-a",
          "follows",
          0.92,
          "explicit"
        ],
        [
          "decoy-b",
          "root",
          "relates_to",
          0.31,
          "inferred"
        ],
        [
          "root",
          "decoy-c",
          "part_of_project",
          0.27,
          "system"
        ]
      ]
    },
    {
      "id": "fh-enterprise-weak-verdant",
      "domain": "enterprise",
      "shape": "weak-generic-neighbor",
      "available": true,
      "intent": "direct",
      "query": "verdant council release readiness evidence docket notes",
      "authority": [
        "fh-enterprise-verdant-direct-authority-6aa"
      ],
      "roots": [
        "fh-enterprise-verdant-root-19c"
      ],
      "answer": "The controlled direct record is the authoritative verdant release-readiness evidence.",
      "weak": [
        "readiness overview",
        "docketing archive",
        "release summary"
      ],
      "nouns": [
        "verdant",
        "council",
        "release",
        "readiness",
        "evidence",
        "docket",
        "notes"
      ],
      "geometry": {
        "total": 12,
        "raw": 9,
        "dense": 8,
        "keyword": 2,
        "rootDenseRank": 8,
        "scores": [
          0.995,
          0.966,
          0.938,
          0.907,
          0.874,
          0.832,
          0.786,
          0.721
        ],
        "recall": [
          0,
          0,
          53,
          7
        ]
      },
      "topology": [
        [
          "root",
          "weak-a",
          "relates_to",
          0.96,
          "explicit"
        ],
        [
          "weak-b",
          "root",
          "drawn_from",
          0.83,
          "system"
        ],
        [
          "root",
          "weak-c",
          "part_of_project",
          0.76,
          "inferred"
        ]
      ]
    },
    {
      "id": "fh-product-weak-canter",
      "domain": "product",
      "shape": "weak-generic-neighbor",
      "available": true,
      "intent": "direct",
      "query": "canter beta rollout review evidence register summary trace",
      "authority": [
        "fh-product-canter-direct-authority-b51"
      ],
      "roots": [
        "fh-product-canter-root-0de"
      ],
      "answer": "The controlled direct record is the authoritative canter beta-rollout evidence.",
      "weak": [
        "review overview",
        "registration digest",
        "summary index"
      ],
      "nouns": [
        "canter",
        "beta",
        "rollout",
        "review",
        "evidence",
        "register",
        "summary",
        "trace"
      ],
      "geometry": {
        "total": 16,
        "raw": 12,
        "dense": 10,
        "keyword": 3,
        "rootDenseRank": null,
        "rootKeywordRank": 2,
        "scores": [
          0.998,
          0.982,
          0.957,
          0.929,
          0.898,
          0.862,
          0.821,
          0.783,
          0.739,
          0.688
        ],
        "recall": [
          101,
          9,
          9,
          2,
          0
        ]
      },
      "topology": [
        [
          "weak-a",
          "root",
          "relates_to",
          0.69,
          "inferred"
        ],
        [
          "root",
          "weak-b",
          "supersedes",
          0.64,
          "system"
        ],
        [
          "weak-b",
          "weak-c",
          "follows",
          0.95,
          "explicit"
        ]
      ]
    },
    {
      "id": "fh-personal-absent-copper",
      "domain": "personal",
      "shape": "absent-cluster-control",
      "available": false,
      "intent": "chronology",
      "query": "what happened after the copper cabin key handoff",
      "authority": [
        "fh-personal-copper-authority-f80",
        "fh-personal-copper-corroboration-a17"
      ],
      "roots": [],
      "answer": "The authoritative copper cabin handoff cluster is deliberately absent from both retrieval arms.",
      "nouns": [
        "copper",
        "cabin",
        "key",
        "handoff"
      ],
      "geometry": {
        "total": 14,
        "raw": 12,
        "dense": 7,
        "keyword": 5,
        "rootDenseRank": null,
        "scores": [
          0.992,
          0.961,
          0.925,
          0.884,
          0.836,
          0.779,
          0.711
        ],
        "recall": [
          27,
          5,
          0
        ]
      },
      "topology": [
        [
          "authority",
          "corroboration",
          "follows",
          0.86,
          "explicit"
        ],
        [
          "raw-a",
          "raw-b",
          "relates_to",
          0.94,
          "inferred"
        ],
        [
          "raw-c",
          "decoy",
          "about_person",
          0.52,
          "system"
        ]
      ]
    },
    {
      "id": "fh-enterprise-absent-sable",
      "domain": "enterprise",
      "shape": "absent-cluster-control",
      "available": false,
      "intent": "causal",
      "query": "why did the sable vendor attestation window move",
      "authority": [
        "fh-enterprise-sable-authority-ccd",
        "fh-enterprise-sable-corroboration-4b2"
      ],
      "roots": [],
      "answer": "The authoritative sable attestation cluster is deliberately absent from both retrieval arms.",
      "nouns": [
        "sable",
        "vendor",
        "attestation",
        "window"
      ],
      "geometry": {
        "total": 20,
        "raw": 17,
        "dense": 12,
        "keyword": 5,
        "rootDenseRank": null,
        "scores": [
          0.999,
          0.987,
          0.968,
          0.944,
          0.917,
          0.886,
          0.853,
          0.817,
          0.776,
          0.732,
          0.685,
          0.627
        ],
        "recall": [
          880,
          34,
          13,
          1,
          0
        ]
      },
      "topology": [
        [
          "corroboration",
          "authority",
          "caused_by",
          0.73,
          "system"
        ],
        [
          "authority",
          "isolated",
          "part_of_project",
          0.66,
          "explicit"
        ],
        [
          "raw-a",
          "raw-b",
          "supersedes",
          0.89,
          "inferred"
        ],
        [
          "raw-c",
          "raw-d",
          "relates_to",
          0.41,
          "system"
        ]
      ]
    }
  ]
} as const satisfies HiddenManifest;

const text = (spec: HiddenCaseManifest, index: number) =>
  `Controlled ${spec.domain} corpus record ${index} without authoritative evidence.`;

function makeDense(spec: HiddenCaseManifest): CandidateFixture[] {
  const rows = spec.geometry.scores.map((denseScore, index): CandidateFixture => ({
    id: `${spec.id}-dense-${index}`,
    content: text(spec, index),
    vectorContent: `Neutral vector evidence ${index}.`,
    denseScore,
    createdAt: 1_000 - index * 7,
    recallCount: spec.geometry.recall[index % spec.geometry.recall.length],
  }));

  if (spec.shape === "long-parent-pollution") {
    const localTerms = spec.local?.split(/\s+/).slice(0, 3).join(" ") ?? "";
    for (let index = 0; index < Math.min(5, rows.length); index++) {
      rows[index] = {
        ...rows[index],
        content: `${localTerms} replacement evidence ${index}.`,
        vectorContent: `${localTerms} replacement chunk ${index}.`,
      };
    }
  }

  if (spec.shape === "weak-generic-neighbor" && rows.length >= 5) {
    rows[4] = {
      ...rows[4],
      id: spec.authority[0],
      content: spec.answer,
      vectorContent: "Controlled fifth direct evidence.",
      tags: ["status:canonical"],
    };
  }

  if (spec.shape === "popular-broad-summary") {
    rows[0] = {
      ...rows[0],
      id: `${spec.id}-popular`,
      content: `Frequently recalled broad ${spec.domain} digest without the authoritative decision.`,
      vectorContent: "Frequently recalled broad digest.",
      recallCount: Math.max(...spec.geometry.recall),
    };
  }

  if (spec.geometry.rootDenseRank !== null) {
    const index = spec.geometry.rootDenseRank - 1;
    rows[index] = {
      ...rows[index],
      id: spec.roots[0],
      content: spec.parentPollution
        ? `${spec.parentPollution}. ${"Unrelated archival material. ".repeat(24)}`
        : `A terse controlled ${spec.domain} root parent.`,
      vectorContent: spec.local ?? spec.nouns.slice(0, 4).join(" "),
      tags: ["kind:episodic"],
      recallCount: 0,
    };
  }

  return rows;
}

function materialize(spec: HiddenCaseManifest): RootQualityCase {
  const dense = makeDense(spec);
  const overlap = spec.geometry.dense + spec.geometry.keyword - spec.geometry.raw;
  const symbol = new Map<string, string>([
    ["root", spec.roots[0] ?? ""],
    ["authority", spec.authority[0]],
    ["corroboration", spec.authority[1] ?? spec.authority[0]],
    ["popular", `${spec.id}-popular`],
    ["raw-a", dense[0]?.id ?? ""],
    ["raw-b", dense[1]?.id ?? dense[0]?.id ?? ""],
    ["raw-c", dense[2]?.id ?? dense[0]?.id ?? ""],
    ["raw-d", dense[3]?.id ?? dense[0]?.id ?? ""],
    ["decoy", dense.at(-1)?.id ?? ""],
  ]);

  for (let index = 0; index < overlap; index++) {
    const target = spec.shape === "popular-broad-summary"
      ? dense.find(row => row.id === `${spec.id}-popular`)!
      : dense[index];
    Object.assign(target, {
      keywordCandidate: true,
      content: `${spec.nouns.slice(0, Math.min(3, spec.nouns.length)).join(" ")} controlled overlap ${index}.`,
    });
  }

  const keywordOnlyCount = spec.geometry.keyword - overlap;
  const keyword: CandidateFixture[] = [];
  for (let index = 0; index < keywordOnlyCount; index++) {
    const isKeywordRoot = spec.geometry.rootDenseRank === null
      && spec.roots.length > 0
      && index === Math.max(0, (spec.geometry.rootKeywordRank ?? 1) - 1);
    const id = isKeywordRoot ? spec.roots[0] : `${spec.id}-keyword-${index}`;
    if (isKeywordRoot) symbol.set("root", id);
    const termCount = isKeywordRoot
      ? Math.min(4, spec.nouns.length)
      : index === 0 ? spec.nouns.length : 1 + index % Math.min(3, spec.nouns.length);
    keyword.push({
      id,
      content: `${spec.nouns.slice(0, termCount).join(" ")} controlled lexical record ${index}.`,
      keywordCandidate: true,
      createdAt: 2_000 - index * 11,
      recallCount: spec.geometry.recall[(dense.length + index) % spec.geometry.recall.length],
      tags: isKeywordRoot ? ["kind:episodic"] : [],
    });
  }

  const rows: CandidateFixture[] = [...dense, ...keyword];
  const weakBySymbol = new Map((spec.weak ?? []).map((content, index) => [`weak-${String.fromCharCode(97 + index)}`, content]));
  const topologySymbols = new Set(spec.topology.flatMap(row => [row[0], row[1]]));
  const ensure = (name: string) => {
    if (symbol.get(name)) return;
    const id = name === "authority"
      ? spec.authority[0]
      : name === "corroboration"
        ? spec.authority[1]
        : `${spec.id}-${name}`;
    const authorityIndex = spec.authority.indexOf(id);
    rows.push({
      id,
      content: authorityIndex >= 0
        ? authorityIndex === 0 ? spec.answer : `Corroborating authoritative evidence for ${spec.nouns.slice(0, 3).join(" ")}.`
        : weakBySymbol.get(name) ?? `Controlled linked decoy ${name} with ${spec.nouns.at(-1) ?? "generic"} context only.`,
      createdAt: 200 - rows.length,
      tags: authorityIndex >= 0 ? ["status:canonical"] : [],
    });
    symbol.set(name, id);
  };

  for (const name of topologySymbols) ensure(name);
  for (const id of spec.authority) {
    if (!rows.some(row => row.id === id)) {
      rows.push({
        id,
        content: id === spec.authority[0] ? spec.answer : `Corroborating authoritative evidence for ${spec.nouns.slice(0, 3).join(" ")}.`,
        createdAt: 100 - rows.length,
        tags: ["status:canonical"],
      });
    }
  }
  while (rows.length < spec.geometry.total) {
    rows.push({
      id: `${spec.id}-graph-padding-${rows.length}`,
      content: "Controlled graph-only padding without query evidence.",
      createdAt: 50 - rows.length,
    });
  }
  if (rows.length !== spec.geometry.total) {
    throw new Error(`${spec.id}: materialized ${rows.length} candidates, expected ${spec.geometry.total}`);
  }

  const edges: EdgeFixture[] = spec.topology.map(([from, to, type, weight, provenance]) => ({
    sourceId: symbol.get(from) ?? from,
    targetId: symbol.get(to) ?? to,
    type,
    weight,
    provenance,
  }));

  return {
    split: "holdout",
    domain: spec.domain,
    failureShape: spec.shape,
    query: spec.query,
    intent: spec.intent,
    candidates: rows,
    edges,
    authoritativeIds: [...spec.authority],
    acceptableRootIds: [...spec.roots],
    candidateAvailable: spec.available,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export const HIDDEN_VALIDATION_CASES: readonly RootQualityCase[] =
  HIDDEN_VALIDATION_MANIFEST.cases.map(materialize);

deepFreeze(HIDDEN_VALIDATION_MANIFEST);
deepFreeze(HIDDEN_VALIDATION_CASES);
