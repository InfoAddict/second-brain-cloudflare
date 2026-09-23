import { mulberry32 } from "../stats";
import { CHUNK_MAX_CHARS } from "../../../src/constants";
import { DAY_MS, WORKSPACES, type CorpusEntry } from "./types";

export const COMMON_TOKENS = ["roadmap", "standup", "invoice"] as const;

export interface HaystackOptions {
  count: number;
  seed: number;
  commonRate: number;
  idPrefix: string;
  now: number;
  spanDays: number;
  cjkRate: number;
  longRate: number;
  workspaces: { workspaceId: string; actorId: string; weight: number }[];
}

type Pick = <T>(xs: readonly T[]) => T;
type Template = (pick: Pick, rand: () => number) => string;

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
  const companyWeight = options.workspaces.filter(workspace => workspace.workspaceId === WORKSPACES.company).reduce((sum, workspace) => sum + workspace.weight, 0);
  const companyFactor = companyWeight > 0 && companyWeight < totalWeight ? Math.min(1.9, totalWeight / companyWeight) : 1;
  const otherFactor = companyWeight < totalWeight ? (totalWeight - companyFactor * companyWeight) / (totalWeight - companyWeight) : 1;
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
  const sentence = () => TEMPLATES[Math.floor(rand() * TEMPLATES.length)](pick, rand);

  return Array.from({ length: options.count }, (_, index) => {
    const workspace = pickWorkspace();
    const long = rand() < options.longRate;
    let content = long ? Array.from({ length: 22 }, sentence).join(" ") : rand() < options.cjkRate ? cjkNote() : sentence();
    if (long) while (content.length <= CHUNK_MAX_CHARS) content += ` ${sentence()}`;
    const rate = options.commonRate * (workspace.workspaceId === WORKSPACES.company ? companyFactor : otherFactor);
    for (const token of COMMON_TOKENS) if (rand() < rate) content += ` ${pick(TAILS[token])}`;
    const createdAt = options.now - Math.floor(rand() * options.spanDays * DAY_MS);
    content += ` Logged ${new Date(createdAt).toISOString().slice(0, 16).replace("T", " at ")} UTC.`;
    return {
      id: `${options.idPrefix}-${String(index + 1).padStart(6, "0")}`,
      content,
      tags: [],
      source: "api",
      createdAt,
      workspaceId: workspace.workspaceId,
      actorId: workspace.actorId,
    };
  });
}
