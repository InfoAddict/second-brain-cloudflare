import type { GoldenQuery } from "../types";
import { entry, finish, pick, pseudoWords, query, rng } from "./synthetic-common";
import type { CorpusEntry, CorpusSpec } from "./types";

/** One identical footer reused by every sender, as templated transactional mail reuses it (Aug 16 mechanism). */
export const NOISE_FOOTER = [
  "Thanks for choosing us. Sign in to your account to view details.",
  "Sign in to your account any time from the app or the website. Follow us on social media for news and tips.",
  "Download our app from the App Store or Google Play. Thanks for choosing us, and follow us on social media.",
  "Need help? Sign in to your account and open the help center, or call the number on the back of your card.",
  "This message was sent to the address on file for your account. Do not reply to this email. Sign in to manage your notification settings.",
  "Privacy policy and legal terms apply. Terms of service, privacy policy, and legal disclosures are available when you sign in to your account.",
  "Follow us on social media. Download our app. Thanks for choosing us. Sign in to your account to view your latest activity and statements.",
].join(" ");

const CITIES = ["Lisbon", "Denver", "Osaka", "Tallinn", "Nairobi", "Quito", "Perth", "Oslo", "Lima", "Hanoi", "Porto", "Seville", "Krakow", "Bergen", "Cusco", "Split", "Turin", "Malmo", "Zagreb", "Riga", "Bilbao", "Tbilisi", "Sofia", "Cork", "Faro", "Graz", "Kyoto", "Cebu", "Nagoya", "Salta"];
const AIRLINES = ["Northwind", "Skyline", "Coastal", "Meridian", "Aurora"];
const DRUGS = ["amoxicillin", "loratadine", "ibuprofen", "cetirizine", "omeprazole", "metformin", "lisinopril", "sertraline", "albuterol", "naproxen", "prednisone", "atorvastatin", "montelukast", "famotidine", "azithromycin"];
const UTILITIES = ["electric", "water", "gas", "internet", "trash", "sewer", "solar", "phone", "cable", "heating", "recycling", "irrigation", "security", "storage", "parking"];
const NOUNS = ["name", "datastore", "color", "font", "venue", "vendor", "laptop", "template", "schedule", "logo"];
const TARGETS = ["new feature", "spring workshop", "office move"];
const FAVORS = ["the ride to the airport", "lending the ladder", "watching the dog", "fixing the bike", "the spare key", "carrying the boxes", "covering my shift", "the loan of a projector", "proofreading the report", "the plant cuttings", "the borrowed tent", "help with the taxes", "the recipe", "the concert tickets", "the sourdough starter", "the paint samples", "the babysitting", "the tool loan", "the hotel tip", "the introduction"];
const PEOPLE = ["Mira", "Devon", "Priya", "Tomas", "Ingrid", "Caleb", "Noor", "Jonas", "Lena", "Omar", "Sana", "Felix", "Yuki", "Ana", "Bram", "Cora", "Dara", "Eli", "Faye", "Gus"];
const ACCOUNT_TOPICS = ["the shared photo library", "the team password vault", "the family streaming plan", "the club membership", "the co-op newsletter", "the library card", "the community garden", "the bike share", "the neighborhood forum", "the volunteer roster"];
const APPS = ["meditation timer", "language flashcards", "budget tracker", "plant identifier", "sleep log", "running coach", "recipe box", "expense splitter", "star map", "habit streaks"];

const money = (n: number) => `$${n.toLocaleString("en-US")}.${String(n * 7 % 100).padStart(2, "0")}`;

export function noise(seed: number): CorpusSpec {
  const rand = rng(seed);
  const entries: CorpusEntry[] = [], queries: GoldenQuery[] = [];
  const mail = (id: string, sender: string, subject: string, body: string) =>
    entries.push(entry(id, `From: ${sender}\nSubject: ${subject}\n${body}\n${NOISE_FOOTER}`, { source: "email-gmail", ageDays: 1 + Math.floor(rand() * 120) }));
  const note = (id: string, text: string) => entries.push(entry(id, text, { source: "api", ageDays: 5 + Math.floor(rand() * 100) }));
  const ask = (n: number, id: string, text: string, gold: string | string[], subset: string) =>
    queries.push(query(`nz-q-${id}-${n}`, "noise", text, Array.isArray(gold) ? gold : [gold], { clusterKey: `nz-${id}-${n}`, tags: [`subset:${subset}`] }));

  // Recurring near-identical notices: one sender, one template, only the amount and reference differ.
  const amounts = new Set<number>();
  while (amounts.size < 90) amounts.add(1000 + Math.floor(rand() * 3000));
  // Batches of three notices share a payroll batch code, so a batch question has three golds among 90 near-identical notices.
  [...amounts].forEach((amount, i) => mail(`nz-deposit-${i}`, "alerts@harborcu.example", "Your direct deposit is complete", `Your direct deposit of ${money(amount)} is complete. Payroll batch PB${String(Math.floor(i / 3) + 1).padStart(2, "0")}. Reference DD${100000 + i * 37}.`));
  for (let k = 0; k < 30; k++) ask(k, "recurring", `Show the direct deposits from payroll batch PB${String(k + 1).padStart(2, "0")}`, [0, 1, 2].map(j => `nz-deposit-${k * 3 + j}`), "recurring");
  [...amounts].slice(0, 10).forEach((amount, i) => ask(i, "recurring-amount", `Find the direct deposit of ${money(amount)}`, [`nz-deposit-${i}`], "recurring"));

  // Airline mail (unique city per booking), each with a genuine decision note about the same trip.
  CITIES.forEach((city, i) => {
    const airline = AIRLINES[i % AIRLINES.length];
    mail(`nz-flight-${i}`, `bookings@${airline.toLowerCase()}air.example`, `Booking confirmed: ${city}`, `Your ${airline} flight to ${city} is confirmed. Confirmation code ${airline.slice(0, 2).toUpperCase()}${city.slice(0, 2).toUpperCase()}${(i * 13) % 90 + 10}. Departs at ${6 + i % 12}:${i % 2 ? "40" : "15"}.`);
  });
  CITIES.slice(0, 15).forEach((city, i) => {
    note(`nz-flightnote-${i}`, `Decided on ${AIRLINES[(i + 2) % AIRLINES.length]} for the ${city} trip because the layover is shortest and the fare was the lowest.`);
    ask(i, "flight-note", `Which airline did I decide on for the ${city} trip and why?`, `nz-flightnote-${i}`, "note-same-topic");
  });
  CITIES.slice(0, 30).forEach((city, i) => {
    ask(i, "flight-mail", i % 2 ? `In my email, what is the confirmation code for my flight to ${city}?` : `What is the confirmation code for the ${city} flight booking?`, `nz-flight-${i}`, "email-control");
  });

  // Pharmacy mail plus decision notes.
  DRUGS.forEach((drug, i) => mail(`nz-rx-${i}`, "pickup@corner-pharmacy.example", `Your ${drug} prescription is ready`, `Your ${drug} refill is ready for pickup at the front counter until Friday. Order ${5000 + i * 11}.`));
  DRUGS.slice(0, 10).forEach((drug, i) => {
    note(`nz-rxnote-${i}`, `Asked the doctor whether to keep taking ${drug}; the plan is to review it after the next checkup.`);
    ask(i, "rx-note", `What did I decide with the doctor about ${drug}?`, `nz-rxnote-${i}`, "note-same-topic");
  });
  DRUGS.forEach((drug, i) => ask(i, "rx-mail", i % 2 ? `According to my email, when can I pick up the ${drug} refill?` : `Is the ${drug} prescription ready for pickup?`, `nz-rx-${i}`, "email-control"));

  // Utility bills: unique reference per bill, decision notes for some.
  UTILITIES.forEach((kind, i) => mail(`nz-bill-${i}`, `billing@${kind}-co.example`, `Your ${kind} bill is ready`, `Your ${kind} statement of ${money(40 + i * 9)} is due on the ${10 + i}th. Account ${kind.toUpperCase().slice(0, 3)}-${7000 + i * 19}.`));
  UTILITIES.forEach((kind, i) => note(`nz-billnote-${i}`, `Switching the ${kind} provider is not worth it; I compared three quotes and the current plan is fine.`));
  UTILITIES.forEach((kind, i) => ask(i, "bill-note", `Did I decide to switch the ${kind} provider?`, `nz-billnote-${i}`, "note-same-topic"));
  UTILITIES.forEach((kind, i) => ask(i, "bill-mail", i % 2 ? `In my email, when is the ${kind} bill due and what is the account number?` : `What is the ${kind} account number on the latest statement?`, `nz-bill-${i}`, "email-control"));

  // More senders with their own templates fill out the mailbox; every one ends in the same footer.
  const senders: [string, (i: number) => [string, string]][] = [
    ["orders@slicehouse.example", i => [`Your order #${2000 + i} is on its way`, `Your ${pick(rand, ["margherita", "veggie", "pepperoni", "mushroom"])} pizza order is out for delivery.`]],
    ["statements@rentacar.example", i => [`Your rental statement ${9000 + i}`, `Your rental from the ${pick(rand, ["airport", "downtown", "station"])} branch ended with a total of ${money(80 + i)}.`]],
    ["trades@brokerly.example", i => [`Trade confirmation available`, `Your trade ${300 + i} executed and the confirmation is available in your documents.`]],
    ["billing@streamly.example", i => [`Your subscription renews soon`, `Your plan renews in ${3 + i % 9} days at ${money(9 + i % 7)}.`]],
    ["noreply@cardco.example", i => [`Your statement is ready`, `Your statement closing balance is ${money(200 + i * 3)}. Minimum payment ${money(25)}.`]],
    ["updates@zippay.example", i => [`You sent a payment`, `You sent ${money(15 + i * 2)} to ${pick(rand, PEOPLE)}. Transfer ${8000 + i}.`]],
  ];
  senders.forEach(([sender, make], s) => { for (let i = 0; i < 40; i++) { const [subject, body] = make(i); mail(`nz-mail-${s}-${i}`, sender, subject, body); } });

  // Off-topic probes: they share only footer words with the mail; the answer is a genuine note that does not repeat the footer word.
  const words = pseudoWords(70, seed + 5);
  // The note answers in synonyms only, as a real preference memory rarely repeats the words of a later question.
  const NOUN_SYN: Record<string, string> = { name: "title", datastore: "database", color: "paint shade", font: "typeface", venue: "hall", vendor: "supplier", laptop: "notebook computer", template: "layout", schedule: "timetable", logo: "emblem" };
  const TARGET_SYN: Record<string, string> = { "new feature": "upcoming release", "spring workshop": "april class", "office move": "relocation" };
  let p = 0;
  for (const noun of NOUNS) for (const target of TARGETS) {
    const id = `nz-probe-${p}`;
    note(id, `For the ${TARGET_SYN[target]}, the ${NOUN_SYN[noun]} I keep coming back to is ${words[p]}, over ${words[p + 35]}.`);
    ask(p, "probe", p % 2 ? `User is choosing a ${noun} for the ${target}, what should I know?` : `choosing a ${noun} for the ${target}`, id, "probe-footer-synonym");
    p++;
  }
  FAVORS.forEach((favor, i) => {
    const id = `nz-probe-${p}`;
    note(id, `Sent a card to ${PEOPLE[i]} about ${favor}; ${words[p]} wrote back to say it was no trouble.`);
    ask(p, "probe", i % 2 ? `thanks to whom for ${favor}` : `who did I thank for ${favor}`, id, "probe-footer-words");
    p++;
  });
  ACCOUNT_TOPICS.forEach(topic => {
    const id = `nz-probe-${p}`;
    note(id, `Household login for ${topic} is held by ${words[p]}; the recovery details are in the drawer.`);
    ask(p, "probe", `how did I set up the sign in for ${topic}`, id, "probe-footer-words");
    p++;
  });
  APPS.forEach(app => {
    const id = `nz-probe-${p}`;
    note(id, `Picked the ${app} called ${words[p]} because it works without any registration.`);
    ask(p, "probe", `which ${app} app did I decide to download`, id, "probe-footer-words");
    p++;
  });

  // Ordinary notes that reuse footer words without answering any query.
  for (let f = 0; f < 150; f++) note(`nz-filler-${f}`, `${pick(rand, ["Thanks", "Follow up", "Reminder", "Idea"])}: ${pick(rand, ["choosing", "sign in", "download", "privacy", "account", "legal review"])} for the ${pick(rand, ["garden", "kitchen", "workshop", "class", "budget"])} ${words[f % words.length].toLowerCase()} project is still open.`);

  return finish("noise", seed, entries, queries);
}
