import type { GoldenQuery } from "../types";
import { mulberry32 } from "../stats";
import { COMMON_TOKENS } from "./haystack";
import type { NeedleRow } from "./types";

/** Needles at least this old get a second, common-token-prefixed query: the shape that exposes LIKE's newest-500 window. */
export const OLD_NEEDLE_DAYS = 450;
/** Board item for underscore identifiers that the keyword arm cannot match. */
export const UNDERSCORE_GAP = "gap:T-0072";

/**
 * Identifier and rare-word queries, built only from a needle's declared keys.
 * Every keyed needle gets the key alone; old ones also get "roadmap <key>", the only common
 * token dense enough at every scale to push an old needle out of the LIKE window.
 */
export function mechanicalQueries(needles: readonly NeedleRow[]): GoldenQuery[] {
  const decoyed = new Set(needles.filter(n => n.id.endsWith("-decoy")).map(n => n.id.replace(/-decoy$/, "")));
  const counters = { identifier: 0, "rare-word": 0 };
  const out: GoldenQuery[] = [];
  for (const needle of needles) {
    if (needle.id.endsWith("-decoy") || !needle.keys?.length) continue;
    if (needle.purpose !== "identifier" && needle.purpose !== "rare-word") continue;
    const n = ++counters[needle.purpose];
    const id = `${needle.purpose === "identifier" ? "q-id" : "q-rare"}-${String(n).padStart(3, "0")}`;
    const key = needle.keys[0];
    // Production strips "_" from query tokens (a LIKE wildcard), so these keys are a measured gap, not an audit error.
    const tags = [...(decoyed.has(needle.id) ? ["tenancy"] : []), ...(key.includes("_") ? ["known-gap", UNDERSCORE_GAP] : [])];
    const byBlake = needle.purpose === "identifier" && needle.workspace === "company" && n % 2 === 1;
    const shared = {
      category: needle.purpose,
      gold: [{ id: needle.id, grade: 2 as const }],
      viewer: byBlake ? ("blake" as const) : ("avery" as const),
      ...(byBlake ? { layer: "company" as const } : {}),
      ...(tags.length ? { tags } : {}),
    };
    out.push({ id, text: key, ...shared });
    if (needle.ageDays >= OLD_NEEDLE_DAYS) {
      out.push({ id: `${id}-c`, text: `${COMMON_TOKENS[0]} ${key}`, ...shared });
    }
  }
  return out;
}

/** The answer sentence must start after this many chars, i.e. inside the second embedding chunk. */
const ANSWER_AFTER = 1700;
const LONG_TARGET = 3100;
const LONG_SEED = 6031;

const LEADS = [
  "Early on", "Around noon", "After the break", "Near the end", "At some point", "Just before two", "Once we sat down", "Later that day", "During the lull",
  "Right at the start", "After a pause", "Toward evening", "Halfway through", "On the way out", "Before the tea", "Around the room", "In the corridor",
  "At the back", "Over the noise", "Between items", "Without warning", "After the phone rang", "Once the door shut", "Past the halfway mark", "Before anyone left",
  "While we waited", "After some grumbling", "As the room warmed up", "Once the slides went dark", "Shortly after three", "In a quiet moment", "When the rain started",
  "As the light faded", "Right after the vote", "Once the printer jammed", "Before we broke for tea",
];
const SUBJECTS = [
  "Mira", "Tomas", "the host", "a neighbor", "Dana", "the chairman", "Jonas", "somebody at the end", "Lucia", "the newest person", "Hamid", "our note-taker",
  "Greta", "one of the regulars", "Anselm", "the coordinator", "Odile", "a guest", "Ruben", "the junior clerk", "Saskia", "the treasurer", "Idris", "the organizer",
  "Petra", "someone from the back", "Wilhelm", "a colleague", "Yusuf", "the person beside me", "Karin", "the moderator",
];
const ACTIONS = [
  "read out the attendance list", "asked whether the schedule still held", "sketched the layout on a napkin", "wondered aloud about the parking rules", "handed round a folder of printouts",
  "argued for a simpler arrangement", "recalled how the last attempt went", "offered to check the details by message", "pointed at a smudge on the screen", "suggested a shorter agenda next time",
  "collected the empty cups", "shared a photo from last spring", "found an error in the earlier figures", "proposed moving the discussion outdoors", "admitted to losing the original paperwork",
  "complained about a stubborn draft from the hallway", "asked for the door to be propped ajar", "compared two versions of the same schedule", "volunteered to tidy the shared folder",
  "described an awkward phone call from the week before", "questioned a number nobody had verified", "passed around a bag of dried apricots", "wrote a reminder on the back of a receipt",
  "explained a shortcut for filing the forms", "mentioned a leaflet that had gone missing", "corrected the spelling of a surname", "reminded us about the deadline for replies",
  "lent out a spare cable", "checked the clock and sighed", "brought up an old rota nobody could find", "asked for a moment to think", "offered a plain summary of the story so far",
  "spilled tea on a stack of handouts", "recommended a quieter room for next time", "counted the chairs twice", "turned the heating down a notch", "flagged a gap in the earlier notes",
  "repeated a point that had already been made", "asked who could carry the box downstairs", "swapped seats to see the board better",
];
const TAILS = [
  ", and nobody objected", ", which got a small laugh", ", though it went nowhere", ", so we moved on", " while the rest of us listened", ", and I wrote that down",
  ", which nobody had expected", " before the next item began", ", and the mood lifted a little", ", though only briefly", ", to general agreement", ", which took longer than planned",
  ", and it left a few questions unanswered", " without much conviction", ", and that seemed to settle it", ", which I only half followed", " and then went quiet",
  ", so I underlined it twice", " as if it were obvious", ", which made the next part easier", ", though nobody wrote it down", " to nobody in particular",
  ", and a few people nodded", ", which is worth remembering", " with a shrug", ", and the conversation wandered off", ", which explains why we ran over", " before checking the time again",
  ", and it stayed unresolved", ", which felt oddly reassuring", " for the third time that day", ", though the reasons stayed vague", ", so it went on the list to revisit", ", and that set the tone afterward",
  " in a low voice",
];

interface LongAnchor { id: string; workspace: NeedleRow["workspace"]; ageDays: number; title: string; opener: string; answer: string }

/** Title, opener and answer sentence per long-context note; padding between them is generated. */
export const LONG_ANCHORS: readonly LongAnchor[] = [
  { id: "n-long-001", workspace: "avery", ageDays: 30, title: "Home project log: the fuse box visit.", opener: "Spent the morning with the contractor going through the old cabinet in the hallway, taking photos of every label and writing down which rooms hang off which circuit.", answer: "By the end of the visit they quoted forty-two hundred for the panel swap and new breaker board, with the permit fee on top." },
  { id: "n-long-002", workspace: "avery", ageDays: 41, title: "Trip planning session: the northern island.", opener: "Sat down with Noor and the laptop to compare routes, and we argued for a while about whether a rental car is worth it in winter.", answer: "In the end we settled on the aisle seats at the back, row 34, because the window pair was already taken." },
  { id: "n-long-003", workspace: "company", ageDays: 52, title: "Quarterly retro notes.", opener: "The team gathered in the big room with sticky notes, and the first round of complaints was mostly about meeting length and unclear ownership.", answer: "The biggest surprise was that ramp-up time for new joiners fell from nine days to four after we deleted the welcome checklist." },
  { id: "n-long-004", workspace: "avery", ageDays: 63, title: "Kitchen renovation diary.", opener: "Day nine of the work: the cabinets are in, the dust is everywhere, and the dog has decided the hallway is now his territory.", answer: "The tiler said the grout needs a full week to cure, so nobody may scrub the floor until the following Monday." },
  { id: "n-long-005", workspace: "avery", ageDays: 74, title: "Weekend with the cousins.", opener: "Drove out on Saturday morning, got lost twice, and arrived just as lunch was being served on the long table under the walnut tree.", answer: "Aunt Ingrid mentioned that grandfather's watch is in the safe deposit box at the credit union, not at her house." },
  { id: "n-long-006", workspace: "company", ageDays: 85, title: "Notes from the security awareness workshop.", opener: "The session started with a quiz about passwords, and it turned out most of us reuse at least one that we should not.", answer: "The trainer's rule of thumb: if a message creates urgency and asks for gift cards, hang up and phone the sender on a known number." },
  { id: "n-long-007", workspace: "avery", ageDays: 96, title: "Garden season planning.", opener: "Walked the beds with a notebook, marking which corners get morning sun and which stay damp until noon, and sketched a rough layout.", answer: "Frost usually ends around the second week of May here, so tomatoes should stay indoors until then." },
  { id: "n-long-008", workspace: "company", ageDays: 107, title: "Board prep call.", opener: "Half an hour before the call I skimmed the deck and wrote down three questions I expected, mostly about hiring and burn.", answer: "Priya's number for the pilot was eleven thousand active accounts by June, which the board treated as the headline." },
  { id: "n-long-009", workspace: "avery", ageDays: 118, title: "Cycling club meeting.", opener: "Twelve of us squeezed into the back of the cafe, and the chairman opened with a reminder about helmets and lights.", answer: "Route for the charity ride is ninety kilometers, with the only serious climb after the lunch stop at the mill." },
  { id: "n-long-010", workspace: "company", ageDays: 129, title: "Interview debrief.", opener: "We compared scorecards over sandwiches, and the first thing everyone said was that the candidate communicated very clearly.", answer: "The candidate asked for a salary of ninety-five thousand and wanted two extra weeks of leave, both within our band." },
  { id: "n-long-011", workspace: "avery", ageDays: 140, title: "Car service appointment.", opener: "Dropped the car off at eight, walked to the cafe across the road, and spent an hour answering messages while it was on the lift.", answer: "The mechanic warned that the timing belt is due at sixty thousand miles and will run around eight hundred with labor." },
  { id: "n-long-012", workspace: "avery", ageDays: 151, title: "Language exchange evening.", opener: "Met my partner at the library annex, where we alternate twenty minutes in each language and try not to peek at the phone.", answer: "Her advice for pronunciation was to record myself reading a paragraph aloud and compare it with a native speaker every Sunday." },
  { id: "n-long-013", workspace: "avery", ageDays: 162, title: "Building association meeting.", opener: "About thirty residents came, more than usual, mostly because the agenda promised a fight about parking and it delivered.", answer: "The vote on the courtyard bench replacement passed nine to three, with work starting after the spring thaw." },
  { id: "n-long-014", workspace: "company", ageDays: 173, title: "Product review offsite, day two.", opener: "The morning was spent on the roadmap for the smaller products, and the discussion kept circling back to who owns support.", answer: "We agreed the launch name will be decided by a customer vote among the top three candidates, closing on the fifteenth." },
  { id: "n-long-015", workspace: "avery", ageDays: 184, title: "Doctor visit summary.", opener: "Arrived early, filled in the forms, and waited forty minutes with a magazine about sailing that I did not read.", answer: "The physiotherapist gave me three stretches for the shoulder, to be done twice daily for six weeks before any scan." },
  { id: "n-long-016", workspace: "avery", ageDays: 195, title: "Wedding planning call.", opener: "Priya and I talked for an hour about seating, and the first draft of the table plan already has two feuding uncles apart.", answer: "The venue needs the final headcount by the first of August, and every guest after that costs sixty-five extra." },
  { id: "n-long-017", workspace: "company", ageDays: 206, title: "Data migration runbook draft.", opener: "This runbook is a draft for the team to poke holes in; I listed prerequisites, owners, and the order of the dry runs.", answer: "Cutover is scheduled for Saturday at 02:00, with a rollback decision point at 04:30 if row counts disagree." },
  { id: "n-long-018", workspace: "avery", ageDays: 217, title: "Reading group evening.", opener: "Seven people came this time, and the host served soup, which kept the conversation friendly even when the opinions split.", answer: "Next month's pick is a short story collection set in a fishing village, and Elise volunteered to host." },
  { id: "n-long-019", workspace: "avery", ageDays: 228, title: "Pet care handover notes.", opener: "Wrote these for the neighbor before the trip, including which cupboard has the food and which drawer has the vet card.", answer: "The neighbor will feed the cat at seven and six, and the spare key is under the blue flowerpot." },
  { id: "n-long-020", workspace: "company", ageDays: 239, title: "Budget review with finance.", opener: "Finance sent the spreadsheet the night before, and I spent the evening cross-checking it against my own tracking sheet.", answer: "Cloud spend was forty percent over plan, almost entirely from the analytics cluster left running over the holidays." },
  { id: "n-long-021", workspace: "avery", ageDays: 250, title: "Volunteer day briefing.", opener: "The coordinator gathered everyone in the parking lot at the end of the previous shift to go through what tomorrow looks like.", answer: "Bring gloves and a hat, the shelter opens at nine, and the shuttle from the station leaves every twenty minutes." },
  { id: "n-long-022", workspace: "company", ageDays: 261, title: "Sprint planning, long version.", opener: "We spent the first hour grooming the backlog, and a few tickets were rewritten because nobody could explain what done meant.", answer: "Capacity for the sprint is thirty-one points because two people are out and one is on support rotation." },
  { id: "n-long-023", workspace: "avery", ageDays: 272, title: "Apartment viewing notes.", opener: "Saw three places in one afternoon, and by the third I could no longer remember which had the good light.", answer: "The second flat had south-facing windows, but the monthly rent was fourteen hundred and the lease required a year." },
  { id: "n-long-024", workspace: "company", ageDays: 283, title: "Conference travel debrief.", opener: "Flew back last night, slept badly, and started writing this on the train before I forgot the sequence of events.", answer: "The reimbursement form wants original receipts within thirty days, otherwise the hotel portion is taxable income." },
];

/**
 * Long-context needles: title and opener, then seeded padding until the answer sentence lands past the
 * first chunk, then more padding. Every padding sentence is unique across all notes, so notes share
 * only a vocabulary of clauses, never whole sentences.
 */
export function longContextNeedles(): NeedleRow[] {
  const rand = mulberry32(LONG_SEED);
  const pick = <T>(items: readonly T[]) => items[Math.floor(rand() * items.length)];
  const used = new Set<string>();
  const pad = () => {
    for (;;) {
      const sentence = `${pick(LEADS)}, ${pick(SUBJECTS)} ${pick(ACTIONS)}${pick(TAILS)}.`;
      if (!used.has(sentence)) { used.add(sentence); return sentence; }
    }
  };
  return LONG_ANCHORS.map(anchor => {
    const parts = [anchor.title, anchor.opener];
    while (parts.join(" ").length < ANSWER_AFTER) parts.push(pad());
    parts.push(anchor.answer);
    while (parts.join(" ").length < LONG_TARGET) parts.push(pad());
    return { id: anchor.id, content: parts.join(" "), tags: ["log"], workspace: anchor.workspace, ageDays: anchor.ageDays, purpose: "long-context" as const };
  });
}
