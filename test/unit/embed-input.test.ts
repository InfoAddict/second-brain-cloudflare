import { describe, it, expect, vi } from "vitest";
import { embed, embedMany } from "../../src/lib/ai";
import { DEFAULTS } from "../../src/config";
import { makeTestEnv } from "../helpers/make-env";

describe("embed() input shape", () => {
  it("sends the bge-en models the plain text array they accept", async () => {
    const env = makeTestEnv();
    await embed("hello", env, DEFAULTS);
    expect(vi.mocked(env.AI.run).mock.calls[0][1]).toEqual({ text: ["hello"] });
  });

  it("asks bge-m3 to truncate over-long input instead of rejecting it", async () => {
    const env = makeTestEnv();
    await embed("hello", env, { ...DEFAULTS, EMBEDDING_MODEL: "@cf/baai/bge-m3" });
    expect(vi.mocked(env.AI.run).mock.calls[0][1]).toEqual({ text: ["hello"], truncate_inputs: true });
  });

  it("makes exactly one AI.run call, delegating to embedMany", async () => {
    const env = makeTestEnv();
    await embed("hello", env, DEFAULTS);
    expect(vi.mocked(env.AI.run).mock.calls).toHaveLength(1);
  });
});

describe("embedMany() input shape", () => {
  it("sends every text in one AI.run call and returns one vector per text, in order", async () => {
    const env = makeTestEnv();
    env.AI.run = vi.fn().mockResolvedValue({ data: [[1, 0], [0, 1]] });
    const vectors = await embedMany(["a", "b"], env, DEFAULTS);
    expect(vi.mocked(env.AI.run).mock.calls).toHaveLength(1);
    expect(vi.mocked(env.AI.run).mock.calls[0][1]).toEqual({ text: ["a", "b"] });
    expect(vectors).toEqual([[1, 0], [0, 1]]);
  });

  it("asks bge-m3 to truncate the whole batch, same as a single text", async () => {
    const env = makeTestEnv();
    await embedMany(["a", "b"], env, { ...DEFAULTS, EMBEDDING_MODEL: "@cf/baai/bge-m3" });
    expect(vi.mocked(env.AI.run).mock.calls[0][1]).toEqual({ text: ["a", "b"], truncate_inputs: true });
  });

  it("preserves order for identical or near-identical texts", async () => {
    const env = makeTestEnv();
    env.AI.run = vi.fn().mockResolvedValue({ data: [[1, 1], [2, 2], [3, 3]] });
    const vectors = await embedMany(["same", "same", "different"], env, DEFAULTS);
    expect(vectors).toEqual([[1, 1], [2, 2], [3, 3]]);
  });
});
