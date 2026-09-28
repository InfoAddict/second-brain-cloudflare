// T3/T4 S4 (16-t3-t4-trust-spec.md, ~1341): the home board's own small panel
// for "changed by AI tools", rendered directly above "Needs a decision"
// (board.js's BOARD_PANELS order) rather than as a row inside it - a UX
// review call: AI edits are already live, not a decision, so they must not
// sit under "Nothing here is recallable until you rule on it" (false for
// them), and folding an informational line into the decision panel turns it
// into a chore against the "nothing asks" principle. One GET /brief already
// carries `changes` (Lane S, src/brief/changes.ts); this file only renders
// it, expands it, and drives the write endpoints every other row already
// uses: POST /undo (single item; Release is Undo on a held row, S5) and
// POST /undo/group (Undo all/Release all, paged 5 at a time - the caller
// loops while remaining > 0).

let aiChangesExpanded = false
let aiChangesData = null

/**
 * One more entry in board.js's BOARD_PANELS, called with (board, brief) like
 * every other panel renderer. Absent entirely when there is nothing to show
 * (no empty state, no badge) - a panel about live AI activity has nothing
 * honest to say when there has been none.
 */
function renderAiChangesPanel(board, brief) {
  const changes = (brief && brief.changes) || null
  aiChangesData = changes
  // Gated on `count` alone (UI review, S4, NIT: confirm this is by design,
  // not two zero counts lining up). `count` is changesToRestJson's own
  // "memories affected, before grouping" total (src/brief/changes.ts) - the
  // one field that answers "did anything happen", independent of `held`
  // (a subset of count) and unaffected by how those changes happened to
  // group into items vs group rows.
  if (!changes || !changes.count) return
  // Full width at 1280 (UI review, S4, MINOR): span4 put it beside "Needs a
  // decision" in the 12-column grid, a two-column layout the UX call to move
  // it above that panel specifically ruled out. board.css has no span12
  // class (every other panel only ever needs a fraction of the row), so
  // css/ai-changes.css declares [data-panel="ai-changes"] full width
  // directly instead of adding one for this sole caller.
  const panel = boardPanel('ai-changes', { title: t('aiChanges.panelTitle'), sub: t('aiChanges.panelSub') })
  panel.body.innerHTML = aiChangesPanelBodyHtml(changes)
  board.appendChild(panel)
}

function aiChangesPanelBodyHtml(changes) {
  const lineText = tPlural('aiChanges.line', changes.count) + (changes.held > 0 ? ` · ${tPlural('aiChanges.heldSuffix', changes.held)}` : '')
  return `<div class="ai-changes-summary">
    <span class="ai-changes-line"><i class="ti ti-sparkles"></i>${escHtml(lineText)}</span>
    <button class="attn" type="button" id="ai-changes-review" aria-expanded="${aiChangesExpanded ? 'true' : 'false'}" onclick="toggleAiChanges()">${escHtml(t('aiChanges.review'))}</button>
  </div>
  <div class="ai-changes-rows" id="ai-changes-rows"${aiChangesExpanded ? '' : ' hidden'}>${aiChangesExpanded ? aiChangesRowsHtml(aiChangesData) : ''}</div>`
}

function toggleAiChanges() {
  aiChangesExpanded = !aiChangesExpanded
  const rows = document.getElementById('ai-changes-rows')
  const btn = document.getElementById('ai-changes-review')
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

/** Always "via {x}" - the fallback names the actor as "an AI tool" rather than skipping the word "via" (UI review, S4). */
function aiChangeByLine(client) {
  return t('aiChanges.byTool', { tool: client || t('aiChanges.anAiTool') })
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

/** Same explicit if-else reasoning as aiChangeEventLabel: aiChanges.family.<family> is a literal path per branch, never a computed one. */
function aiChangeFamilyPhrase(family, count) {
  if (family === 'status') return tPlural('aiChanges.family.status', count)
  if (family === 'canonical_edit') return tPlural('aiChanges.family.canonical_edit', count)
  if (family === 'capsule_changed') return tPlural('aiChanges.family.capsule_changed', count)
  if (family === 'trash') return tPlural('aiChanges.family.trash', count)
  if (family === 'revert') return tPlural('aiChanges.family.revert', count)
  if (family === 'released') return tPlural('aiChanges.family.released', count)
  if (family === 'held') return tPlural('aiChanges.family.held', count)
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
  const until = Number(group.until) || 0
  if (group.can_release_all) {
    if (!aiChangeCanActOnHeld()) return `<div class="ai-change-lock-note">${escHtml(t('aiChanges.teammateNote'))}</div>`
    return `<button type="button" class="ai-change-btn" onclick="aiChangeGroupAction('${escAttr(group.group)}', 'release', ${Number(group.count) || 0}, ${until})">${escHtml(t('aiChanges.releaseAll'))}</button>`
  }
  if (group.can_undo_all) {
    return `<button type="button" class="ai-change-btn" onclick="aiChangeGroupAction('${escAttr(group.group)}', 'undo', ${Number(group.count) || 0}, ${until})">${escHtml(t('aiChanges.undoAll'))}</button>`
  }
  return ''
}

function aiChangeGroupRowHtml(group) {
  const by = aiChangeByLine(group.client)
  const when = formatDateUI(group.until, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const what = aiChangeFamilyPhrase(group.family, group.count)
  // aiChanges.group is only ever "{what} · {time}" (two slots); the tool goes
  // into the {time} slot alongside the real time so every row - item or group
  // - reads the same "what · via tool · time" order (UI review, S4). No new
  // copy: both halves are already-translated fragments, just composed here.
  const label = t('aiChanges.group', { what, time: `${by} · ${when}` })
  return `<div class="ai-change-row ai-change-group" data-group="${escAttr(group.group)}">
    <div class="ai-change-meta">${escHtml(label)}</div>
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
 *
 * `until` is the group row's own timestamp, not Date.now() (UI review, S4,
 * MAJOR): the confirm text says "before {time}", and that has to be the same
 * moment the row itself displays, not whatever time the dialog happened to
 * open at.
 */
function aiChangeGroupAction(group, kind, total, until) {
  const isRelease = kind === 'release'
  const timeLabel = formatDateUI(until, { hour: 'numeric', minute: '2-digit' })
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
        // DRAFT: the copywriter's aiChanges.partial reads "Undid", which is
        // the right verb for undo-all but not for release-all's own partial
        // outcome - no distinct release-partial key exists yet, flagged.
        if (skipped > 0) {
          showToast(tPlural('aiChanges.partial', skipped, { done: doneCount, n: doneCount + skipped, skipped }))
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
