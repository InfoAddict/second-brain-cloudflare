/**
 * R3 (MAJOR, budget audit): once the Cloudflare account's daily D1 cap is spent, D1 hard-fails
 * every query with an opaque error (Cloudflare error 1101 reaches the caller with no wording about
 * the limit — test/budget/visible-limit.test.ts @ v4/budget-audit 0bf42b1c). This module turns that
 * raw D1 error into the named, visible daily_limit contract (director's fixed contract, 2026-09-27):
 * REST 429 + Retry-After + a fixed JSON body; MCP one plain sentence from copy deck 18-copy-deck.md
 * section 6.7. The limit is per Cloudflare ACCOUNT, never "your Second Brain" (6.7's own truth check).
 */
import { describe, it, expect } from "vitest";
import {
  classifyD1DailyLimitError, nextMidnightUtcIso, retryAfterSeconds,
  dailyLimitRestResponse, dailyLimitMcpMessage,
} from "../../src/lib/daily-limit";

const READ_TEXT = "D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";
const WRITE_TEXT = "D1_ERROR: Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";

describe("classifyD1DailyLimitError", () => {
  it("classifies the row read limit message", () => {
    expect(classifyD1DailyLimitError(new Error(READ_TEXT))).toBe("d1_rows_read");
  });

  it("classifies the row write limit message", () => {
    expect(classifyD1DailyLimitError(new Error(WRITE_TEXT))).toBe("d1_rows_written");
  });

  it("returns null for an unrelated error", () => {
    expect(classifyD1DailyLimitError(new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed"))).toBeNull();
  });

  it("returns null for a non-Error throw", () => {
    expect(classifyD1DailyLimitError("just a string")).toBeNull();
    expect(classifyD1DailyLimitError(undefined)).toBeNull();
  });
});

describe("nextMidnightUtcIso", () => {
  it("returns the same day's midnight when already exactly at it", () => {
    const now = new Date("2026-09-27T00:00:00.000Z").getTime();
    expect(nextMidnightUtcIso(now)).toBe("2026-09-28T00:00:00.000Z");
  });

  it("returns tomorrow's midnight from midday", () => {
    const now = new Date("2026-09-27T14:32:10.000Z").getTime();
    expect(nextMidnightUtcIso(now)).toBe("2026-09-28T00:00:00.000Z");
  });

  it("is always less than 24 hours away", () => {
    const now = new Date("2026-09-27T00:00:00.001Z").getTime();
    const iso = nextMidnightUtcIso(now);
    expect(new Date(iso).getTime() - now).toBeLessThan(24 * 60 * 60 * 1000);
    expect(new Date(iso).getTime() - now).toBeGreaterThan(0);
  });
});

describe("retryAfterSeconds", () => {
  it("rounds up to whole seconds", () => {
    const now = new Date("2026-09-27T23:59:58.500Z").getTime();
    expect(retryAfterSeconds(nextMidnightUtcIso(now), now)).toBe(2);
  });
});

describe("dailyLimitRestResponse", () => {
  it("d1_rows_written: 429, Retry-After, and the write-refused body", async () => {
    const now = new Date("2026-09-27T14:00:00.000Z").getTime();
    const res = dailyLimitRestResponse("d1_rows_written", now);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe(String(retryAfterSeconds(nextMidnightUtcIso(now), now)));
    const body = await res.json() as any;
    expect(body).toEqual({
      ok: false,
      error: "daily_limit",
      limit: "d1_rows_written",
      resets_at: "2026-09-28T00:00:00.000Z",
      message: "Cloudflare's free daily database limit is used up, so nothing was saved. It resets at midnight UTC. Cloudflare's Workers Paid plan raises this limit.",
    });
  });

  it("d1_rows_read: the load-refused body", async () => {
    const now = new Date("2026-09-27T14:00:00.000Z").getTime();
    const res = dailyLimitRestResponse("d1_rows_read", now);
    const body = await res.json() as any;
    expect(body.message).toBe("Cloudflare's free daily database limit is used up, so this could not load. It resets at midnight UTC. Cloudflare's Workers Paid plan raises this limit.");
    expect(body.limit).toBe("d1_rows_read");
  });

  it("never says \"your Second Brain used it up\"", async () => {
    const res1 = dailyLimitRestResponse("d1_rows_read");
    const res2 = dailyLimitRestResponse("d1_rows_written");
    const [b1, b2] = await Promise.all([res1.json() as any, res2.json() as any]);
    expect(b1.message).not.toMatch(/your second brain used/i);
    expect(b2.message).not.toMatch(/your second brain used/i);
  });
});

describe("dailyLimitMcpMessage", () => {
  it("d1_rows_written: the exact write sentence", () => {
    expect(dailyLimitMcpMessage("d1_rows_written")).toBe(
      "Not saved. The Cloudflare account running this Second Brain has used up its free daily database limit. It resets at midnight UTC, so try again after that. Cloudflare's Workers Paid plan raises this limit.",
    );
  });

  it("d1_rows_read: the exact read sentence", () => {
    expect(dailyLimitMcpMessage("d1_rows_read")).toBe(
      "Could not load memories. The Cloudflare account running this Second Brain has used up its free daily database limit. It resets at midnight UTC. Cloudflare's Workers Paid plan raises this limit.",
    );
  });
});
