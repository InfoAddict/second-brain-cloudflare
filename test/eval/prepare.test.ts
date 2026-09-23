import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ReplayStore, type LiveAi } from "./ai-replay";
import { ACTORS, EVAL_NOW, WORKSPACES, type CorpusEntry, type CorpusSpec } from "./corpus/types";
import { prepare } from "./prepare";
import { hashVector } from "./vectors";
import { getVariant } from "./variants";

const MODEL = "@cf/baai/bge-small-en-v1.5";
const entry = (id: string, content: string): CorpusEntry => ({ id, content, tags: [], source: "api", createdAt: EVAL_NOW - 86_400_000, workspaceId: WORKSPACES.avery, actorId: ACTORS.avery });
const spec: CorpusSpec = {
  id: "tiny-prepare", intent: "tie",
  entries: [entry("a", "xylo alpha plan"), entry("b", "beta gardening note"), entry("c", "gamma tomato note")],
  edges: [],
  queries: [{ id: "q", category: "rare-word", text: "xylo alpha", gold: [{ id: "a", grade: 2 }], viewer: "avery" }],
};
const live = (): LiveAi & { run: ReturnType<typeof vi.fn> } => ({
  run: vi.fn(async (_model: string, input: unknown) => ({
    data: (input as { text: string[] }).text.map(t => hashVector(t, 384)),
    usage: { prompt_tokens: 4, total_tokens: 4 },
  })),
});

// The store only accepts paths inside <root>/.eval-cache, so each test gets a temp root.
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), "eval-prepare-"));
  mkdirSync(join(root, ".eval-cache"), { recursive: true });
  return { root, file: join(root, ".eval-cache", "c.jsonl") };
};

describe("prepare", () => {
  const args = (store: ReplayStore, l: LiveAi, maxNeurons = 1000) => ({
    spec, variant: getVariant("baseline"), backend: "sqlite" as const, model: MODEL, store, live: l, maxNeurons, concurrency: 2, log: () => {},
  });

  it("records every missing text once, verifies a clean replay, and is a no-op the second time", async () => {
    const { root, file } = scratch();
    const l = live();
    const first = await prepare(args(new ReplayStore([], file, { root }), l));
    expect(first.missing).toBeGreaterThan(0);
    expect(l.run.mock.calls.length).toBe(first.missing);
    const calls = l.run.mock.calls.length;
    const second = await prepare(args(new ReplayStore([file], file, { root }), l));
    expect(second.missing).toBe(0);
    expect(l.run.mock.calls.length).toBe(calls);
  });

  it("aborts before any live call when the estimate exceeds the neuron cap", async () => {
    const l = live();
    const { root, file } = scratch();
    const store = new ReplayStore([], file, { root });
    await expect(prepare(args(store, l, 0.000001))).rejects.toThrow(/max-neurons/);
    expect(l.run).not.toHaveBeenCalled();
  });
});
