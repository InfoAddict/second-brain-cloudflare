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

/**
 * Sources this corpus uses from each Track 3 class (`src/memory/source-class.ts`'s eventual rule). `codex-session`
 * and `cursor-session` are NOT YET in `src/constants.ts`'s `TRANSCRIPT_SOURCES` (only `claude-code` is, as of this
 * round); they are the two new automatic-transcript clients Track 3 is adding, so the corpus is built for the
 * classification ahead of the source landing, the same way the corpus otherwise never touches `src/`.
 */
export const NOISE_MIRROR_SOURCES = ["email-gmail"] as const;
export const NOISE_TRANSCRIPT_SOURCES = ["codex-session", "cursor-session"] as const;

/** Shared wrapper text every codex-session excerpt carries, the transcript analogue of the mail footer. */
const CODEX_OPEN = "Session log (codex-session, repo secondbrain-cloudflare, last 3 turns):";
const CODEX_CLOSE = "Full transcript remains in the IDE's session history; this is an automatic excerpt.";
/** Shared wrapper text every cursor-session excerpt carries. */
const CURSOR_OPEN = "Cursor AI pane, last 3 turns of the conversation:";
const CURSOR_CLOSE = "See the Cursor session panel for the complete exchange.";

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

/** Payroll-adjacent decisions: distinct from the recurring deposit notices' wording, but sharing "paycheck" / "deposit" / "account" vocabulary that the keyword arm matches against all 90 of them at once. */
/**
 * Payroll-adjacent decisions, as a query/note pair: the query literally says "direct deposit" or "payroll", the
 * words the keyword arm matches against all 90 near-identical deposit notices at once; the note answers in
 * different words entirely, the same synonym discipline the footer probes below use, so nothing about the note
 * itself can out-compete the mail on lexical grounds and the crowding is real rather than trivially dodged.
 */
const PAYROLL_QUERY = [
  "how my direct deposit is split between two bank accounts", "switching which payroll processor handles my direct deposit at work", "changing my tax withholding on the payroll form after the raise",
  "moving my direct deposit from biweekly to monthly", "setting up an automatic transfer into savings from each payroll deposit", "adding a dependent to my payroll benefits",
  "adjusting my retirement contribution percentage on the payroll portal", "opting into early access to my payroll deposit", "changing which bank receives my payroll direct deposit",
  "consolidating the two checking accounts my direct deposit used to split between", "keeping a paper pay stub mailed home instead of the payroll portal", "signing up for the new payroll benefits portal",
  "keeping overtime pay in a separate account from the regular payroll deposit", "choosing a budgeting app to track the payroll deposits", "splitting a bonus between spending and savings instead of the usual payroll deposit",
  "asking payroll to fix a rounding error in the direct deposit", "moving my emergency fund out of the account that shares my payroll direct deposit", "changing the default savings percentage on my payroll deposit",
];
const PAYROLL_NOTE = [
  "moved the recurring pay into two accounts instead of one, roughly a third into savings", "kept the same processor after checking what switching would actually save", "bumped the withholding up one bracket after doing the math on the raise",
  "kept the pay schedule as is; switching cadence was not worth the hassle", "set an automatic sweep of a fixed amount into savings on each pay date", "added the dependent after confirming the paperwork with HR",
  "raised the retirement contribution by two points", "decided against the early-access option after reading the fine print", "moved the pay split to the newer bank once the old one raised its fees",
  "closed the older of the two checking accounts and moved everything to the one that stayed", "kept the mailed stub for now since the portal login has been flaky", "signed up for the new benefits portal after confirming it kept the same login",
  "kept overtime pay flowing to the main account rather than splitting it out", "picked a plain spreadsheet over a paid app to track the deposits", "put most of the bonus into savings and kept a small amount for spending",
  "got the rounding error corrected after flagging it to HR", "moved the emergency fund to a bank with no ties to work pay at all", "raised the default savings cut by five percent",
];

/** Software-decision topics: a transcript excerpt discusses one inconclusively; a genuine note records the actual decision. */
const DEV_TOPICS = [
  "the caching layer", "the retry policy", "the queue library", "the auth flow", "the migration tool", "the logging format", "the test runner",
  "the CI pipeline", "the config loader", "the error boundary", "the pagination scheme", "the rate limiter", "the flag-based rollout system", "the search index",
  "the notification service", "the webhook retries", "the session store", "the file upload limit", "the background job queue", "the API version scheme",
  "the schema validation library", "the deployment pipeline", "the feature branch strategy", "the code formatter", "the dependency injection setup",
  "the metrics dashboard", "the alerting thresholds", "the database connection pool", "the request timeout", "the graceful shutdown logic",
];

/**
 * Crowding-only decisions, as a query/note pair: the query shares "test" / "push" / "lint" / "CI" vocabulary with
 * the recurring chore transcripts (not with its own note), the transcript analogue of PAYROLL_QUERY/PAYROLL_NOTE.
 */
const CROWD_QUERY = [
  "whether flaky browser tests should block a push", "how many retries a failing CI job gets before paging anyone", "whether lint warnings should fail the build or just warn",
  "how long a slow integration test may run before it times out", "whether a green test run is required before a merge on Fridays", "who gets paged when the nightly test run fails twice in a row",
  "whether the test suite should run on every commit or only on push to main", "how flaky a test has to be before it gets quarantined",
  "whether a failing lint check should block the push or just warn in the log", "how often the CI cache should be invalidated", "whether the build should fail on a single skipped test",
  "who reviews a pull request whose tests are still running", "whether a hotfix branch skips the full test run", "how long CI keeps old build artifacts",
  "whether a merge queue is worth the wait over pushing straight to main", "whether test coverage under 80 percent should block a push",
  "how many parallel test shards the CI job should run", "whether a red build on main pages the on-call engineer immediately",
];
const CROWD_NOTE = [
  "moved the unreliable browser checks to a nightly job so they never hold up shipping", "capped the automatic retry count at two before waking someone up", "kept style warnings non-blocking; only real errors stop the build",
  "gave the slow suite a longer time budget instead of trimming it further", "no special Friday rule; the normal merge checks already cover it", "the on-call rotation owns it after the second failure, not before",
  "kept it running on every commit; the extra minutes were worth catching issues early", "three failures in a week moves a check to the quarantine list",
  "made lint advisory only; nothing failing should be a formatting nit", "cleared the cache weekly instead of on every dependency bump", "a skipped one warns but does not fail anything",
  "reviews can start early; merging still waits for green", "hotfixes still run the full suite; there is no shortcut for those", "old artifacts are pruned after two weeks to save storage",
  "added the queue; a short wait beats untangling a broken main", "coverage is tracked but does not block anything yet",
  "settled on four after timing a few options", "a red main pages right away; it used to wait for the next scheduled check",
];

const money = (n: number) => `$${n.toLocaleString("en-US")}.${String(n * 7 % 100).padStart(2, "0")}`;

export function noise(seed: number): CorpusSpec {
  const rand = rng(seed);
  const entries: CorpusEntry[] = [], queries: GoldenQuery[] = [];
  const mail = (id: string, sender: string, subject: string, body: string) =>
    entries.push(entry(id, `From: ${sender}\nSubject: ${subject}\n${body}\n${NOISE_FOOTER}`, { source: "email-gmail", ageDays: 1 + Math.floor(rand() * 120) }));
  const note = (id: string, text: string) => entries.push(entry(id, text, { source: "api", ageDays: 5 + Math.floor(rand() * 100) }));
  const codex = (id: string, turns: string) => entries.push(entry(id, `${CODEX_OPEN}\n${turns}\n${CODEX_CLOSE}`, { source: "codex-session", ageDays: 1 + Math.floor(rand() * 120) }));
  const cursor = (id: string, turns: string) => entries.push(entry(id, `${CURSOR_OPEN}\n${turns}\n${CURSOR_CLOSE}`, { source: "cursor-session", ageDays: 1 + Math.floor(rand() * 120) }));
  // Dev/test split, T-0089.3.5 director addition: Track 3 tunes source weights, the occupancy cap and the
  // near-duplicate collapse against this corpus, so the gate that judges the tuned result must be scored on a
  // held-out half tuning never saw, the same way `standing` withholds a split. Split by cluster (here, by query:
  // every cluster in this corpus is exactly one query, so the two coincide), skewed 70/30 rather than an even half
  // so the test half alone clears the gate's 200-query floor on its own (see SYNTHETIC-CORPORA.md for the exact
  // counts). Keyed by a hash of the query's own id, not a global sequential counter: a counter's phase against a
  // subset's generation order can put a whole contiguous run of one subset's hardest (or easiest) cases on the same
  // side by chance. Confirmed live: with a sequential counter, every genuinely recoverable transcript-crowding case
  // (gold buried mid-pack, not at rank 1 and not missing outright) landed in dev, so the test half showed no
  // improvement at all from a fix that demonstrably worked (traced by hand on the dev-side queries). A hash of the
  // id has no relationship to generation order, so it cannot reproduce that correlation.
  const splitHash = (key: string): "dev" | "test" => {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
    return Math.abs(h) % 10 < 7 ? "test" : "dev";
  };
  const ask = (n: number, id: string, text: string, gold: string | string[], subset: string) => {
    const queryId = `nz-q-${id}-${n}`;
    queries.push(query(queryId, "noise", text, Array.isArray(gold) ? gold : [gold], { clusterKey: `nz-${id}-${n}`, tags: [`subset:${subset}`, `split:${splitHash(queryId)}`] }));
  };

  // ── Mail ──────────────────────────────────────────────────────────────────

  // Recurring near-identical notices: one sender, one template, only the amount and reference differ.
  const amounts = new Set<number>();
  while (amounts.size < 90) amounts.add(1000 + Math.floor(rand() * 3000));
  // Batches of three notices share a payroll batch code, so a batch question has three golds among 90 near-identical notices.
  [...amounts].forEach((amount, i) => mail(`nz-deposit-${i}`, "alerts@harborcu.example", "Your direct deposit is complete", `Your direct deposit of ${money(amount)} is complete. Payroll batch PB${String(Math.floor(i / 3) + 1).padStart(2, "0")}. Reference DD${100000 + i * 37}.`));
  for (let k = 0; k < 30; k++) ask(k, "recurring", `Show the direct deposits from payroll batch PB${String(k + 1).padStart(2, "0")}`, [0, 1, 2].map(j => `nz-deposit-${k * 3 + j}`), "recurring");
  [...amounts].slice(0, 10).forEach((amount, i) => ask(i, "recurring-amount", `Find the direct deposit of ${money(amount)}`, [`nz-deposit-${i}`], "recurring"));

  // Near-duplicate crowding: a genuine payroll-adjacent decision the same 90 deposit notices try to bury. The
  // query, not the note, carries the "direct deposit" / "payroll" words that pull the 90 near-duplicates in. Each
  // note also gets a unique, rare tag word (the same trick probe-footer-synonym's notes use below): 18 short
  // decision sentences in the same register are otherwise close enough in embedding space to bury each other
  // instead of the mail, confirmed live in this round's second draft, before the tag was added. Three phrasings
  // per topic, all pointing at the same note: run against the real recorded baseline, only a fraction of any one
  // topic's phrasings land where a fix can reach (gold already first, or gold pushed out past the top 10 the
  // report can see, are both unaffected by design; only the middle is recoverable), so the subset needs enough
  // queries for that fraction to add up to a headline-visible gain, confirmed live in this round's third draft.
  const tags = pseudoWords(60, seed + 23);
  const decisionAsk = (topic: string) => [`What did I decide about ${topic}?`, `Do you remember what I decided about ${topic}?`, `Remind me what I decided about ${topic}.`];
  const weDecisionAsk = (topic: string) => [`What did we decide about ${topic}?`, `Do you remember what we decided about ${topic}?`, `Remind me what we decided about ${topic}.`];
  PAYROLL_QUERY.forEach((topic, i) => {
    const id = `nz-payroll-${i}`;
    note(id, `${PAYROLL_NOTE[i]}, filed under the household tag ${tags[i]}.`);
    decisionAsk(topic).forEach((text, v) => ask(i * 3 + v, "mail-crowding", text, id, "mail-crowding"));
  });

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

  // Footer-overlap probes: the query shares a handful of footer words with every piece of mail; the answer is a
  // genuine note that repeats none of them (synonyms only), so nothing but the mail's shared boilerplate can pull
  // mail above it. Filler notes below use a disjoint vocabulary so they cannot win this competition by accident
  // (the T-0089.3.5 rebuild's fix: round 2 found the old filler notes reused these exact trigger words and beat
  // the mail itself, so the corpus never measured the mail attractor it was built to test).
  const words = pseudoWords(70, seed + 5);
  const NOUN_SYN: Record<string, string> = { name: "title", datastore: "database", color: "paint shade", font: "typeface", venue: "hall", vendor: "supplier", laptop: "notebook computer", template: "layout", schedule: "timetable", logo: "emblem" };
  const TARGET_SYN: Record<string, string> = { "new feature": "upcoming release", "spring workshop": "april class", "office move": "relocation" };
  let p = 0;
  // Three phrasings per (noun, target) pair, one shared note: the same statistical-weight reasoning as the
  // mail-crowding paraphrases above, confirmed live to matter for this subset specifically.
  const synonymAsk = (noun: string, target: string) => [`choosing a ${noun} for the ${target}`, `User is choosing a ${noun} for the ${target}, what should I know?`, `Which ${noun} did I pick for the ${target}?`];
  for (const noun of NOUNS) for (const target of TARGETS) {
    const id = `nz-probe-${p}`;
    note(id, `For the ${TARGET_SYN[target]}, the ${NOUN_SYN[noun]} I keep coming back to is ${words[p]}, over ${words[p + 35]}.`);
    synonymAsk(noun, target).forEach((text, v) => ask(p * 3 + v, "probe-syn", text, id, "probe-footer-synonym"));
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

  // Ordinary filler notes: disjoint vocabulary from the probes and the footer (gardening/weather/routine chatter,
  // none of "choosing", "sign in", "download", "account", "privacy", "legal", "follow", "help center", "app store")
  // AND from the transcript-control phrasing below ("said", "discuss", "session"). Their only job is mailbox-
  // adjacent bulk; they must never be able to win a probe or control query by accidental word match (the T-0089.3.5
  // rebuild's fix, twice over: round 2 found the old filler notes reused the mail probes' trigger words, and this
  // round's own first draft reused "said" from "what was said about", the transcript-control phrasing below).
  const fillerWords = pseudoWords(40, seed + 11);
  const FILLER_VERB = ["Watered", "Repotted", "Weeded", "Pruned", "Mulched", "Composted", "Trimmed", "Raked"];
  const FILLER_NOUN = ["tomatoes", "basil", "hedge", "gutter", "porch light", "bike chain", "bookshelf", "spare key hook"];
  for (let f = 0; f < 40; f++) note(`nz-filler-${f}`, `${pick(rand, FILLER_VERB)} the ${pick(rand, FILLER_NOUN)} on ${pick(rand, ["Tuesday", "Saturday", "the long weekend", "the way home"])}; ${fillerWords[f]} left it looking better than before.`);

  // ── Transcripts (codex-session, cursor-session): T-0089.3.5 director addition ──────────────────────────────────

  // Recurring near-identical chore excerpts: one shape, one wrapper, only the run number, group and counts differ.
  // The group label is embedded the same way mail embeds "Payroll batch PBxx": without it, a batch question has no
  // text anywhere in the corpus tying three specific runs to "group G01", and recall has nothing to find (this
  // round's own first draft made exactly that mistake; recall@5 on the batch queries was 0.40, confirmed by running
  // the real embedding pipeline, not reasoned about).
  const runNums = new Set<number>();
  while (runNums.size < 60) runNums.add(100 + Math.floor(rand() * 900));
  const chore = (i: number, runId: number) => `User: can you run the full test suite before I push?\nAssistant: Ran npm test for CI run ${runId}, group G${String(Math.floor(i / 3) + 1).padStart(2, "0")}: ${110 + (i % 40)} passed, 0 failed, finished in ${10 + i % 20}.${i % 10}s. Lint clean.\nUser: great, push it then.`;
  [...runNums].forEach((runId, i) => (i % 2 ? cursor : codex)(`nz-chore-${i}`, chore(i, runId)));
  for (let k = 0; k < 20; k++) ask(k, "transcript-recurring", `Show the CI runs from group G${String(k + 1).padStart(2, "0")}`, [0, 1, 2].map(j => `nz-chore-${k * 3 + j}`), "transcript-recurring");
  [...runNums].slice(0, 10).forEach((runId, i) => ask(i, "transcript-recurring-lookup", `Find the CI run numbered ${runId}`, [`nz-chore-${i}`], "transcript-recurring"));

  // Near-duplicate crowding: a genuine CI-policy decision the same 60 chore excerpts try to bury. As with
  // PAYROLL_QUERY/PAYROLL_NOTE above, the query carries the "test" / "push" / "CI" words and the note does not,
  // and each note gets its own rare tag word so the 18 short CI-policy notes cannot bury each other either. Three
  // phrasings per topic, same reasoning as mail-crowding above.
  CROWD_QUERY.forEach((topic, i) => {
    const id = `nz-crowd-${i}`;
    note(id, `${CROWD_NOTE[i]}, filed under the ticket tag ${tags[18 + i]}.`);
    weDecisionAsk(topic).forEach((text, v) => ask(i * 3 + v, "transcript-crowding", text, id, "transcript-crowding"));
  });

  // Dev-topic transcripts (a status check, not a decision) plus the genuine decision note that settles each one.
  // Wording varies per topic (not one uniform template) and repeats the topic three times, so 30 of these do not
  // crowd each other out the way one fixed template did in this round's first draft (confirmed live: a topic's own
  // note lost to two or three OTHER topics' transcripts, not to its own, because the boilerplate dominated the
  // topic words). The framing here (a status check) also avoids "choosing" / "should we do X or Y", which in the
  // same first draft collided with the mail probes' own "choosing a NOUN for the TARGET" trigger words closely
  // enough that dev-topic transcripts, not mail, became the mail probes' own top blockers.
  const devFraming = ["any changes worth flagging", "anything blocking it right now", "is it still on the default setup", "does it need attention before the next release"];
  const devStatus = ["hasn't moved since the last check", "is still on the starter template's default", "is stable, nothing new to report", "is fine for now but worth another look later"];
  DEV_TOPICS.forEach((topic, i) => {
    const turns = `User: quick check on ${topic}, ${pick(rand, devFraming)}?\nAssistant: ${topic} ${pick(rand, devStatus)}.\nUser: ok, noted on ${topic}, nothing to do right now.`;
    (i % 2 ? cursor : codex)(`nz-dev-${i}`, turns);
  });
  // Three phrasings per topic, same reasoning as mail-crowding above.
  DEV_TOPICS.slice(0, 20).forEach((topic, i) => {
    note(`nz-devnote-${i}`, `Decided on ${topic}: went with the simpler option after the benchmark showed the difference did not matter in practice, tagged ${tags[36 + i]} in the notes.`);
    weDecisionAsk(topic).forEach((text, v) => ask(i * 3 + v, "note-same-topic-transcript", text, `nz-devnote-${i}`, "note-same-topic-transcript"));
  });
  DEV_TOPICS.forEach((topic, i) => {
    const client = i % 2 ? "cursor" : "codex";
    ask(i, "transcript-control", i % 2 ? `In my ${client} session, what did we discuss about ${topic}?` : `In my coding session, what came up about ${topic}?`, `nz-dev-${i}`, "transcript-control");
  });

  // Wrapper-overlap probes: the query shares wording with the session wrapper text (every transcript carries it);
  // the answer is a genuine note repeating none of it. Disjoint filler vocabulary applies here too (no separate
  // transcript filler notes are generated, so there is nothing that could confound this probe by accident).
  const tWords = pseudoWords(24, seed + 17);
  const TPROBE_TOPICS = ["the garage sale pricing", "the potluck sign-up sheet", "the carpool schedule", "the book club pick", "the yard sale flyer", "the recycling pickup swap", "the spare room paint color", "the hand-me-down bike", "the community fridge stock", "the neighborhood watch rotation", "the shared toolshed key", "the porch light timer"];
  TPROBE_TOPICS.forEach((topic, i) => {
    const id = `nz-tprobe-${i}`;
    note(id, `For ${topic}, settled on ${tWords[i]} after asking around; nobody minded either way.`);
    ask(i, "transcript-probe", i % 2 ? `Where can I find the full record of our last conversation about ${topic}?` : `What did the session history say about ${topic}?`, id, "transcript-probe");
  });

  return finish("noise", seed, entries, queries);
}
