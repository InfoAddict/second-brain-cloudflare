import type { GoldenQuery } from "../types";
import { buildCorpus } from "./build";
import { entry, finish, query, rng } from "./synthetic-common";
import type { CorpusSpec } from "./types";

interface Standing {
  /** "When ..." trigger clause, an infinitive and a noun phrase for the same situation. */
  when: string; inf: string; noun: string;
  action: string;
  /** Two different subjects that reuse the trigger's key word. */
  near: [string, string];
}

// Thirty distinct situations, one instruction each. No two share a subject, so a wrong fire is never a sibling variant.
export const STANDING: readonly Standing[] = [
  { when: "booking a flight", inf: "book a flight", noun: "the flight booking", action: "check the shared calendar for conflicts first", near: ["flight simulator game", "paper airplane flight physics"] },
  { when: "sending an invoice to a client", inf: "send an invoice to a client", noun: "the client invoice", action: "attach the signed purchase order", near: ["invoice font for the newsletter", "client mascot drawing"] },
  { when: "ordering lunch for the team", inf: "order lunch for the team", noun: "the team lunch order", action: "ask about allergies before choosing a menu", near: ["team lunch scene in the sitcom", "lunch box storage ideas"] },
  { when: "scheduling a dentist visit", inf: "schedule a dentist visit", noun: "the dentist appointment", action: "book it early in the day so it cannot slip", near: ["dentist character in the film", "visit hours of the science museum"] },
  { when: "merging a pull request", inf: "merge a pull request", noun: "the pull request merge", action: "wait for the full test run to finish", near: ["pull request analogy in the podcast", "merge lanes on the highway"] },
  { when: "packing for a trip abroad", inf: "pack for a trip abroad", noun: "the trip packing", action: "photograph the passport and keep the copy offline", near: ["packing tape brands", "abroad semester blog post"] },
  { when: "hiring a contractor for home repair", inf: "hire a contractor for a home repair", noun: "the contractor hiring", action: "get three written quotes before signing", near: ["contractor tax classification", "home repair television show"] },
  { when: "replying to a wedding invitation", inf: "reply to a wedding invitation", noun: "the wedding invitation reply", action: "answer within a week and note dietary needs", near: ["wedding invitation card design", "wedding playlist ideas"] },
  { when: "registering for a course", inf: "register for a course", noun: "the course registration", action: "read the refund policy before paying", near: ["course syllabus template", "golf course review"] },
  { when: "changing the budget", inf: "change the budget", noun: "the budget change", action: "record the reason in the finance log", near: ["budget airline comparison", "budget tent for camping"] },
  { when: "lending money to a friend", inf: "lend money to a friend", noun: "the friend loan", action: "only lend what I can afford to lose", near: ["money plant care", "friend recommendation for a novel"] },
  { when: "signing a lease", inf: "sign a lease", noun: "the lease signing", action: "have the landlord's insurance clause checked first", near: ["lease return of a leased car mileage", "signing off a chess tournament"] },
  { when: "buying a used car", inf: "buy a used car", noun: "the used car purchase", action: "pay for an independent inspection", near: ["car wash song lyrics", "used bookstore in the old town"] },
  { when: "starting a new medication", inf: "start a new medication", noun: "the new medication", action: "write down the start date and any side effects", near: ["medication names in crossword clues", "new moon photography"] },
  { when: "renewing the passport", inf: "renew the passport", noun: "the passport renewal", action: "start at least four months before expiry", near: ["passport photo booth locations", "renewing a library book"] },
  { when: "posting on social media about work", inf: "post on social media about work", noun: "the work social post", action: "get the manager's approval first", near: ["social media history essay", "work bench plans"] },
  { when: "installing a system update", inf: "install a system update", noun: "the system update", action: "back up the laptop first", near: ["update on the neighborhood bakery", "solar system model kit"] },
  { when: "accepting a meeting invite", inf: "accept a meeting invite", noun: "the meeting invite", action: "decline if there is no agenda", near: ["meeting point for the hike", "invite list for the picnic"] },
  { when: "cooking for guests", inf: "cook for guests", noun: "the guest dinner", action: "test the recipe once beforehand", near: ["cooking oil smoke points", "guests of the podcast episode"] },
  { when: "writing a performance review", inf: "write a performance review", noun: "the performance review", action: "list three concrete examples per point", near: ["performance of the orchestra", "book review site"] },
  { when: "paying the property tax", inf: "pay the property tax", noun: "the property tax payment", action: "pay by bank transfer and keep the receipt", near: ["property listing photos", "tax history of the coffee trade"] },
  { when: "adopting a pet", inf: "adopt a pet", noun: "the pet adoption", action: "visit the animal twice before deciding", near: ["pet peeve list", "adopting a highway cleanup stretch"] },
  { when: "buying a laptop", inf: "buy a laptop", noun: "the laptop purchase", action: "check the repair options and battery replacement cost", near: ["laptop stand woodworking", "buying guide for kayaks"] },
  { when: "moving to a new apartment", inf: "move to a new apartment", noun: "the apartment move", action: "photograph every room before unpacking", near: ["moving average formula", "apartment plant ideas"] },
  { when: "giving a presentation", inf: "give a presentation", noun: "the presentation", action: "rehearse aloud with a timer", near: ["giving tuesday charities", "presentation software history"] },
  { when: "reviewing a contract", inf: "review a contract", noun: "the contract review", action: "read the termination clause first", near: ["contract bridge strategy", "review of the new cafe"] },
  { when: "donating to charity", inf: "donate to a charity", noun: "the charity donation", action: "check the charity's rating and keep the receipt", near: ["charity shop find of a vase", "donating blood recovery tips"] },
  { when: "planning a road trip", inf: "plan a road trip", noun: "the road trip plan", action: "book the first and last night in advance", near: ["road bike tire pressure", "trip hop music playlist"] },
  { when: "taking on a new project at work", inf: "take on a new project at work", noun: "the new project", action: "write down the scope and what is excluded", near: ["project runway episode", "new year resolutions at work anniversaries"] },
  { when: "setting a password for a new account", inf: "set a password for a new account", noun: "the new account password", action: "generate it in the password manager", near: ["password for the old wifi router story", "savings account interest rates history"] },
];

const POSITIVE = [
  (s: Standing) => `I am about to ${s.inf}. What should I keep in mind?`,
  (s: Standing) => `Someone just asked me to ${s.inf}. Anything I told myself about that?`,
  // No relative-time phrase (Task 2's eval input note: parseTimePhrase must find none in this corpus).
  (s: Standing) => `Heads up: ${s.noun} is on my plate again.`,
  (s: Standing) => `Getting ready to ${s.inf}, what is my usual rule?`,
  (s: Standing) => `${s.noun[0].toUpperCase()}${s.noun.slice(1)} is coming up, remind me how I handle it.`,
];
const NEAR = [(p: string) => `Can you recommend something about ${p}?`, (p: string) => `What is the best ${p} this year?`];
const INTENT = [
  (s: Standing) => `What happened with the last time of ${s.noun}?`,
  (s: Standing) => `Summarize the history of ${s.noun}.`,
  (s: Standing) => `How much did ${s.noun} cost in total?`,
];
export const UNRELATED_QUERIES = 1140;

export function standing(seed: number): CorpusSpec {
  const rand = rng(seed + 2);
  const core = buildCorpus("core-1k");
  const entries = [...core.entries], queries: GoldenQuery[] = [];
  const split = (n: number) => (n % 2 ? "test" : "dev");
  STANDING.forEach((s, i) => {
    const id = `st-memory-${i}`;
    entries.push(entry(id, `When ${s.when}, ${s.action}.`, { ageDays: 20 + i, tags: ["standing"] }));
    const add = (n: string, text: string, group: string, gold: string[]) =>
      queries.push(query(`st-${group}-${i}-${n}`, "standing", text, gold, { clusterKey: id, tags: [`standing:${group}`, `split:${split(i)}`] }));
    POSITIVE.forEach((f, j) => add(String(j), f(s), "yes", [id]));
    s.near.forEach((p, j) => NEAR.forEach((f, k) => add(`${j}${k}`, f(p), "overlap", [])));
    INTENT.forEach((f, j) => add(String(j), f(s), "intent", []));
  });
  // Unrelated traffic: ordinary questions about the haystack, at a realistic share of all queries.
  const pool = core.queries.map(q => q.text);
  const seen = new Set<string>();
  for (let n = 0; seen.size < UNRELATED_QUERIES; n++) {
    const text = pool[Math.floor(rand() * pool.length)];
    if (seen.has(text)) continue;
    seen.add(text);
    queries.push(query(`st-unrelated-${seen.size}`, "standing", text, [], { clusterKey: `unrel-${seen.size}`, tags: ["standing:unrelated", `split:${split(seen.size)}`] }));
  }
  return finish("standing", seed, entries, queries, core.edges);
}
