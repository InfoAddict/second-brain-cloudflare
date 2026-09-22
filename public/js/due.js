// The due sheet: list from GET /due, with Done / Snooze / Not a commitment
// actions on each row. Opened from the attention chip, or from a push
// notification's deep link — public/sw.js's notificationclick, arriving
// through any of four redundant channels; see handleDueLink below.
// See GET /due, POST /due/snooze, POST /due/clear (src/routes/admin.ts).

/** Whatever the sheet last loaded, kept so an action can drop a row without a refetch. */
let loadedDue = { overdue: [], upcoming: [] }
/**
 * Monotonic. A cold boot can fire more than one loadDueQueue call for one
 * deep link (live-traced: an early, unauthenticated GET /due racing the
 * later, properly-awaited one — see handleDueLink below), and whichever
 * call's response arrives LAST used to win regardless of which one actually
 * started last, so a slow, stale failure could clobber an already-rendered
 * success. Every invocation stamps its own id here at the top, before any
 * await, and checks it again after — only the invocation matching the
 * CURRENT value (i.e. the most recently STARTED one) is allowed to write
 * #due-list, on success or failure alike. Protects every caller, not just
 * the boot path.
 */
let dueLoadSeq = 0

function openDueSheet(highlightId) {
  closeMenu()
  document.getElementById('due-sheet').classList.add('open')
  return loadDueQueue(highlightId)
}

function closeDueSheet() {
  document.getElementById('due-sheet').classList.remove('open')
}

async function loadDueQueue(highlightId) {
  // Never fetch, never render, on a call that arrived before credentials
  // exist — see handleDueLink's own guard for the boot-time case this
  // protects against; this one is belt-and-braces for any other caller.
  if (!WORKER_URL || !AUTH_TOKEN) return
  const seq = ++dueLoadSeq
  const list = document.getElementById('due-list')
  list.innerHTML = `<p class="digest-note">${escHtml(t('integrations.loading'))}</p>`
  try {
    const res = await fetch(`${WORKER_URL}/due`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'failed')
    if (seq !== dueLoadSeq) return // a newer call has since started; never clobber its render
    loadedDue = { overdue: data.overdue, upcoming: data.upcoming }
    renderDueQueue(highlightId)
  } catch {
    if (seq !== dueLoadSeq) return // stale failure — a newer call is in flight or already rendered
    // Deliberately not the empty state: see loops.js's loadLoopsQueue for why.
    list.innerHTML = `<p class="digest-note"><i class="ti ti-wifi-off"></i> ${escHtml(t('due.loadFailed'))}</p>`
  }
}

function dueWhenLine(item) {
  // Local time (formatDateUI), not UTC: when_at now anchors midnight in the
  // brain's configured TIMEZONE (src/config.ts, src/when/timezone.ts), not
  // UTC midnight, so the browser's own local render already shows the
  // intended calendar date for someone in that zone.
  return t('due.due', { date: formatDateUI(item.when_at, { year: 'numeric', month: 'short', day: 'numeric' }) })
}

/**
 * `expanded` (the row the caller deep-linked to, if any) shows the fuller
 * content GET /due carries and its tags; every other row shows the short
 * label so the sheet is scannable rather than a wall of full memories.
 */
function dueRow(item, expanded) {
  const isTask = (item.tags || []).includes('task')
  const tagsLine = expanded && item.tags && item.tags.length
    ? `<div class="card-tags due-tags">${item.tags.map((tag) => `<span class="tag-chip">${escHtml(tag)}</span>`).join('')}</div>`
    : ''
  const body = expanded ? escHtml(item.content) : escHtml(titleLine(item.label, 120))
  // Content full-width, then tags/date, then a wrapping actions row (up to
  // four buttons) — .due-row stacks rather than sitting content and actions
  // side by side the way loops.js's shared .task layout does, which left the
  // content column a sliver once four buttons claimed the rest of the row.
  return `
    <div class="due-row${expanded ? ' due-row-expanded' : ''}" id="due-row-${escAttr(item.id)}">
      <div class="due-text">${body}</div>
      ${tagsLine}
      <div class="digest-note">${escHtml(dueWhenLine(item))}</div>
      <div class="due-actions">
        <button type="button" class="card-action-btn" onclick="resolveDue('${escAttr(item.id)}', 'done', ${isTask}, this)"><i class="ti ti-check"></i> ${escHtml(t('due.done'))}</button>
        <button type="button" class="card-action-btn" onclick="snoozeDue('${escAttr(item.id)}', 'tomorrow', this)"><i class="ti ti-clock"></i> ${escHtml(t('due.snoozeTomorrow'))}</button>
        <button type="button" class="card-action-btn" onclick="snoozeDue('${escAttr(item.id)}', 'next-week', this)"><i class="ti ti-clock"></i> ${escHtml(t('due.snoozeNextWeek'))}</button>
        <button type="button" class="card-action-btn" onclick="resolveDue('${escAttr(item.id)}', 'clear', false, this)"><i class="ti ti-x"></i> ${escHtml(t('due.notCommitment'))}</button>
      </div>
    </div>`
}

function renderDueQueue(highlightId) {
  const list = document.getElementById('due-list')
  const items = [...loadedDue.overdue, ...loadedDue.upcoming]
  if (!items.length) {
    list.innerHTML = `<p class="digest-note">${escHtml(t('due.empty'))}</p>`
    return
  }
  list.innerHTML = items.map((item) => dueRow(item, item.id === highlightId)).join('')
  if (highlightId) {
    const row = document.getElementById(`due-row-${highlightId}`)
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' })
  }
}

/** Take a resolved/snoozed item out of the sheet, mirroring loops.js's dropFromLoopsQueue. */
function dropFromDueQueue(id) {
  loadedDue.overdue = loadedDue.overdue.filter((i) => i.id !== id)
  loadedDue.upcoming = loadedDue.upcoming.filter((i) => i.id !== id)
  renderDueQueue()
}

/**
 * 'done' resolves through /loops/resolve when the entry is task-tagged — a
 * real open commitment being finished, the same action loops.js offers —
 * and through /due/clear otherwise, since there is no task to mark done.
 * 'clear' (Not a commitment) always goes through /due/clear.
 */
async function resolveDue(id, action, isTask, btn) {
  if (btn) btn.disabled = true
  try {
    const res = action === 'done' && isTask
      ? await fetch(`${WORKER_URL}/loops/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
        body: JSON.stringify({ id, action: 'done' }),
      })
      : await fetch(`${WORKER_URL}/due/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
        body: JSON.stringify({ id }),
      })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'failed')
    dropFromDueQueue(id)
  } catch (e) {
    if (btn) btn.disabled = false
    showToast(action === 'done' ? t('due.doneFailed', { message: e.message }) : t('due.clearFailed', { message: e.message }))
  }
}

function snoozeUntilDate(choice) {
  const DAY = 24 * 60 * 60 * 1000
  const days = choice === 'next-week' ? 7 : 1
  return new Date(Date.now() + days * DAY).toISOString().slice(0, 10)
}

async function snoozeDue(id, choice, btn) {
  if (btn) btn.disabled = true
  try {
    const res = await fetch(`${WORKER_URL}/due/snooze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ id, until: snoozeUntilDate(choice) }),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'failed')
    dropFromDueQueue(id)
  } catch (e) {
    if (btn) btn.disabled = false
    showToast(t('due.snoozeFailed', { message: e.message }))
  }
}

/**
 * A due deep link can arrive through four redundant channels (public/sw.js's
 * notificationclick, hardened against iOS's unreliable URL/navigation
 * handling on notification tap):
 *
 *   1. navigator.serviceWorker's 'message' event ({type:'due-deep-link'}) —
 *      an already-open client got focused and postMessage'd directly.
 *   2. location.hash '#due/<id>' — a same-document hashchange, or present
 *      on the very first load.
 *   3. location.search '?due=<id>' — the URL openWindow was given; iOS has
 *      been observed to preserve query/path more reliably than a fragment.
 *   4. IndexedDB's stashed pending record (public/js/pending-due.js) — the
 *      service worker's own fallback for when NEITHER a live client nor the
 *      opened window's URL survived the OS's PWA-launch handling.
 *
 * All four no-op completely — no fetch, no failure note, no state consumed —
 * before WORKER_URL/AUTH_TOKEN exist, so boot ordering never matters: due.js
 * loads (and its listeners register) well before app.js runs init() and
 * sets them, and a channel firing that early must leave everything exactly
 * as it found it for a later, properly-authenticated call to still see.
 */

/**
 * Held for the ENTIRE duration of one handleDueLink call, from just after
 * the auth-readiness check through every channel it tries — not just the
 * final openDueSheet — because the IndexedDB fallback below awaits a read
 * before it knows whether there is anything to open at all. Multiple resume
 * signals (visibilitychange, pageshow, focus) fire together in practice, and
 * without a guard held that early, two concurrent calls could both read the
 * same still-unread record and both open the sheet. A flag, not a time
 * window: whichever call is already running wins, and the next one that
 * finds the guard clear starts a fresh, honest check.
 */
let dueLinkInFlight = false

/** How long a stashed IndexedDB record is trusted — older is a previous tap already handled some other way, not a fresh one to resurrect. */
const DUE_LINK_PENDING_TTL_MS = 2 * 60 * 1000

/**
 * Checks the hash, then the search param, then the IndexedDB fallback, in
 * that order, and opens the first one found. Call on boot (showApp), on
 * 'hashchange' (an already-loaded tab whose hash changes, e.g. via
 * client.navigate() on browsers that still honor it), and on RESUME
 * (visibilitychange to visible, pageshow, window focus) — iOS wakes a
 * backgrounded PWA by resuming it, not by navigating or booting, so nothing
 * else would ever see a notification tap that landed while the app was
 * merely suspended rather than closed. See public/sw.js's
 * handleNotificationClick: the IndexedDB stash now happens unconditionally,
 * before postMessage and before openWindow, precisely because either of
 * those can be lost to a frozen/suspended page while the stash cannot.
 */
async function handleDueLink() {
  if (dueLinkInFlight) return
  // due.js loads and registers the hashchange listener below well before
  // app.js (loaded last of every script) runs init() and sets these — and
  // the browser itself dispatches 'hashchange' during the initial
  // navigation into a URL with a fragment, catching this listener that
  // early. A call this early must do nothing at all: no fetch (an empty
  // AUTH_TOKEN still sends "Bearer " and the Worker 401s), no failure note,
  // and critically no hash/search-clear and no IndexedDB read/clear — so
  // every channel is still there, and this function still callable, once
  // showApp's own later call arrives with real credentials.
  if (!WORKER_URL || !AUTH_TOKEN) return

  dueLinkInFlight = true
  try {
    const hash = window.location.hash || ''
    const hashMatch = hash.match(/^#due\/(.+)$/)
    if (hashMatch) {
      const id = decodeURIComponent(hashMatch[1])
      // Cleared BEFORE anything async runs, so a hashchange re-firing for the
      // same tap finds nothing left to match.
      history.replaceState(null, '', window.location.pathname + window.location.search)
      await openDueSheet(id)
      return
    }

    const params = new URLSearchParams(window.location.search)
    const searchId = params.get('due')
    if (searchId) {
      params.delete('due')
      const query = params.toString()
      history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : '') + window.location.hash)
      await openDueSheet(searchId)
      return
    }

    if (typeof readPendingDueRecord !== 'function') return
    const record = await readPendingDueRecord()
    if (!record) return
    await clearPendingDueRecord()
    if (Date.now() - record.at < DUE_LINK_PENDING_TTL_MS) await openDueSheet(record.id)
  } finally {
    dueLinkInFlight = false
  }
}

/** An id delivered via the service worker's postMessage before auth was ready; drained by flushPendingDueLinkMessage() once it is. */
let pendingDueLinkFromMessage = null

/** Called on boot (alongside handleDueLink) so a message that arrived pre-auth still gets opened once credentials exist. */
function flushPendingDueLinkMessage() {
  if (!pendingDueLinkFromMessage) return
  if (!WORKER_URL || !AUTH_TOKEN) return
  const id = pendingDueLinkFromMessage
  pendingDueLinkFromMessage = null
  openDueSheet(id)
}

/**
 * navigator.serviceWorker's 'message' event, from public/sw.js's
 * notificationclick: far more reliable than the URL-based channels above
 * when a window is ALREADY open, since it needs no navigation at all — see
 * public/sw.js for why client.navigate() was dropped in favor of it. Queues
 * rather than drops when auth is not ready yet; flushPendingDueLinkMessage
 * (called from showApp) drains the queue once it is.
 *
 * The service worker now stashes to IndexedDB unconditionally, even on this
 * same client-exists branch, so this path opens the sheet immediately AND
 * clears that record (fire-and-forget — the open above already happened;
 * this is just cleanup) so a resume listener firing moments later never
 * finds a stale record and reopens the same tap a second time.
 */
function handleDueLinkMessage(entryId) {
  if (!entryId) return
  pendingDueLinkFromMessage = entryId
  if (typeof clearPendingDueRecord === 'function') clearPendingDueRecord()
  flushPendingDueLinkMessage()
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  // showApp() covers a fresh load/login, but a push notification's tap more
  // often finds the PWA already open in a backgrounded tab, whose hash can
  // still change without re-running init()/showApp() on browsers that honor
  // client.navigate(). Without this listener that change was silently
  // ignored and whatever sheet was left open (often the menu, from enabling
  // notifications there) stayed on screen.
  window.addEventListener('hashchange', handleDueLink)
  // iOS resumes a backgrounded PWA rather than reloading or navigating it —
  // no boot, no hashchange. pageshow and focus cover browsers/situations
  // visibilitychange alone misses (e.g. a window regaining focus without a
  // visibility transition); handleDueLink's own in-flight guard and its
  // no-op-before-auth check make firing all of these together cheap and safe.
  window.addEventListener('pageshow', handleDueLink)
  window.addEventListener('focus', handleDueLink)
}
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') handleDueLink()
  })
}
if (typeof navigator !== 'undefined' && navigator.serviceWorker && typeof navigator.serviceWorker.addEventListener === 'function') {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event && event.data
    if (data && data.type === 'due-deep-link') handleDueLinkMessage(data.entry_id)
  })
}
