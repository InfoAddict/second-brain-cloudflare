/**
 * The Web Push sender: reads due items for one workspace, encrypts a
 * notification per subscription (RFC 8291, src/push/crypto.ts), and posts it
 * to the subscription's push service. Driven by the hourly integration-sync
 * cron (src/index.ts) and by the admin POST /push/run and /push/test routes.
 */
import type { Env } from "../env";
import { resolveConfig, type Config } from "../config";
import { DUE_SQL } from "../when/input";
import { encryptWebPush } from "./crypto";
import { vapidAuthHeader } from "./vapid";
import { fromBase64Url } from "./base64url";
import { OWED_TO_ME_TAG, COUNTERPARTY_TAG_PREFIX, counterpartyName } from "../commitments/direction";
import { reviewLabel } from "../decisions/capture";

// Literal for now, not imported from a shared reserved-tag list: Track 7's
// Lane A (src/tags/t7.ts) owns that list and lands separately. Reconcile once
// it merges.
const LEDGER_DECISION_TAG = "ledger:decision";

/** A feed, not a blast: at most this many due items per workspace are considered per run. */
const MAX_NOTIFICATIONS_PER_RUN = 3;
/**
 * Each send is an external fetch, and the free plan allows 50 per
 * invocation, shared with anything else the same invocation fetches. One
 * PushBudget of 40 is created per invocation and shared by every workspace
 * that invocation touches: the cron, POST /push/run and POST /push/test.
 * A send the budget cannot cover is never attempted, so it is never a failure.
 */
export const MAX_PUSH_FETCHES_PER_RUN = 40;
/**
 * Subscribed workspaces the cron reads per run. Each costs two D1 SELECTs,
 * so the worst case is 1 + 2 x 50 + 1 = 102 D1 calls per invocation, well
 * under the 1,000 cap. The ring cursor below brings the rest in later runs.
 */
export const MAX_PUSH_WORKSPACES_PER_RUN = 50;
/** Consecutive send failures a subscription tolerates before it is dropped. */
const MAX_FAIL_COUNT = 5;
/** Per-workspace delivery record: {entryId: {w: when_at, s: endpoint hashes that received it at that when_at}}. */
export const PUSHED_KV_PREFIX = "pushed:";
/**
 * The cron's position in the ring of subscribed workspaces, with the
 * maintenance_cursor semantics (src/runtime/rotation.ts): ascending by id,
 * resume strictly after the stored value, wrap at the end, '' takes its
 * turn like any other id. KV rather than that table: it is single-row by
 * design (CHECK id = 1) and this track adds no schema.
 */
export const PUSH_CURSOR_KV_KEY = "push:cursor";

export interface PushBudget { fetchesLeft: number }

/** One per invocation; pass the same one to every workspace the invocation pushes to. */
export function newPushBudget(): PushBudget {
  return { fetchesLeft: MAX_PUSH_FETCHES_PER_RUN };
}
/**
 * Push services require a TTL on every request (RFC 8030 section 5.2); Apple
 * in particular rejects a request missing one. An hour is enough life for a
 * due-item nudge to reach an offline device without the push service
 * holding onto (and eventually redelivering) something stale.
 */
const PUSH_TTL_SECONDS = 3600;
/** RFC 8030 section 5.3. "normal" is the one push services expect absent a real priority signal — this sender has none. */
const PUSH_URGENCY = "normal";
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
  tags: string[];
}

type PushKind = "inbound" | "decision" | "other";

function pushKindOf(tags: string[]): PushKind {
  if (tags.includes(LEDGER_DECISION_TAG)) return "decision";
  if (tags.includes(OWED_TO_ME_TAG)) return "inbound";
  return "other";
}

/** The display name from the row's counterparty:<slug> tag, or null when there is none. */
function counterpartyOf(tags: string[]): string | null {
  const tag = tags.find((t) => t.startsWith(COUNTERPARTY_TAG_PREFIX));
  return tag ? counterpartyName(tag.slice(COUNTERPARTY_TAG_PREFIX.length)) : null;
}

type SendResult = "ok" | "gone" | "failed";

interface SendOutcome {
  result: SendResult;
  /** The push service's HTTP response status, or null when the request itself threw (network error). */
  httpStatus: number | null;
}

function parseTags(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(typeof raw === "string" ? raw : "[]");
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function pushedKvKey(workspaceId: string): string {
  return `${PUSHED_KV_PREFIX}${workspaceId}`;
}

type DeliveryMap = Record<string, { w: number; s: string[] }>;

/**
 * Per subscription, not per workspace, so a run cut short by the budget
 * resumes with exactly the subscriptions still missing an item. A pre-4.0
 * map stored a bare when_at, meaning every subscription had it: read that
 * as delivered to all current subscriptions, so upgrading re-sends nothing.
 */
async function readDeliveryMap(env: Env, workspaceId: string, hashes: string[]): Promise<DeliveryMap> {
  const raw = await env.OAUTH_KV.get(pushedKvKey(workspaceId));
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== "object") return {};
  const map: DeliveryMap = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "number") {
      map[id] = { w: value, s: [...hashes] };
    } else if (value && typeof value === "object") {
      const { w, s } = value as { w?: unknown; s?: unknown };
      if (typeof w === "number" && Array.isArray(s)) map[id] = { w, s: s.filter((h): h is string => typeof h === "string") };
    }
  }
  return map;
}

/**
 * Keeps every item still in the due window whatever its age, and drops a
 * record only once its item has left the window and its when_at is over 30
 * days old. Pruning by age alone dropped still-due items overdue by more
 * than 30 days, which were then re-pushed on every run. Hashes of deleted
 * subscriptions are dropped too.
 */
function pruneDeliveryMap(map: DeliveryMap, dueIds: Set<string>, hashes: Set<string>, now: number): DeliveryMap {
  const cutoff = now - PUSHED_MAP_PRUNE_AGE_MS;
  const pruned: DeliveryMap = {};
  for (const [id, entry] of Object.entries(map)) {
    if (dueIds.has(id) || entry.w >= cutoff) pruned[id] = { w: entry.w, s: entry.s.filter(h => hashes.has(h)) };
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

/** The attribution line, its own short sentence with the product name capitalized. */
const FROM_SECOND_BRAIN = "From your Second Brain.";

/**
 * The Worker has no browser locale to render in, so the notification body's
 * date is formatted directly in the brain's configured TIMEZONE via Intl —
 * not toISOString (always UTC) and not the server runtime's own local time
 * (Workers run in UTC anyway, and even if they did not, "the machine
 * happened to run on" is not "the zone this brain is configured for").
 */
function zonedDateParts(atMs: number, timezone: string): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(atMs);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  return { year: get("year"), month: get("month"), day: get("day") };
}

/**
 * "today", or a friendly "Sep 1" ("Sep 1, 2025" when the year differs from
 * the current one in the brain's timezone) — never the ISO date the old
 * wording used (18-copy-deck.md section 5.1).
 */
function friendlyDueDate(atMs: number, now: number, timezone: string): string {
  const due = zonedDateParts(atMs, timezone);
  const today = zonedDateParts(now, timezone);
  if (due.year === today.year && due.month === today.month && due.day === today.day) return "today";
  const options: Intl.DateTimeFormatOptions = { timeZone: timezone, month: "short", day: "numeric" };
  if (due.year !== today.year) options.year = "numeric";
  return new Intl.DateTimeFormat("en-US", options).format(atMs);
}

function notificationPayload(candidate: DueCandidate, contentFree: boolean, timezone: string, now: number): Record<string, unknown> {
  if (contentFree) return { title: "Something is due. Tap to see it." };
  const dueDate = friendlyDueDate(candidate.when_at, now, timezone);
  const kind = pushKindOf(candidate.tags);

  if (kind === "decision") {
    return { title: reviewLabel(candidate.label), body: `How did this decision turn out? ${FROM_SECOND_BRAIN}`, entry_id: candidate.id };
  }
  if (kind === "inbound") {
    const counterparty = counterpartyOf(candidate.tags);
    const body = counterparty
      ? `${counterparty} owes you this. Due ${dueDate}. ${FROM_SECOND_BRAIN}`
      : `Owed to you. Due ${dueDate}. ${FROM_SECOND_BRAIN}`;
    return { title: candidate.label, body, entry_id: candidate.id };
  }
  return { title: candidate.label, body: `Due ${dueDate}. ${FROM_SECOND_BRAIN}`, entry_id: candidate.id };
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
        Urgency: PUSH_URGENCY,
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

/** Keeps each IN-list well under D1's 100 bound parameters, with room for a statement's two extra bindings. */
const HASHES_PER_STATEMENT = 90;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function groupBy<K>(entries: [K, string][]): Map<K, string[]> {
  const groups = new Map<K, string[]>();
  for (const [key, hash] of entries) groups.set(key, [...(groups.get(key) ?? []), hash]);
  return groups;
}

interface SendRecord { hash: string; result: SendResult; httpStatus: number | null; failCountBefore: number }

/**
 * Every failed send adds exactly 1 to its subscription's fail_count; a
 * success resets it, so the stored value is the failures since the last
 * success, taken in send order. At MAX_FAIL_COUNT, or on 404/410, the
 * subscription is deleted. Only attempted sends are recorded, so a send the
 * budget skipped can never count. One D1 batch, one subrequest, however many
 * statements the chunking makes.
 */
async function applySubscriptionOutcomes(env: Env, sends: SendRecord[]): Promise<void> {
  const bySub = new Map<string, { failCountBefore: number; results: SendResult[] }>();
  for (const send of sends) {
    const entry = bySub.get(send.hash) ?? { failCountBefore: send.failCountBefore, results: [] };
    entry.results.push(send.result);
    bySub.set(send.hash, entry);
  }

  const toDelete: string[] = [];
  const failedOnly: [number, string][] = [];
  const recovered: [number, string][] = [];
  for (const [hash, { failCountBefore, results }] of bySub) {
    if (results.includes("gone")) { toDelete.push(hash); continue; }
    let consecutive = failCountBefore;
    let failures = 0;
    let sawOk = false;
    for (const result of results) {
      if (result === "ok") { consecutive = 0; sawOk = true; } else { consecutive++; failures++; }
    }
    if (consecutive >= MAX_FAIL_COUNT) toDelete.push(hash);
    else if (sawOk) recovered.push([consecutive, hash]);
    else failedOnly.push([failures, hash]);
  }

  const writes = [];
  for (const hashes of chunk(toDelete, HASHES_PER_STATEMENT)) {
    writes.push(env.DB.prepare(
      `DELETE FROM push_subscriptions WHERE endpoint_hash IN (${hashes.map(() => "?").join(",")})`,
    ).bind(...hashes));
  }
  // Relative, so a concurrent run's increments are not overwritten.
  for (const [failures, group] of groupBy(failedOnly)) {
    for (const hashes of chunk(group, HASHES_PER_STATEMENT)) {
      writes.push(env.DB.prepare(
        `UPDATE push_subscriptions SET fail_count = fail_count + ? WHERE endpoint_hash IN (${hashes.map(() => "?").join(",")})`,
      ).bind(failures, ...hashes));
    }
  }
  const okAt = Date.now();
  for (const [trailing, group] of groupBy(recovered)) {
    for (const hashes of chunk(group, HASHES_PER_STATEMENT)) {
      writes.push(env.DB.prepare(
        `UPDATE push_subscriptions SET last_ok_at = ?, fail_count = ? WHERE endpoint_hash IN (${hashes.map(() => "?").join(",")})`,
      ).bind(okAt, trailing, ...hashes));
    }
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

/** One workspace's pending sends for this run, and what it has sent so far. */
interface WorkspacePush {
  workspaceId: string;
  now: number;
  timezone: string;
  candidates: DueCandidate[];
  subs: PushSubscriptionRow[];
  delivery: DeliveryMap;
  dueIds: Set<string>;
  tasks: SendTask[];
  sends: SendRecord[];
}

interface SendTask { push: WorkspacePush; candidate: DueCandidate; sub: PushSubscriptionRow }

/**
 * Two D1 SELECTs (the subscriptions one only when something is due) and one
 * KV read. Pending tasks are every (item, subscription) pair the delivery
 * record lacks at the item's current when_at, item-major so each device
 * gets the most overdue item first.
 */
async function prepareWorkspacePush(env: Env, workspaceId: string, now: number, timezone: string): Promise<WorkspacePush> {
  const push: WorkspacePush = {
    workspaceId, now, timezone, candidates: [], subs: [], delivery: {}, dueIds: new Set(), tasks: [], sends: [],
  };
  const dueRows = ((await env.DB.prepare(
    `SELECT id, content, when_at, when_label, tags FROM entries
     WHERE ${DUE_SQL} AND when_at <= ? AND workspace_id = ?
     ORDER BY when_at ASC LIMIT ?`,
  ).bind(now, workspaceId, MAX_NOTIFICATIONS_PER_RUN * 5).all()).results ?? []) as Record<string, any>[];
  if (!dueRows.length) return push;

  push.subs = ((await env.DB.prepare(
    `SELECT id, endpoint_hash, subscription_json, content_free, fail_count FROM push_subscriptions
     WHERE workspace_id = ? ORDER BY endpoint_hash`,
  ).bind(workspaceId).all()).results ?? []) as unknown as PushSubscriptionRow[];
  if (!push.subs.length) return push;

  push.dueIds = new Set(dueRows.map(r => r.id as string));
  push.delivery = await readDeliveryMap(env, workspaceId, push.subs.map(s => s.endpoint_hash));
  for (const row of dueRows) {
    if (push.candidates.length >= MAX_NOTIFICATIONS_PER_RUN) break;
    const record = push.delivery[row.id as string];
    const have = new Set(record && record.w === row.when_at ? record.s : []);
    const missing = push.subs.filter(sub => !have.has(sub.endpoint_hash));
    if (!missing.length) continue;
    const candidate: DueCandidate = {
      id: row.id as string,
      when_at: row.when_at as number,
      label: (row.when_label as string | null) || (row.content as string).slice(0, 80),
      tags: parseTags(row.tags),
    };
    push.candidates.push(candidate);
    for (const sub of missing) push.tasks.push({ push, candidate, sub });
  }
  return push;
}

/**
 * Sends tasks in order while the shared budget lasts and returns the index
 * of the first task it could not afford, or -1. The check and decrement run
 * before the await, so parallel callers sharing one budget cannot overrun it.
 */
async function runTasks(env: Env, tasks: SendTask[], budget: PushBudget): Promise<number> {
  for (let i = 0; i < tasks.length; i++) {
    if (budget.fetchesLeft <= 0) return i;
    budget.fetchesLeft--;
    const { push, candidate, sub } = tasks[i];
    const outcome = await sendOne(env, sub, notificationPayload(candidate, !!sub.content_free, push.timezone, push.now));
    push.sends.push({ hash: sub.endpoint_hash, result: outcome.result, httpStatus: outcome.httpStatus, failCountBefore: sub.fail_count });
    const record = push.delivery[candidate.id];
    if (record && record.w === candidate.when_at) record.s.push(sub.endpoint_hash);
    else push.delivery[candidate.id] = { w: candidate.when_at, s: [sub.endpoint_hash] };
  }
  return -1;
}

/** Subscription outcomes in one batch, then the delivery record of each workspace that sent anything. */
async function finishPushes(env: Env, pushes: WorkspacePush[]): Promise<void> {
  await applySubscriptionOutcomes(env, pushes.flatMap(p => p.sends));
  for (const push of pushes) {
    if (!push.sends.length) continue;
    const hashes = new Set(push.subs.map(s => s.endpoint_hash));
    await env.OAUTH_KV.put(pushedKvKey(push.workspaceId), JSON.stringify(pruneDeliveryMap(push.delivery, push.dueIds, hashes, push.now)));
  }
}

const okCount = (sends: SendRecord[]) => sends.filter(s => s.result === "ok").length;

/**
 * Pushes due items (overdue and due today, DUE_SQL) for one workspace to
 * each subscription that has not yet had them at their current when_at.
 * POST /push/run calls this once per readable workspace with one shared
 * budget; alone it gets a budget of its own.
 *
 * Cost: at most 3 D1 calls (due SELECT, subscriptions SELECT, one batch),
 * one KV read and one KV write, and budget-limited external fetches.
 */
export async function pushDueItems(
  env: Env, workspaceId: string, resolved?: Readonly<Config>, budget: PushBudget = newPushBudget(),
): Promise<PushDueItemsResult> {
  const config = resolved ?? await resolveConfig(env);
  const push = await prepareWorkspacePush(env, workspaceId, Date.now(), config.TIMEZONE);
  await runTasks(env, push.tasks, budget);
  await finishPushes(env, [push]);
  return { sent: okCount(push.sends), candidates: push.candidates.length, subscriptions: push.subs.length, results: toReportedOutcomes(push.sends) };
}

/** Up to `limit` ids from the ring, starting strictly after the cursor and wrapping. */
function ringSlice(ring: string[], cursor: string | null, limit: number): string[] {
  const after = cursor === null ? 0 : ring.findIndex(id => id > cursor);
  const start = after === -1 ? 0 : after;
  return Array.from({ length: Math.min(limit, ring.length) }, (_, i) => ring[(start + i) % ring.length]);
}

/** Each workspace's first pending task, then each one's second, and so on. */
function interleave(pushes: WorkspacePush[]): SendTask[] {
  const longest = pushes.reduce((max, p) => Math.max(max, p.tasks.length), 0);
  const tasks: SendTask[] = [];
  for (let position = 0; position < longest; position++) {
    for (const push of pushes) if (position < push.tasks.length) tasks.push(push.tasks[position]);
  }
  return tasks;
}

/**
 * The hourly cron. Reads up to MAX_PUSH_WORKSPACES_PER_RUN subscribed
 * workspaces from the persistent ring cursor, interleaves their pending
 * sends one per workspace per round under one 40-fetch budget, then moves
 * the cursor: to the last workspace read when everything fit, otherwise to
 * just before the workspace whose send the budget could not afford, so the
 * next run starts there. Within a workspace, the delivery record resumes
 * with exactly the subscriptions still missing an item. Together these
 * reach every workspace and subscription within a bounded number of runs.
 *
 * Worst case per invocation: 102 D1 calls (1 ring scan + 2 per workspace x
 * 50 + 1 batch), 40 external fetches, 51 KV reads (cursor and one delivery
 * record per workspace) and 41 KV writes (a record per workspace that sent,
 * at most one per fetch, plus the cursor, written only when it moves).
 */
export async function pushDueItemsAllWorkspaces(env: Env, resolved?: Readonly<Config>): Promise<{ sent: number }> {
  const ring = (((await env.DB.prepare(
    `SELECT DISTINCT workspace_id FROM push_subscriptions ORDER BY workspace_id`,
  ).all()).results ?? []) as { workspace_id: string }[]).map(r => r.workspace_id);
  if (!ring.length) return { sent: 0 };

  const cursor = await env.OAUTH_KV.get(PUSH_CURSOR_KV_KEY);
  const selection = ringSlice(ring, cursor, MAX_PUSH_WORKSPACES_PER_RUN);
  const config = resolved ?? await resolveConfig(env);
  const now = Date.now();
  const pushes: WorkspacePush[] = [];
  for (const workspaceId of selection) pushes.push(await prepareWorkspacePush(env, workspaceId, now, config.TIMEZONE));

  const tasks = interleave(pushes);
  const stoppedAt = await runTasks(env, tasks, newPushBudget());
  await finishPushes(env, pushes);

  let next: string | null = selection[selection.length - 1];
  if (stoppedAt !== -1) {
    const index = selection.indexOf(tasks[stoppedAt].push.workspaceId);
    next = index > 0 ? selection[index - 1] : cursor;
  }
  if (next !== null && next !== cursor) await env.OAUTH_KV.put(PUSH_CURSOR_KV_KEY, next);

  return { sent: pushes.reduce((n, p) => n + okCount(p.sends), 0) };
}

/** POST /push/test's fixed notification, bypassing the due query entirely. */
export interface SendTestNotificationResult {
  sent: number;
  subscriptions: number;
  /** Same shape POST /push/run reports — shared code path, not a duplicate. */
  results: PushOutcome[];
}

/** Sends to subscriptions in endpoint-hash order while the budget lasts; POST /push/test shares one budget across workspaces. */
export async function sendTestNotification(
  env: Env, workspaceId: string, budget: PushBudget = newPushBudget(),
): Promise<SendTestNotificationResult> {
  const subs = ((await env.DB.prepare(
    `SELECT id, endpoint_hash, subscription_json, content_free, fail_count FROM push_subscriptions
     WHERE workspace_id = ? ORDER BY endpoint_hash`,
  ).bind(workspaceId).all()).results ?? []) as unknown as PushSubscriptionRow[];
  if (!subs.length) return { sent: 0, subscriptions: 0, results: [] };

  const payload = { title: "Second Brain", body: "Test notification. Push is working." };
  const sends: SendRecord[] = [];
  for (const sub of subs) {
    if (budget.fetchesLeft <= 0) break;
    budget.fetchesLeft--;
    const outcome = await sendOne(env, sub, payload);
    sends.push({ hash: sub.endpoint_hash, result: outcome.result, httpStatus: outcome.httpStatus, failCountBefore: sub.fail_count });
  }
  await applySubscriptionOutcomes(env, sends);

  return { sent: okCount(sends), subscriptions: subs.length, results: toReportedOutcomes(sends) };
}
