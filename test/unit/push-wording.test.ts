/**
 * Push wording for commitments and decisions (src/push/send.ts,
 * notificationPayload), per 18-copy-deck.md section 5.1: friendly dates
 * ("Sep 1", "today"), no ISO, the attribution as its own capitalized
 * sentence, and a decision review's title built fresh by push (the stored
 * when_label carries no English prefix — see decisions-capture.test.ts).
 * Same real-SQLite harness as test/integration/push-send.test.ts.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { pushDueItems } from "../../src/push/send";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import type { Env } from "../../src/env";

const DAY = 24 * 60 * 60 * 1000;

let sq: SqliteD1 | null = null;
afterEach(() => {
  sq?.close();
  sq = null;
  resetDatabaseInit();
  vi.restoreAllMocks();
});

function dbOf(s: SqliteD1) {
  return { prepare: (sql: string) => s.db.prepare(sql), exec: (sql: string) => s.db.exec(sql), batch: (stmts: any[]) => s.db.batch(stmts) };
}

async function migrated(): Promise<SqliteD1> {
  const s = makeSqliteD1();
  resetDatabaseInit();
  await initializeDatabase({ DB: dbOf(s) } as unknown as Env);
  return s;
}

function seedDue(s: SqliteD1, id: string, content: string, whenAt: number, label: string | null, tags: string[] = []) {
  s.seed({ id, content, createdAt: 1000, tags });
  s.db.prepare(`UPDATE entries SET when_at = ?, when_kind = 'due', when_source = 'model', when_label = ? WHERE id = ?`)
    .bind(whenAt, label, id).run();
}

function seedSubscription(s: SqliteD1, id: string, workspaceId: string, endpoint: string) {
  s.db.prepare(
    `INSERT INTO push_subscriptions (id, workspace_id, endpoint_hash, subscription_json, content_free, created_at, fail_count)
     VALUES (?, ?, ?, ?, 0, ?, 0)`,
  ).bind(
    id, workspaceId, `hash-${id}`,
    JSON.stringify({ endpoint, keys: { p256dh: VALID_P256DH, auth: VALID_AUTH } }),
    Date.now(),
  ).run();
}

const VALID_P256DH = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const VALID_AUTH = "BTBZMqHH6r4Tts7J_aSIgg";

async function sentPayload(s: SqliteD1): Promise<any> {
  const env = makeTestEnv(dbOf(s) as any, { OAUTH_KV: makeMemoryKV() });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));
  const cryptoModule = await import("../../src/push/crypto");
  const encryptSpy = vi.spyOn(cryptoModule, "encryptWebPush");
  await pushDueItems(env, "");
  const plaintext = new TextDecoder().decode(encryptSpy.mock.calls[0][0].plaintext);
  return JSON.parse(plaintext);
}

describe("push wording by kind", () => {
  it("names the counterparty and a friendly date (no year: same as the current year) for an inbound commitment", async () => {
    sq = await migrated();
    const midnightUtc = Date.UTC(2026, 8, 1); // 2026-09-01, safely in the past, same year as "now"
    seedDue(sq, "e1", "Priya: send the signed contract", midnightUtc, null, ["task", "owed-to-me", "counterparty:priya"]);
    seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");

    const payload = await sentPayload(sq);
    expect(payload.title).toBe("Priya: send the signed contract");
    expect(payload.body).toBe("Priya owes you this. Due Sep 1. From your Second Brain.");
    expect(payload.body).not.toContain("—");
    expect(payload.body).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("drops the counterparty clause when the row has no counterparty tag", async () => {
    sq = await migrated();
    const midnightUtc = Date.UTC(2026, 8, 1);
    seedDue(sq, "e1", "Something owed", midnightUtc, null, ["task", "owed-to-me"]);
    seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");

    const payload = await sentPayload(sq);
    expect(payload.body).toBe("Owed to you. Due Sep 1. From your Second Brain.");
  });

  it("adds the year when the due date falls in a different year than today", async () => {
    sq = await migrated();
    const midnightUtc = Date.UTC(2020, 8, 1); // clearly a past year
    seedDue(sq, "e1", "Something owed", midnightUtc, null, ["task", "owed-to-me", "counterparty:priya"]);
    seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");

    const payload = await sentPayload(sq);
    expect(payload.body).toBe("Priya owes you this. Due Sep 1, 2020. From your Second Brain.");
  });

  it("titles a decision review by building 'Review: <label>' fresh, from the bare stored label", async () => {
    sq = await migrated();
    // when_label carries no English prefix once capture.ts stores it (fix
    // for "Italian on the Due sheet") — push builds "Review: " itself.
    seedDue(
      sq, "e1", "Decided to hire Dana for the design lead role.", Date.now() - DAY,
      "hiring Dana", ["ledger:decision", "confidence:0.7", "confidence-source:stated"],
    );
    seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");

    const payload = await sentPayload(sq);
    expect(payload.title).toBe("Review: hiring Dana");
    expect(payload.body).toBe("How did this decision turn out? From your Second Brain.");
    expect(payload.body).not.toContain("—");
  });

  it("leaves an ordinary due row's title unchanged, with the new friendly-date body", async () => {
    sq = await migrated();
    const midnightUtc = Date.UTC(2026, 8, 1);
    seedDue(sq, "e1", "File the report", midnightUtc, "File the report", ["task"]);
    seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");

    const payload = await sentPayload(sq);
    expect(payload.title).toBe("File the report");
    expect(payload.body).toBe("Due Sep 1. From your Second Brain.");
  });

  it("says 'today' when the due date is today in the brain's timezone, with no year or month/day", async () => {
    sq = await migrated();
    seedDue(sq, "e1", "File the report", Date.now() - 60_000, "File the report", ["task"]);
    seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");

    const payload = await sentPayload(sq);
    expect(payload.body).toBe("Due today. From your Second Brain.");
  });

  it("omits the year when the due date falls in the current year", async () => {
    sq = await migrated();
    const now = new Date();
    const thisYearButYesterday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), Math.max(1, now.getUTCDate() - 1));
    seedDue(sq, "e1", "File the report", thisYearButYesterday, "File the report", ["task"]);
    seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");

    const payload = await sentPayload(sq);
    expect(payload.body).not.toMatch(/\d{4}/);
    expect(payload.body).toContain("From your Second Brain.");
  });

  it("content-free subscriptions get the new fixed title, regardless of kind", async () => {
    sq = await migrated();
    seedDue(sq, "e1", "Priya: send the signed contract", Date.now() - DAY, null, ["task", "owed-to-me", "counterparty:priya"]);
    sq.db.prepare(
      `INSERT INTO push_subscriptions (id, workspace_id, endpoint_hash, subscription_json, content_free, created_at, fail_count)
       VALUES ('sub-1', '', 'hash-sub-1', ?, 1, ?, 0)`,
    ).bind(
      JSON.stringify({ endpoint: "https://push.example.com/s1", keys: { p256dh: VALID_P256DH, auth: VALID_AUTH } }),
      Date.now(),
    ).run();

    const payload = await sentPayload(sq);
    expect(payload.title).toBe("Something is due. Tap to see it.");
    expect(payload.body).toBeUndefined();
  });

  it("still costs exactly three D1 statements per workspace", async () => {
    sq = await migrated();
    seedDue(sq, "e1", "Priya: send the signed contract", Date.now() - DAY, null, ["task", "owed-to-me", "counterparty:priya"]);
    seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));

    const before = sq.issued.length;
    await pushDueItems(env, "");
    // due select, subscriptions select, one batch for subscription-state writes
    expect(sq.issued.length - before).toBe(3);
  });

  it("pins the worst case well under Workers' free-plan limit of 50 external fetches per invocation", async () => {
    sq = await migrated();
    for (let i = 0; i < 3; i++) {
      seedDue(sq, `due-${i}`, `Due item ${i}`, Date.now() - DAY, `Due item ${i}`, ["task"]);
    }
    for (let i = 0; i < 60; i++) {
      seedSubscription(sq, `sub-${i}`, "", `https://push.example.com/s${i}`);
    }
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));

    // 3 due items x 60 subscriptions = 180 possible sends, well past the cap.
    await pushDueItems(env, "");

    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(40);
    expect(fetchSpy.mock.calls.length).toBeLessThan(50);
  });
});
