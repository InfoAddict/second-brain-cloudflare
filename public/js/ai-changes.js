// T3/T4 S4 (16-t3-t4-trust-spec.md, ~1341): the home board's "AI tools
// changed N memories" line, one more stop inside board.js's decide panel
// (renderDecisionPanel). One GET /brief already carries `changes` (Lane S,
// src/brief/changes.ts); this file only renders it, expands it, and drives
// the write endpoints every other row already uses: POST /undo (single item;
// Release is Undo on a held row, S5) and POST /undo/group (Undo all/Release
// all, paged 5 at a time - the caller loops while remaining > 0).

let aiChangesExpanded = false
let aiChangesData = null

/**
 * Called once from renderDecisionPanel with brief.changes. Empty string when
 * there is nothing to show (7.9 "absent when count is 0") - board.js already
 * drops an empty stop, the same as its stale/unindexed/due rows above it.
 */
function aiChangesStopHtml(changes) {
  aiChangesData = changes || null
  if (!changes || !changes.count) return ''
  const lineText = t('aiChanges.line', { n: changes.count }) + (changes.held > 0 ? ` · ${t('aiChanges.heldSuffix', { n: changes.held })}` : '')
  return `<article class="stop ai-changes-stop" id="ai-changes-stop">
    <div class="stop-actions">
      <span class="ai-changes-line"><i class="ti ti-sparkles"></i>${escHtml(lineText)}</span>
      <button class="attn" type="button" aria-expanded="${aiChangesExpanded ? 'true' : 'false'}" onclick="toggleAiChanges()">${escHtml(t('aiChanges.review'))}</button>
    </div>
    <div class="ai-changes-rows" id="ai-changes-rows"${aiChangesExpanded ? '' : ' hidden'}>${aiChangesExpanded ? aiChangesRowsHtml(aiChangesData) : ''}</div>
  </article>`
}

function toggleAiChanges() {
  aiChangesExpanded = !aiChangesExpanded
  const rows = document.getElementById('ai-changes-rows')
  const btn = document.querySelector('#ai-changes-stop .attn')
  if (rows) {
    rows.hidden = !aiChangesExpanded
    rows.innerHTML = aiChangesExpanded ? aiChangesRowsHtml(aiChangesData) : ''
  }
  if (btn) btn.setAttribute('aria-expanded', aiChangesExpanded ? 'true' : 'false')
}

function aiChangesRowsHtml(changes) {
  if (!changes || !Array.isArray(changes.items)) return ''
  return changes.items.map(aiChangeRowHtml).join('')
}

function aiChangeRowHtml(row) {
  return row.kind === 'group' ? aiChangeGroupRowHtml(row) : aiChangeItemRowHtml(row)
}

function aiChangeByLine(client) {
  return client ? t('aiChanges.byTool', { tool: client }) : t('aiChanges.anAiTool')
}

/** Explicit if-else, not a keyed lookup passed to the translate helper - the i18n test's static scanner flags a variable argument there as a new dynamic call site. */
function aiChangeEventLabel(item) {
  if (item.family === 'canonical_edit') return t('aiChanges.evEditedTrusted')
  if (item.family === 'capsule_changed') return t('aiChanges.evCapsule')
  if (item.family === 'trash') return t('aiChanges.evTrash')
  if (item.family === 'revert') return t('aiChanges.evReverted')
  if (item.family === 'released') return t('aiChanges.evReleased')
  if (item.family === 'status') {
    if (item.status === 'canonical') return t('aiChanges.evTrusted')
    if (item.status === 'draft') return t('aiChanges.evUnconfirmed')
    if (item.status === 'deprecated') return t('aiChanges.evWrong')
    return ''
  }
  if (item.family === 'held') {
    const reason = Array.isArray(item.reasons) ? item.reasons[0] : null
    if (reason === 'too_long') return t('aiChanges.evHeldTooLong')
    const phrase = typeof heldReasonPhrase === 'function' ? heldReasonPhrase(reason) : ''
    return t('aiChanges.evHeld', { reason: phrase })
  }
  return ''
}

/**
 * True unless a non-admin teammate is looking at a held row on a company
 * memory they did not author (16-t3-t4-trust-spec.md Q-G, 7.8's "teammate
 * view: rows without buttons, lock note"). The changes query already scopes
 * every OTHER family to rows the viewer acted on or authored, so this only
 * ever matters for `held`, the one family visible to a whole company
 * workspace regardless of who wrote the entry (a hold is everyone's to see).
 * Solo brains (no TEAM_MODE) and admins always pass.
 */
function aiChangeCanActOnHeld() {
  const teamMode = typeof TEAM_MODE !== 'undefined' && TEAM_MODE
  if (!teamMode) return true
  return typeof teamIsAdmin !== 'undefined' && teamIsAdmin === true
}

function aiChangeItemButtonsHtml(item) {
  if (item.family === 'held') {
    if (!item.can_release) return ''
    if (!aiChangeCanActOnHeld()) return `<div class="ai-change-lock-note">${escHtml(t('aiChanges.teammateNote'))}</div>`
    return `<button type="button" class="ai-change-btn" onclick="aiChangeRelease('${escAttr(item.id)}', this)">${escHtml(t('held.release'))}</button>`
  }
  if (item.can_undo) {
    return `<button type="button" class="ai-change-btn" onclick="aiChangeUndo('${escAttr(item.id)}', this)">${escHtml(t('history.undo'))}</button>`
  }
  return ''
}

function aiChangeItemRowHtml(item) {
  const label = aiChangeEventLabel(item)
  const by = aiChangeByLine(item.client)
  const when = formatDateUI(item.at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const preview = item.preview ? `<div class="ai-change-preview">${escHtml(item.preview)}</div>` : ''
  return `<div class="ai-change-row" data-id="${escAttr(item.id)}">
    <div class="ai-change-meta">${escHtml(`${label} · ${by} · ${when}`)}</div>
    ${preview}
    ${aiChangeItemButtonsHtml(item)}
  </div>`
}

function aiChangeGroupButtonsHtml(group) {
  if (group.can_release_all) {
    if (!aiChangeCanActOnHeld()) return `<div class="ai-change-lock-note">${escHtml(t('aiChanges.teammateNote'))}</div>`
    return `<button type="button" class="ai-change-btn" onclick="aiChangeGroupAction('${escAttr(group.group)}', 'release', ${Number(group.count) || 0})">${escHtml(t('aiChanges.releaseAll'))}</button>`
  }
  if (group.can_undo_all) {
    return `<button type="button" class="ai-change-btn" onclick="aiChangeGroupAction('${escAttr(group.group)}', 'undo', ${Number(group.count) || 0})">${escHtml(t('aiChanges.undoAll'))}</button>`
  }
  return ''
}

function aiChangeGroupRowHtml(group) {
  const by = aiChangeByLine(group.client)
  const when = formatDateUI(group.until, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const label = t('aiChanges.group', { n: group.count, time: when })
  return `<div class="ai-change-row ai-change-group" data-group="${escAttr(group.group)}">
    <div class="ai-change-meta">${escHtml(`${label} · ${by}`)}</div>
    ${aiChangeGroupButtonsHtml(group)}
  </div>`
}

/** Undo is the primary action here, not an offer to reverse one - unlike undo.js's undoToast write-site pattern, this posts immediately. */
async function aiChangeUndo(id, btn) {
  if (btn) btn.disabled = true
  try {
    const result = await apiUndo(id)
    const { changed } = undoResultToast(result)
    if (changed && typeof loadBrief === 'function') loadBrief()
  } finally {
    if (btn) btn.disabled = false
  }
}

/** Same POST /undo every held row's Release calls (S5, memory-crud.js's releaseHeld). */
async function aiChangeRelease(id, btn) {
  if (btn) btn.disabled = true
  try {
    const res = await fetch(`${WORKER_URL}/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ id }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || '')
    showToast(t('held.released'))
    if (typeof loadBrief === 'function') loadBrief()
  } catch (e) {
    showToast(t('held.releaseFailed', { message: e.message || '' }))
  } finally {
    if (btn) btn.disabled = false
  }
}

/**
 * Undo all / Release all: confirm (openDangerConfirm, S4's own focus trap
 * comes free from the one shared sheet), then loop POST /undo/group while
 * `remaining` > 0 (5 per page), summing done vs skipped across every page
 * into one final toast rather than one per page.
 */
function aiChangeGroupAction(group, kind, total) {
  const isRelease = kind === 'release'
  const timeLabel = formatDateUI(Date.now(), { hour: 'numeric', minute: '2-digit' })
  const title = isRelease ? t('aiChanges.releaseAll') : t('aiChanges.undoAll')
  const body = isRelease ? t('aiChanges.confirmReleaseAll', { n: total }) : t('aiChanges.confirmUndoAll', { n: total, time: timeLabel })
  const confirmLabel = isRelease ? t('aiChanges.releaseAll') : t('aiChanges.undoAll')

  openDangerConfirm({
    title,
    body,
    confirmLabel,
    tone: isRelease ? 'primary' : 'danger',
    onConfirm: async (_checked, done, progress) => {
      let doneCount = 0
      let skipped = 0
      let remaining = 1
      try {
        while (remaining > 0) {
          const res = await fetch(`${WORKER_URL}/undo/group`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
            body: JSON.stringify({ group }),
          })
          const data = await res.json()
          if (!res.ok || !data.ok) {
            showToast(data.error || t('team.actionFailed'))
            break
          }
          for (const r of data.results || []) {
            if (r.result === 'reverted' || r.result === 'released') doneCount++
            else skipped++
          }
          remaining = Number(data.remaining) || 0
          if (remaining > 0 && typeof progress === 'function') progress(confirmLabel)
        }
        if (skipped > 0) {
          showToast(t('aiChanges.partial', { done: doneCount, n: doneCount + skipped, skipped }))
        } else if (isRelease) {
          showToast(t('held.released'))
        } else {
          showToast(t('undo.undone'))
        }
      } finally {
        done()
        if (typeof loadBrief === 'function') loadBrief()
      }
    },
  })
}
