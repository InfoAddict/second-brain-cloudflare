import { mulberry32 } from "../stats";
import { CHUNK_MAX_CHARS } from "../../../src/constants";
import { DAY_MS, WORKSPACES, type CorpusEntry } from "./types";

export const COMMON_TOKENS = ["roadmap", "standup", "invoice"] as const;
/**
 * Dense tier: everyday words that no other haystack word contains. Every row carries at most two of them,
 * so a query of three dense words matches only its gold (9 words give 84 distinct triples per readable
 * scope: avery reads avery+company, blake reads company+blake). `denseRate`
 * tunes each word's df into the band the keyword arm needs in the default scope of avery and of blake:
 * over KEYWORD_CANDIDATE_LIMIT (LIKE truncates) yet a three-word dfSum under FTS_MATCH_BUDGET (the router
 * keeps FTS), and at most 2 words per row keeps df / rows under QUERY_SATURATION_FRACTION.
 */
export const DENSE_TOKENS = ["garden", "window", "coffee", "kitchen", "letter", "table", "bread", "cheese", "basket"] as const;

/** Share of haystack rows per classifier score 1-5: the classifier rates most personal notes 2-3 and few 5. */
export const IMPORTANCE_WEIGHTS = [0.1, 0.3, 0.36, 0.17, 0.07] as const;

/**
 * Mean dense words per row by workspace (0-2), per scale. df of one word = sum(rows x mean) / 9 over the
 * scope, so the three scopes' rates are solved together: avery reads avery+company, blake reads
 * company+blake. Solved for haystacks of 656 / 4656 / 19656 rows (HAYSTACK_ROWS in build.ts), which lands
 * each word near 75 / 575 / 590 rows in both default scopes. At 5k the company and blake rates sit at the
 * two-per-row cap, which is why nine words is the most that keep 5k above the window with margin.
 */
export const DENSE_RATE_BY_SCALE = {
  "1k": { [WORKSPACES.avery]: 0.25, [WORKSPACES.company]: 2, [WORKSPACES.blake]: 1.13 },
  "5k": { [WORKSPACES.avery]: 0.5, [WORKSPACES.company]: 2, [WORKSPACES.blake]: 2 },
  "20k": { [WORKSPACES.avery]: 0.1, [WORKSPACES.company]: 0.5, [WORKSPACES.blake]: 0.45 },
} as const;

/**
 * Correlated tier: three words that only ever appear together, in a share of rows set per scale. Their
 * per-word df is the same as their co-occurrence, so a query of all three has an AND match as large as
 * each word's df: the shape that makes an unbounded AND tier as costly as scoring every match.
 * Rows carry no other word of the tier, and no needle but the guard's does.
 */
export const CORRELATED_TOKENS = ["trellis", "compost", "seedling"] as const;
/** Share of haystack rows that carry the correlated triple: about 800 rows in avery's default scope at 5k and 20k. */
export const CORRELATED_RATE_BY_SCALE = { "1k": 0, "5k": 0.19, "20k": 0.045 } as const;

export interface HaystackOptions {
  count: number;
  seed: number;
  /** Probability a note mentions each of the three COMMON_TOKENS (company rows get a boost, see below). */
  commonRate: number;
  idPrefix: string;
  now: number;
  spanDays: number;
  cjkRate: number;
  /** Share of notes long enough to span several chunks (over CHUNK_MAX_CHARS). */
  longRate: number;
  /** Mean dense-tier words (0-2) per row: one number for every workspace, or a rate per workspace id (missing = 0). */
  denseRate: number | Readonly<Record<string, number>>;
  /** Weights for scores 1-5 (default IMPORTANCE_WEIGHTS). Drawn from its own stream, so the text never shifts. */
  importanceWeights?: readonly number[];
  /** Share of rows that also carry the CORRELATED_TOKENS triple; default 0, which leaves every row byte-identical. */
  correlatedRate?: number;
  workspaces: { workspaceId: string; actorId: string; weight: number }[];
}

type Pick = <T>(xs: readonly T[]) => T;
type Template = (pick: Pick, rand: () => number, words: (n: number) => string) => string;

const PEOPLE = ["Marta", "Devon", "Priya", "Tomas", "Elise", "Ravi", "Noor", "Jonas", "Keiko", "Omar", "Ines", "Callum", "Sana", "Bruno", "Lena", "Hassan", "Mireille", "Dmitri", "Yara", "Felix"];
const PROJECTS = ["Amber Falcon", "Quiet Harbor", "Copper Lantern", "Northwind Ledger", "Blue Meridian", "Paper Kite", "Granite Loop", "Willow Signal", "Saffron Bridge", "Ember Atlas"];
const TOPICS = ["vendor onboarding", "quarterly hiring", "the office move", "onboarding docs", "customer interviews", "pricing experiments", "the data migration", "accessibility fixes", "the support backlog", "partner outreach"];
const DECISIONS = ["ship a smaller first version", "pause the rollout until Monday", "split the work into two milestones", "hand the review to a fresh pair of eyes", "keep the current vendor for one more quarter", "write the plan down before building"];
const MOODS = ["calm", "restless", "tired but glad", "focused", "a bit scattered", "upbeat"];
const ACTIVITIES = ["Long walk by the river", "Cooked a big batch of soup", "Cleaned the garage", "Finished the crossword", "Repotted the ferns", "Cycled to the market"];
const REFLECTIONS = ["I should protect mornings for deep work", "small habits keep compounding", "less scrolling and more reading tonight", "sleep matters more than another hour of work"];
const BOOKS = ["The Orchard Ledger", "Small Habits at Scale", "A Field Guide to Ferns", "Notes on Slow Software", "Cities and Rivers"];
const INSIGHTS = ["the second chapter reframes how to plan a week", "the author argues for fewer, larger bets", "the appendix has a useful checklist", "the case studies felt dated but the framing holds"];
const DISHES = ["lentil soup", "roasted cauliflower", "shakshuka", "miso noodles", "a simple tomato tart"];
const INGREDIENTS = ["smoked paprika", "preserved lemon", "fresh dill", "toasted sesame", "brown butter"];
const VERDICTS = ["worth repeating", "needs more salt", "too fiddly for a weeknight", "the family liked it"];
const PLACES = ["Lisbon", "Kyoto", "Reykjavik", "Oaxaca", "Tallinn", "Hobart", "Split", "Bergen"];
const MONTHS = ["March", "May", "June", "September", "October"];
const TRANSPORT = ["the train", "a night ferry", "flights", "a rental car"];
const CATEGORIES = ["groceries", "transit", "subscriptions", "utilities", "books"];
const AMOUNTS = ["a bit over plan", "under plan", "exactly on plan", "double last month"];
const EXERCISES = ["rowing", "a tempo run", "mobility work", "swimming", "hill repeats"];
const COMPONENTS = ["login form", "export job", "search page", "billing sync", "notification queue", "image uploader"];
const ISSUES = ["intermittent timeout", "wrong sort order", "missing translation", "flaky retry", "stale cache"];
const STATUSES = ["blocked", "in review", "done", "waiting on design", "in progress"];
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const VERBS = ["tighten", "rewrite", "measure", "document", "simplify"];
const PREFIXES = ["OPS", "WEB", "APP"];

// Ordinary everyday words, drawn with a skew toward the front so a few are dense and most sit in a long tail.
const EVERYDAY = ["thing", "time", "people", "work", "day", "week", "home", "good", "new", "first", "last", "long", "little", "great", "small", "big", "high", "young", "old", "important", "different", "bad", "right", "early", "late", "public", "able", "sure", "clear", "free", "full", "real", "hard", "easy", "simple", "quick", "slow", "quiet", "busy", "ready",
  "make", "take", "come", "give", "look", "want", "need", "feel", "seem", "leave", "keep", "let", "begin", "help", "show", "hear", "play", "run", "move", "live", "believe", "bring", "happen", "write", "sit", "stand", "lose", "pay", "meet", "include", "continue", "set", "learn", "change", "lead", "watch", "follow", "stop", "create", "speak", "read", "spend", "grow", "open", "walk", "win", "offer", "remember", "love", "consider", "appear", "buy", "wait", "serve", "send", "expect", "build", "stay", "fall", "reach", "remain", "suggest", "raise", "pass", "sell", "require", "decide", "pull",
  "family", "friend", "year", "morning", "evening", "night", "month", "question", "problem", "place", "room", "door", "street", "city", "water", "money", "story", "fact", "hand", "eye", "life", "world", "school", "state", "student", "group", "country", "office", "party", "ladder", "puddle", "curtain", "blanket", "paper", "candle", "phone", "message", "answer", "reason", "idea", "plan", "result", "point", "number", "system", "program", "case", "part", "level", "form", "order", "course", "line", "end", "side", "power", "hour", "game", "market", "price", "health", "sleep", "food", "music", "movie", "weather", "season", "summer", "winter", "spring", "autumn", "pillow", "breakfast", "dinner", "lunch", "teapot", "lantern", "apple", "river", "mountain", "beach", "forest", "bridge", "road", "train", "car", "bike", "ticket", "bag", "shoes", "coat", "book", "page", "chapter", "picture", "color", "sound", "light", "shadow", "wind", "rain", "snow", "cloud", "sun", "moon", "star", "field", "farm", "animal", "bird", "fish", "dog", "cat", "horse",
  "again", "always", "never", "often", "maybe", "almost", "enough", "together", "instead", "already", "still", "just", "even", "also", "soon", "later", "today", "tomorrow", "yesterday", "tonight", "around", "before", "after", "between", "through", "during", "without", "within", "against", "toward", "about", "because", "although", "while", "until", "since",
  "careful", "curious", "gentle", "honest", "patient", "proud", "rough", "sharp", "smooth", "tidy", "warm", "cool", "bright", "dark", "heavy", "soft", "loud", "narrow", "wide", "deep"];

const JA = [["田中", "来月の予算", "資料を共有する"], ["佐藤", "新しい採用計画", "候補者に連絡する"], ["鈴木", "引っ越しの準備", "見積もりを比較する"], ["高橋", "顧客インタビュー", "質問リストを直す"]];
const ZH = [["小王", "下个季度的计划", "先做一个小版本"], ["李老师", "招聘安排", "本周内联系候选人"], ["陈经理", "供应商合同", "下周再确认价格"], ["小张", "用户访谈", "整理问题清单"]];
const KO = [["민수", "다음 분기 예산", "자료를 공유하기로 했다"], ["지은", "채용 계획", "후보자에게 연락하기로 했다"], ["도윤", "이사 준비", "견적을 비교하기로 했다"], ["서연", "고객 인터뷰", "질문 목록을 고치기로 했다"]];

const TEMPLATES: Template[] = [
  p => `Team check-in ${p(WEEKDAYS)}: ${p(PEOPLE)} is ${p(STATUSES)} on ${p(PROJECTS)}; next up is to ${p(VERBS)} the ${p(COMPONENTS)}.`,
  p => `Meeting with ${p(PEOPLE)} about ${p(TOPICS)}. We agreed to ${p(DECISIONS)}. Follow up on ${p(WEEKDAYS)}.`,
  (p, r) => `${p(PREFIXES)}-${1000 + Math.floor(r() * 7000)}: ${p(VERBS)} the ${p(COMPONENTS)} (${p(ISSUES)}). Status: ${p(STATUSES)}.`,
  p => `Felt ${p(MOODS)} today. ${p(ACTIVITIES)} with ${p(PEOPLE)}; ${p(REFLECTIONS)}.`,
  p => `Reading notes on "${p(BOOKS)}": ${p(INSIGHTS)}.`,
  p => `Tried ${p(DISHES)} with ${p(INGREDIENTS)}; ${p(VERDICTS)}.`,
  p => `Trip idea: ${p(PLACES)} in ${p(MONTHS)}. Book ${p(TRANSPORT)} early.`,
  p => `Budget check: ${p(CATEGORIES)} came in ${p(AMOUNTS)} this month.`,
  p => `Idea: ${p(VERBS)} the ${p(COMPONENTS)} before ${p(PROJECTS)} ships. Worth a weekend prototype.`,
  (p, r) => `Workout: ${p(EXERCISES)} for ${20 + Math.floor(r() * 40)} minutes, felt ${p(MOODS)}.`,
  p => `Decision: we will ${p(DECISIONS)} because ${p(REFLECTIONS)}.`,
  (_p, _r, w) => `Note to self: ${w(6)}.`,
  (p, _r, w) => `${p(PEOPLE)} said ${w(7)}, and I agreed.`,
  (_p, _r, w) => `Quick thought about ${w(4)} and ${w(4)}.`,
  (_p, _r, w) => `Today I sorted out ${w(5)}; tomorrow ${w(3)}.`,
  (p, _r, w) => `On ${p(WEEKDAYS)} we talked about ${w(5)}. ${w(4)}.`,
  (_p, _r, w) => `Remember to ${w(2)} before ${w(3)}, then ${w(4)}.`,
];

const TAILS: Record<(typeof COMMON_TOKENS)[number], readonly string[]> = {
  roadmap: ["This ties into the roadmap.", "Add it to the roadmap review.", "Flag it for the next roadmap pass."],
  standup: ["Mention it at standup.", "Raise it at the next standup."],
  invoice: ["Check the invoice first.", "Match it to the invoice."],
};

export function generateHaystack(options: HaystackOptions): CorpusEntry[] {
  const rand = mulberry32(options.seed);
  const pick: Pick = xs => xs[Math.floor(rand() * xs.length)];
  const totalWeight = options.workspaces.reduce((sum, workspace) => sum + workspace.weight, 0);
  // Company-layer viewers see far fewer rows than personal ones, so company rows carry up to 1.9x the
  // common-token rate and the rest are scaled down to keep the overall rate at commonRate.
  const companyWeight = options.workspaces.filter(workspace => workspace.workspaceId === WORKSPACES.company).reduce((sum, workspace) => sum + workspace.weight, 0);
  const companyFactor = companyWeight > 0 && companyWeight < totalWeight ? Math.min(1.9, totalWeight / companyWeight) : 1;
  const otherFactor = companyWeight < totalWeight ? (totalWeight - companyFactor * companyWeight) / (totalWeight - companyWeight) : 1;
  // Own stream, so the dense tier never shifts the rest of the corpus.
  const denseRand = mulberry32(options.seed ^ 0x9e3779b9);
  // Its own stream too, and never drawn from at rate 0.
  const correlatedRand = mulberry32(options.seed ^ 0x51ed270b);
  const correlatedClause = () => (options.correlatedRate && correlatedRand() < options.correlatedRate
    ? ` Spring bed plan: ${CORRELATED_TOKENS.join(", ")}.` : "");
  // Importance draws from a stream of its own with a seed distinct from the correlated tier's.
  const importanceRand = mulberry32(options.seed ^ 0x2545f491);
  const importanceWeights = options.importanceWeights ?? IMPORTANCE_WEIGHTS;
  const importanceTotal = importanceWeights.reduce((sum, weight) => sum + weight, 0);
  const drawImportance = () => {
    let remaining = importanceRand() * importanceTotal;
    for (let score = 0; score < importanceWeights.length; score++) if ((remaining -= importanceWeights[score]) < 0) return score + 1;
    return importanceWeights.length;
  };
  // Each workspace deals dense words from its own shuffled deck, so every word gets (almost) the same
  // number of slots in any scope built from whole workspaces; consecutive cards never repeat.
  const decks = new Map<string, string[]>();
  const deal = (workspaceId: string) => {
    const deck = decks.get(workspaceId) ?? [];
    decks.set(workspaceId, deck);
    while (deck.length < 2) {
      const last = deck.at(-1);
      let perm: string[];
      do {
        perm = [...DENSE_TOKENS];
        for (let i = perm.length - 1; i > 0; i--) {
          const j = Math.floor(denseRand() * (i + 1));
          [perm[i], perm[j]] = [perm[j], perm[i]];
        }
      } while (perm[0] === last);
      deck.push(...perm);
    }
    return deck.shift()!;
  };
  const denseClause = (workspaceId: string) => {
    const mean = typeof options.denseRate === "number" ? options.denseRate : (options.denseRate[workspaceId] ?? 0);
    const whole = Math.min(2, Math.floor(mean));
    const count = Math.min(2, whole + (denseRand() < mean - whole ? 1 : 0));
    if (!count) return "";
    const first = deal(workspaceId);
    return count === 1 ? ` Also thinking about the ${first}.` : ` Also thinking about the ${first} and the ${deal(workspaceId)}.`;
  };
  const pickWorkspace = () => {
    let remaining = rand() * totalWeight;
    for (const workspace of options.workspaces) if ((remaining -= workspace.weight) < 0) return workspace;
    return options.workspaces[options.workspaces.length - 1];
  };
  const cjkNote = () => {
    const pool = pick([JA, ZH, KO]);
    const [who, topic, action] = pick(pool);
    if (pool === JA) return `${who}さんと${topic}について打ち合わせた。${action}。`;
    if (pool === ZH) return `今天和${who}讨论了${topic}，决定${action}。`;
    return `${who}와 ${topic}에 대해 이야기했다. ${action}.`;
  };
  // Multiplying two draws skews picks toward the front of the pool: a few dense words and a long tail.
  const words = (n: number) => Array.from({ length: n }, () => EVERYDAY[Math.floor(rand() * rand() * EVERYDAY.length)]).join(" ");
  const sentence = () => TEMPLATES[Math.floor(rand() * TEMPLATES.length)](pick, rand, words);

  return Array.from({ length: options.count }, (_, index) => {
    const workspace = pickWorkspace();
    const long = rand() < options.longRate;
    let content = long ? Array.from({ length: 22 }, sentence).join(" ") : rand() < options.cjkRate ? cjkNote() : sentence();
    if (long) while (content.length <= CHUNK_MAX_CHARS) content += ` ${sentence()}`;
    const rate = options.commonRate * (workspace.workspaceId === WORKSPACES.company ? companyFactor : otherFactor);
    for (const token of COMMON_TOKENS) if (rand() < rate) content += ` ${pick(TAILS[token])}`;
    content += denseClause(workspace.workspaceId);
    content += correlatedClause();
    const createdAt = options.now - Math.floor(rand() * options.spanDays * DAY_MS);
    content += ` Logged ${new Date(createdAt).toISOString().slice(0, 16).replace("T", " at ")} UTC (entry ${index + 1}).`;
    return {
      id: `${options.idPrefix}-${String(index + 1).padStart(6, "0")}`,
      content,
      tags: [],
      source: "api",
      createdAt,
      workspaceId: workspace.workspaceId,
      actorId: workspace.actorId,
      importanceScore: drawImportance(),
    };
  });
}
