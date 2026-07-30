#!/usr/bin/env node
/**
 * Fills a throwaway Second Brain with enough varied memories to exercise the
 * embedding migration (#248) end to end.
 *
 * WHY THIS EXISTS
 *
 * A freshly provisioned brain has no memories, and every interesting failure mode
 * in a migration is about scale: batch boundaries, the keyset cursor paging across
 * entries that share a timestamp, the daily allowance running out part-way, and
 * resuming afterwards. An empty brain proves the plumbing and none of the loop.
 *
 * NEVER POINT THIS AT A BRAIN YOU CARE ABOUT. It writes real memories that you
 * would then have to delete one by one. It is for a scratch account.
 *
 * WHAT IT COSTS
 *
 * Each capture is not one model call. `captureEntry` embeds the content, runs a
 * duplicate/contradiction check (another embed, a Vectorize query, and possibly a
 * streaming LLM call), classifies it (another LLM call), and may infer graph
 * edges. So seeding 120 memories is a few hundred model calls before the
 * migration test starts. On a free account that is a real slice of the day's
 * allowance — seed in the morning, or seed less.
 *
 * WHY THE CONTENT IS DELIBERATELY VARIED
 *
 * Capture blocks near-duplicates at DUPLICATE_BLOCK_THRESHOLD (0.95). Seeding with
 * "test entry 1", "test entry 2" … would get most of them rejected as duplicates
 * of each other, and you would be testing dedupe rather than migration. The
 * sentences below are built from unrelated subject matter for that reason.
 *
 * A few are long enough to split into several chunks, because the migration
 * budgets its batches in chunks rather than entries — a brain of uniformly short
 * memories never exercises that.
 *
 * USAGE
 *
 *   node scripts/seed-test-brain.mjs --url https://second-brain.<sub>.workers.dev \
 *                                    --token <the brain's password> \
 *                                    [--count 120]
 *
 * Then run the migration from the desktop app's Advanced Settings → Matching.
 */

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const url = (arg("url") ?? process.env.SB_URL ?? "").replace(/\/$/, "");
const token = arg("token") ?? process.env.SB_TOKEN ?? "";
const count = Number(arg("count", "120"));

if (!url || !token) {
  console.error(
    "Need --url and --token (or SB_URL / SB_TOKEN).\n" +
      "Point this ONLY at a throwaway brain — it writes real memories.",
  );
  process.exit(1);
}
if (!/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(url)) {
  console.error(`Refusing to seed ${url} — expected a plain workers.dev origin.`);
  process.exit(1);
}

// Subject matter chosen to be mutually dissimilar, so dedupe does not reject
// them. Each template is filled with a distinct detail.
const TEMPLATES = [
  n => `The sourdough starter doubles in about ${4 + (n % 5)} hours when the kitchen sits near 21 degrees.`,
  n => `Bus route ${100 + n} stops running after 23:40 on weekdays, so the last useful connection is the 23:12.`,
  n => `Anna's youngest is called Marek and turns ${3 + (n % 9)} in November — she mentioned wanting a cargo bike.`,
  n => `The blue oscilloscope drifts about ${n % 7} millivolts after an hour; it needs the warm-up before any calibration run.`,
  n => `Decided against the ${["oak", "walnut", "birch", "ash"][n % 4]} shelving because the wall studs are 600mm apart, not 400.`,
  n => `The tomato variety that actually survived last summer was Costoluto, planted in week ${12 + (n % 6)}.`,
  n => `Reminder: the ${["dentist", "optician", "physio", "vet"][n % 4]} only books ${2 + (n % 3)} weeks ahead, and never on Fridays.`,
  n => `Rent review lands in month ${1 + (n % 12)}; the lease allows a rise capped at inflation plus one percent.`,
  n => `That recurring build failure was a stale lockfile, not the compiler — deleting node_modules fixed it in run ${n}.`,
  n => `The cellar humidity sits around ${55 + (n % 20)} percent, which is fine for the tools but wrong for paper.`,
];

/** Long entries, so some batches are chunk-bound rather than entry-bound. */
function longEntry(n) {
  const paras = [];
  for (let p = 0; p < 4; p++) {
    paras.push(
      `Section ${p + 1} of note ${n}. ` +
        `The measurements were taken over ${3 + p} consecutive evenings, each time after the room had settled. ` +
        `What surprised me was how much the reading depended on whether the window had been open earlier in the day, ` +
        `which is not something the manual mentions anywhere. ` +
        `The pattern held across all ${5 + p} attempts, so it is unlikely to be noise. ` +
        `Next time it would be worth logging the outdoor temperature alongside, because the correlation looked stronger ` +
        `than the one with time of day, and that would change how the schedule should be arranged.`,
    );
  }
  return paras.join("\n\n");
}

const TAGS = [["kitchen"], ["transport"], ["people"], ["workshop"], ["house"], ["garden"], ["admin"], ["work"]];

let stored = 0;
let duplicate = 0;
let failed = 0;

console.log(`Seeding ${count} memories into ${url}\n`);

for (let n = 0; n < count; n++) {
  // Roughly one in eight is long enough to split into several chunks.
  const content = n % 8 === 7 ? longEntry(n) : TEMPLATES[n % TEMPLATES.length](n);
  try {
    const res = await fetch(`${url}/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ content, tags: TAGS[n % TAGS.length], source: "api" }),
    });
    if (!res.ok) {
      failed++;
      if (failed <= 3) console.error(`  HTTP ${res.status} on ${n}: ${(await res.text()).slice(0, 120)}`);
    } else {
      const body = await res.json();
      // The route reports a duplicate rather than failing — that is capture
      // working, not an error, but it means one fewer memory to migrate.
      if (body.duplicate || body.action === "duplicate") duplicate++;
      else stored++;
    }
  } catch (e) {
    failed++;
    if (failed <= 3) console.error(`  ${n}: ${String(e).slice(0, 120)}`);
  }

  if ((n + 1) % 20 === 0) console.log(`  ${n + 1}/${count} — ${stored} stored, ${duplicate} duplicate, ${failed} failed`);
  // Gentle, so a free-tier account is not rate-limited into failures that look
  // like bugs.
  await new Promise(r => setTimeout(r, 150));
}

console.log(`\nDone: ${stored} stored, ${duplicate} duplicate, ${failed} failed.`);
console.log(`Vectors are written out of band, so give it a minute before migrating.\n`);

console.log(`What to check, in order — and what each step proves:

 1. Advanced Settings → Matching. The estimate should read close to ${stored}
    memories. If it reads lower, that is the deprecated-entry exclusion, not a bug.

 2. Pick a finer option and start. WATCH YOUR CLOUDFLARE DASHBOARD:
    a new index should appear alongside the existing one, NOT replace it.
    → proves Cloudflare accepts the new size, and that nothing is destroyed.

 3. While it runs, search the dashboard for something you seeded.
    → proves the "search is incomplete while this runs" warning is honest.

 4. Close the settings window mid-rebuild, reopen it.
    → proves the ledger resumes instead of restarting. Note whether the app
      warned you before closing; it is supposed to.

 5. Let it finish, then search again.
    → proves the rebuild actually populated the new index.

 6. Do NOT free the old data yet. Check the old index still holds its vectors.
    → proves the rollback story is real, not just claimed.

 7. Now free the old data, and confirm the old index disappears.
    → proves the one irreversible step works, and only when asked.

 8. Migrate BACK to the standard option.
    → proves reversibility in both directions, which is the property users
      will actually lean on.

Report back: the index names you saw, whether the old one kept its vectors,
how long the rebuild took, and anything the app said that turned out untrue.`);
