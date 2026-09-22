// The due sheet: list from GET /due, with Done / Snooze / Not a commitment
// actions on each row. Opened from the attention chip, or from a push
// notification's deep link (#due/<id>, public/sw.js's notificationclick).
// See GET /due, POST /due/snooze, POST /due/clear (src/routes/admin.ts).

/** Whatever the sheet last loaded, kept so an action can drop a row without a refetch. */
let loadedDue = { overdue: [], upcoming: [] }

function openDueSheet(highlightId) {
  closeMenu()
  document.getElementById('due-sheet').classList.add('open')
  loadDueQueue(highlightId)
}

function closeDueSheet() {
  document.getElementById('due-sheet').classList.remove('open')
}

async function loadDueQueue(highlightId) {
  const list = document.getElementById('due-list')
  list.innerHTML = `<p class="digest-note">${escHtml(t('integrations.loading'))}</p>`
  try {
    const res = await fetch(`${WORKER_URL}/due`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'failed')
    loadedDue = { overdue: data.overdue, upcoming: data.upcoming }
    renderDueQueue(highlightId)
  } catch {
    // Deliberately not the empty state: see loops.js's loadLoopsQueue for why.
    list.innerHTML = `<p class="digest-note"><i class="ti ti-wifi-off"></i> ${escHtml(t('due.loadFailed'))}</p>`
  }
}

function dueWhenLine(item) {
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
    ? `<div class="due-tags">${item.tags.map((tag) => `<span class="tag-chip">${escHtml(tag)}</span>`).join('')}</div>`
    : ''
  const body = expanded ? escHtml(item.content) : escHtml(titleLine(item.label, 120))
  return `
    <div class="task due-row${expanded ? ' due-row-expanded' : ''}" id="due-row-${escAttr(item.id)}">
      <div class="task-t">${body}</div>
      ${tagsLine}
      <div class="digest-note">${escHtml(dueWhenLine(item))}</div>
      <div class="task-actions">
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
function handleDueHash() {
  const hash = window.location.hash || ''
  const match = hash.match(/^#due\/(.+)$/)
  if (!match) return
  const id = decodeURIComponent(match[1])
  history.replaceState(null, '', window.location.pathname + window.location.search)
  openDueSheet(id)
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
