import { describe, expect, it, vi } from "vitest";
import { inferQueryTags } from "../../src/recall/distill";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";
import { STAND_IN_MAX_TAGS, STAND_IN_TAG_THRESHOLD, cosine, formatTags, parseTagPrompt, pickTags } from "./tag-standin";

const prompt = (tags: string, query: string) =>
  `From this list of tags: ${tags}\n\nWhich tags best match this query? Reply with only a comma-separated list of matching tag names from the list, or nothing if none apply.\n\nQuery: ${query}`;
const input = (content: string) => ({ messages: [{ role: "user", content }], max_tokens: 100, stream: true });

describe("parseTagPrompt", () => {
  it("reads the shown tags and the query", () => {
    expect(parseTagPrompt(input(prompt("finance, vendor, travel", "the freight dispute")))).toEqual({ tags: ["finance", "vendor", "travel"], query: "the freight dispute" });
  });

  it("keeps a query that itself contains the template's separators", () => {
    const q = "line one\n\nQuery: line two, with commas";
    expect(parseTagPrompt(input(prompt("a, b", q))).query).toBe(q);
  });

  it("fails loudly when the wording drifts", () => {
    const drifted = prompt("a, b", "q").replace("Which tags best match", "Which tags match");
    expect(() => parseTagPrompt(input(drifted))).toThrow(/inferQueryTags prompt/);
    expect(() => parseTagPrompt(input("Summarize this."))).toThrow(/inferQueryTags prompt/);
  });

  it("splits the shown list the way production splits a reply: on commas, trimmed, empties dropped, repeats folded", () => {
    expect(parseTagPrompt(input(prompt("a, , b, a,c ", "q"))).tags).toEqual(["a", "b", "c"]);
  });

  it("fails loudly on an empty tag list or message shape", () => {
    expect(() => parseTagPrompt(input(prompt("", "q")))).toThrow(/tag list/);
    expect(() => parseTagPrompt(input(prompt(" , ", "q")))).toThrow(/tag list/);
    expect(() => parseTagPrompt({ messages: [], stream: true })).toThrow(/one user message/);
    expect(() => parseTagPrompt({ messages: [{ role: "system", content: prompt("a", "q") }] })).toThrow(/one user message/);
  });

});

/** Runs the real inferQueryTags over a brain holding these tags; returns what it sent the model and what it returned for `reply`. */
async function viaProduction(tags: string[], query: string, reply = "") {
  const db = makeTestDb();
  db.entries.push({ id: "e1", content: "Note", tags: JSON.stringify(tags), source: "api", created_at: 1000, vector_ids: "[]", recall_count: 0, importance_score: 0 });
  let seen: unknown;
  const aiRun = vi.fn(async (_model: string, body: unknown) => {
    seen = body;
    return new ReadableStream({ start(c) { if (reply) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ response: reply })}\n\n`)); c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close(); } });
  });
  const returned = await inferQueryTags(query, makeTestEnv(db, { AI: { run: aiRun } as unknown as Ai }));
  expect(aiRun).toHaveBeenCalledTimes(1);
  return { parsed: parseTagPrompt(seen as never), returned };
}

// These fail when the matching part of src/recall/distill.ts changes shape, so the stand-in cannot drift silently.
describe("parseTagPrompt against the real inferQueryTags", () => {
  it("reads the shown tags and the query", async () => {
    const { parsed } = await viaProduction(["work", "personal", "finance"], "quarterly planning session");
    expect([...parsed.tags].sort()).toEqual(["finance", "personal", "work"]);
    expect(parsed.query).toBe("quarterly planning session");
  });

  it("sees only the first 50 tags of the vocabulary", async () => {
    const all = Array.from({ length: 60 }, (_, i) => `topic${String(i).padStart(2, "0")}`);
    const { parsed } = await viaProduction(all, "unrelated wording");
    expect(parsed.tags).toEqual(all.slice(0, 50));
  });

  it("sees the query cut to its first 300 characters", async () => {
    const long = `${"x".repeat(299)}\u{1F600}${"tail ".repeat(20)}`; // the cut lands inside a surrogate pair
    const { parsed } = await viaProduction(["work"], long);
    expect(parsed.query).toBe(long.slice(0, 300));
    expect(parsed.query).toHaveLength(300);
  });

  it("carries a CJK query through unchanged", async () => {
    const cjk = "四半期の計画について教えてください";
    expect((await viaProduction(["work"], cjk)).parsed.query).toBe(cjk);
    const long = "計".repeat(350);
    expect((await viaProduction(["work"], long)).parsed.query).toBe("計".repeat(300));
  });

  it("splits a stored tag that contains a comma exactly as production splits a reply", async () => {
    // production stores "a, b" as one tag but shows it as "a, b" in a comma-joined list, then splits replies on commas
    const { parsed, returned } = await viaProduction(["a", "a, b", "c"], "unrelated wording", "a, b, c");
    expect(parsed.tags).toEqual(["a", "b", "c"]);
    expect(returned).toEqual(["a", "c"]); // "b" is not a known tag; "a, b" can never come back
    const echoed = await viaProduction(["a", "a, b", "c"], "unrelated wording", formatTags(pickTags([1, 0], parsed.tags, new Map(parsed.tags.map(t => [t, [1, 0]])), 0.5, 10)));
    for (const t of echoed.returned) expect(["a", "a, b", "c"]).toContain(t);
  });
});

describe("cosine", () => {
  it("is scale-free and 0 for a zero vector", () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1, 12);
    expect(cosine([1, 0], [0, 3])).toBeCloseTo(0, 12);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe("pickTags", () => {
  const q = [1, 0];
  const tags = ["a", "b", "c", "d", "e"];
  const at = (c: number) => [c, Math.sqrt(1 - c * c)];
  const vecs = new Map([["a", at(0.9)], ["b", at(0.8)], ["c", at(0.7)], ["d", at(0.6)], ["e", at(0.1)]]);

  it("keeps tags at or above the threshold, best first", () => {
    expect(pickTags(q, tags, vecs, 0.7, 10)).toEqual(["a", "b", "c"]);
  });

  it("includes a tag exactly at the threshold and excludes one just under", () => {
    expect(pickTags(q, ["a"], new Map([["a", [0.5, Math.sqrt(0.75)]]]), 0.5 - 1e-9, 3)).toEqual(["a"]);
    expect(pickTags(q, ["a"], new Map([["a", [0.5, Math.sqrt(0.75)]]]), 0.5 + 1e-9, 3)).toEqual([]);
  });

  it("caps the count and breaks ties by name", () => {
    expect(pickTags(q, tags, vecs, 0.5, 2)).toEqual(["a", "b"]);
    const tie = new Map([["y", at(0.8)], ["x", at(0.8)]]);
    expect(pickTags(q, ["y", "x"], tie, 0.5, 5)).toEqual(["x", "y"]);
  });

  it("returns nothing when no tag clears the threshold, and throws on a missing vector", () => {
    expect(pickTags(q, ["e"], vecs, 0.5, 3)).toEqual([]);
    expect(() => pickTags(q, ["zzz"], vecs, 0.5, 3)).toThrow(/no embedding for tag/);
  });

  it("uses the documented constants", () => {
    expect(STAND_IN_MAX_TAGS).toBe(3);
    expect(STAND_IN_TAG_THRESHOLD).toBeGreaterThan(0);
    expect(STAND_IN_TAG_THRESHOLD).toBeLessThan(1);
  });
});

describe("formatTags", () => {
  it("emits the comma-separated form inferQueryTags parses", () => {
    expect(formatTags(["a", "b"])).toBe("a, b");
    expect(formatTags([])).toBe("");
  });
});
