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

/** A feed, not a blast: at most this many due items get a notification per run. */
const MAX_NOTIFICATIONS_PER_RUN = 3;
/**
 * Each push send is an external fetch, and Workers' free plan allows only 50
 * subrequests per INVOCATION — not per workspace. The hourly cron's
 * pushDueItemsAllWorkspaces covers every subscribed workspace in one
 * invocation, so this budget is shared across all of them (round-robin
 * below), not reset per workspace; a lone pushDueItems call (POST
 * /push/run) still gets the same cap to itself. Capped well under 50,
 * leaving headroom for whatever else that cron run fetches externally.
 * A candidate whose subscriptions are not all reached within budget is left
 * off the pushed-map, so the whole candidate (every one of its
 * subscriptions, not a partial subset) is retried on the next run.
 */
const MAX_PUSH_FETCHES_PER_RUN = 40;
/** Consecutive send failures a subscription tolerates before it is dropped. */
const MAX_FAIL_COUNT = 5;
/** {entryId: when_at at the time it was last pushed}, one map per workspace. */
export const PUSHED_KV_PREFIX = "pushed:";
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

/**
 * D1 bounds a statement to 100 parameters. An IN-list of endpoint hashes is
 * chunked well under that (leaving room for a chunk's own extra literal
 * binding, such as toMarkOk's Date.now()) — a large brain's subscription
 * count must not overflow one statement's bind list.
 */
const HASHES_PER_STATEMENT = 90;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** One batch, however many statements it carries: still one D1 subrequest, whatever the chunking above splits it into. */
async function applySubscriptionOutcomes(
  env: Env,
  outcomes: { hash: string; result: SendResult; failCountBefore: number }[],
): Promise<void> {
  const toDelete = outcomes.filter(o => o.result === "gone" || (o.result === "failed" && o.failCountBefore + 1 >= MAX_FAIL_COUNT)).map(o => o.hash);
  const toBump = outcomes.filter(o => o.result === "failed" && o.failCountBefore + 1 < MAX_FAIL_COUNT).map(o => o.hash);
  const toMarkOk = outcomes.filter(o => o.result === "ok").map(o => o.hash);

  const writes = [];
  for (const hashes of chunk(toDelete, HASHES_PER_STATEMENT)) {
    writes.push(env.DB.prepare(
      `DELETE FROM push_subscriptions WHERE endpoint_hash IN (${hashes.map(() => "?").join(",")})`,
    ).bind(...hashes));
  }
  for (const hashes of chunk(toBump, HASHES_PER_STATEMENT)) {
    writes.push(env.DB.prepare(
      `UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE endpoint_hash IN (${hashes.map(() => "?").join(",")})`,
    ).bind(...hashes));
  }
  const markOkAt = Date.now();
  for (const hashes of chunk(toMarkOk, HASHES_PER_STATEMENT)) {
    writes.push(env.DB.prepare(
      `UPDATE push_subscriptions SET last_ok_at = ?, fail_count = 0 WHERE endpoint_hash IN (${hashes.map(() => "?").join(",")})`,
    ).bind(markOkAt, ...hashes));
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

/** A workspace with something to push: candidates and subscriptions already read, ready to queue as send tasks. */
interface WorkspacePush {
  workspaceId: string;
  candidates: DueCandidate[];
  subs: PushSubscriptionRow[];
  pushed: Record<string, number>;
  now: number;
  timezone: string;
}

type PreparedWorkspacePush = WorkspacePush | { ready: false; candidateCount: number };

/**
 * Reads one workspace's due candidates and subscriptions, applying the
 * pushed-map dedup — everything pushDueItems needs before it can queue
 * sends, and exactly what pushDueItemsAllWorkspaces needs to do for every
 * subscribed workspace before it can round-robin them together. Two D1
 * SELECTs, same as before; no sends happen here.
 */
async function prepareWorkspacePush(env: Env, workspaceId: string, now: number, config: Readonly<Config>): Promise<PreparedWorkspacePush> {
  const dueRows = ((await env.DB.prepare(
    `SELECT id, content, when_at, when_label, tags FROM entries
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
      tags: parseTags(r.tags),
    }));

  if (!candidates.length) return { ready: false, candidateCount: 0 };

  const subs = ((await env.DB.prepare(
    `SELECT id, endpoint_hash, subscription_json, content_free, fail_count FROM push_subscriptions WHERE workspace_id = ?`,
  ).bind(workspaceId).all()).results ?? []) as unknown as PushSubscriptionRow[];

  if (!subs.length) return { ready: false, candidateCount: candidates.length };

  return { workspaceId, candidates, subs, pushed, now, timezone: config.TIMEZONE };
}

/** One external fetch still to make: which workspace, which candidate (by index), to which subscription. */
interface SendTask {
  workspaceId: string;
  candidateIndex: number;
  sub: PushSubscriptionRow;
}

/** Every task for one workspace, candidate-major (matches the single-workspace order this always had). */
function tasksFor(push: WorkspacePush): SendTask[] {
  const tasks: SendTask[] = [];
  for (let candidateIndex = 0; candidateIndex < push.candidates.length; candidateIndex++) {
    for (const sub of push.subs) tasks.push({ workspaceId: push.workspaceId, candidateIndex, sub });
  }
  return tasks;
}

/**
 * Interleaves every workspace's own task list one position at a time
 * (workspace A's 1st task, B's 1st, C's 1st, then A's 2nd, B's 2nd, ...) so
 * a shared fetch budget consumed in this order can never starve a small
 * workspace behind a large one: a workspace with few tasks finishes early
 * and simply drops out of later rounds, while a large workspace only ever
 * claims the rounds a smaller one had nothing left to contribute to.
 */
function roundRobinTasks(pushes: readonly WorkspacePush[]): SendTask[] {
  const perWorkspace = pushes.map(tasksFor);
  const maxLen = perWorkspace.reduce((max, tasks) => Math.max(max, tasks.length), 0);
  const interleaved: SendTask[] = [];
  for (let position = 0; position < maxLen; position++) {
    for (const tasks of perWorkspace) {
      if (position < tasks.length) interleaved.push(tasks[position]);
    }
  }
  return interleaved;
}

interface WorkspaceRunState {
  sent: number;
  outcomes: { hash: string; result: SendResult; httpStatus: number | null; failCountBefore: number }[];
  /** How many of a candidate's subscriptions were actually attempted, keyed by candidate index. */
  attempted: Map<number, number>;
}

/**
 * Sends tasks in order up to maxFetches shared across every workspace in
 * `tasks`, then stops — a task past the budget is simply never attempted,
 * so it can never register as a "failed" send (that would wrongly count
 * against a subscription's fail_count and risk deleting it, C13's whole
 * point). Per-workspace state is returned so each workspace can finalize
 * (mark completed candidates pushed, write subscription outcomes) on its
 * own, independent of every other workspace's outcome.
 */
async function sendTasks(env: Env, pushes: readonly WorkspacePush[], tasks: readonly SendTask[], maxFetches: number): Promise<Map<string, WorkspaceRunState>> {
  const byWorkspace = new Map(pushes.map(p => [p.workspaceId, p]));
  const states = new Map<string, WorkspaceRunState>(pushes.map(p => [p.workspaceId, { sent: 0, outcomes: [], attempted: new Map() }]));

  let fetchesUsed = 0;
  for (const task of tasks) {
    if (fetchesUsed >= maxFetches) break;
    const push = byWorkspace.get(task.workspaceId)!;
    const candidate = push.candidates[task.candidateIndex];
    const payload = notificationPayload(candidate, !!task.sub.content_free, push.timezone, push.now);
    const outcome = await sendOne(env, task.sub, payload);
    fetchesUsed++;

    const state = states.get(task.workspaceId)!;
    if (outcome.result === "ok") state.sent++;
    state.outcomes.push({ hash: task.sub.endpoint_hash, result: outcome.result, httpStatus: outcome.httpStatus, failCountBefore: task.sub.fail_count });
    state.attempted.set(task.candidateIndex, (state.attempted.get(task.candidateIndex) ?? 0) + 1);
  }
  return states;
}

/**
 * Marks fully-covered candidates pushed (a candidate cut short by the
 * shared fetch budget stays eligible, so its remaining subscriptions — not
 * just the ones already reached — are retried in full next run), writes
 * the subscription-state batch, and persists the pushed map. One D1 batch
 * and one KV write, regardless of how many workspaces shared the budget.
 */
async function finalizeWorkspacePush(env: Env, push: WorkspacePush, state: WorkspaceRunState): Promise<PushDueItemsResult> {
  for (let candidateIndex = 0; candidateIndex < push.candidates.length; candidateIndex++) {
    if ((state.attempted.get(candidateIndex) ?? 0) === push.subs.length) {
      push.pushed[push.candidates[candidateIndex].id] = push.candidates[candidateIndex].when_at;
    }
  }

  await applySubscriptionOutcomes(env, state.outcomes);
  await env.OAUTH_KV.put(pushedKvKey(push.workspaceId), JSON.stringify(prunePushedMap(push.pushed, push.now)));

  return { sent: state.sent, candidates: push.candidates.length, subscriptions: push.subs.length, results: toReportedOutcomes(state.outcomes) };
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
 *
 * External-fetch cost: MAX_PUSH_FETCHES_PER_RUN at most (this call's own
 * budget — see pushDueItemsAllWorkspaces for the shared, multi-workspace
 * version of this same cap).
 */
export async function pushDueItems(env: Env, workspaceId: string, resolved?: Readonly<Config>): Promise<PushDueItemsResult> {
  const now = Date.now();
  const config = resolved ?? await resolveConfig(env);
  const prepared = await prepareWorkspacePush(env, workspaceId, now, config);
  if (!("candidates" in prepared)) return { sent: 0, candidates: prepared.candidateCount, subscriptions: 0, results: [] };

  const states = await sendTasks(env, [prepared], tasksFor(prepared), MAX_PUSH_FETCHES_PER_RUN);
  return finalizeWorkspacePush(env, prepared, states.get(workspaceId)!);
}

/**
 * Runs every workspace that actually has a subscription, rather than every
 * workspace in the brain: one extra SELECT (DISTINCT workspace_id) plus two
 * SELECTs and one batch per subscribed workspace, same as pushDueItems
 * alone. On the common case — one personal brain, one subscribed workspace
 * — that is four D1 statements total for the whole hourly run.
 *
 * External-fetch cost: MAX_PUSH_FETCHES_PER_RUN for the WHOLE run, shared
 * across every workspace (round-robin, see roundRobinTasks) rather than
 * reset per workspace — the free plan's 50-subrequest cap is per
 * invocation, and this one invocation covers every subscribed workspace.
 * Without this, a 9-member team with 3 due items on 2 devices each already
 * makes 54 sends before any other workspace is even counted.
 */
export async function pushDueItemsAllWorkspaces(env: Env, resolved?: Readonly<Config>): Promise<{ sent: number }> {
  const rows = ((await env.DB.prepare(
    `SELECT DISTINCT workspace_id FROM push_subscriptions`,
  ).all()).results ?? []) as { workspace_id: string }[];

  const now = Date.now();
  const config = resolved ?? await resolveConfig(env);
  const pushes: WorkspacePush[] = [];
  for (const row of rows) {
    const prepared = await prepareWorkspacePush(env, row.workspace_id, now, config);
    if ("candidates" in prepared) pushes.push(prepared);
  }

  const states = await sendTasks(env, pushes, roundRobinTasks(pushes), MAX_PUSH_FETCHES_PER_RUN);

  let sent = 0;
  for (const push of pushes) {
    const result = await finalizeWorkspacePush(env, push, states.get(push.workspaceId)!);
    sent += result.sent;
  }
  return { sent };
}

/** POST /push/test's fixed notification, bypassing the due query entirely. */
export interface SendTestNotificationResult {
  sent: number;
  subscriptions: number;
  /** Same shape POST /push/run reports — shared code path, not a duplicate. */
  results: PushOutcome[];
}

export async function sendTestNotification(env: Env, workspaceId: string): Promise<SendTestNotificationResult> {
  const subs = ((await env.DB.prepare(
    `SELECT id, endpoint_hash, subscription_json, content_free, fail_count FROM push_subscriptions WHERE workspace_id = ?`,
  ).bind(workspaceId).all()).results ?? []) as unknown as PushSubscriptionRow[];
  if (!subs.length) return { sent: 0, subscriptions: 0, results: [] };

  const payload = { title: "Second Brain", body: "Test notification. Push is working." };
  let sent = 0;
  const outcomes: { hash: string; result: SendResult; httpStatus: number | null; failCountBefore: number }[] = [];
  for (const sub of subs) {
    const outcome = await sendOne(env, sub, payload);
    if (outcome.result === "ok") sent++;
    outcomes.push({ hash: sub.endpoint_hash, result: outcome.result, httpStatus: outcome.httpStatus, failCountBefore: sub.fail_count });
  }
  await applySubscriptionOutcomes(env, outcomes);

  return { sent, subscriptions: subs.length, results: toReportedOutcomes(outcomes) };
}
