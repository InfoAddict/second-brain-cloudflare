// The out-of-date review queue.
//
// The staleness pass flags a memory whose claim has an age on it — something
// that was true when written and may not be now — and home shows the count as
// "N may be out of date". This is what sits behind that chip.
//
// It exists because the chip used to open a free-text recall for the literal
// phrase "What might be out of date?". That is a vector search over the whole
// brain, so it returned whichever memories happened to contain those words: on a
// real brain, a post about AI systems reciting outdated information and a note
// about naming requirements, while the one memory actually carrying the tag
// never appeared. The model then said, correctly, that it could not tell what
// was out of date. The count is computed from an exact tag predicate, so the
// entries behind it were knowable the whole time.
//
// A client-side filter over the loaded list is not the fix either. The dashboard
// holds the 50 most recent entries and a memory old enough to be flagged is
// almost never among them, so that renders an empty queue instead of a wrong
// answer. The filtering is server-side, in GET /stale, which shares its
// predicate with the count so the two cannot disagree.

/** Entries fetched per page. The Worker caps `limit` at 100. */
const STALE_PAGE = 50

/** Everything loaded so far, in order. */
let loadedStale = []
/** How many the Worker says are flagged, which may be more than are on screen. */
let staleTotal = 0

function openStaleSheet() {
  closeMenu()
  loadedStale = []
  document.getElementById('stale-sheet').classList.add('open')
  loadStaleQueue()
}

function closeStaleSheet() {
  document.getElementById('stale-sheet').classList.remove('open')
  // Editing, appending to or forgetting a flagged memory all change the count
  // home is showing, and the brief was fetched before any of it happened.
  refreshAll({ list: false })
}

async function loadStaleQueue({ append = false } = {}) {
  const list = document.getElementById('stale-list')
  if (!append) list.innerHTML = `<p class="digest-note">${escHtml(t('integrations.loading'))}</p>`
  try {
    const res = await fetch(`${WORKER_URL}/stale?limit=${STALE_PAGE}&offset=${append ? loadedStale.length : 0}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'failed')
    staleTotal = data.total
    loadedStale = append ? [...loadedStale, ...data.entries] : data.entries
    renderStaleQueue()
  } catch {
    // Deliberately not the empty state: "nothing looks out of date" would tell
    // the user their brain is healthy at exactly the moment it could not be
    // checked, and the flagged memory would sit there unreviewed.
    if (!append) {
      list.innerHTML = `<p class="digest-note"><i class="ti ti-wifi-off"></i> ${escHtml(t('stale.loadFailed'))}</p>`
    }
  }
}

function loadMoreStale(btn) {
  btn.disabled = true
  btn.textContent = t('integrations.loading')
  loadStaleQueue({ append: true })
}

function staleRow(e) {
  // The date the claim was last confirmed, not when it was written. "Out of
  // date" is an assertion about age, and the reviewer cannot rule on it without
  // knowing how long it has been since anyone touched this.
  const confirmed = e.last_updated || e.created_at
  const when = confirmed
    ? t('stale.lastConfirmed', { date: formatDateUI(confirmed, { year: 'numeric', month: 'short', day: 'numeric' }) })
    : ''
  return `
    <div class="stale-row" id="stale-row-${escAttr(e.id)}">
      <p class="stale-text">${escHtml(e.content)}</p>
      ${when ? `<span class="stale-when">${escHtml(when)}</span>` : ''}
      <div class="stale-actions">
        <button class="card-action-btn" onclick="openEdit('${escAttr(e.id)}', ${escAttr(JSON.stringify(e.content))}, ${escAttr(JSON.stringify(e.tags || []))})"><i class="ti ti-pencil"></i> ${escHtml(t('memories.edit'))}</button>
        <button class="card-action-btn" onclick="openAppend('${escAttr(e.id)}', '${escAttr(e.content.slice(0, 80))}')"><i class="ti ti-writing"></i> ${escHtml(t('memories.append'))}</button>
        <button class="card-action-btn danger" onclick="openConfirm('${escAttr(e.id)}', this)"><i class="ti ti-trash"></i> ${escHtml(t('memories.forget'))}</button>
      </div>
    </div>`
}

/**
 * Take a memory out of the queue once it has been acted on.
 *
 * All three row actions resolve the row, for two different reasons: forget
 * removes the memory outright, while edit and append clear the staleness flag on
 * their own — touching a memory is what confirms it, so the Worker strips the
 * tag (tagsAfterWrite, tagsAfterAppend). Either way the row is answering a
 * question that has been answered, and leaving it there reads as the action
 * having failed.
 *
 * Called by memory-crud rather than reached for by it: this module knows what
 * its own queue holds, and an id it is not showing must leave it untouched, or
 * forgetting something from the Memories screen would renumber a queue that
 * never contained it.
 */
function dropFromStaleQueue(id) {
  if (!loadedStale.length) return
  const remaining = loadedStale.filter((e) => e.id !== id)
  if (remaining.length === loadedStale.length) return
  loadedStale = remaining
  // The total counts the whole queue, not the page, so it moves with the row —
  // otherwise "3 more" survives resolving all three.
  staleTotal = Math.max(0, staleTotal - 1)
  renderStaleQueue()
}

function renderStaleQueue() {
  const list = document.getElementById('stale-list')
  const more = document.getElementById('stale-more')

  if (!loadedStale.length) {
    list.innerHTML = `<p class="digest-note">${escHtml(t('stale.empty'))}</p>`
    more.hidden = true
    return
  }

  list.innerHTML = loadedStale.map(staleRow).join('')

  const remaining = staleTotal - loadedStale.length
  more.hidden = remaining <= 0
  if (remaining > 0) more.textContent = t('stale.more', { n: remaining })
}
