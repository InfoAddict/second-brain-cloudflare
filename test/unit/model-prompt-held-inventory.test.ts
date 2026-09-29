/**
 * Codex review class E (T-0089.4.2): "no AI model ever sees held text." A held row's content is
 * unreviewed by definition; it must never be read into ANY model prompt -- contradiction,
 * duplicate/merge, digest, insight, classify, or anything else. This scans src/ for every genuine
 * chat-completion call (`(env.AI as any).run(` / `env.AI.run(` with a `messages:` prompt, never an
 * embedding call) and requires each to be named here with why its row source can never include a
 * currently-held row -- either it runs `excludeHeld` (src/quarantine/tags.ts) on its candidate
 * rows immediately before building the prompt, or it structurally cannot reach held content at
 * all. A call site added without one of these two shapes is the bug class E exists to catch.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "../..");

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (name.endsWith(".ts")) yield path;
  }
}

interface Site { file: string; line: number }

/** Same lookback distance check-scope.mjs and the other structural guards in this codebase use
 * for a marker "a few lines above" a flagged line (scope-checked:, validity:, scope-outer-join:).
 * The old value here, 2, was narrower than every other guard's own convention for no stated
 * reason, and missed a binding aliased 3 lines above its own `.run(` (cloud re-review MINOR,
 * held-reader-class tightening round): `const ai = env.AI` followed by two other lines before
 * `ai.run({messages: ...})` sat entirely outside a window that only looked back 2 lines. */
const LOOKBACK = 5;
const CALL = /\benv\.AI\b[\s\S]*?\.run\(/;

/** The pure per-line predicate: is `lines[i]` a genuine chat-completion `.run(` call, an AI
 * binding reachable within LOOKBACK lines above it (aliased or not), passed a `messages:` or
 * `contexts:` prompt within the next few lines? Split out from the file-walking scan so the
 * reviewer's own probe can be asserted on directly, with no fixture file needed. */
export function isChatCallSite(lines: string[], i: number): boolean {
  if (!/\.run\(/.test(lines[i])) return false;
  // The AI binding can be cast/typed on the line(s) just above a `.run(` that starts a new line
  // after the cast closes (model-reranker.ts's shape), or aliased to a local const several lines
  // earlier -- not always on the call's own line, and not always within a couple of lines.
  const nearby = lines.slice(Math.max(0, i - LOOKBACK), i + 1).join("\n");
  if (!/\bAI\b/.test(nearby) || !CALL.test(nearby)) return false;
  // A genuine prompt-bearing call passes messages: (chat) or contexts: (the reranker) within a
  // few lines of the call itself.
  const window = lines.slice(i, i + 6).join("\n");
  return /messages\s*:|contexts\s*:/.test(window);
}

/** Every genuine chat-completion call: `.run(` on an AI binding, passed a `messages:` prompt.
 * Excludes embed calls (embedMany/embed in src/lib/ai.ts), which carry no free-text prompt. */
function scanChatCalls(): Site[] {
  const sites: Site[] = [];
  for (const path of walk(join(ROOT, "src"))) {
    const file = relative(ROOT, path);
    if (file === "lib/ai.ts") continue; // embed/embedMany only -- no chat prompt
    const lines = readFileSync(path, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (isChatCallSite(lines, i)) sites.push({ file, line: i + 1 });
    }
  }
  return sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

const ACCOUNTED_FOR: { file: string; line: number; why: string }[] = [
  {
    file: "src/capture/classify.ts", line: 42,
    why: "classifyEntry(content, ...) takes raw content, never a row query. Its callers: entry.ts returns early at decision.hold, before classify ever runs, for the write's own content; the merge-target path only reaches a row duplicate.ts's own excludeHeld-filtered candidateRows offered. mirror.ts classifies fresh provider content before any row exists. admin.ts's /classify-pending scans UNCLASSIFIED_WHERE (tags NOT LIKE '%\"status:%'), which structurally excludes every held row too -- withHold always adds status:draft atomically alongside quarantine:, and applyTagReplacement preserves both as worker-owned across every edit, so no path removes status: while leaving quarantine: in place.",
  },
  {
    file: "src/capture/duplicate.ts", line: 201,
    why: "merge/replace decision prompt: existingList is built from candidateRows, which the read above filters through excludeHeld before anything else touches it (Codex review class E, T-0089.4.2).",
  },
  {
    file: "src/capture/duplicate.ts", line: 246,
    why: "contradiction-only prompt: same candidateRows, same excludeHeld filter as the merge/replace prompt above -- one read, one filter, both branches.",
  },
  {
    file: "src/compression/digest.ts", line: 43,
    why: "synthesizeDigest's rows argument is the caller's candidate read (compressTag), which now runs excludeHeld on rawEntries before rawEntries.length is even checked (Codex review class E, T-0089.4.2).",
  },
  {
    file: "src/insight/reason.ts", line: 372,
    why: "reasonOverPair(a, b, ...) takes two rows its callers already read. src/insight/weekly.ts's draw query and routes/admin.ts's /insights/dry-run preview both now filter a/b through notHeldSql (T-0102 MINOR fix: one NOT LIKE clause per recognized hold reason, alias-qualified) alongside the status:deprecated/valid_until re-checks they already did for the same reason: a candidate accrued clean can be held by the time it is drawn, days later.",
  },
  {
    file: "src/recall/insight.ts", line: 34,
    why: "synthesizeInsight's only caller (search.ts) builds its matches from rcRows, which notHeld() (search.ts) filters before rerank, plus an explicit isHeld re-check on the evidence-slot fallback. An as-of call rewrites matches' content from entry_versions afterward (enrichWithAsOf); resolveAtT (as-of.ts, T-0102 MAJOR fix) redacts that rewritten content to \"\" whenever the resolved historical tags were held, so a version that WAS held at T can never reach this prompt even though the row is unheld and releasable today.",
  },
  {
    file: "src/recall/model-reranker.ts", line: 175,
    why: "scoreRerankCandidates' candidates.text comes from search.ts's loadContent, which now re-checks isHeld via d1Tags (already in memory, no extra read) immediately before its own fallback fetch, on top of notHeld() already filtering the candidate ids upstream of rerank.",
  },
  {
    file: "src/when/pass.ts", line: 269,
    why: "judgeCommitment's prompt is built from candidateSql's own rows, which now adds NOT_HELD_SQL alongside its existing when_at/when_source/openLoopSql predicates (Codex review class E, T-0089.4.2).",
  },
  {
    file: "src/routes/recall.ts", line: 309,
    why: "POST /chat's body.memories is opaque client-composed text (see the route's own comment: the shipped client serializes a prior GET /recall response into it), never a server-side row read here -- there is no candidate query at this boundary to filter. The row-read boundary this rule protects is GET /recall and get(), which already exclude/warn on held content before the client ever sees it to compose from.",
  },
];

describe("every chat-completion call site's row source excludes held rows, or is accounted for", () => {
  const sites = scanChatCalls();

  it("finds at least the known call sites (the scanner itself is not a no-op)", () => {
    expect(sites.length).toBeGreaterThanOrEqual(3);
  });

  it("matches the accounted-for list exactly", () => {
    const actual = sites.map(s => `${s.file}:${s.line}`).sort();
    const expected = ACCOUNTED_FOR.map(s => `${s.file}:${s.line}`).sort();
    expect(actual).toEqual(expected);
  });
});

// Cloud re-review MINOR on 0b970baa: the reviewer's own probe -- an AI binding aliased 3 lines
// above its own `.run(` call sat entirely outside the old, 2-line lookback window, so the scanner
// never saw it at all (not flagged, not accounted for -- just invisible). Asserted directly
// against isChatCallSite(), no fixture file needed.
describe("structural probe the reviewer found unguarded (widened lookback)", () => {
  it("finds a chat call whose AI binding is aliased 3 lines above it", () => {
    const lines = [
      "const ai = env.AI;",
      "const rows = candidateRows;",
      "const prompt = buildPrompt(rows);",
      "const result = await ai.run(MODEL, { messages: [{ role: \"user\", content: prompt }] });",
    ];
    expect(isChatCallSite(lines, 3)).toBe(true);
  });
});
