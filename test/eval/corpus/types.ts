import type { EdgeType } from "../../../src/graph/types";
import type { Identity } from "../../../src/lib/identity";
import type { GoldenQuery, QueryCategory, ViewerId } from "../types";

export const EVAL_NOW = Date.UTC(2026, 8, 1);
export const DAY_MS = 86_400_000;

export const WORKSPACES = { avery: "ws-avery", company: "ws-acme", blake: "ws-blake", outsider: "ws-outsider" } as const;
export const ACTORS = { avery: "u-avery", blake: "u-blake", outsider: "u-outsider" } as const;

export const IDENTITIES: Record<ViewerId, Identity> = {
  avery: { userId: ACTORS.avery, role: "admin", personalWorkspaceId: WORKSPACES.avery, companyWorkspaceIds: [WORKSPACES.company], defaultShare: "" },
  blake: { userId: ACTORS.blake, role: "member", personalWorkspaceId: WORKSPACES.blake, companyWorkspaceIds: [WORKSPACES.company], defaultShare: "" },
  outsider: { userId: ACTORS.outsider, role: "member", personalWorkspaceId: WORKSPACES.outsider, companyWorkspaceIds: [], defaultShare: "" },
};

export interface CorpusEntry {
  id: string;
  content: string;
  tags: string[];
  source: string;
  createdAt: number;
  workspaceId: string;
  actorId: string;
  /** Classifier score 1-5 (loader default 3, the classifier's own fallback; never 0). */
  importanceScore?: number;
}

export interface CorpusEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: EdgeType;
  weight: number;
  provenance: "explicit" | "inferred" | "system";
  workspaceId: string;
}

export interface NeedleRow {
  id: string;
  content: string;
  tags: string[];
  workspace: keyof typeof WORKSPACES;
  actor?: "avery" | "blake";
  ageDays: number;
  source?: string;
  keys?: string[];
  purpose?: QueryCategory;
}

export interface CorpusSpec {
  id: string;
  /** "tie": common-word unions fit the LIKE window (core-1k). "discriminate": they overflow it (5k, 20k). */
  intent: "tie" | "discriminate";
  entries: CorpusEntry[];
  edges: CorpusEdge[];
  queries: GoldenQuery[];
  /** sha256 of each golden-data file the spec was built from; copied into every report. Absent for corpora with no committed data. */
  dataFingerprint?: Record<string, string>;
}

export function needleToEntry(row: NeedleRow): CorpusEntry {
  const actor = row.actor ?? (row.workspace === "blake" ? "blake" : row.workspace === "outsider" ? "outsider" : "avery");
  return {
    id: row.id,
    content: row.content,
    tags: row.tags,
    source: row.source ?? "api",
    createdAt: EVAL_NOW - row.ageDays * DAY_MS,
    workspaceId: WORKSPACES[row.workspace],
    actorId: ACTORS[actor],
  };
}
