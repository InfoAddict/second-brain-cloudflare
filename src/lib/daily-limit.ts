import { json } from "./http";

/**
 * R3 (budget audit, MAJOR): D1 on the free plan hard-fails every query once the account's daily
 * cap is spent, since 2026-09-01. Cloudflare's own error text names which cap ("row read limit" or
 * "row write limit"), so classifying it is a substring match on the caught error's message — not a
 * guess based on which route is running, since a write route's own identity check is itself a read
 * and can trip the read cap while the write cap still has headroom.
 */
export type D1DailyLimitKind = "d1_rows_read" | "d1_rows_written";

export function classifyD1DailyLimitError(e: unknown): D1DailyLimitKind | null {
  if (!(e instanceof Error)) return null;
  const message = e.message.toLowerCase();
  if (!message.includes("free tier daily row")) return null;
  if (message.includes("row read limit")) return "d1_rows_read";
  if (message.includes("row write limit")) return "d1_rows_written";
  return null;
}

const DAY_MS = 86_400_000;

/** The next 00:00 UTC strictly after `now`, ISO 8601. Always less than 24 hours away. */
export function nextMidnightUtcIso(now: number = Date.now()): string {
  const next = Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
  return new Date(next).toISOString();
}

/** Whole seconds until `resetsAtIso`, rounded up — the Retry-After header value. */
export function retryAfterSeconds(resetsAtIso: string, now: number = Date.now()): number {
  return Math.ceil((new Date(resetsAtIso).getTime() - now) / 1000);
}

/**
 * Copy deck 18-copy-deck.md section 6.7 (copywriter-approved, 2026-09-27). Never says "your Second
 * Brain used it up" — the limit belongs to the Cloudflare ACCOUNT, and other D1 databases on it
 * share the same cap.
 */
const REST_MESSAGE: Record<D1DailyLimitKind, string> = {
  d1_rows_written: "Cloudflare's free daily database limit is used up, so nothing was saved. It resets at midnight UTC.",
  d1_rows_read: "Cloudflare's free daily database limit is used up, so this could not load. It resets at midnight UTC.",
};

const MCP_MESSAGE: Record<D1DailyLimitKind, string> = {
  d1_rows_written: "Not saved. The Cloudflare account running this Second Brain has used up its free daily database limit. It resets at midnight UTC, so try again after that. The owner can remove the limit by moving to Cloudflare's Workers Paid plan.",
  d1_rows_read: "Could not load memories. The Cloudflare account running this Second Brain has used up its free daily database limit. It resets at midnight UTC.",
};

export function dailyLimitMcpMessage(kind: D1DailyLimitKind): string {
  return MCP_MESSAGE[kind];
}

function dailyLimitResponse(kind: D1DailyLimitKind, message: string, now: number): Response {
  const resetsAt = nextMidnightUtcIso(now);
  const res = json({ ok: false, error: "daily_limit", limit: kind, resets_at: resetsAt, message }, 429);
  res.headers.set("Retry-After", String(retryAfterSeconds(resetsAt, now)));
  return res;
}

/** The fixed REST contract (director, 2026-09-27): 429, Retry-After, and this exact JSON body. */
export function dailyLimitRestResponse(kind: D1DailyLimitKind, now: number = Date.now()): Response {
  return dailyLimitResponse(kind, REST_MESSAGE[kind], now);
}

/**
 * The MCP surface's pre-dispatch failures (identity resolution is itself a D1 read, and runs
 * before any tool executes) — same envelope and status as REST, but `message` is the MCP sentence
 * so an AI tool relaying it says the right thing.
 */
export function dailyLimitMcpResponse(kind: D1DailyLimitKind, now: number = Date.now()): Response {
  return dailyLimitResponse(kind, MCP_MESSAGE[kind], now);
}
