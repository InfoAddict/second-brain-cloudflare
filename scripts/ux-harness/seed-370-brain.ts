/**
 * UX-I: seeds a 3.7.0-shaped brain (schema frozen at 0a39810, test/fixtures/schema-3.7.0.sql)
 * with realistic content, then boots the real 4.0 upgrade against it (schema init, no backfill —
 * the same claim test/integration/upgrade-from-3.7.0.test.ts proves in the test suite, exercised
 * here against a real local D1 instead of an in-memory one).
 *
 * Two variants:
 *   - "solo": one owner, a realistic personal brain.
 *   - "team": the same brain plus one teammate, with a memory shared into the company workspace
 *     before any 4.0 code ran, so the shared-history rows (D-SH) have something pre-4.0 to walk.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitSchemaStatements, stripSqlComments } from "../../test/helpers/sqlite-d1";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { openLocalBrain, resetLocalBrain, ROOT } from "./local-env";

const FIXTURE = join(ROOT, "test/fixtures/schema-3.7.0.sql");

async function load370Schema(env: import("../../src/env").Env): Promise<void> {
  const schema = readFileSync(FIXTURE, "utf8");
  for (const statement of splitSchemaStatements(stripSqlComments(schema))) {
    const sql = statement.trim();
    if (sql) await env.DB.prepare(sql).run();
  }
}

const REALISTIC_MEMORIES: { content: string; tags?: string[]; source?: string; daysAgo: number }[] = [
  { content: "Started using Second Brain to keep track of project decisions and things I keep forgetting.", daysAgo: 60 },
  { content: "The Q3 planning doc lives in the shared drive under Projects/2026-Q3.", tags: ["work"], daysAgo: 55 },
  { content: "Sam prefers async updates over meetings, send a written summary after each sync.", tags: ["work", "person:sam"], daysAgo: 50 },
  { content: "Recipe: the sourdough starter needs feeding every 12 hours at room temperature.", tags: ["home"], daysAgo: 48 },
  { content: "Renew the passport before the March trip, it expires in April.", tags: ["task"], daysAgo: 45 },
  { content: "Ana's birthday is the 14th, she likes bookstores and plants.", tags: ["person:ana"], daysAgo: 40 },
  { content: "Decided to use Postgres over MongoDB for the new service, better fit for the relational data.", tags: ["work", "status:canonical"], daysAgo: 35 },
  { content: "The gym schedule changed, evening classes now start at 6:30 instead of 6.", daysAgo: 30 },
  { content: "Migrated the old cron jobs to the new scheduler, old ones are disabled but not deleted yet.", tags: ["work"], daysAgo: 25 },
  { content: "Meeting notes: the vendor contract renews automatically unless cancelled 30 days ahead.", tags: ["work"], daysAgo: 20 },
];

async function seedContent(env: import("../../src/env").Env, now: number): Promise<void> {
  const DAY = 86_400_000;
  for (let i = 0; i < REALISTIC_MEMORIES.length; i++) {
    const m = REALISTIC_MEMORIES[i];
    await env.DB.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES (?, ?, ?, ?, ?, '[]')`,
    ).bind(`ux-mem-${i}`, m.content, JSON.stringify(m.tags ?? []), m.source ?? "api", now - m.daysAgo * DAY).run();
  }
  // A prompt capsule: the always-on context block a person builds up over time.
  await env.DB.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES (?, ?, ?, 'api', ?, '[]')`,
  ).bind("ux-capsule", "Working on the Second Brain 4.0 release. Priorities: shipping the UX wave, keeping the free tier honest.", '["capsule:project","capsule-slot:current-focus","status:canonical"]', now - 10 * DAY).run();
  // A deprecated row: superseded by the Postgres decision above.
  await env.DB.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES (?, ?, ?, 'api', ?, '[]')`,
  ).bind("ux-deprecated", "Leaning towards MongoDB for the new service, flexible schema seems easier short term.", '["work","status:deprecated"]', now - 38 * DAY).run();
  // A mirrored row: looks like it arrived from a connected Notion page.
  await env.DB.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES (?, ?, ?, 'notion', ?, '[]')`,
  ).bind("ux-mirror", "Roadmap page (synced from Notion): Q1 focus is the mobile app, Q2 is integrations.", '["notion","work"]', now - 15 * DAY).run();
  // Edges: a small real graph rather than isolated rows.
  const edges: [string, string, string][] = [
    ["ux-mem-1", "ux-mem-9", "relates_to"],
    ["ux-mem-2", "ux-mem-9", "relates_to"],
    ["ux-mem-6", "ux-deprecated", "supersedes"],
    ["ux-capsule", "ux-mem-6", "relates_to"],
  ];
  for (const [source, target, type] of edges) {
    await env.DB.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, 0.7, 'explicit', '{}', ?, ?)`,
    ).bind(`${source}-${target}`, source, target, type, now, now).run();
  }
}

export type BrainVariant = "solo" | "team";

export async function seed370Brain(variant: BrainVariant, brainName = `3.7-${variant}`): Promise<{ brainName: string }> {
  resetLocalBrain(brainName);
  resetDatabaseInit();
  const { env, close } = await openLocalBrain(brainName);
  try {
    console.log(`ux-harness: loading the 3.7.0-shaped schema (${FIXTURE})`);
    await load370Schema(env);

    const now = Date.now();
    await seedContent(env, now);

    if (variant === "team") {
      // A memory shared into the company workspace BEFORE 4.0 ever ran: entry_events does not
      // exist yet at 3.7.0, so this predates the "shared" event entirely, matching a real brain
      // that turned on team mode before this release. workspace_id "" is the pre-tenancy value
      // schema-3.7.0.sql's entries table already defaults to.
      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES (?, ?, ?, 'api', ?, '[]')`,
      ).bind("ux-shared-pre40", "The team decided to standardize on TypeScript for all new services.", '["work"]', now - 42 * 86_400_000).run();
    }

    console.log("ux-harness: booting the real 4.0 upgrade (schema init, no backfill)");
    const entriesBefore = await countRows(env, "entries");
    const edgesBefore = await countRows(env, "edges");
    await initializeDatabase(env);
    // The upgrade's "no backfill" claim is proven exhaustively against real per-statement counts
    // in test/integration/upgrade-from-3.7.0.test.ts; this just confirms the seeded rows this
    // script wrote came through untouched (total_changes() over getPlatformProxy's D1 RPC layer
    // does not read the same way it does against a raw sqlite connection, so it is not used here).
    const entriesAfter = await countRows(env, "entries");
    const edgesAfter = await countRows(env, "edges");
    if (entriesAfter !== entriesBefore || edgesAfter !== edgesBefore) {
      throw new Error(`ux-harness: the upgrade changed row counts (entries ${entriesBefore} -> ${entriesAfter}, edges ${edgesBefore} -> ${edgesAfter}); expected both unchanged`);
    }
    console.log(`ux-harness: upgrade complete, ${entriesAfter} entries and ${edgesAfter} edges untouched`);

    const roots = await ensureTenantBootstrap(env);
    console.log("ux-harness: tenant bootstrap:", roots);

    if (variant === "team") {
      const { member, token } = await createMember(env, { name: "Priya", role: "member" });
      // Move the pre-4.0 memory into the company workspace now that sharing (and its audit event)
      // exists, so a teammate has something to see in the shared-history walkthroughs.
      const { moveEntry } = await import("../../src/capture/share");
      const owner = (await (await import("../../src/lib/identity")).resolveIdentityByUserId(env, roots.ownerUserId))!;
      await moveEntry("ux-shared-pre40", "company", env, owner, { actorId: owner.userId, channel: "rest" });
      console.log(`ux-harness: teammate ${member.name} (${member.userId}) created, token: ${token}`);
    }

    return { brainName };
  } finally {
    await close();
  }
}

async function countRows(env: import("../../src/env").Env, table: "entries" | "edges"): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

const isMain = process.argv[1]?.endsWith("seed-370-brain.mjs");
if (isMain) {
  const variant = (process.argv[2] as BrainVariant) ?? "solo";
  if (variant !== "solo" && variant !== "team") {
    console.error(`usage: node scripts/ux-seed.mjs [solo|team]`);
    process.exit(2);
  }
  seed370Brain(variant).then(({ brainName }) => {
    console.log(`ux-harness: seeded brain "${brainName}" — run it with UX_BRAIN=${brainName} npm run dev:local`);
  }).catch((e) => { console.error(e); process.exit(1); });
}
