// Getting fresh data back after something changed.
//
// This dashboard is also the desktop app: the same HTML, loaded inside a Tauri
// window with no address bar, no reload button and no keyboard shortcut for
// one. So there is no "just refresh the page" fallback here — whatever the app
// fails to refetch stays wrong on screen until the user quits and reopens.
//
// That was not theoretical. The header count came from `/count` and the
// greeting's count came from the brief, and only the first was refetched after
// a delete — so the two lines disagreed with each other on the same screen,
// with no way for the user to resolve it. The fix is not "also refresh the
// brief there"; it is that every screen reads from one refresh, and every
// mutation calls it.
//
// The window can also sit open for days, so returning to it re-reads too.

/** Guards the interval-limited refreshes; a mutation always refreshes now. */
let lastRefreshAt = 0
/** Coalesces overlapping calls — two mutations in a row are one refetch. */
let refreshInFlight = null

/**
 * How long a background refresh trusts what is already on screen. Applies only
 * to refreshes nobody asked for (returning to the window, arriving at home);
 * an explicit press and a mutation both bypass it. Without a floor, flicking
 * between tabs would refetch the brief's six D1 queries every time.
 */
const REFRESH_MIN_INTERVAL_MS = 30_000

/**
 * Refetch everything the shell displays: the count in the header, the brief
 * behind the greeting, the list, and the tag vocabulary that the filters and
 * the editor both read.
 *
 * `list: false` is for callers that have already updated the list themselves —
 * deleting a memory animates its row out and drops it locally, and reloading
 * the list underneath that would replace the element mid-animation.
 */
async function refreshAll({ list = true } = {}) {
  if (!WORKER_URL || !AUTH_TOKEN) return
  if (refreshInFlight) return refreshInFlight

  // Class, not id: the control exists twice — sidebar on desktop, top bar on
  // mobile — and only one of the two is ever visible.
  const btns = document.querySelectorAll('.refresh-now')
  btns.forEach((b) => b.classList.add('spinning'))

  refreshInFlight = (async () => {
    const jobs = [updateStatus(), loadBrief(), loadTags()]
    if (list) jobs.push(loadRecent())
    // Only when it is open. The sheet reloads itself on open, so this covers the
    // one case that leaves: pressing refresh, or finishing a chore, while
    // looking at the numbers the chore just changed.
    const menu = document.getElementById('menu-sheet')
    if (menu && menu.classList.contains('open')) jobs.push(loadMenuStats())
    // Settled, not all: one endpoint being down should not leave the other
    // three showing stale numbers with no explanation.
    await Promise.allSettled(jobs)
    lastRefreshAt = Date.now()
  })()

  try {
    await refreshInFlight
  } finally {
    refreshInFlight = null
    btns.forEach((b) => b.classList.remove('spinning'))
  }
}

/** The background variant: refresh only if what is on screen has had time to go stale. */
function refreshIfStale(opts) {
  if (Date.now() - lastRefreshAt < REFRESH_MIN_INTERVAL_MS) return
  refreshAll(opts)
}

// Coming back to a window that has been in the background — another app, another
// desktop, a laptop reopened the next morning — is the one moment the user is
// most likely to be looking at numbers from a previous session.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshIfStale()
})
