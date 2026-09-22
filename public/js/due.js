// The due sheet: list from GET /due, with Done / Snooze / Not a commitment
// actions on each row. Opened from the attention chip, or from a push
// notification's deep link (#due/<id>, public/sw.js's notificationclick).
// See GET /due, POST /due/snooze, POST /due/clear (src/routes/admin.ts).

/** Whatever the sheet last loaded, kept so an action can drop a row without a refetch. */
let loadedDue = { overdue: [], upcoming: [] }
/**
 * Monotonic. A cold boot can fire more than one loadDueQueue call for one
 * deep link (live-traced: an early, unauthenticated GET /due racing the
 * later, properly-awaited one — see handleDueHash below), and whichever
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
  // exist — see handleDueHash's own guard for the boot-time case this
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
 * `#due/<id>`, from a push notification's notificationclick (public/sw.js)
 * or a shared link. Read once on load, then cleared so a refresh does not
 * reopen the same sheet. Additive — the one hash this dashboard interprets,
 * no router.
 */
/** Set for the duration of one handleDueHash-driven load; see the guard below. */
let dueHashInFlight = false

function handleDueHash() {
  // A tap on the same notification has been observed to fire this twice in
  // one boot with no second call site anywhere in this codebase — ignore
  // re-entry while the first is still in flight rather than starting a
  // second, redundant load.
  if (dueHashInFlight) return
  // due.js loads and registers the hashchange listener below well before
  // app.js (loaded last of every script) runs init() and sets these — and
  // the browser itself dispatches 'hashchange' during the initial
  // navigation into a URL with a fragment (observed via the service
  // worker's client.navigate()/openWindow() path), catching this listener
  // that early. A call this early must do nothing at all: no fetch (an
  // empty AUTH_TOKEN still sends "Bearer " and the Worker 401s), no failure
  // note, and critically no hash-clear and no in-flight flag — so the hash
  // is still there, and this function still callable, once showApp's own
  // later call arrives with real credentials.
  if (!WORKER_URL || !AUTH_TOKEN) return
  const hash = window.location.hash || ''
  const match = hash.match(/^#due\/(.+)$/)
  if (!match) return
  const id = decodeURIComponent(match[1])
  // Cleared BEFORE anything async runs, so a hashchange re-firing for the
  // same tap finds nothing left to match.
  history.replaceState(null, '', window.location.pathname + window.location.search)
  dueHashInFlight = true
  Promise.resolve(openDueSheet(id)).finally(() => { dueHashInFlight = false })
}

// showApp() covers a fresh load/login, but a push notification's tap more
// often finds the PWA already open in a backgrounded tab: public/sw.js's
// notificationclick focuses that client and calls client.navigate(url),
// which changes the hash WITHOUT re-running init()/showApp(). Without this
// listener the hash change was silently ignored and whatever sheet was left
// open (often the menu, from enabling notifications there) stayed on screen.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('hashchange', handleDueHash)
}
