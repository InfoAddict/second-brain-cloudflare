/** Lightweight toast with optional undo action. No dependency on a component library. */
let toastTimer = null

/**
 * SH-1 and SH-3 are the first callers that can show a toast while
 * `#view-sheet` stays open (its history row actions and its status control
 * both re-hydrate in place rather than closing the sheet first). At a narrow
 * viewport the sheet is bottom-anchored and its fixed action row sits at the
 * same screen edge as the toast's own default position, so the two can
 * overlap; at a wide one the sheet is centered with room below it, and they
 * never do. Measuring both rects handles this without hardcoding a
 * breakpoint: only lift the toast when it would actually collide.
 */
function clearToastOfOpenSheetActions(el) {
  el.style.bottom = ''
  const sheet = document.getElementById('view-sheet')
  const actions = sheet && sheet.classList.contains('open') ? sheet.querySelector('.view-actions') : null
  if (!actions || typeof actions.getBoundingClientRect !== 'function') return
  const actionsRect = actions.getBoundingClientRect()
  const toastHeight = el.getBoundingClientRect().height
  const defaultBottom = 24
  const toastTopAtDefault = window.innerHeight - defaultBottom - toastHeight
  if (toastTopAtDefault < actionsRect.bottom) {
    el.style.bottom = `${Math.round(window.innerHeight - actionsRect.top + 12)}px`
  }
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
  el.classList.add('visible')
  if (typeof window !== 'undefined' && typeof el.getBoundingClientRect === 'function') {
    clearToastOfOpenSheetActions(el)
  }
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
