import type { RecallMatch, WhyTrace } from "./types";
import { formatAsOfQualifier } from "../memory/stale";
import { getStatus } from "../memory/status";
import { DEFAULTS, type Config } from "../config";
import { allowanceFor, snippetOf, truncationNote, type Snippet } from "./snippet";
import { computeCompoundStale } from "./compound-stale";
import type { CompoundStaleSignal } from "./types";
import { sourceClass } from "./source-trust";
import { editedCanonicalAt } from "../quarantine/tags";
import { formatValidityDate } from "../memory/validity";
import type { ValiditySummary } from "./validity-view";

/** How long the canonical-edit label shows after the dated tag (5.7). Expiry is by date at render time; there is no job. */
export const EDITED_CANONICAL_LABEL_DAYS = 7;

/**
 * The bracketed header every memory-returning MCP tool prints.
 *
 * One builder because there are three of them — recall, list_recent and get —
 * and they had drifted: recall showed the layer and its author, the other two
 * showed neither, so an agent that browsed with list_recent or fetched with get
 * could not tell a shared memory from a private one, or who wrote it, while the
 * same memory recalled a moment earlier said both. list_recent even rendered
 * tags as " · ops", which is the separator the layer badge uses, so a tag and a
 * layer were indistinguishable in the one tool that showed no layer.
 *
 * Callers append their own suffixes after the closing bracket (recall's score,
 * its [updated] and [related] labels).
 */
export function memoryHeader(m: {
  createdAt: number;
  source?: string | null;
  tags: string[];
  workspace?: "personal" | "company" | "system";
  actorName?: string | null;
}): string {
  const date = new Date(m.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  const src = m.source ? ` · ${m.source}` : "";
  // Layer badge: only when it carries information — which means only on the
  // company layer. "personal" is the default home of every memory a caller can
  // see, so badging it says nothing: on a single-user brain it decorated 100% of
  // results, and even inside a team the absence of " · shared" already means the
  // row is the reader's own. System-space rows stay unbadged for the same reason.
  const layer = m.workspace === "company"
    ? ` · shared${m.actorName ? ` · ${m.actorName}` : ""}`
    : "";
  // The AI-edit label (5.7): a canonical row edited through MCP within the
  // last EDITED_CANONICAL_LABEL_DAYS. Recall names no tool (Q-I) — the
  // dashboard, brief and history read the newest version's client instead.
  const editedAt = getStatus(m.tags) === "canonical" ? editedCanonicalAt(m.tags) : null;
  const editedAgeDays = editedAt ? (Date.now() - Date.parse(`${editedAt}T12:00:00Z`)) / 86_400_000 : Infinity;
  const editedLabel = editedAt && editedAgeDays <= EDITED_CANONICAL_LABEL_DAYS
    ? ` · edited via an AI tool on ${new Date(`${editedAt}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
    : "";
  const tagList = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
  return `${date}${src}${layer}${editedLabel}${tagList}`;
}

/**
 * The bracket `get` and `list_recent` append after `memoryHeader`'s own
 * bracket for a row that is not current (spec 14 5.9). Null for a current
 * row — nothing to say. A stated valid_from prints "from <date>"; an
 * unstated one (UNKNOWN_START, an end-only fact) prints "until <date>" alone.
 */
export function validityBracket(v: ValiditySummary, timezone: string): string | null {
  if (v.validityState === "current") return null;
  if (v.validityState === "wrong") return "[marked wrong]";
  const until = formatValidityDate(v.validUntil as number, timezone);
  const trueWindow = v.validFromStated ? `true from ${formatValidityDate(v.validFrom, timezone)} until ${until}` : `true until ${until}`;
  return v.validityState === "replaced"
    ? `[replaced on ${until} by ${v.supersededBy!.id}: ${trueWindow}]`
    : `[ended ${until}: ${trueWindow}]`;
}

export function renderRecallText(
  matches: RecallMatch[],
  insight: string,
  opts: { full?: boolean; queryTokens?: string[]; config?: Readonly<Config>; compoundStale?: CompoundStaleSignal } = {},
): string {
  const contentById = new Map(matches.map(m => [m.id, m.content]));
  const blocks: string[] = [];
  const renderedMatches: RecallMatch[] = [];
  let used = 0;
  let omitted = 0;
  const cfg = opts.config ?? DEFAULTS;

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    // Spelled month: this text is read by assistants, and a numeric date is
    // ambiguous between US and international order.
    const header = memoryHeader(m);
    const score = (m.score * 100).toFixed(0);
    const updateLabel = m.isUpdate ? " [updated]" : "";
    const hopLabel = m.hop > 0 ? ` [related · ${hopProvenance(m, contentById)}]` : "";
    const staleLabel = m.staleAsOf ? ` · ${formatAsOfQualifier(m.updatedAt)}` : "";
    // T-0089.2.1 (spec 5.9): a stated start, and a flag for a dependent built
    // on a source later marked wrong, ride in the same place as the stale label.
    const trueSinceLabel = m.validFromStated ? ` · true since ${monthYear(m.validFrom, cfg.TIMEZONE)}` : "";
    const retractedSourceLabel = m.retractedSource ? " · built on a memory that was later retracted, verify before asserting" : "";
    // Recurring notices the collapse absorbed into this one (4.4): named on
    // the header line, then listed by id so an agent can fetch one directly.
    const similarLabel = m.similar?.length
      ? ` · and ${m.similar.length} similar (${m.similar.map(s => shortDate(s.createdAt)).join(", ")})`
      : "";
    const similarIdsLine = m.similar?.length ? `similar ids: ${m.similar.map(s => s.id).join(", ")}\n` : "";

    const s: Snippet = opts.full
      ? { text: (m.content ?? "").trim(), truncated: false, fullLength: (m.content ?? "").length }
      : snippetOf(m.content, allowanceFor(i, m.score, cfg), { queryTokens: opts.queryTokens });
    const body = s.truncated ? `${s.text}${truncationNote(m.id, s)}` : s.text;
    const block = `${i + 1}. [${header}] (${score}% match)${updateLabel}${hopLabel}${staleLabel}${trueSinceLabel}${retractedSourceLabel}${similarLabel}\nID: ${m.id}\n${body}`;
    // The why line rides outside the budget: asking for an explanation must not change which memories come back.
    const whyLine = m.why ? `why: ${whyText(m, m.why, contentById)}\n` : "";
    const extraLines = `${whyLine}${similarIdsLine}`;

    // Stop once the budget is spent, but always return at least one match.
    if (!opts.full && blocks.length && used + block.length > cfg.RECALL_OUTPUT_BUDGET) {
      omitted = matches.length - i;
      break;
    }
    used += block.length;
    renderedMatches.push(m);
    blocks.push(extraLines ? block.replace(`\nID: ${m.id}\n`, `\nID: ${m.id}\n${extraLines}`) : block);
  }

  const compoundStale = opts.compoundStale ?? computeCompoundStale(renderedMatches);
  let prefix = "";
  if (compoundStale) {
    const oldest = new Date(compoundStale.oldestUpdatedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    prefix = `**Staleness warning:** ${compoundStale.count} sources are marked stale as-of (oldest touch: ${oldest}). Verify before combining them into a single claim.\n\n---\n\n`;
  }

  let text = blocks.join("\n\n");
  if (omitted > 0) {
    text += `\n\n${omitted} more match${omitted > 1 ? "es" : ""} omitted to bound the response size. Narrow the query, or call get("<id>") for a specific memory.`;
  }
  const body = insight ? `**Insight:** ${insight}\n\n---\n\n${text}` : text;
  return prefix ? prefix + body : body;
}

// A term is "rare" once its idf clears this (about one note in twenty holds it).
const RARE_IDF = 3;
const WHY_MAX_TERMS = 3;

const shortDate = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
/** "Jun 2026", in the brain's TIMEZONE (T-0089.2.2), for a stated valid_from. */
const monthYear = (ms: number, timezone: string) => new Date(ms).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: timezone });

/** One plain line saying why a memory came back, from the trace recall already computed. */
function whyText(m: RecallMatch, why: WhyTrace, contentById: Map<string, string>): string {
  const parts: string[] = [];
  if (why.dense_rank !== null) parts.push(`meaning #${why.dense_rank}`);
  if (why.keyword_terms.length) {
    const shown = why.keyword_terms.slice(0, WHY_MAX_TERMS).map(t => {
      const notes = [t.level === 2 && t.idf >= RARE_IDF ? "rare" : "", t.level === 1 ? "inside a longer word" : ""].filter(Boolean);
      return `"${t.term}"${notes.length ? ` (${notes.join(", ")})` : ""}`;
    });
    const more = why.keyword_terms.length - shown.length;
    parts.push(`keywords ${shown.join(", ")}${more > 0 ? ` +${more} more` : ""}`);
  }
  if (getStatus(m.tags) === "canonical") parts.push("canonical");
  const mult = why.multipliers;
  if (mult) {
    if (why.age_known === false) parts.push("age unknown");
    else if (mult.recency >= 0.95) parts.push(`recent (${shortDate(m.createdAt)})`);
    if (mult.importance > 1) parts.push("high importance");
    else if (mult.importance < 1) parts.push("low importance");
    if (mult.tag_boost > 1) parts.push("tag match");
    if (mult.frequency > 1) parts.push("recalled before");
    if (mult.source_weight < 1) parts.push(`${sourceClass(m.source, m.tags)} source ×${mult.source_weight}`);
  }
  if (why.rerank_move) parts.push(`reranked ${why.rerank_move}`);
  if (why.graph) {
    const from = contentById.get(why.graph.from);
    parts.push(`linked from ${from ? `"${snippet(from)}"` : why.graph.from}`);
  }
  if (why.slot === "evidence") parts.push("evidence slot");
  else if (why.slot === "deeper") parts.push("deeper list");
  return parts.length ? parts.join(" · ") : "ranked on its combined score";
}

// For a graph-expanded match, describe why it surfaced: who formed the edge
// (you vs. auto vs. system), when, and which memory it was reached from.
function hopProvenance(m: RecallMatch, contentById: Map<string, string>): string {
  const who =
    m.viaProvenance === "explicit" ? "you linked" :
    m.viaProvenance === "system" ? "system-linked" :
    "auto-linked";
  const when = m.viaLinkedAt ? ` · ${new Date(m.viaLinkedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}` : "";
  const fromContent = m.viaFrom ? contentById.get(m.viaFrom) : undefined;
  const from = fromContent ? ` · from "${snippet(fromContent)}"` : "";
  return `${who}${when}${from}`;
}

function snippet(text: string): string {
  const s = text.trim().replace(/\s+/g, " ");
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}
