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

  it("fails loudly on a malformed tag list or message shape", () => {
    expect(() => parseTagPrompt(input(prompt("", "q")))).toThrow(/tag list/);
    expect(() => parseTagPrompt(input(prompt("a, , b", "q")))).toThrow(/tag list/);
    expect(() => parseTagPrompt(input(prompt("a, a", "q")))).toThrow(/tag list/);
    expect(() => parseTagPrompt({ messages: [], stream: true })).toThrow(/one user message/);
    expect(() => parseTagPrompt({ messages: [{ role: "system", content: prompt("a", "q") }] })).toThrow(/one user message/);
  });

  it("tracks the real prompt in src/recall/distill.ts", async () => {
    const db = makeTestDb();
    db.entries.push({ id: "e1", content: "Note", tags: '["work","personal","finance"]', source: "api", created_at: 1000, vector_ids: "[]", recall_count: 0, importance_score: 0 });
    let seen: unknown;
    const aiRun = vi.fn(async (_model: string, body: unknown) => {
      seen = body;
      return new ReadableStream({ start(c) { c.close(); } });
    });
    await inferQueryTags("quarterly planning session", makeTestEnv(db, { AI: { run: aiRun } as unknown as Ai }));
    expect(aiRun).toHaveBeenCalledTimes(1);
    const parsed = parseTagPrompt(seen as never);
    expect([...parsed.tags].sort()).toEqual(["finance", "personal", "work"]);
    expect(parsed.query).toBe("quarterly planning session");
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
