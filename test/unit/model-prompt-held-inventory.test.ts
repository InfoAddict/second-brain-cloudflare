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

/** Every genuine chat-completion call: `.run(` on an AI binding, passed a `messages:` prompt.
 * Excludes embed calls (embedMany/embed in src/lib/ai.ts), which carry no free-text prompt. */
function scanChatCalls(): Site[] {
  const sites: Site[] = [];
  const CALL = /\benv\.AI\b[\s\S]*?\.run\(/;
  for (const path of walk(join(ROOT, "src"))) {
    const file = relative(ROOT, path);
    if (file === "lib/ai.ts") continue; // embed/embedMany only -- no chat prompt
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/\.run\(/.test(lines[i])) continue;
      // The AI binding can be cast/typed on the line(s) just above a `.run(` that starts a new
      // line after the cast closes (model-reranker.ts's shape), not always on the call's own line.
      const nearby = lines.slice(Math.max(0, i - 2), i + 1).join("\n");
      if (!/\bAI\b/.test(nearby) || !CALL.test(nearby)) continue;
      // A genuine prompt-bearing call passes messages: (chat) or contexts: (the reranker) within
      // a few lines of the call itself.
      const window = lines.slice(i, i + 6).join("\n");
      if (!/messages\s*:|contexts\s*:/.test(window)) continue;
      sites.push({ file, line: i + 1 });
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
    why: "reasonOverPair(a, b, ...) takes two rows its callers already read. src/insight/weekly.ts's draw query and routes/admin.ts's /insights/dry-run preview both now filter a.tags/b.tags NOT LIKE '%\"quarantine:%' alongside the status:deprecated/valid_until re-checks they already did for the same reason: a candidate accrued clean can be held by the time it is drawn, days later.",
  },
  {
    file: "src/recall/insight.ts", line: 34,
    why: "synthesizeInsight's only caller (search.ts) builds its matches from rcRows, which notHeld() (search.ts) filters before rerank, plus an explicit isHeld re-check on the evidence-slot fallback.",
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
    file: "src/routes/recall.ts", line: 307,
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
