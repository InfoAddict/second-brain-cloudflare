// Browser-aware "Add to Home Screen" guide. iOS Safari (and every other iOS
// browser, which all share WebKit's Push API restriction) cannot receive Web
// Push at all outside an installed PWA — "Enable notifications" used to just
// say "not supported" there, a dead end when the real answer is "install the
// app in two taps." Detection is deliberately small and honest: a five-value
// enum from the UA string, not an attempt to model every device or browser
// version. Installed (standalone) users never see any of this.

/** display-mode: standalone (most platforms) or navigator.standalone (iOS). */
function isStandalone() {
  const media = typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(display-mode: standalone)').matches
    : false
  const iosStandalone = typeof navigator !== 'undefined' && navigator.standalone === true
  return media || iosStandalone
}

/**
 * 'ios-safari' | 'ios-other' | 'android-chromium' | 'android-firefox' |
 * 'desktop' | 'unknown'. Reads the real navigator by default; a caller may
 * pass one in for testing.
 */
function detectPlatform(nav) {
  const n = nav || (typeof navigator !== 'undefined' ? navigator : {})
  const ua = n.userAgent || ''
  const uaData = n.userAgentData

  // iPadOS 13+ sends a plain desktop Mac UA by default ("request desktop
  // site" is the default, not an opt-in) — indistinguishable from a real Mac
  // by UA string alone. Multi-touch is the widely-used way to tell them
  // apart: a real Mac reports maxTouchPoints 0.
  const looksLikeIpadDesktopUA = n.platform === 'MacIntel' && (n.maxTouchPoints || 0) > 1
  if (/iPhone|iPod|iPad/.test(ua) || looksLikeIpadDesktopUA) {
    // Every iOS browser ships on WebKit and carries "Safari" in its UA; only
    // the vendor tokens below distinguish a non-Safari one. iOS 16.4+ lets
    // any of them install a PWA through their own share/menu, same mechanism.
    return /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) ? 'ios-other' : 'ios-safari'
  }

  if (/Android/.test(ua)) {
    if (/Firefox/.test(ua)) return 'android-firefox'
    if (/Chrome|CriOS|SamsungBrowser|EdgA|OPR|Brave/.test(ua)) return 'android-chromium'
    return 'unknown'
  }

  // userAgentData.mobile is Chromium-only and coarse — used only to catch a
  // mobile UA the checks above did not recognize, never to override them.
  const mobileByUaData = !!(uaData && uaData.mobile)
  return (/Mobi|Tablet/.test(ua) || mobileByUaData) ? 'unknown' : 'desktop'
}

/** Whether the install guide should stand in for ordinary notification controls — any mobile browser, never standalone, never desktop. */
function needsInstallGuide() {
  return !isStandalone() && detectPlatform() !== 'desktop'
}

/**
 * Android Chromium's native install prompt (Chrome, Edge, Samsung Internet,
 * Brave — anything that fires beforeinstallprompt). Captured at boot,
 * preventDefault()ed so the browser's own mini-infobar never fights this
 * guide's own button, and one-shot: the browser invalidates the event once
 * prompt() has been called on it, so a second trigger without a fresh event
 * does nothing.
 */
let deferredInstallPrompt = null

function hasNativeInstallPrompt() {
  return !!deferredInstallPrompt
}

async function triggerNativeInstallPrompt() {
  const event = deferredInstallPrompt
  if (!event) return false
  deferredInstallPrompt = null
  event.prompt()
  try { await event.userChoice } catch {}
  return true
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    deferredInstallPrompt = event
  })
}

// SF-symbols-style "square and arrow up" — the actual iOS share glyph, drawn
// inline so no icon font dependency is needed for a shape Tabler does not have.
const INSTALL_GUIDE_SHARE_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V4"/><path d="M8 8l4-4 4 4"/><path d="M4 13v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/></svg>'

/** Two-step platforms share a step pair; everything else gets one generic line. */
function installGuideStepKeys(platform) {
  if (platform === 'ios-safari' || platform === 'ios-other') {
    return ['installGuide.stepShareIcon', 'installGuide.stepAddToHomeScreen']
  }
  if (platform === 'android-firefox' || platform === 'android-chromium') {
    return ['installGuide.stepMenu', 'installGuide.stepInstallAndroid']
  }
  return ['installGuide.stepGeneric']
}

function installGuideStepIcon(platform, index) {
  if (index !== 0) return ''
  if (platform === 'ios-safari' || platform === 'ios-other') return INSTALL_GUIDE_SHARE_ICON_SVG
  if (platform === 'android-firefox' || platform === 'android-chromium') return '<i class="ti ti-dots-vertical"></i>'
  return ''
}

function installGuideStepsHtml(platform) {
  return installGuideStepKeys(platform)
    .map((key, i) => `<li>${installGuideStepIcon(platform, i)} ${escHtml(t(key))}</li>`)
    .join('')
}

/**
 * Fills #install-guide-body. Android Chromium with a live native prompt skips
 * instructions entirely and leads with the real Install button (requirement:
 * "the guide's primary button is a REAL Install that calls prompt()").
 * Everything else gets a numbered step card in the platform's own words.
 */
function renderInstallGuideBody() {
  const body = document.getElementById('install-guide-body')
  if (!body) return

  const why = `<p class="digest-note">${escHtml(t('installGuide.why'))}</p>`

  if (hasNativeInstallPrompt()) {
    body.innerHTML = why +
      `<button class="install-guide-cta" type="button" onclick="triggerNativeInstallPrompt()">${escHtml(t('installGuide.installButton'))}</button>`
    return
  }

  const platform = detectPlatform()
  body.innerHTML = why +
    `<ol class="install-guide-steps">${installGuideStepsHtml(platform)}</ol>` +
    `<p class="digest-note">${escHtml(t('installGuide.thenOpen'))}</p>`
}

/** Mirrors due.js's openDueSheet/closeDueSheet — same bottom-sheet convention, not a new modal system. */
function openInstallGuide() {
  if (typeof closeMenu === 'function') closeMenu()
  const sheet = document.getElementById('install-guide-sheet')
  if (sheet) sheet.classList.add('open')
  renderInstallGuideBody()
}

function closeInstallGuide() {
  const sheet = document.getElementById('install-guide-sheet')
  if (sheet) sheet.classList.remove('open')
}

// Once-per-session nudge banner (requirement: gentle, mobile browsers only,
// never standalone, never desktop, never twice in one session). sessionStorage
// rather than localStorage on purpose — the nudge is allowed back next visit,
// just not again this one.
const INSTALL_NUDGE_SESSION_KEY = 'install-guide-nudged'

function shouldShowInstallNudge() {
  if (!needsInstallGuide()) return false
  try {
    return !sessionStorage.getItem(INSTALL_NUDGE_SESSION_KEY)
  } catch {
    // No storage to remember a dismissal with — safer to stay quiet than nag.
    return false
  }
}

function showInstallNudge() {
  if (!shouldShowInstallNudge()) return
  try { sessionStorage.setItem(INSTALL_NUDGE_SESSION_KEY, '1') } catch {}
  const el = document.getElementById('install-nudge-banner')
  if (el) el.hidden = false
}

function dismissInstallNudge() {
  const el = document.getElementById('install-nudge-banner')
  if (el) el.hidden = true
}

function openInstallGuideFromNudge() {
  dismissInstallNudge()
  openInstallGuide()
}

if (typeof module !== 'undefined') {
  module.exports = {
    isStandalone, detectPlatform, needsInstallGuide,
    hasNativeInstallPrompt, triggerNativeInstallPrompt,
    installGuideStepKeys, installGuideStepsHtml, renderInstallGuideBody,
    openInstallGuide, closeInstallGuide,
    shouldShowInstallNudge, showInstallNudge, dismissInstallNudge, openInstallGuideFromNudge,
  }
}
