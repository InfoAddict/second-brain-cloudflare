import type { GoldenQuery } from "../types";
import { mulberry32 } from "../stats";
import { COMMON_TOKENS } from "./haystack";
import { LONG_ANCHORS } from "./long-anchors";
import type { NeedleRow } from "./types";

/** Needles at least this old get a second, common-token-prefixed query: the shape that exposes LIKE's newest-500 window. */
export const OLD_NEEDLE_DAYS = 450;
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
    const tagsFor = () => (decoyed.has(needle.id) ? ["tenancy"] : []);
    const byBlake = needle.purpose === "identifier" && needle.workspace === "company" && n % 2 === 1;
    const shared = {
      category: needle.purpose,
      gold: [{ id: needle.id, grade: 2 as const }],
      viewer: byBlake ? ("blake" as const) : ("avery" as const),
      ...(byBlake ? { layer: "company" as const } : {}),
    };
    const tagged = () => (tagsFor().length ? { tags: tagsFor() } : {});
    out.push({ id, text: key, ...shared, ...tagged() });
    if (needle.ageDays >= OLD_NEEDLE_DAYS) {
      out.push({ id: `${id}-c`, text: `${COMMON_TOKENS[0]} ${key}`, ...shared, ...tagged() });
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
    return { id: anchor.id, content: parts.join(" "), tags: ["log"], workspace: anchor.workspace, ageDays: anchor.ageDays, purpose: "long-context" as const, ...(anchor.importance === undefined ? {} : { importance: anchor.importance }) };
  });
}
