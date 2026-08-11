import { describe, it, expect, vi } from "vitest";
import { parseInsightResponse, sharesVocabulary, reasonOverPair } from "../../src/insight/reason";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";

function makeAI(payload: string) {
  return {
    run: vi.fn().mockResolvedValue(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(payload)}}\n\n`));
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    })),
  } as unknown as Ai;
}

describe("parseInsightResponse()", () => {
  it("accepts a well-formed insight", () => {
    const out = parseInsightResponse(`{"insight": true, "shape": "contradiction", "text": "In March you chose flat pricing; in July you chose usage-based."}`);
    expect(out?.shape).toBe("contradiction");
  });

  it("tolerates prose around the JSON", () => {
    const out = parseInsightResponse(`Sure!\n{"insight": true, "shape": "throughline", "text": "You return to onboarding friction every few weeks."}\nHope that helps.`);
    expect(out?.shape).toBe("throughline");
  });

  it("returns null on an explicit refusal", () => {
    expect(parseInsightResponse(`{"insight": false}`)).toBeNull();
  });

  it("returns null on unparseable output", () => {
    expect(parseInsightResponse("I could not find anything.")).toBeNull();
  });

  it("returns null on an invalid shape", () => {
    expect(parseInsightResponse(`{"insight": true, "shape": "vibes", "text": "Something long enough to pass the length floor easily."}`)).toBeNull();
  });

  it("returns null when the text is too short to say anything", () => {
    expect(parseInsightResponse(`{"insight": true, "shape": "connection", "text": "Related."}`)).toBeNull();
  });
});

describe("sharesVocabulary()", () => {
  it("is true when the insight names something from the source", () => {
    expect(sharesVocabulary(
      "In March you chose flat pricing, and in July usage-based billing.",
      "We should adopt flat pricing for the first tier.",
    )).toBe(true);
  });

  it("is false for a statement that only echoes stopwords", () => {
    expect(sharesVocabulary(
      "You often talk about this and that.",
      "Kubernetes autoscaling thresholds were raised for the ingest workers.",
    )).toBe(false);
  });
});

describe("reasonOverPair()", () => {
  const a = { content: "We should adopt flat pricing for the first tier of the product." };
  const b = { content: "Decision: switch to usage-based pricing, flat tiers were leaving money on the table." };

  it("returns the insight when it names something from both entries", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeAI(`{"insight": true, "shape": "contradiction", "text": "You chose flat pricing for the first tier, then switched to usage-based pricing."}`),
    });
    const out = await reasonOverPair(a, b, env);
    expect(out?.shape).toBe("contradiction");
  });

  it("rejects a generic statement that echoes neither entry specifically", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeAI(`{"insight": true, "shape": "throughline", "text": "You often talk about building a second brain and thinking about things."}`),
    });
    expect(await reasonOverPair(a, b, env)).toBeNull();
  });

  it("returns null rather than throwing when the model call fails", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: { run: vi.fn().mockRejectedValue(new Error("AI down")) } as unknown as Ai,
    });
    await expect(reasonOverPair(a, b, env)).resolves.toBeNull();
  });
});
