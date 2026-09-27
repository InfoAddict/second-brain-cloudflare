// The one place a dashboard write turns into POST /undo and a result toast.
// SH-1's history rows (Undo, Restore this version) and every SH-2 write-site
// toast call through these three functions, so the result mapping and the
// double-submit guard live once.

/** Never throws: a network failure and a 4xx/5xx both come back as {ok:false}. */
async function apiUndo(id, toVersion) {
  const body = toVersion ? { id, to_version: toVersion } : { id }
  try {
    const res = await fetch(`${WORKER_URL}/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify(body),
    })
    let data = {}
    try {
      data = await res.json()
    } catch {}
    return { ok: res.ok, status: res.status, data }
  } catch (e) {
    return { ok: false, status: 0, data: { error: e.message } }
  }
}

/**
 * Maps one /undo result to a toast, and reports whether the memory actually
 * changed so the caller knows whether to refresh.
 *
 * Branches on `data.status` and HTTP status first, since those are stable
 * across Worker versions; `data.reason` (BE-4's honest 404/409 detail: pruned,
 * gone, mirror) is read where present but nothing here requires it, so this
 * degrades to the server's own message on a Worker that predates BE-4.
 *
 * `opts.provider`, when the caller has it (the entry's own source, read the
 * same way history rows read {provider} for a sync row), fills the mirror
 * toast's template. BE-4's 409 body carries no provider field of its own, so
 * without one this falls back to the server's own sentence.
 */
function undoResultToast(result, opts = {}) {
  const data = result.data || {}
  if (result.ok && data.ok) {
    if (data.status === 'no_change') {
      showToast(t('undo.noChange'))
      return { changed: false }
    }
    if (data.recreatedIncomingId) {
      showToast(t('undo.recreated'), {
        action: t('undo.open'),
        onAction: () => {
          if (typeof opts.onOpen === 'function') opts.onOpen(data.recreatedIncomingId)
        },
      })
      return { changed: true }
    }
    if (data.incomingTruncated) {
      showToast(t('undo.incomingTruncated'))
      return { changed: true }
    }
    // reverted and restored share one toast (SH-2's result table).
    showToast(t('undo.undone'))
    return { changed: true }
  }
  if (result.status === 403) {
    showToast(t('undo.forbidden'))
    return { changed: false }
  }
  if (result.status === 409 && data.reason === 'stale') {
    showToast(t('undo.stale'))
    return { changed: false }
  }
  if (result.status === 409 && data.reason === 'mirror') {
    showToast(opts.provider ? t('undo.mirror', { provider: opts.provider }) : data.error || t('team.actionFailed'))
    return { changed: false }
  }
  if (result.status === 404 && data.reason === 'gone') {
    showToast(t('undo.gone'))
    return { changed: false }
  }
  if (result.status === 500 || result.status === 502) {
    showToast(t('undo.reembedFailed'))
    return { changed: false }
  }
  showToast(data.error || t('team.actionFailed'))
  return { changed: false }
}

/**
 * The write-site pattern: show the "it happened" toast with an Undo action.
 * A second click while the first POST is in flight is a no-op — the guard is
 * per call, matching the one Undo button the toast ever shows at once.
 */
function undoToast(message, id, opts = {}) {
  let inFlight = false
  showToast(message, {
    action: t('history.undo'),
    onAction: async () => {
      if (inFlight) return
      inFlight = true
      try {
        const result = await apiUndo(id)
        const { changed } = undoResultToast(result, opts)
        if (changed && typeof opts.onUndone === 'function') opts.onUndone(result.data)
      } finally {
        inFlight = false
      }
    },
  })
}

/** Sequential, capped at 50 (SH-2): one summary toast, not one per row. */
async function undoMany(ids) {
  const capped = ids.slice(0, 50)
  let succeeded = 0
  for (const id of capped) {
    const result = await apiUndo(id)
    if (result.ok && result.data?.ok && result.data.status !== 'no_change') succeeded++
  }
  showToast(t('undo.bulkSummary', { n: succeeded, total: capped.length }))
  return { succeeded, total: capped.length }
}
