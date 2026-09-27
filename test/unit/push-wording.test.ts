/**
 * Push wording for commitments and decisions (src/push/send.ts,
 * notificationPayload): inbound items name the counterparty and "was due";
 * decision reviews use the label and a fixed review body; every other row
 * stays byte for byte what it always was. Same real-SQLite harness as
 * test/integration/push-send.test.ts.
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
  it("names the counterparty and 'was due' for an inbound commitment", async () => {
    sq = await migrated();
    const midnightUtc = Date.UTC(2026, 8, 1); // 2026-09-01
    seedDue(sq, "e1", "Priya: send the signed contract", midnightUtc, null, ["task", "owed-to-me", "counterparty:priya"]);
    seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");

    const payload = await sentPayload(sq);
    expect(payload.body).toBe("Owed to you by Priya, was due 2026-09-01 - from your second brain");
    expect(payload.title).toBe("Priya: send the signed contract");
    expect(payload.body).not.toContain("—");
  });

  it("drops the counterparty clause when the row has no counterparty tag", async () => {
    sq = await migrated();
    const midnightUtc = Date.UTC(2026, 8, 1);
    seedDue(sq, "e1", "Something owed", midnightUtc, null, ["task", "owed-to-me"]);
    seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");

    const payload = await sentPayload(sq);
    expect(payload.body).toBe("Owed to you, was due 2026-09-01 - from your second brain");
  });

  it("titles a decision review with its label and a fixed check-in body", async () => {
    sq = await migrated();
    seedDue(
      sq, "e1", "Decided to hire Dana for the design lead role.", Date.now() - DAY,
      "Review: hiring Dana", ["ledger:decision", "confidence:0.7", "confidence-source:stated"],
    );
    seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");

    const payload = await sentPayload(sq);
    expect(payload.title).toBe("Review: hiring Dana");
    expect(payload.body).toBe("Time to check how it went - from your second brain");
    expect(payload.body).not.toContain("—");
  });

  it("leaves an ordinary due row's wording exactly as it was", async () => {
    sq = await migrated();
    seedDue(sq, "e1", "File the report", Date.now() - DAY, "File the report", ["task"]);
    seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");

    const payload = await sentPayload(sq);
    expect(payload.title).toBe("File the report");
    expect(payload.body).toMatch(/^due \d{4}-\d{2}-\d{2} - from your second brain$/);
  });

  it("content-free subscriptions are unchanged regardless of kind", async () => {
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
    expect(payload.title).toBe("1 thing due - tap to view");
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
});
