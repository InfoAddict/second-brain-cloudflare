/**
 * One candidate pair in, at most one insight out.
 *
 * Two properties here are load-bearing, and both are corrections to the
 * generator this replaces:
 *
 *   - The prompt mandates NO opening phrase. Its predecessor required the answer
 *     to start with "You tend to" / "There's a recurring" / "Across your
 *     memories" and discarded anything else, which made the generic shape a
 *     contract rather than something a better model could escape.
 *
 *   - There is an explicit refusal path. That is what makes noisy inputs safe:
 *     roughly half of the `supersedes` edges on a real brain are false
 *     positives, so the model must be free to say there is no tension here
 *     rather than be told there is one.
 */
import type { Env } from "../env";
import { DEFAULTS, type Config } from "../config";
import { INSIGHT_PASS_MAX_TOKENS, LLM_MODEL } from "../constants";
import { readStreamText } from "../lib/ai";

export type InsightShape = "contradiction" | "throughline" | "connection";

export interface ReasonedInsight {
  shape: InsightShape;
  text: string;
}

const SHAPES: ReadonlySet<string> = new Set(["contradiction", "throughline", "connection"]);

/** Below this the model has not said anything a person could act on. */
const MIN_INSIGHT_TEXT_CHARS = 40;

/** How much of each entry the prompt carries. */
const ENTRY_EXCERPT_CHARS = 800;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "you", "your", "about",
  "into", "over", "then", "than", "they", "them", "have", "has", "was", "were",
  "are", "but", "not", "all", "any", "can", "will", "would", "should", "could",
  "often", "talk", "thing", "things", "something", "these", "those", "when",
  "what", "which", "there", "their", "been", "more", "most", "some", "such",
]);

const distinctiveTokens = (text: string): Set<string> =>
  new Set(
    text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g)?.filter(t => !STOPWORDS.has(t)) ?? [],
  );

/**
 * Does the insight name something specific from this source?
 *
 * The failure this exists to catch is the centroid statement — text that echoes
 * only the topic two entries have in common and nothing particular to either.
 * Requiring overlap with each side independently is what separates "you often
 * talk about building a second brain" from an observation about two memories.
 */
export function sharesVocabulary(text: string, source: string): boolean {
  const wanted = distinctiveTokens(source);
  if (!wanted.size) return true; // nothing distinctive to match against
  for (const token of distinctiveTokens(text)) {
    if (wanted.has(token)) return true;
  }
  return false;
}

export function parseInsightResponse(raw: string): ReasonedInsight | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }

  if (parsed.insight !== true) return null;
  const shape = String(parsed.shape ?? "");
  if (!SHAPES.has(shape)) return null;

  const text = String(parsed.text ?? "").trim();
  if (text.length < MIN_INSIGHT_TEXT_CHARS) return null;

  return { shape: shape as InsightShape, text };
}

export async function reasonOverPair(
  a: { content: string },
  b: { content: string },
  env: Env,
  config: Readonly<Config> = DEFAULTS,
): Promise<ReasonedInsight | null> {
  const first = a.content.slice(0, ENTRY_EXCERPT_CHARS);
  const second = b.content.slice(0, ENTRY_EXCERPT_CHARS);

  const prompt = `You are reading two memories from one person's second brain. They were written at different times and are similar in subject.

Memory A:
${first}

Memory B:
${second}

Is there a real, specific insight in the relationship between these two? Only answer yes if you can name something concrete from BOTH memories. Restating what they have in common is not an insight.

The shape is one of:
- "contradiction" — B reverses, revises or conflicts with A
- "throughline" — the same concern returning, developing over time
- "connection" — two things that relate but were never linked

Write in the second person, plainly, in one or two sentences. Do not begin with a set phrase. Do not hedge.

Respond with JSON only. No text outside the JSON object.
{"insight": false} OR {"insight": true, "shape": "<shape>", "text": "<the insight>"}`;

  let raw = "";
  try {
    const stream = await (env.AI as any).run(config.LLM_MODEL as any, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: INSIGHT_PASS_MAX_TOKENS,
      stream: true,
    });
    raw = await readStreamText(stream as ReadableStream);
  } catch (e) {
    console.error("Insight reasoning call failed (non-fatal):", e);
    return null;
  }

  const parsed = parseInsightResponse(raw);
  if (!parsed) return null;

  // The mechanical floor. A real insight names something from each side; a
  // centroid names only what they share.
  if (!sharesVocabulary(parsed.text, first)) return null;
  if (!sharesVocabulary(parsed.text, second)) return null;

  return parsed;
}
