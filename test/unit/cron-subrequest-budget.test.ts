/**
 * All four nightly jobs are fired from a single scheduled() invocation (src/index.ts),
 * so they share ONE D1 cost budget — a self-imposed 50 statements per invocation, not
 * a platform ceiling (the free plan actually allows 1,000 D1/KV/Vectorize subrequests
 * per invocation; see NIGHTLY_D1_STATEMENT_BUDGET below). Each of them awaits
 * initializeDatabase, so before it was memoised the same thirteen DDL statements were paid
 * for once per job, and the pass that runs last could find the budget already spent.
 *
 * Memoisation cut that to thirteen; #282 cut the thirteen to a single catalogue read
 * on any brain that is already migrated, which every brain is after its first request.
 * The D1 mock answers the probe as a migrated brain, which is what a nightly cron always
 * runs against — a brain with no schema has no entries to compress.
 *
 * This measures the whole invocation rather than any one job, because per-job budget
 * assertions are not true in situ.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { resetDatabaseInit } from "../../src/db/init";
import { SYNC_EVENT_BATCH } from "../../src/integrations/calendar";
import { STALENESS_AGE_MS } from "../../src/staleness/pass";
import { makeTestDb, makeTestEnv, makeVectorizeMock, makeMemoryKV } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";
import type { Env } from "../../src/env";
import { INTEGRATION_SYNC_CRON } from "../../src/integrations/mirror";
import { INTEGRATION_PROVIDERS } from "../../src/integrations";
import { INSIGHT_ACCRUAL_CRON, INSIGHT_TEAM_WEEKLY_CRON, INSIGHT_WEEKLY_CRON } from "../../src/insight/schedule";
import { CONFIG_KEY } from "../../src/config";
import { ACCRUAL_CURSOR_KEY } from "../../src/insight/candidates";
import { FTS_READY_KV_KEY } from "../../src/constants";

// This is a self-imposed D1 cost budget, NOT the platform's subrequest
// ceiling. Cloudflare's actual free-plan subrequest limits per invocation are:
//   - 50 external subrequests (fetch() to the internet)
//   - 1,000 subrequests to Cloudflare services (D1, KV, Vectorize)
// https://developers.cloudflare.com/workers/platform/limits/#subrequests
// Fifty D1 statements is nowhere near that 1,000-statement ceiling; it is kept
// tight anyway because D1's OWN free tier is a daily quota (5M rows read,
// 100k written per day) and the free plan's 10 ms CPU-per-invocation limit is
// unaffected by any of this — a cheap D1 statement count is still the
// cheapest proxy this suite has for "did a job get needlessly chatty."
// MOVED 50 -> 53: src/when/pass.ts's nightly extraction pass runs after the
// original three and adds a fixed baseline of three statements every night
// regardless of whether it finds any candidates — resolveConfig's KV read
// (config:overrides), its own cursor KV read (when:cursor), and the one
// prefilter SELECT. Still nowhere near the platform's real 1,000-subrequest
// ceiling.
// MOVED 53 -> 57: runFtsMaintenance runs after the when pass and adds four
// statements on the measured night — the ready-flag KV GET, the cursor KV
// GET, the rowid-keyset SELECT, and the ready KV PUT. The two-statement
// delete-then-insert batch and the cursor KV PUT only fire on a night with
// pre-FTS rows to index, which this double's rowid SELECT cannot produce
// (it returns no rows), so the measured ledger shows 4, not the real-D1
// worst case of 6 — the exact pins below are the tight guard for that.
// MOVED 57 -> 58 (write-path isolation v2.2): runFtsBackfill now checks FTS
// liveness (isFtsLive: one D1 SELECT against sqlite_master, verifying
// entries_fts exists AND all three sync triggers exist with their exact
// bodies) before touching entries_fts, so it can skip cleanly instead of
// throwing into a table a hot-path repair left not-live. That check runs
// unconditionally, so it adds one D1 statement to every ordinary night, not
// just a not-live one.
// MOVED 58 -> 61 (Task 5, nightly integrity self-heal): runFtsMaintenance now
// checks liveness itself (one D1 SELECT against sqlite_master, the same
// query isFtsLive already used inside runFtsBackfill) before deciding
// whether to rebuild, then on a live index runs FTS5's own integrity-check
// statement (one D1 statement), then reads the ready flag itself (one KV
// GET) to decide whether to defer to the backfill or run the count/spot
// parity checks. On a healthy night with the backfill still in progress —
// what this suite measures — that is +3 D1/KV statements on top of the 5
// already counted above (runFtsBackfill's own liveness check, ready GET,
// cursor GET, rowid SELECT, and ready PUT all still run unchanged; the
// liveness check and ready GET are paid twice, once by runFtsMaintenance and
// once by runFtsBackfill, since Task 5 calls the latter as an ordinary
// caller rather than threading its own answers through). A genuinely
// unhealthy night costs more still (rebuild's DDL batch, or
// checkFtsIntegrity's count and spot-check SELECTs) but is not the shape
// this budget suite exercises.
// MOVED 61 -> 61 (combined review of Tasks 4-6, FIXes 1, 2, and 4): the
// duplicated reads go away and two guard batches land, and the measured
// ordinary night moves 23 -> 22. FIX 4 threads runFtsMaintenance's known
// live=true / ready=false into the backfill's internal step, so the
// duplicated liveness query and ready GET disappear (-2 on every
// backfilling night). FIX 1's ready-latch guard (liveness + both EXCEPT
// parity probes in ONE env.DB.batch) adds +1 on every night that attempts
// a latch — the empty page, the final partial batch — so the measured
// ledger nets -1. FIX 2's rotating content check does not run on a
// backfilling night at all: it runs only once ready is latched, where it
// adds a content-cursor KV GET, one window-read batch (two SELECT
// statements), and the cursor-advance KV PUT every ready night, plus one
// more re-index batch only on a night that actually finds drifted rows —
// see the ready-night pin below, which measures exactly that shape. The
// honest worst case (a rebuild night, or a ready night with drift) stays
// well inside this ceiling, so the constant itself does not move.
const NIGHTLY_D1_STATEMENT_BUDGET = 61;
// The weekly dangling-edge sweep (GRAPH_SWEEP_WEEKDAY_UTC in src/graph/pass.ts)
// adds exactly one DELETE on top of an ordinary night. That is still nowhere
// near the platform's real 1,000-subrequest ceiling, so the honest worst-case
// budget for a sweep night is this, not a reason to shrink anything.
const SWEEP_NIGHT_D1_STATEMENT_BUDGET = NIGHTLY_D1_STATEMENT_BUDGET + 1;
// The platform ceiling this suite's one external caller — the integration
// sync's feed fetch — actually has to respect (see "the integration schedule"
// tests below).
const FREE_PLAN_EXTERNAL_SUBREQUESTS = 50;
const MAINTENANCE_CRON = "0 1 * * *";

// D1 bills EXECUTIONS: run/first/all/exec spend one each, and a batch() spends one however
// many statements it carries. Counting prepares instead would price the batched writes in
// the compression and staleness passes as if they were still one round trip per row —
// which is exactly the cost this budget is meant to track.
//
// KV is billed into the SAME `statements` ledger, not a separate counter: a
// KVNamespace.get/put is its own subrequest against the same free-plan
// ceiling D1 competes for (the night-summary recorder's one OAUTH_KV.put per
// maintenance invocation is the case this exists to catch), so a budget test
// that only watched D1 would go blind to it growing.
function countingEnv(db: D1Mock, overrides: Partial<Env> = {}) {
  const statements: string[] = [];
  const bill = (sql: string) => statements.push(sql.replace(/\s+/g, " ").trim());
  const wrap = (stmt: any, sql: string): any => ({
    bind: (...a: any[]) => wrap(stmt.bind(...a), sql),
    run: () => { bill(sql); return stmt.run(); },
    first: (...a: any[]) => { bill(sql); return stmt.first(...a); },
    all: () => { bill(sql); return stmt.all(); },
    __inner: stmt,
  });
  const prepared: string[] = [];
  const DB = {
    prepare(sql: string) { prepared.push(sql.replace(/\s+/g, " ").trim()); return wrap(db.prepare(sql), sql); },
    exec(sql: string) { bill(sql); return db.exec(sql); },
    batch: (stmts: any[]) => { bill("BATCH"); return db.batch(stmts.map((s: any) => s.__inner ?? s)); },
  } as unknown as D1Database;

  const baseKV = overrides.OAUTH_KV ?? makeTestEnv(db).OAUTH_KV;
  const OAUTH_KV = {
    ...baseKV,
    get: (...a: Parameters<KVNamespace["get"]>) => { bill(`KV GET ${a[0]}`); return (baseKV.get as any)(...a); },
    put: (...a: Parameters<KVNamespace["put"]>) => { bill(`KV PUT ${a[0]}`); return (baseKV.put as any)(...a); },
  } as unknown as KVNamespace;

  return { env: makeTestEnv(db, { DB, VECTORIZE: makeVectorizeMock(), ...overrides, OAUTH_KV }), statements, prepared };
}

// Each tag gets more than the ten eligible entries a digest needs, so nightly compression
// actually runs. Without that the budget test measures a cron with its largest job idle.
function seedCompressibleTags(db: D1Mock, tagCount: number) {
  const old = Date.now() - STALENESS_AGE_MS - 86400000;
  for (let t = 0; t < tagCount; t++) {
    for (let i = 0; i < 11; i++) {
      db.entries.push({
        id: `t${t}-e${i}`, content: `Person ${i} works at Company ${t}`, tags: JSON.stringify([`topic-${t}`]),
        source: "api", created_at: old + i, updated_at: old + i, vector_ids: "[]",
        recall_count: 0, importance_score: 0, contradiction_wins: 0, contradiction_losses: 0,
      });
    }
  }
}

// ─── Integration fixture ──────────────────────────────────────────────────────
// A connected calendar with a backlog far larger than one batch, so the cron is
// measured with the integration job doing as much work as it is ever allowed to.

function icsUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function icsWithUpcomingEvents(count: number): string {
  const now = Date.now();
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN"];
  for (let i = 0; i < count; i++) {
    const start = now + (i + 1) * 3600_000; // hourly, inside the 30-day window
    lines.push(
      "BEGIN:VEVENT", `UID:evt-${i}@test`, `DTSTAMP:${icsUtc(now)}`,
      `DTSTART:${icsUtc(start)}`, `DTEND:${icsUtc(start + 1800_000)}`,
      `SUMMARY:Event ${i}`, "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

// The feed URL carries the provider id so a stubbed fetch can tell the
// connections apart when more than one is wired up.
async function connectCalendar(
  kv: KVNamespace,
  eventCount: number,
  providers: string[] = ["calendar-google"],
): Promise<ReturnType<typeof vi.fn>> {
  for (const [i, id] of providers.entries()) {
    await kv.put(`integrations:${id}`, JSON.stringify({
      provider: id,
      authKind: "token",
      credentials: { token: `https://cal.example/${id}/feed.ics` },
      config: {},
      status: "connected",
      workspaceName: id,
      lastSyncedAt: null,
      lastSyncError: null,
      itemMap: {},
      createdAt: 0,
      // Distinct so the rotation has a defined starting order.
      updatedAt: i,
    }));
  }
  const ics = icsWithUpcomingEvents(eventCount);
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => ics }) as any);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// Consecutive runs in a test land in the same millisecond, which the real
// schedule never does — and the rotation cursor is a timestamp, so equal
// timestamps tie and registry order wins every time. Step a fake clock by an
// hour per run so a multi-run test models the schedule it is describing.
function hourlyClock(): (run: number) => void {
  const base = Date.now();
  const spy = vi.spyOn(Date, "now");
  return (run: number) => spy.mockReturnValue(base + run * 3600_000);
}

// Pins Date.now() to a specific instant. Unlike hourlyClock's base-plus-offset
// (which floats with whatever day the suite happens to run on), this fixes the
// UTC weekday outright — needed here because runGraphPass's dangling-edge
// sweep (GRAPH_SWEEP_WEEKDAY_UTC in src/graph/pass.ts) only fires on Sundays,
// and a test that measures the nightly budget without controlling the weekday
// would pass six days out of seven and fail every Sunday.
function clockAt(iso: string): void {
  vi.spyOn(Date, "now").mockReturnValue(new Date(iso).getTime());
}

// 2024-01-14 is a Sunday (GRAPH_SWEEP_WEEKDAY_UTC = 0); 2024-01-15 is an
// ordinary Monday. Both are recent enough that STALENESS_AGE_MS lookback and
// other Date.now()-derived fixtures in this file still land in the past.
const SWEEP_NIGHT_UTC = "2024-01-14T02:00:00Z";
const ORDINARY_NIGHT_UTC = "2024-01-15T02:00:00Z";

// `cron` selects which invocation is being measured — the two schedules are two
// separate budgets, so a run has to name the one it means (#290).
async function runCron(env: any, cron = MAINTENANCE_CRON) {
  const pending: Promise<any>[] = [];
  const ctx = { waitUntil: (p: Promise<any>) => pending.push(p) } as any;
  await (worker as any).scheduled({ cron } as any, env, ctx);
  await Promise.allSettled(pending);
}

describe("nightly cron D1 subrequest cost", () => {
  beforeEach(() => {
    resetDatabaseInit();
    vi.restoreAllMocks();
  });

  it("probes the schema once per invocation, not once per job, and issues no DDL", async () => {
    const db = makeTestDb();
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    for (let i = 0; i < 25; i++) {
      db.entries.push({
        id: `job-${i}`, content: `Person ${i} works at Company ${i}`, tags: "[]",
        source: "api", created_at: old + i, updated_at: old + i, vector_ids: "[]",
      });
    }
    const { env, statements } = countingEnv(db);

    await runCron(env);

    // The signature statement of initializeDatabase, once for the whole cron.
    expect(statements.filter(s => s.startsWith("SELECT type AS kind, name, sql AS definition FROM sqlite_master"))).toHaveLength(1);
    // #282: the schema is already there, and the whole point is that finding that out no
    // longer costs a CREATE and an ALTER per object.
    expect(statements.filter(s => /^(CREATE|ALTER)\b/.test(s))).toEqual([]);
  });

  // The staleness pass used to be the largest consumer of this budget: one CAS per
  // candidate, and in situ it runs concurrently with the compression job's writes, so its
  // guards lose and it pays for re-reads and retries on top. Batched, the whole pass is a
  // candidate query and one write round trip.
  it("keeps a nightly run with every job busy inside the budget, sweep night included", async () => {
    // Pinned to the sweep night (see clockAt above): the worst case for this
    // budget is every job busy AND the weekly dangling-edge sweep running, so
    // that is the case this ceiling has to hold under — an unpinned clock
    // would only exercise it one day in seven and pass the other six
    // regardless of whether the ceiling actually covers it.
    clockAt(SWEEP_NIGHT_UTC);
    const db = makeTestDb();
    seedCompressibleTags(db, 7);
    const { env, statements } = countingEnv(db);

    await runCron(env);

    expect(db.entries.filter(e => JSON.parse(e.tags).includes("synthesized")).length).toBeGreaterThan(0);
    expect(db.entries.filter(e => e.staleness_checked_at != null)).toHaveLength(25);
    expect(statements.length).toBeLessThanOrEqual(SWEEP_NIGHT_D1_STATEMENT_BUDGET);
  });

  // The exact-pin tests below fix the clock rather than trusting the real
  // Date.now(), because runGraphPass's dangling-edge sweep only fires on
  // Sundays (GRAPH_SWEEP_WEEKDAY_UTC in src/graph/pass.ts). Six days a week
  // the old, clock-free version of this test measured a night WITHOUT the
  // sweep and passed; every Sunday it measured a night WITH it and failed.
  // Pinning the clock makes both nights explicit and both pinned numbers
  // reproducible regardless of what day the suite runs on.

  it("keeps an ordinary night (no dangling-edge sweep) inside the free-plan D1 budget", async () => {
    clockAt(ORDINARY_NIGHT_UTC);
    const db = makeTestDb();
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    for (let i = 0; i < 25; i++) {
      db.entries.push({
        id: `job-${i}`, content: `Person ${i} works at Company ${i}`, tags: "[]",
        source: "api", created_at: old + i, updated_at: old + i, vector_ids: "[]",
      });
    }
    const { env, statements } = countingEnv(db);

    await runCron(env);

    expect(statements.length).toBeLessThanOrEqual(NIGHTLY_D1_STATEMENT_BUDGET);
    // Exact pin, not just the ceiling: 11 D1 statements (unchanged from before
    // the night-summary recorder) plus the ONE OAUTH_KV.put it adds per
    // maintenance invocation, plus when-extraction's fixed 3-statement
    // baseline, plus FTS maintenance's 7. If this number moves, say why in
    // the same commit, see the scope-checker test's convention for this
    // pattern.
    // MOVED 23 -> 22 (combined review of Tasks 4-6): FIX 4 threads the
    // maintenance's known live/ready answers into the backfill's internal
    // step, so the backfill's own liveness query and ready GET are gone
    // (-2), and FIX 1's ready-latch guard (liveness + both EXCEPT parity
    // probes in one batch) adds +1 on this latch night. The old
    // decomposition read "runFtsMaintenance's own liveness check, the
    // integrity-check statement, and its own ready GET, then
    // runFtsBackfill's liveness check, ready GET, cursor GET, rowid SELECT,
    // and ready PUT" (8); it now reads liveness, integrity-check, ready
    // GET, cursor GET, rowid SELECT, latch-guard batch, ready PUT (7).
    expect(statements.length).toBe(22);
  });

  it("keeps a sweep night (the weekly dangling-edge sweep runs) inside the free-plan D1 budget", async () => {
    clockAt(SWEEP_NIGHT_UTC);
    const db = makeTestDb();
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    for (let i = 0; i < 25; i++) {
      db.entries.push({
        id: `job-${i}`, content: `Person ${i} works at Company ${i}`, tags: "[]",
        source: "api", created_at: old + i, updated_at: old + i, vector_ids: "[]",
      });
    }
    const { env, statements } = countingEnv(db);

    await runCron(env);

    expect(statements.length).toBeLessThanOrEqual(NIGHTLY_D1_STATEMENT_BUDGET);
    // Exact pin: the same 22 as an ordinary night, plus the ONE dangling-edge
    // DELETE the sweep adds once a week. If this number moves, say why in the
    // same commit, see the scope-checker test's convention for this pattern.
    expect(statements.length).toBe(23);
  });

  // The other FTS night shape: ready already latched, so the backfill is
  // skipped and checkFtsIntegrity's parity checks run instead (count, spot
  // check, and FIX 2's rotating content window). The ordinary-night pin
  // above never reaches them, so this is where FIX 2's statements are
  // actually measured.
  it("keeps a ready night (the integrity checks and the rotating window run) inside the budget", async () => {
    clockAt(ORDINARY_NIGHT_UTC);
    const db = makeTestDb();
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    for (let i = 0; i < 25; i++) {
      db.entries.push({
        id: `job-${i}`, content: `Person ${i} works at Company ${i}`, tags: "[]",
        source: "api", created_at: old + i, updated_at: old + i, vector_ids: "[]",
      });
    }
    const kv = makeMemoryKV();
    await kv.put(FTS_READY_KV_KEY, "1"); // pre-cron put, outside the measured ledger
    const { env, statements } = countingEnv(db, { OAUTH_KV: kv });

    await runCron(env);

    expect(statements.length).toBeLessThanOrEqual(NIGHTLY_D1_STATEMENT_BUDGET);
    // Exact pin: the same 15-statement baseline as an ordinary night (11 D1,
    // the night-summary OAUTH_KV.put, when-extraction's 3) plus FTS
    // maintenance's 9: liveness (1), integrity-check (1), ready GET (1),
    // then checkFtsIntegrity's count+max-rowid SELECT (1), the T-0065
    // per-workspace parity batch (FIX 1, final review: entries GROUP BY +
    // the entry_counts read + the entry_counts trigger-liveness read, ONE
    // env.DB.batch so it still costs a single statement here even though it
    // carries three queries) (1), spot-check SELECT (1), and the rotating
    // window's content-cursor KV GET (1), one window-read batch (1; one
    // SELECT — the orphan half moved to count parity, so the batch shrank by
    // a statement while the count held), and the cursor-advance KV PUT (1).
    // No re-index batch: the mock is a healthy brain, so the window finds no
    // drifted rows, and the T-0065 parity batch above finds no per-workspace
    // drift either, so its own repair batch never fires. If this number
    // moves, say why in the same commit.
    expect(statements.length).toBe(24);
  });

  it("still leaves the staleness pass room to run after the other jobs", async () => {
    const db = makeTestDb();
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    db.entries.push({
      id: "job", content: "Bob works at Example Inc", tags: "[]",
      source: "api", created_at: old, updated_at: old, vector_ids: "[]",
    });
    const { env } = countingEnv(db);

    await runCron(env);

    const tags: string[] = JSON.parse(db.entries.find(e => e.id === "job")!.tags);
    expect(tags).toContain("stale:as-of");
  });

  // ─── The integration sync's own invocation (#290) ──────────────────────────
  // The mirror sync used to be the fourth job on this invocation, sized against
  // an accounting that counted only the ONE outbound fetch a sync makes. What a
  // batch actually costs is the bindings each mirrored item touches — two D1
  // queries per created entry, three per updated one — so its five batches were
  // 100 D1 queries in an invocation that allows 50 in total. Even one batch only
  // fitted while the batch was creates and exactly one provider was connected.
  // It now runs on its own schedule, so these are two budgets to keep, not one.

  describe("the integration schedule", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("runs one batch, and records the cursor the next run resumes from", async () => {
      const db = makeTestDb();
      const kv = makeMemoryKV();
      const fetchMock = await connectCalendar(kv, 120);
      const { env } = countingEnv(db, { OAUTH_KV: kv });

      await runCron(env, INTEGRATION_SYNC_CRON);

      // One batch is one feed fetch and one expansion of it — the expansion is
      // the CPU half of #290, so paying it once per run is the point.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(db.entries.filter(e => e.source === "calendar-google")).toHaveLength(SYNC_EVENT_BATCH);

      const saved = JSON.parse((await kv.get("integrations:calendar-google")) as string);
      expect(Object.keys(saved.itemMap)).toHaveLength(SYNC_EVENT_BATCH);
      expect(saved.lastSyncedAt).not.toBeNull();
    });

    // An iCloud published URL that misses on caldav retries once on calendars
    // (#310). That is two outbound fetches in the same invocation; the happy
    // path above still asserts one, so this is the case that notices the extra.
    it("pays two feed fetches when an iCloud caldav host misses and calendars succeeds", async () => {
      const db = makeTestDb();
      const kv = makeMemoryKV();
      await kv.put("integrations:calendar-icloud", JSON.stringify({
        provider: "calendar-icloud",
        authKind: "token",
        credentials: { token: "https://p12-caldav.icloud.com/published/2/token" },
        config: {},
        status: "connected",
        workspaceName: "Family",
        lastSyncedAt: null,
        lastSyncError: null,
        itemMap: {},
        createdAt: 0,
        updatedAt: 0,
      }));
      const ics = icsWithUpcomingEvents(120);
      const fetchMock = vi.fn(async (url: string) => {
        if (String(url).includes("-caldav.")) {
          return { ok: false, status: 400, text: async () => "" } as any;
        }
        return { ok: true, status: 200, text: async () => ics } as any;
      });
      vi.stubGlobal("fetch", fetchMock);
      const { env } = countingEnv(db, { OAUTH_KV: kv });

      await runCron(env, INTEGRATION_SYNC_CRON);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
        "https://p12-caldav.icloud.com/published/2/token",
        "https://p12-calendars.icloud.com/published/2/token",
      ]);
      expect(db.entries.filter(e => e.source === "calendar-icloud")).toHaveLength(SYNC_EVENT_BATCH);
      const saved = JSON.parse((await kv.get("integrations:calendar-icloud")) as string);
      expect(saved.lastSyncedAt).not.toBeNull();
    });

    it("keeps its own invocation inside the D1 budget", async () => {
      const db = makeTestDb();
      seedCompressibleTags(db, 7); // a big brain must not make the sync cost more
      const kv = makeMemoryKV();
      const fetchMock = await connectCalendar(kv, 120);
      const { env, statements } = countingEnv(db, { OAUTH_KV: kv });

      await runCron(env, INTEGRATION_SYNC_CRON);

      expect(db.entries.filter(e => e.source === "calendar-google")).toHaveLength(SYNC_EVENT_BATCH);
      expect(statements.length).toBeLessThanOrEqual(NIGHTLY_D1_STATEMENT_BUDGET);
      // The integration sync is the only caller in this codebase that makes an
      // actual fetch() — the one thing the platform's 50-per-invocation
      // external-subrequest ceiling governs. One feed fetch, nowhere near it.
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(FREE_PLAN_EXTERNAL_SUBREQUESTS);
    });

    // The multiplier the rotation exists to remove: syncing every connected
    // provider in one invocation measured 70 D1 queries with two calendars.
    it("syncs one provider per run however many are connected", async () => {
      const db = makeTestDb();
      seedCompressibleTags(db, 7);
      const kv = makeMemoryKV();
      const fetchMock = await connectCalendar(kv, 120, ["calendar-google", "calendar-outlook", "calendar-icloud"]);
      const { env, statements } = countingEnv(db, { OAUTH_KV: kv });

      await runCron(env, INTEGRATION_SYNC_CRON);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(db.entries.filter(e => e.source.startsWith("calendar-"))).toHaveLength(SYNC_EVENT_BATCH);
      expect(statements.length).toBeLessThanOrEqual(NIGHTLY_D1_STATEMENT_BUDGET);
    });

    it("rotates to the least recently attempted provider on the next run", async () => {
      const db = makeTestDb();
      const kv = makeMemoryKV();
      await connectCalendar(kv, 120, ["calendar-google", "calendar-outlook"]);
      const { env } = countingEnv(db, { OAUTH_KV: kv });

      await runCron(env, INTEGRATION_SYNC_CRON);
      resetDatabaseInit();
      await runCron(env, INTEGRATION_SYNC_CRON);

      // Each got exactly one batch — the second run did not repeat the first's
      // provider, which is what stops one connection starving the others.
      expect(db.entries.filter(e => e.source === "calendar-google")).toHaveLength(SYNC_EVENT_BATCH);
      expect(db.entries.filter(e => e.source === "calendar-outlook")).toHaveLength(SYNC_EVENT_BATCH);
    });

    // A provider whose token has expired writes updatedAt but never lastSyncedAt.
    // Ordering the rotation by lastSyncedAt would therefore pick it every single
    // run, forever, and the working connection would never sync again.
    it("does not let a permanently failing provider starve a working one", async () => {
      const db = makeTestDb();
      const kv = makeMemoryKV();
      await connectCalendar(kv, 120, ["calendar-google", "calendar-outlook"]);
      const { env } = countingEnv(db, { OAUTH_KV: kv });
      const ics = icsWithUpcomingEvents(120);
      // calendar-google's feed is broken; calendar-outlook's is fine.
      vi.stubGlobal("fetch", vi.fn(async (url: any) => {
        if (String(url).includes("calendar-google")) throw new Error("401 Unauthorized");
        return { ok: true, status: 200, text: async () => ics } as any;
      }));

      const tick = hourlyClock();
      for (let run = 0; run < 4; run++) {
        tick(run);
        resetDatabaseInit();
        await runCron(env, INTEGRATION_SYNC_CRON);
      }

      const failing = JSON.parse((await kv.get("integrations:calendar-google")) as string);
      expect(failing.status).toBe("error");
      // The working provider kept getting turns rather than being locked out —
      // four runs, so two of them were its.
      expect(db.entries.filter(e => e.source === "calendar-outlook"))
        .toHaveLength(2 * SYNC_EVENT_BATCH);
    });

    // The case above is an error the provider's own handler catches, so the
    // provider persists updatedAt itself. This is the one where it does not:
    // a throw escaping the handler is swallowed by job() in src/index.ts, and
    // nothing about the record was written. If the rotation trusted providers to
    // advance their own cursor, this provider would be re-selected every run
    // forever — and, because its item map did not persist either, would re-mirror
    // the same batch under fresh ids each time.
    it("advances past a provider whose sync throws past its own handler", async () => {
      const db = makeTestDb();
      const kv = makeMemoryKV();
      await connectCalendar(kv, 120, ["calendar-google", "calendar-outlook"]);
      const { env } = countingEnv(db, { OAUTH_KV: kv });
      vi.spyOn(INTEGRATION_PROVIDERS["calendar-google"], "sync")
        .mockRejectedValue(new Error("KV write failed inside saveIntegration"));

      const tick = hourlyClock();
      for (let run = 0; run < 4; run++) {
        tick(run);
        resetDatabaseInit();
        await runCron(env, INTEGRATION_SYNC_CRON);
      }

      // Two of the four runs went to the provider that works.
      expect(db.entries.filter(e => e.source === "calendar-outlook"))
        .toHaveLength(2 * SYNC_EVENT_BATCH);
      // And the thrower never mirrored anything, so there are no duplicate
      // re-creations to find.
      expect(db.entries.filter(e => e.source === "calendar-google")).toHaveLength(0);
    });
  });

  // ─── Routing (#290) ────────────────────────────────────────────────────────
  // The split only buys anything if scheduled() actually branches. A handler
  // that ignored event.cron would run every job on BOTH triggers, which is
  // strictly worse than before: the same shared cost, now paid hourly.

  describe("cron routing", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("does not run the mirror sync on the maintenance schedule", async () => {
      const db = makeTestDb();
      const kv = makeMemoryKV();
      const fetchMock = await connectCalendar(kv, 120);
      const { env } = countingEnv(db, { OAUTH_KV: kv });

      await runCron(env, MAINTENANCE_CRON);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(db.entries.filter(e => e.source === "calendar-google")).toHaveLength(0);
    });

    it("does not run the maintenance jobs on the integration schedule", async () => {
      const db = makeTestDb();
      const old = Date.now() - STALENESS_AGE_MS - 86400000;
      db.entries.push({
        id: "job", content: "Bob works at Example Inc", tags: "[]",
        source: "api", created_at: old, updated_at: old, vector_ids: "[]",
      });
      const kv = makeMemoryKV();
      await connectCalendar(kv, 1);
      const { env } = countingEnv(db, { OAUTH_KV: kv });

      await runCron(env, INTEGRATION_SYNC_CRON);

      // The staleness pass is the cheapest maintenance job to detect: on the
      // maintenance schedule this same entry comes back tagged.
      const tags: string[] = JSON.parse(db.entries.find(e => e.id === "job")!.tags);
      expect(tags).not.toContain("stale:as-of");
    });

    it("falls back to maintenance for an unrecognised schedule", async () => {
      const db = makeTestDb();
      const old = Date.now() - STALENESS_AGE_MS - 86400000;
      db.entries.push({
        id: "job", content: "Bob works at Example Inc", tags: "[]",
        source: "api", created_at: old, updated_at: old, vector_ids: "[]",
      });
      const { env } = countingEnv(db);

      await runCron(env, "*/5 * * * *");

      const tags: string[] = JSON.parse(db.entries.find(e => e.id === "job")!.tags);
      expect(tags).toContain("stale:as-of");
    });

    // The insight passes get the same treatment as the mirror sync above: each
    // is its own budget (#290's argument extended to insight accrual/#296's
    // reasoning pass), so scheduled() has to name them explicitly. A handler
    // that let either fall through would run the maintenance suite a second
    // (or third) time on top of whatever the insight job itself did — the
    // exact multiplier the split exists to avoid, now happening daily and
    // weekly instead of hourly.

    it("does not run the maintenance jobs on the insight accrual schedule", async () => {
      const db = makeTestDb();
      const old = Date.now() - STALENESS_AGE_MS - 86400000;
      db.entries.push({
        id: "job", content: "Bob works at Example Inc", tags: "[]",
        source: "api", created_at: old, updated_at: old, vector_ids: "[]",
      });
      const kv = makeMemoryKV();
      const kvGet = vi.spyOn(kv, "get");
      const { env } = countingEnv(db, { OAUTH_KV: kv });

      await runCron(env, INSIGHT_ACCRUAL_CRON);

      // The staleness pass is the cheapest maintenance job to detect: on the
      // maintenance schedule this same entry comes back tagged.
      const tags: string[] = JSON.parse(db.entries.find(e => e.id === "job")!.tags);
      expect(tags).not.toContain("stale:as-of");
      // And accrual's own job did run: it is the very first thing
      // runInsightAccrual does, so this is what tells "routed nowhere" (the
      // bug this test exists to catch) apart from "routed correctly to a job
      // that found nothing to accrue."
      expect(kvGet).toHaveBeenCalledWith(ACCRUAL_CURSOR_KEY);
    });

    it("does not run the maintenance jobs on the insight weekly schedule", async () => {
      const db = makeTestDb();
      const old = Date.now() - STALENESS_AGE_MS - 86400000;
      db.entries.push({
        id: "job", content: "Bob works at Example Inc", tags: "[]",
        source: "api", created_at: old, updated_at: old, vector_ids: "[]",
      });
      const { env, prepared } = countingEnv(db);

      await runCron(env, INSIGHT_WEEKLY_CRON);

      const tags: string[] = JSON.parse(db.entries.find(e => e.id === "job")!.tags);
      expect(tags).not.toContain("stale:as-of");
      // And the weekly pass's own job did run: its candidate-queue read is
      // the first D1 statement it issues, so its presence is what tells
      // "routed nowhere" apart from "routed correctly to a job with nothing
      // pending."
      expect(prepared.some(s => s.includes("FROM insight_candidates"))).toBe(true);
    });

    // The fifth trigger (spec 4.5). Its gating, its solo-brain behaviour and
    // what it writes are covered end to end in
    // test/integration/team-insight-schedule.test.ts; what belongs HERE is the
    // same fact this describe asserts about the other four — that the cron is
    // routed at all, and that routing it did not also re-run maintenance.
    // Every trigger added to wrangler.jsonc needs a case in both places.
    it("does not run the maintenance jobs on the team insight schedule", async () => {
      const db = makeTestDb();
      const old = Date.now() - STALENESS_AGE_MS - 86400000;
      db.entries.push({
        id: "job", content: "Bob works at Example Inc", tags: "[]",
        source: "api", created_at: old, updated_at: old, vector_ids: "[]",
      });
      const kv = makeMemoryKV();
      // The branch is off by default, and an off branch returns before it
      // touches D1 — which would leave "routed nowhere" and "routed correctly"
      // indistinguishable here. On, the company-workspace read is its first
      // statement and therefore the positive signal.
      await kv.put(CONFIG_KEY, JSON.stringify({ TEAM_INSIGHTS: "on" }));
      const { env, prepared } = countingEnv(db, { OAUTH_KV: kv });

      await runCron(env, INSIGHT_TEAM_WEEKLY_CRON);

      const tags: string[] = JSON.parse(db.entries.find(e => e.id === "job")!.tags);
      expect(tags).not.toContain("stale:as-of");
      expect(prepared.some(s => s.includes("FROM workspaces WHERE kind = 'company'"))).toBe(true);
    });
  });
});
