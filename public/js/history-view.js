// SH-1: the history timeline on the memory sheet. renderHistory(entry) reads
// entry.history (contract 4.1 of the v4 UX build spec) and replaces the plain
// event list memory-crud.js used to draw by hand. memory-crud.js's
// renderViewTimeline delegates here when entry.history is present, and keeps
// its own old rendering as the fallback for a Worker that predates it.

const HISTORY_REASON_KEYS = {
  update: 'reasonUpdate',
  append: 'reasonAppend',
  merge: 'reasonMerge',
  replace: 'reasonReplace',
  rollup: 'reasonRollup',
  status: 'reasonStatus',
  due: 'reasonDue',
  mirror: 'reasonMirror',
  revert: 'reasonRevert',
}

/**
 * The status a `reason: "status"` row changed the memory TO. `before_status`
 * on a row is the status before THAT row's change, so the destination is the
 * nearest earlier change row's `before_status` — or, for the newest change,
 * the entry's current status tag.
 */
function historyStatusTarget(items, index, entry) {
  for (let i = index - 1; i >= 0; i--) {
    if (items[i].kind === 'change') return items[i].before_status
  }
  return typeof tagValue === 'function' ? tagValue(entry.tags || [], 'status:') : null
}

function historyReasonLabel(item, index, items, entry) {
  const key = HISTORY_REASON_KEYS[item.reason]
  if (!key) return item.reason || ''
  if (item.reason === 'status') {
    const target = historyStatusTarget(items, index, entry)
    const label = target && typeof viewStatusLabel === 'function' ? viewStatusLabel(target) : target || ''
    return t(`history.${key}`, { status: label })
  }
  return t(`history.${key}`)
}

function historyWhoLabel(item, entry) {
  if (item.channel === 'system:digest') return t('history.byDigest')
  if (item.channel === 'system:insight') return t('history.byInsight')
  if (item.channel === 'system:mirror') {
    const provider = (typeof sourceBadge === 'function' ? sourceBadge(entry.source).label : entry.source) || ''
    return t('history.bySync', { provider })
  }
  const actor = item.actor_name || ''
  if (item.client) return t('history.byClient', { actor, client: item.client })
  if (item.channel === 'mcp') return t('history.byAgent', { actor })
  return t('history.byDashboard', { actor })
}

function historyDate(at) {
  return at ? formatDateUI(at, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''
}

function renderHistoryChangeRow(item, index, items, entry) {
  const meta = [historyReasonLabel(item, index, items, entry), historyDate(item.at), historyWhoLabel(item, entry)].filter(Boolean).join(' · ')
  const actions = []
  if (item.can_undo) {
    actions.push(`<button type="button" class="history-action" data-action="undo">${escHtml(t('history.undo'))}</button>`)
  } else if (item.can_restore) {
    actions.push(`<button type="button" class="history-action" data-action="restore-version">${escHtml(t('history.restoreVersion'))}</button>`)
  }
  return (
    `<li class="history-item" data-seq="${escHtml(String(item.seq))}">` +
    `<div class="history-meta">${escHtml(meta)}</div>` +
    `<div class="history-before">` +
    `<div class="history-before-label">${escHtml(t('history.before'))}</div>` +
    `<p class="history-before-text" data-preview="${escAttr(item.before_preview || '')}">${escHtml(item.before_preview || '')}</p>` +
    `<button type="button" class="history-link-btn" data-action="show-before">${escHtml(t('history.showAll'))}</button>` +
    `</div>` +
    (actions.length ? `<div class="history-item-actions">${actions.join('')}</div>` : '') +
    `</li>`
  )
}

function renderHistoryEventRow(item) {
  const meta = [item.actor_name || '', typeof timelineEventLabel === 'function' ? timelineEventLabel(item.event) : item.event || '', historyDate(item.at)]
    .filter(Boolean)
    .join(' · ')
  return `<li class="history-item" data-event="${escAttr(item.event || '')}"><div class="history-meta">${escHtml(meta)}</div></li>`
}

function renderHistoryFooters(footer) {
  if (!footer) return ''
  const parts = []
  if (footer.pruned) {
    parts.push(`<div class="history-footer" data-footer="pruned">${escHtml(t('history.footerPruned', { n: footer.kept }))}</div>`)
  }
  if (footer.not_recorded_before) {
    const date = formatDateUI(footer.not_recorded_before, { year: 'numeric', month: 'short', day: 'numeric' })
    parts.push(`<div class="history-footer" data-footer="not-recorded">${escHtml(t('history.footerNotRecorded', { date }))}</div>`)
  }
  if (footer.shared_cut_by) {
    parts.push(`<div class="history-footer" data-footer="shared-cut">${escHtml(t('history.footerSharedCut', { name: footer.shared_cut_by }))}</div>`)
  }
  return parts.join('')
}

/** Refetches /entry and re-renders the sheet, then focuses a live action button. */
async function historyRehydrateAndFocus(id) {
  if (typeof hydrateView === 'function') await hydrateView(id)
  const list = document.querySelector('#view-timeline .history-list')
  const target = list?.querySelector('[data-action="undo"], [data-action="restore-version"]')
  if (target) target.focus()
  else if (list) {
    list.setAttribute('tabindex', '-1')
    list.focus()
  }
}

function wireHistoryRow(li, item, entry) {
  const showBtn = li.querySelector('[data-action="show-before"]')
  if (showBtn) {
    let expanded = false
    let fullText = null
    showBtn.onclick = async () => {
      const p = li.querySelector('.history-before-text')
      if (!expanded) {
        if (fullText === null) {
          showBtn.disabled = true
          try {
            const res = await fetch(`${WORKER_URL}/entry/version?id=${encodeURIComponent(entry.id)}&seq=${encodeURIComponent(item.seq)}`, {
              headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
            })
            const data = await res.json()
            fullText = data.ok ? data.content : p.dataset.preview
          } catch {
            fullText = p.dataset.preview
          } finally {
            showBtn.disabled = false
          }
        }
        p.textContent = fullText
        showBtn.textContent = t('history.showLess')
        expanded = true
      } else {
        p.textContent = p.dataset.preview
        showBtn.textContent = t('history.showAll')
        expanded = false
      }
    }
  }

  const undoBtn = li.querySelector('[data-action="undo"]')
  if (undoBtn) {
    undoBtn.onclick = async () => {
      undoBtn.disabled = true
      try {
        const result = await apiUndo(entry.id)
        undoResultToast(result)
      } finally {
        await historyRehydrateAndFocus(entry.id)
      }
    }
  }

  const restoreBtn = li.querySelector('[data-action="restore-version"]')
  if (restoreBtn) {
    restoreBtn.onclick = () => {
      openDangerConfirm({
        title: t('history.restoreTitle'),
        body: t('history.restoreBody', { date: historyDate(item.at) }),
        confirmLabel: t('history.restoreConfirm'),
        tone: 'primary',
        onConfirm: async (_checked, done) => {
          const result = await apiUndo(entry.id, item.seq)
          undoResultToast(result)
          done()
          await historyRehydrateAndFocus(entry.id)
        },
      })
    }
  }
}

/** Replaces #view-timeline's contents with the rich history list (SH-1). */
function renderHistory(entry) {
  const el = document.getElementById('view-timeline')
  if (!el) return
  const items = entry.history?.items || []
  const footer = entry.history?.footer
  if (!items.length) {
    el.style.display = 'none'
    el.innerHTML = ''
    return
  }
  const rowsHtml = items.map((item, index) => (item.kind === 'change' ? renderHistoryChangeRow(item, index, items, entry) : renderHistoryEventRow(item))).join('')
  el.style.display = ''
  el.innerHTML = `<div class="view-timeline-label history-label">${escHtml(t('memories.timelineLabel'))}</div><ol class="history-list">${rowsHtml}</ol>${renderHistoryFooters(footer)}`
  // Joined by data-seq, not position: the same convention loadRelated uses
  // (row.dataset.id), so wiring does not depend on the DOM giving back rows
  // in array order.
  const changeItems = items.filter((it) => it.kind === 'change')
  el.querySelectorAll('.history-item').forEach((li) => {
    if (li.dataset.seq === undefined) return
    const item = changeItems.find((it) => String(it.seq) === li.dataset.seq)
    if (item) wireHistoryRow(li, item, entry)
  })
}
