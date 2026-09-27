/** Lightweight toast with optional undo action. No dependency on a component library. */
let toastTimer = null

/**
 * SH-1 and SH-3 are the first callers that can show a toast while
 * `#view-sheet` stays open (its history row actions and its status control
 * both re-hydrate in place rather than closing the sheet first). Below the
 * same 768px breakpoint main.css uses to switch the sheet from centered to
 * bottom-anchored, the sheet's fixed action row sits at the same screen edge
 * as the toast's own default position, and a tall toast can cover more than
 * just that row. Decided: on a narrow screen with a sheet open, the toast
 * moves to the top of the viewport instead, clear of the sheet entirely.
 * Desktop (the sheet is centered there, with room below it) is unaffected.
 */
function positionToastForOpenSheet(el) {
  el.classList.remove('app-toast--top')
  const sheet = document.getElementById('view-sheet')
  const isSheetOpen = !!(sheet && sheet.classList.contains('open'))
  const isNarrow = typeof window !== 'undefined' && typeof window.innerWidth === 'number' && window.innerWidth < 768
  if (isSheetOpen && isNarrow) el.classList.add('app-toast--top')
}

function showToast(message, opts = {}) {
  const { action, onAction, duration = 6000 } = opts
  let el = document.getElementById('app-toast')
  if (!el) {
    el = document.createElement('div')
    el.id = 'app-toast'
    el.className = 'app-toast'
    el.setAttribute('role', 'status')
    document.body.appendChild(el)
  }
  if (toastTimer) clearTimeout(toastTimer)
  el.innerHTML =
    `<span class="app-toast-msg">${escHtml(message)}</span>` +
    (action
      ? `<button type="button" class="app-toast-action">${escHtml(action)}</button>`
      : '')
  positionToastForOpenSheet(el)
  el.classList.add('visible')
  const btn = el.querySelector('.app-toast-action')
  if (btn && onAction) {
    // Returned, not dropped: the action can be async and can fail, and its
    // caller — or a test — needs something to wait on. A promise is truthy, so
    // this does not suppress the click the way returning false would.
    btn.onclick = () => {
      el.classList.remove('visible')
      return onAction()
    }
  }
  toastTimer = setTimeout(() => el.classList.remove('visible'), duration)
}
