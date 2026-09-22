// The open-loops queue: entries tagged "task" that have not been marked done.
//
// Mirrors stale.js's shape (a home preview backed by a "see all" sheet paging
// the full queue) because it exists for the same reason: a member re-reading
// scrollback for "what did I say I'd do" cannot ask a vector index that
// question reliably, and a chip that names a count needs a queue behind it
// that actually holds that many rows. See GET /loops, POST /loops/resolve
// (src/routes/admin.ts) and the shared predicate OPEN_LOOP_SQL
// (src/memory/loops.ts).

/** Entries fetched per page. The Worker caps `limit` at 100. */
const LOOPS_PAGE = 50

/** Everything loaded so far in the sheet, in order. */
let loadedLoops = []
/** How many the Worker says are open, which may be more than are on screen. */
let loopsTotal = 0

function openLoopsSheet() {
  closeMenu()
  loadedLoops = []
  document.getElementById('loops-sheet').classList.add('open')
  loadLoopsQueue()
}

function closeLoopsSheet() {
  document.getElementById('loops-sheet').classList.remove('open')
}

async function loadLoopsQueue({ append = false } = {}) {
  const list = document.getElementById('loops-list')
  if (!append) list.innerHTML = `<p class="digest-note">${escHtml(t('integrations.loading'))}</p>`
  try {
    const res = await fetch(`${WORKER_URL}/loops?limit=${LOOPS_PAGE}&offset=${append ? loadedLoops.length : 0}`, {
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
      list.innerHTML = `<p class="digest-note"><i class="ti ti-wifi-off"></i> ${escHtml(t('loops.loadFailed'))}</p>`
    }
  }
}

function loadMoreLoops(btn) {
  btn.disabled = true
  btn.textContent = t('integrations.loading')
  loadLoopsQueue({ append: true })
}

function loopRow(e) {
  return `
    <div class="task" id="loop-row-${escAttr(e.id)}">
      <div class="task-t">${escHtml(titleLine(e.content, 120))}</div>
      <div class="task-actions">
        <button type="button" class="card-action-btn" onclick="resolveLoop('${escAttr(e.id)}', 'done', this)"><i class="ti ti-check"></i> ${escHtml(t('loops.done'))}</button>
        <button type="button" class="card-action-btn" onclick="resolveLoop('${escAttr(e.id)}', 'not-task', this)"><i class="ti ti-x"></i> ${escHtml(t('loops.notTask'))}</button>
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

/**
 * Resolve one loop, wherever it is showing: the home panel's preview (via
 * `briefData`, the cache brief.js keeps and board.js re-renders from — classic
 * scripts sharing one top-level scope, not a module import) and the full
 * sheet, if open. Optimistic: the row is gone the moment the Worker confirms
 * it, with no wait for the next scheduled /brief refetch.
 */
async function resolveLoop(id, action, btn) {
  if (btn) btn.disabled = true
  try {
    const res = await fetch(`${WORKER_URL}/loops/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ id, action }),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'failed')

    if (typeof briefData !== 'undefined' && briefData && briefData.loops) {
      briefData.loops.items = briefData.loops.items.filter((i) => i.id !== id)
      briefData.loops.open = Math.max(0, briefData.loops.open - 1)
    }
    dropFromLoopsQueue(id)
    if (typeof renderBoard === 'function' && typeof briefData !== 'undefined' && briefData) renderBoard(briefData)
  } catch (e) {
    if (btn) btn.disabled = false
    if (action === 'done') showToast(t('loops.doneFailed', { message: e.message }))
    else showToast(t('loops.notTaskFailed', { message: e.message }))
  }
}
