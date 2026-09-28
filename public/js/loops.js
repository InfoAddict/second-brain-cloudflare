// The open-loops queue: entries tagged "task" that have not been marked done.
//
// Mirrors stale.js's shape (a home preview backed by a "see all" sheet paging
// the full queue) because it exists for the same reason: a member re-reading
// scrollback for "what did I say I'd do" cannot ask a vector index that
// question reliably, and a chip that names a count needs a queue behind it
// that actually holds that many rows. See GET /loops, POST /loops/resolve
// (src/routes/admin.ts) and the shared predicate OPEN_LOOP_SQL
// (src/memory/loops.ts).
//
// T7-E (Track 7 lane E, Design 5): the queue now splits by direction. "You
// owe" (outbound) is the original queue; "Owed to you" (inbound) is a
// two-way commitment someone else made to the user (owed_by on capture,
// src/commitments/direction.ts). The sheet pages GET /loops?direction=out|in
// through a segmented control; the home panel (board.js's renderLoopsPanel)
// shows both groups from the one /brief fetch.

/** Entries fetched per page. The Worker caps `limit` at 100. */
const LOOPS_PAGE = 50

/** Everything loaded so far in the sheet, in order. */
let loadedLoops = []
/** How many the Worker says are open for the CURRENT direction, which may be more than are on screen. */
let loopsTotal = 0
/** Which tab the sheet is showing. Not persisted across opens: Design 7.1 states "out" as the default every time. */
let loopsDirection = 'out'

function openLoopsSheet() {
  closeMenu()
  loadedLoops = []
  loopsDirection = 'out'
  updateLoopsTabs()
  document.getElementById('loops-sheet').classList.add('open')
  return loadLoopsQueue()
}

function closeLoopsSheet() {
  document.getElementById('loops-sheet').classList.remove('open')
}

/** Reflects loopsDirection onto the two tab buttons, if the sheet's markup has them (index.html). */
function updateLoopsTabs() {
  const outTab = document.getElementById('loops-tab-out')
  const inTab = document.getElementById('loops-tab-in')
  if (outTab) {
    outTab.classList.toggle('active', loopsDirection === 'out')
    outTab.setAttribute('aria-selected', String(loopsDirection === 'out'))
  }
  if (inTab) {
    inTab.classList.toggle('active', loopsDirection === 'in')
    inTab.setAttribute('aria-selected', String(loopsDirection === 'in'))
  }
}

/** Switches the sheet's tab, dropping whatever the other tab had loaded and paging the new one fresh. */
function setLoopsDirection(direction) {
  if (direction !== 'out' && direction !== 'in') return
  if (direction === loopsDirection) return
  loopsDirection = direction
  loadedLoops = []
  updateLoopsTabs()
  return loadLoopsQueue()
}

async function loadLoopsQueue({ append = false } = {}) {
  const list = document.getElementById('loops-list')
  if (!append) list.innerHTML = `<p class="digest-note">${escHtml(t('integrations.loading'))}</p>`
  try {
    const res = await fetch(`${WORKER_URL}/loops?direction=${loopsDirection}&limit=${LOOPS_PAGE}&offset=${append ? loadedLoops.length : 0}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'failed')
    loopsTotal = data.total
    loadedLoops = append ? [...loadedLoops, ...data.entries] : data.entries
    renderLoopsQueue()
  } catch {
    // Deliberately not the empty state: "nothing is open" would tell the user
    // their list is clear at exactly the moment it could not be checked.
    if (!append) {
      list.innerHTML = `<p class="digest-note"><i class="ti ti-wifi-off"></i> ${escHtml(t('loops.loadFailed'))}</p>` +
        `<button type="button" class="digest-more" onclick="loadLoopsQueue()">${escHtml(t('loops.tryAgain'))}</button>`
    }
  }
}

function loadMoreLoops(btn) {
  btn.disabled = true
  btn.textContent = t('integrations.loading')
  loadLoopsQueue({ append: true })
}

/**
 * "due Sep 1" (still ahead) or "was due Sep 1" (already past) for an inbound
 * row carrying the promised date. Design 7.1 names this line, but neither GET
 * /loops nor the dashboard brief's loop preview currently returns a
 * when_at for these rows (see the T7-E report: a backend gap) — this reads
 * defensively and renders nothing until one does.
 */
function loopDueLine(item) {
  if (!item || !item.when_at) return ''
  const date = formatDateUI(item.when_at, { year: 'numeric', month: 'short', day: 'numeric' })
  return item.when_at < Date.now() ? t('loops.wasDueDate', { date }) : t('loops.dueDate', { date })
}

/**
 * The counterparty tag's display name, derived from `tags` the same way GET
 * /loops itself does (src/commitments/direction.ts's counterpartyOf) — read
 * client-side because the dashboard brief's loop preview items (Design 5.3
 * L2) carry `tags` but not a pre-computed `counterparty` field.
 */
function loopCounterpartyOf(tags) {
  const tag = (tags || []).find((tag) => String(tag).startsWith('counterparty:'))
  if (!tag) return ''
  return tag
    .slice('counterparty:'.length)
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ')
}

/** "in" when the row itself says so, or carries the inbound marker tag — covers both a sheet row (direction from GET /loops) and a panel row (direction from the brief's loop preview). */
function loopIsInbound(item) {
  if (!item) return false
  return item.direction === 'in' || (item.tags || []).includes('owed-to-me')
}

/** Finds a loop item by id wherever the caller (sheet or panel) might have it loaded, so resolveLoop can tell its direction regardless of which one invoked it. */
function findLoopItem(id) {
  const fromSheet = loadedLoops.find((e) => e.id === id)
  if (fromSheet) return fromSheet
  if (typeof briefData !== 'undefined' && briefData && briefData.loops && Array.isArray(briefData.loops.items)) {
    return briefData.loops.items.find((e) => e.id === id)
  }
  return undefined
}

function loopRow(e) {
  const inbound = loopIsInbound(e)
  const counterparty = e.counterparty || loopCounterpartyOf(e.tags)
  const metaParts = inbound ? [counterparty ? t('loops.fromName', { name: counterparty }) : '', loopDueLine(e)].filter(Boolean) : []
  const meta = metaParts.length ? `<span>${escHtml(metaParts.join(' · '))}</span>` : ''
  const doneLabel = inbound ? t('loops.received') : t('loops.done')
  const notTaskLabel = inbound ? t('due.notCommitment') : t('loops.notTask')
  return `
    <div class="task" id="loop-row-${escAttr(e.id)}">
      <div class="task-t">${escHtml(titleLine(e.content, 120))}${meta}</div>
      <div class="task-actions">
        <button type="button" class="card-action-btn" onclick="resolveLoop('${escAttr(e.id)}', 'done', this)"><i class="ti ti-check"></i> ${escHtml(doneLabel)}</button>
        <button type="button" class="card-action-btn" onclick="resolveLoop('${escAttr(e.id)}', 'not-task', this)"><i class="ti ti-x"></i> ${escHtml(notTaskLabel)}</button>
      </div>
    </div>`
}

function renderLoopsQueue() {
  const list = document.getElementById('loops-list')
  const more = document.getElementById('loops-more')

  if (!loadedLoops.length) {
    list.innerHTML = `<p class="digest-note">${escHtml(t('loops.empty'))}</p>`
    more.hidden = true
    return
  }

  list.innerHTML = loadedLoops.map(loopRow).join('')

  const remaining = loopsTotal - loadedLoops.length
  more.hidden = remaining <= 0
  if (remaining > 0) more.textContent = t('loops.more', { n: remaining })
}

/** Take a resolved loop out of the sheet, if it is showing. Mirrors dropFromStaleQueue. */
function dropFromLoopsQueue(id) {
  if (!loadedLoops.length) return
  const remaining = loadedLoops.filter((e) => e.id !== id)
  if (remaining.length === loadedLoops.length) return
  loadedLoops = remaining
  loopsTotal = Math.max(0, loopsTotal - 1)
  renderLoopsQueue()
}

/** The toast shown after a successful resolve, by action and direction (Design 7.1: "Each shows an Undo toast."). */
function loopResolvedToast(action, inbound) {
  if (action === 'done') return inbound ? t('loops.receivedToast') : t('loops.doneToast')
  return t('loops.notTaskToast')
}

/**
 * Resolve one loop, wherever it is showing: the home panel's preview (via
 * `briefData`, the cache brief.js keeps and board.js re-renders from — classic
 * scripts sharing one top-level scope, not a module import) and the full
 * sheet, if open. Optimistic: the row is gone the moment the Worker confirms
 * it, with no wait for the next scheduled /brief refetch.
 *
 * On success, shows an Undo toast: the same generic POST /undo (src/routes/
 * entries.ts) memory-crud.js's own writes use, since /loops/resolve's write
 * goes through the same Track 1 version-snapshot batch (resolveEntryAction)
 * any other single-entry revert can reach.
 */
async function resolveLoop(id, action, btn) {
  if (btn) btn.disabled = true
  const inbound = loopIsInbound(findLoopItem(id))
  try {
    const res = await fetch(`${WORKER_URL}/loops/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ id, action }),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'failed')

    if (typeof briefData !== 'undefined' && briefData) {
      if (briefData.loops && Array.isArray(briefData.loops.items)) {
        briefData.loops.items = briefData.loops.items.filter((i) => i.id !== id)
        if (!inbound) briefData.loops.open = Math.max(0, (briefData.loops.open || 0) - 1)
      }
      if (inbound && typeof briefData.owed_to_me === 'number') {
        briefData.owed_to_me = Math.max(0, briefData.owed_to_me - 1)
      }
    }
    dropFromLoopsQueue(id)
    if (typeof renderBoard === 'function' && typeof briefData !== 'undefined' && briefData) renderBoard(briefData)

    showToast(loopResolvedToast(action, inbound), {
      action: t('loops.undo'),
      onAction: async () => {
        try {
          const undoRes = await fetch(`${WORKER_URL}/undo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
            body: JSON.stringify({ id }),
          })
          const undoData = await undoRes.json()
          if (!undoData.ok) throw new Error(undoData.error || 'failed')
          loadLoopsQueue()
        } catch (e) {
          showToast(t('loops.undoFailed', { message: e.message }))
        }
      },
    })
  } catch (e) {
    if (btn) btn.disabled = false
    if (action !== 'done') showToast(t('loops.notTaskFailed', { message: e.message }))
    else if (inbound) showToast(t('loops.receivedFailed', { message: e.message }))
    else showToast(t('loops.doneFailed', { message: e.message }))
  }
}
