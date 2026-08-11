/**
 * A small brain with known answers.
 *
 * The reference brain this feature was designed against is saturated with one
 * project, 97 days old, and 43% automated report exhaust — so it is the hardest
 * case for cross-topic connections and the easiest for recurring themes.
 * Tuning against it alone biases the pass toward one shape. This fixture is what
 * makes the pipeline evaluable without it.
 *
 * The assertion it supports is symmetric: every planted pair must surface, and
 * every decoy must not.
 */
import { vi } from "vitest";
import { makeTestEnv, makeVectorizeMock, makeMemoryKV } from "./make-env";
import { makeSqliteD1 } from "./sqlite-d1";

const DAY = 86400000;
export const FIXTURE_NOW = 400 * DAY;
const DIM = 384;

interface FixtureEntry {
  id: string;
  content: string;
  tags: string[];
  source: string;
  createdAt: number;
  importance: number;
  vector: number[];
}

// --- Vector construction -----------------------------------------------
//
// An earlier version of this fixture built vectors as sin(seed + i * 0.001)
// for a hand-picked seed per entry, on the theory that seeds close together
// (1, 1.0005, ...) would cosine-cluster and seeds far apart (1 vs 2 vs 3)
// would not. Measured, that is false: any two seeds within about half a
// sine cycle of one another collapse to near-identical vectors regardless
// of how far apart the seeds are — cosine(near(1), near(2)) came out to
// 0.992, as high as the deliberately-planted contradiction pair itself.
// Every "unrelated topic" pair the fixture was supposed to keep apart
// (pricing vs onboarding, pricing vs support) was accidentally a neighbour
// of everything else in the 1-3 range, and the near-duplicate decoy could
// not be built at all: making it dissimilar enough to the entry it was
// supposed to fail against necessarily made it just as dissimilar to the
// entry it was supposed to succeed against, because those two were
// themselves cosine-indistinguishable. See task-9-report.md.
//
// This replaces it with topic clusters: each cluster is an independent
// random unit vector, and each cluster's members blend that shared
// direction with their own independent noise. In 384 dimensions,
// independently-drawn random unit vectors have cosine similarity
// clustered tightly around 0 (concentration of measure), so distinct
// clusters separate reliably without hand-tuning, and a member's
// similarity to its own cluster is controlled directly by `pull`.

/** FNV-1a, only so each label gets its own deterministic PRNG stream. */
function hashLabel(label: string): number {
  let h = 2166136261;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — small and dependency-free; the fixture only needs determinism. */
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const normalize = (v: number[]): number[] => {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / norm);
};

/** A deterministic unit vector for a label — the same label always yields the same vector. */
const unit = (label: string): number[] => {
  const rand = mulberry32(hashLabel(label));
  return normalize(new Array(DIM).fill(0).map(() => rand() * 2 - 1));
};

/**
 * A member of a topic cluster: `pull` of the cluster's shared direction plus
 * `1 - pull` of the member's own independent noise, renormalised. Two
 * members of the same cluster at the default pull are close (~0.99) without
 * being identical; `decoy-recent` uses a lower pull so it sits under
 * MIN_SIMILARITY (0.80) against every other pricing-cluster member — the
 * point of that decoy is that only the gap floor excludes it, not a
 * similarity floor doing the same job twice.
 */
const clusterMember = (cluster: number[], label: string, pull = 0.92): number[] => {
  const noise = unit(label);
  return normalize(cluster.map((c, i) => c * pull + noise[i] * (1 - pull)));
};

const CLUSTER_PRICING = unit("cluster:pricing");
const CLUSTER_CONNECTION = unit("cluster:connection");
const CLUSTER_STATE = unit("cluster:state");

// Every field has a default so a fixture entry states only what it is testing.
// The default content must clear MIN_INSIGHT_CONTENT_CHARS (80) from
// src/insight/eligibility.ts, or an entry that does not override it is silently
// ineligible and the fixture tests nothing. Count before shortening this.
const entry = (over: Partial<FixtureEntry> & { id: string }): FixtureEntry => ({
  content: "Placeholder fixture content, written long enough that it comfortably clears the eligibility floor used by the insight pass.",
  tags: ["pricing"],
  source: "claude-desktop",
  createdAt: FIXTURE_NOW,
  importance: 3,
  vector: clusterMember(CLUSTER_PRICING, "default"),
  ...over,
});

export const PLANTED: FixtureEntry[] = [
  // contradiction — reversed decision, four months apart
  entry({
    id: "plant-contradiction-old",
    content: "Decision: price the first tier flat at $9 a month, because predictable billing is what small teams asked for.",
    createdAt: FIXTURE_NOW - 120 * DAY, tags: ["pricing"], importance: 4,
    vector: clusterMember(CLUSTER_PRICING, "plant-contradiction-old"),
  }),
  entry({
    id: "plant-contradiction-new",
    content: "Decision: move the first tier to usage-based billing. Flat pricing was leaving money on the table for heavy accounts.",
    createdAt: FIXTURE_NOW, tags: ["pricing"], importance: 4,
    vector: clusterMember(CLUSTER_PRICING, "plant-contradiction-new"),
  }),
  // connection — two topics never tagged together
  entry({
    id: "plant-connection-a",
    content: "Onboarding drop-off is worst at the credential step; people stall before they ever store a memory.",
    createdAt: FIXTURE_NOW - 95 * DAY, tags: ["onboarding"], importance: 4,
    vector: clusterMember(CLUSTER_CONNECTION, "plant-connection-a"),
  }),
  entry({
    id: "plant-connection-b",
    content: "Support volume is dominated by people who cannot get their token working on the first attempt.",
    createdAt: FIXTURE_NOW - 5 * DAY, tags: ["support"], importance: 4,
    vector: clusterMember(CLUSTER_CONNECTION, "plant-connection-b"),
  }),
];

export const DECOYS: FixtureEntry[] = [
  // successive measurements — similar, months apart, and worthless
  entry({
    id: "decoy-state-old",
    content: "Traffic snapshot: 1,462 clones and 485 unique cloners over the last fourteen days.",
    createdAt: FIXTURE_NOW - 100 * DAY, tags: ["metrics", "volatility:state"],
    vector: clusterMember(CLUSTER_STATE, "decoy-state-old"),
  }),
  entry({
    id: "decoy-state-new",
    content: "Traffic snapshot: 733 clones and 296 unique cloners over the last fourteen days.",
    createdAt: FIXTURE_NOW, tags: ["metrics", "volatility:state"],
    vector: clusterMember(CLUSTER_STATE, "decoy-state-new"),
  }),
  // machine-authored — must never be reasoned over
  entry({
    id: "decoy-machine",
    content: "[Synthesized from 34 entries tagged work] The project is being actively developed and promoted.",
    createdAt: FIXTURE_NOW - 60 * DAY, tags: ["synthesized", "work"], source: "system",
    // Deliberately still similarity-eligible (same pricing cluster) — the
    // point of this decoy is that the tag filter excludes it, not that it
    // was too dissimilar to reach the candidate stage in the first place.
    vector: clusterMember(CLUSTER_PRICING, "decoy-machine"),
  }),
  // integration-mirrored record
  entry({
    id: "decoy-mirror",
    content: "PR merged: chore(deps): bump the npm_and_yarn group across 2 directories with 3 updates.",
    createdAt: FIXTURE_NOW - 70 * DAY, tags: ["repo"], source: "git-hook",
    // Same reasoning as decoy-machine: similarity-eligible, excluded by source.
    vector: clusterMember(CLUSTER_PRICING, "decoy-mirror"),
  }),
  // near-duplicate written days apart, not months
  entry({
    id: "decoy-recent",
    content: "Decision: price the first tier flat at $9 a month for predictable billing on small teams.",
    createdAt: FIXTURE_NOW - 2 * DAY, tags: ["pricing"],
    // Lower pull: measured cosine ~0.69 against both plant-contradiction
    // entries, comfortably under MIN_SIMILARITY, so it is excluded from
    // pairing with the old entry by similarity and from the new entry by
    // the gap floor (2 days) — never by both at once, and never by neither.
    vector: clusterMember(CLUSTER_PRICING, "decoy-recent", 0.5),
  }),
];

export function makeInsightFixture() {
  const all = [...PLANTED, ...DECOYS];
  const byVectorId = new Map(all.map(e => [`vec-${e.id}`, e]));

  const vectorize = makeVectorizeMock({
    getByIds: vi.fn().mockImplementation(async (ids: string[]) =>
      ids.map(id => ({ id, values: byVectorId.get(id)?.vector })).filter(v => v.values),
    ),
    query: vi.fn().mockImplementation(async (values: number[]) => {
      const cosine = (a: number[], b: number[]) => {
        let dot = 0, na = 0, nb = 0;
        for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
        return na && nb ? dot / Math.sqrt(na * nb) : 0;
      };
      return {
        matches: all
          .map(e => ({
            id: `vec-${e.id}`,
            score: cosine(values, e.vector),
            metadata: {
              parentId: e.id, created_at: e.createdAt, tags: e.tags,
              content: e.content, source: e.source,
            },
          }))
          .sort((x, y) => y.score - x.score)
          .slice(0, 10),
      };
    }),
  });

  const sqlite = makeSqliteD1();
  for (const e of all) {
    sqlite.seed({
      id: e.id, content: e.content, createdAt: e.createdAt,
      tags: e.tags, source: e.source,
      vectorIds: [`vec-${e.id}`], importanceScore: e.importance,
    });
  }

  const env = makeTestEnv(undefined, {
    DB: sqlite.db as any, VECTORIZE: vectorize, OAUTH_KV: makeMemoryKV(),
  });

  return {
    env, sqlite, all,
    planted: PLANTED.map(e => e.id),
    decoys: DECOYS.map(e => e.id),
    /** Every candidate pair accrual recorded, as `a_id|b_id` strings. */
    async pairs(): Promise<string[]> {
      const { results } = await sqlite.db.prepare(
        `SELECT a_id, b_id FROM insight_candidates ORDER BY score DESC`,
      ).all() as { results: { a_id: string; b_id: string }[] };
      return results.map(r => `${r.a_id}|${r.b_id}`);
    },
  };
}
