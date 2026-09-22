/**
 * The Web Push sender: reads due items for one workspace, encrypts a
 * notification per subscription (RFC 8291, src/push/crypto.ts), and posts it
 * to the subscription's push service. Driven by the hourly integration-sync
 * cron (src/index.ts) and by the admin POST /push/run and /push/test routes.
 */
import type { Env } from "../env";
import { resolveConfig } from "../config";
import { DUE_SQL } from "../when/input";
import { encryptWebPush } from "./crypto";
import { vapidAuthHeader } from "./vapid";
import { fromBase64Url } from "./base64url";

/** A feed, not a blast: at most this many due items get a notification per run. */
const MAX_NOTIFICATIONS_PER_RUN = 3;
/** Consecutive send failures a subscription tolerates before it is dropped. */
const MAX_FAIL_COUNT = 5;
/** {entryId: when_at at the time it was last pushed}, one map per workspace. */
export const PUSHED_KV_PREFIX = "pushed:";
/** Push services want a TTL on every request; a day is generous for a due-item nudge. */
const PUSH_TTL_SECONDS = 86400;
/** Forgotten test/stale ids age out of the pushed-map on write; see prunePushedMap. */
const PUSHED_MAP_PRUNE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** POST /push/run's per-subscription outcomes, capped so a large brain's response stays small. */
const MAX_REPORTED_RESULTS = 10;

interface PushSubscriptionRow {
  id: string;
  endpoint_hash: string;
  subscription_json: string;
  content_free: number;
  fail_count: number;
}

interface DueCandidate {
  id: string;
  when_at: number;
  label: string;
}

type SendResult = "ok" | "gone" | "failed";

interface SendOutcome {
  result: SendResult;
  /** The push service's HTTP response status, or null when the request itself threw (network error). */
  httpStatus: number | null;
}

function pushedKvKey(workspaceId: string): string {
  return `${PUSHED_KV_PREFIX}${workspaceId}`;
}

async function readPushedMap(env: Env, workspaceId: string): Promise<Record<string, number>> {
  const raw = await env.OAUTH_KV.get(pushedKvKey(workspaceId));
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, number>;
  } catch {
    return {};
  }
}

/**
 * Drops ids whose recorded when_at is more than 30 days old. The map only
 * ever grows (an entry is added the moment it is pushed, and a resolved/
 * cleared entry stops appearing in the due query but its old id lingers
 * forever otherwise) — cheap because it costs nothing beyond the write this
 * function already does on every call, no extra D1 or KV round trip.
 */
function prunePushedMap(map: Record<string, number>, now: number): Record<string, number> {
  const cutoff = now - PUSHED_MAP_PRUNE_AGE_MS;
  const pruned: Record<string, number> = {};
  for (const [id, whenAt] of Object.entries(map)) {
    if (whenAt >= cutoff) pruned[id] = whenAt;
  }
  return pruned;
}

/** "ok" | "http_<code>" | "error", the shape POST /push/run reports per subscription. */
function outcomeStatus(outcome: SendOutcome): string {
  if (outcome.result === "ok") return "ok";
  if (outcome.httpStatus != null) return `http_${outcome.httpStatus}`;
  return "error";
}

export interface PushOutcome {
  /** First 12 hex characters of the subscription's endpoint hash — enough to tell rows apart in a log, not enough to identify the device. */
  endpoint_hash_prefix: string;
  status: string;
}

function toReportedOutcomes(outcomes: { hash: string; result: SendResult; httpStatus: number | null }[]): PushOutcome[] {
  return outcomes.slice(0, MAX_REPORTED_RESULTS).map(o => ({
    endpoint_hash_prefix: o.hash.slice(0, 12),
    status: outcomeStatus(o),
  }));
}

/**
 * The Worker has no browser locale to render in, so the notification body's
 * date is formatted directly in the brain's configured TIMEZONE via Intl —
 * not toISOString (always UTC) and not the server runtime's own local time
 * (Workers run in UTC anyway, and even if they did not, "the machine
 * happened to run on" is not "the zone this brain is configured for").
 */
function notificationPayload(candidate: DueCandidate, contentFree: boolean, timezone: string): Record<string, unknown> {
  if (contentFree) return { title: "1 thing due - tap to view" };
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(candidate.when_at);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  const dueDate = `${get("year")}-${get("month")}-${get("day")}`;
  return { title: candidate.label, body: `due ${dueDate} - from your second brain`, entry_id: candidate.id };
}

/**
 * Encrypts and sends one message. encryptWebPush generates its own fresh
 * ephemeral ECDH key pair per call (src/push/crypto.ts) — this function never
 * touches the persistent VAPID keys except through vapidAuthHeader, which
 * signs the JWT and is unrelated to the message's encryption key.
 */
async function sendOne(env: Env, sub: PushSubscriptionRow, payload: Record<string, unknown>): Promise<SendOutcome> {
  const subscription = JSON.parse(sub.subscription_json) as { endpoint: string; keys: { p256dh: string; auth: string } };
  const encrypted = await encryptWebPush({
    plaintext: new TextEncoder().encode(JSON.stringify(payload)),
    subscriptionPublicKey: fromBase64Url(subscription.keys.p256dh),
    subscriptionAuthSecret: fromBase64Url(subscription.keys.auth),
  });

  let res: Response;
  try {
    res = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "aes128gcm",
        TTL: String(PUSH_TTL_SECONDS),
        Authorization: await vapidAuthHeader(env, subscription.endpoint),
      },
      body: encrypted.body,
    });
  } catch {
    return { result: "failed", httpStatus: null };
  }
  if (res.status === 404 || res.status === 410) return { result: "gone", httpStatus: res.status };
  return { result: res.ok ? "ok" : "failed", httpStatus: res.status };
}

/** One batch, whatever it carries: the delete/bump/last_ok_at writes below never cost more than one D1 statement together. */
async function applySubscriptionOutcomes(
  env: Env,
  outcomes: { hash: string; result: SendResult; failCountBefore: number }[],
): Promise<void> {
  const toDelete = outcomes.filter(o => o.result === "gone" || (o.result === "failed" && o.failCountBefore + 1 >= MAX_FAIL_COUNT)).map(o => o.hash);
  const toBump = outcomes.filter(o => o.result === "failed" && o.failCountBefore + 1 < MAX_FAIL_COUNT).map(o => o.hash);
  const toMarkOk = outcomes.filter(o => o.result === "ok").map(o => o.hash);

  const writes = [];
  if (toDelete.length) {
    writes.push(env.DB.prepare(
      `DELETE FROM push_subscriptions WHERE endpoint_hash IN (${toDelete.map(() => "?").join(",")})`,
    ).bind(...toDelete));
  }
  if (toBump.length) {
    writes.push(env.DB.prepare(
      `UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE endpoint_hash IN (${toBump.map(() => "?").join(",")})`,
    ).bind(...toBump));
  }
  if (toMarkOk.length) {
    writes.push(env.DB.prepare(
      `UPDATE push_subscriptions SET last_ok_at = ?, fail_count = 0 WHERE endpoint_hash IN (${toMarkOk.map(() => "?").join(",")})`,
    ).bind(Date.now(), ...toMarkOk));
  }
  if (writes.length) await env.DB.batch(writes);
}

export interface PushDueItemsResult {
  sent: number;
  candidates: number;
  subscriptions: number;
  /** Per-subscription send outcomes, capped at MAX_REPORTED_RESULTS — POST /push/run surfaces these for live diagnosis. */
  results: PushOutcome[];
}

/**
 * Pushes due items (overdue and due today, DUE_SQL) for one workspace to
 * every subscription registered against it. Dedupes against a KV map of the
 * last when_at pushed per entry — re-notifies only when when_at has actually
 * moved (a snooze to a new date), never on every run for the same due date.
 *
 * D1 cost: one SELECT for due candidates, one SELECT for subscriptions, one
 * batch for whatever subscription-state writes the run produced — three
 * statements at most, regardless of how many notifications are sent.
 */
export async function pushDueItems(env: Env, workspaceId: string): Promise<PushDueItemsResult> {
  const now = Date.now();
  const config = await resolveConfig(env);
  const dueRows = ((await env.DB.prepare(
    `SELECT id, content, when_at, when_label FROM entries
     WHERE ${DUE_SQL} AND when_at <= ? AND workspace_id = ?
     ORDER BY when_at ASC LIMIT ?`,
  ).bind(now, workspaceId, MAX_NOTIFICATIONS_PER_RUN * 5).all()).results ?? []) as Record<string, any>[];

  const pushed = await readPushedMap(env, workspaceId);
  const candidates: DueCandidate[] = dueRows
    .filter(r => pushed[r.id as string] !== (r.when_at as number))
    .slice(0, MAX_NOTIFICATIONS_PER_RUN)
    .map(r => ({
      id: r.id as string,
      when_at: r.when_at as number,
      label: (r.when_label as string | null) || (r.content as string).slice(0, 80),
    }));

  if (!candidates.length) return { sent: 0, candidates: 0, subscriptions: 0, results: [] };

  const subs = ((await env.DB.prepare(
    `SELECT id, endpoint_hash, subscription_json, content_free, fail_count FROM push_subscriptions WHERE workspace_id = ?`,
  ).bind(workspaceId).all()).results ?? []) as unknown as PushSubscriptionRow[];

  if (!subs.length) return { sent: 0, candidates: candidates.length, subscriptions: 0, results: [] };

  let sent = 0;
  const outcomes: { hash: string; result: SendResult; httpStatus: number | null; failCountBefore: number }[] = [];
  for (const candidate of candidates) {
    const payload = (contentFree: boolean) => notificationPayload(candidate, contentFree, config.TIMEZONE);
    for (const sub of subs) {
      const outcome = await sendOne(env, sub, payload(!!sub.content_free));
      if (outcome.result === "ok") sent++;
      outcomes.push({ hash: sub.endpoint_hash, result: outcome.result, httpStatus: outcome.httpStatus, failCountBefore: sub.fail_count });
    }
    pushed[candidate.id] = candidate.when_at;
  }

  await applySubscriptionOutcomes(env, outcomes);
  await env.OAUTH_KV.put(pushedKvKey(workspaceId), JSON.stringify(prunePushedMap(pushed, now)));

  return { sent, candidates: candidates.length, subscriptions: subs.length, results: toReportedOutcomes(outcomes) };
}

/**
 * Runs pushDueItems for every workspace that actually has a subscription,
 * rather than every workspace in the brain: one extra SELECT (DISTINCT
 * workspace_id) plus pushDueItems' own three statements per subscribed
 * workspace. On the common case — one personal brain, one subscribed
 * workspace — that is four D1 statements total for the whole hourly run.
 */
export async function pushDueItemsAllWorkspaces(env: Env): Promise<{ sent: number }> {
  const rows = ((await env.DB.prepare(
    `SELECT DISTINCT workspace_id FROM push_subscriptions`,
  ).all()).results ?? []) as { workspace_id: string }[];

  let sent = 0;
  for (const row of rows) {
    const result = await pushDueItems(env, row.workspace_id);
    sent += result.sent;
  }
  return { sent };
}

/** POST /push/test's fixed notification, bypassing the due query entirely. */
export async function sendTestNotification(env: Env, workspaceId: string): Promise<{ sent: number; subscriptions: number }> {
  const subs = ((await env.DB.prepare(
    `SELECT id, endpoint_hash, subscription_json, content_free, fail_count FROM push_subscriptions WHERE workspace_id = ?`,
  ).bind(workspaceId).all()).results ?? []) as unknown as PushSubscriptionRow[];
  if (!subs.length) return { sent: 0, subscriptions: 0 };

  const payload = { title: "Second Brain", body: "Test notification. Push is working." };
  let sent = 0;
  const outcomes: { hash: string; result: SendResult; failCountBefore: number }[] = [];
  for (const sub of subs) {
    const outcome = await sendOne(env, sub, payload);
    if (outcome.result === "ok") sent++;
    outcomes.push({ hash: sub.endpoint_hash, result: outcome.result, failCountBefore: sub.fail_count });
  }
  await applySubscriptionOutcomes(env, outcomes);

  return { sent, subscriptions: subs.length };
}
