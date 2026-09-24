// Opt-in: loads the real pinned ONNX models (downloads on first use, ~3.5 GB, anonymous). EVAL_LOCAL_MODELS=1 npm run test:eval:local-models
import { describe, expect, it } from "vitest";
import { probeReranker } from "../../src/recall/model-reranker";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { makeLocalAi } from "./local-ai";

const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
const norm = (a: number[]) => Math.hypot(...a);
const PAIRS = {
  paraphrase: ["The quarterly budget review was moved to Thursday afternoon.", "They rescheduled the finance meeting for the end of the week."],
  unrelated: ["The quarterly budget review was moved to Thursday afternoon.", "Tomato seedlings need six hours of direct sunlight."],
};

describe.skipIf(!process.env.EVAL_LOCAL_MODELS)("real local models", () => {
  const ai = makeLocalAi();
  type Emb = { shape: number[]; data: number[][]; usage: { prompt_tokens: number } };

  for (const [model, dims, extra] of [["@cf/baai/bge-small-en-v1.5", 384, { pooling: "cls" }], ["@cf/baai/bge-small-en-v1.5", 384, {}], ["@cf/baai/bge-m3", 1024, { truncate_inputs: true }]] as const) {
    it(`${model} ${JSON.stringify(extra)}: unit vectors, and a paraphrase sits closer than an unrelated sentence`, async () => {
      const para = await ai.run(model, { text: [...PAIRS.paraphrase], ...extra }) as Emb;
      const unrel = await ai.run(model, { text: [...PAIRS.unrelated], ...extra }) as Emb;
      expect(para.shape).toEqual([2, dims]);
      const [sp, su] = [cos(para.data[0], para.data[1]), cos(unrel.data[0], unrel.data[1])];
      console.log(`${model} ${JSON.stringify(extra)}: cos(paraphrase)=${sp.toFixed(4)} cos(unrelated)=${su.toFixed(4)} norms=${[...para.data, ...unrel.data].map(v => norm(v).toFixed(6)).join(",")} tokens=${para.usage.prompt_tokens}`);
      for (const v of [...para.data, ...unrel.data]) expect(norm(v)).toBeCloseTo(1, 4);
      expect(sp).toBeGreaterThan(su + 0.1);
      const single = await ai.run(model, { text: [PAIRS.paraphrase[0]], ...extra }) as Emb; // batching must not change a vector
      expect(cos(single.data[0], para.data[0])).toBeGreaterThan(0.9999);
    }, 600_000);
  }

  it("bge-reranker-base scores a relevant passage above an irrelevant one", async () => {
    const res = await ai.run("@cf/baai/bge-reranker-base", {
      query: "When was the budget review rescheduled?",
      contexts: [{ text: "Tomato seedlings need six hours of direct sunlight." }, { text: "The quarterly budget review was moved to Thursday afternoon." }],
    }) as { response: { id: number; score: number }[] };
    console.log(`bge-reranker-base: ${JSON.stringify(res.response)}`);
    expect(res.response[0].id).toBe(1);
    expect(res.response[0].score).toBeGreaterThan(res.response[1].score);
    expect(res.response[0].score - res.response[1].score).toBeGreaterThan(2); // raw logits: the margin is the signal
  }, 600_000);

  it("the production reranker probe passes against the real local model and latches ready", async () => {
    const kv = makeMemoryKV();
    const res = await probeReranker(makeTestEnv(undefined, { AI: ai as unknown as Ai, OAUTH_KV: kv }));
    console.log(`reranker probe: ${JSON.stringify(res)}`);
    expect(res.ok).toBe(true);
    expect(await kv.get("reranker:ready:bge-base-v1")).toBe("1");
  }, 600_000);
});
