// "Download the app" button in the sidebar footer.
//
// Release asset filenames carry the version (Second Brain_1.1.0_universal.dmg),
// so there is no fixed URL for "the latest .dmg". The button therefore renders
// immediately pointing at the releases page — which always works, with no
// network call — and then upgrades its href to the exact installer once the
// GitHub API answers. If that call fails, is rate limited, or the OS is not one
// we ship for, the releases page is what the user gets.
//
// Assets are matched by extension rather than by name: the API's
// browser_download_url percent-encodes spaces as dots, so matching the
// displayed filename would be fragile.

const SB_REPO = 'rahilp/second-brain-cloudflare'
const SB_RELEASES_PAGE = `https://github.com/${SB_REPO}/releases/latest`

/**
 * 'mac' | 'windows' | 'mobile' | 'unknown'.
 *
 * 'mobile' and 'unknown' are deliberately separate. There is no desktop build a
 * phone or tablet can install, so those get no button at all — offering one is
 * pure noise on the device where sidebar space is scarcest. An unrecognised
 * *desktop* (Linux, or a browser that reports nothing useful) still gets a
 * button pointing at the releases page, since the user may well be able to use
 * one of the builds.
 */
function detectDesktopOs() {
  const data = navigator.userAgentData
  const platform = String((data && data.platform) || navigator.platform || '')
  const ua = navigator.userAgent || ''

  // iPadOS reports itself as MacIntel, so the touch check has to come before
  // the Mac check or every iPad is offered a .dmg it cannot open.
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return 'mobile'
  if (data && data.mobile === true) return 'mobile'
  if ((navigator.maxTouchPoints || 0) > 1 && /Mac/i.test(platform)) return 'mobile'

  if (/Mac|darwin/i.test(platform) || /Mac OS X/i.test(ua)) return 'mac'
  if (/Win/i.test(platform) || /Windows NT/i.test(ua)) return 'windows'
  return 'unknown'
}

function sbDownloadIcon(os) {
  if (os === 'mac') return 'ti-brand-apple'
  if (os === 'windows') return 'ti-brand-windows'
  return 'ti-download'
}

function sbDownloadLabel(os) {
  if (os === 'mac') return t('download.mac')
  if (os === 'windows') return t('download.windows')
  return t('download.generic')
}

/** Swaps the href for the exact installer. Silent no-op on any failure. */
async function upgradeDownloadHref(os, anchor) {
  if (!anchor || (os !== 'mac' && os !== 'windows')) return
  try {
    const res = await fetch(`https://api.github.com/repos/${SB_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (!res.ok) return
    const release = await res.json()
    const ext = os === 'mac' ? '.dmg' : '.exe'
    const asset = (release.assets || []).find(
      (a) => typeof a.name === 'string' && a.name.toLowerCase().endsWith(ext),
    )
    if (asset && asset.browser_download_url) {
      anchor.href = asset.browser_download_url
      if (release.tag_name) anchor.title = t('download.withTag', { label: sbDownloadLabel(os), tag: release.tag_name })
    }
  } catch {
    // Offline, rate limited, or blocked — the releases page href still stands.
  }
}

function renderDownloadButton() {
  // Pointless inside the desktop app, which sets this flag on the wrapper
  // window before the page runs.
  if (window.SB_DESKTOP) return

  const footer = document.querySelector('.sb-footer')
  if (!footer) return
  // Idempotent: the footer can re-render, and two buttons would be worse than
  // none.
  if (document.getElementById('sb-download-app')) return

  const os = detectDesktopOs()
  // No desktop build exists for a phone or tablet, so show nothing rather than
  // a link the user cannot act on.
  if (os === 'mobile') return
  const label = sbDownloadLabel(os)

  const link = document.createElement('a')
  link.id = 'sb-download-app'
  link.className = 'sb-footer-btn'
  link.href = SB_RELEASES_PAGE
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  link.title = label
  link.innerHTML = `<i class="ti ${sbDownloadIcon(os)}"></i><span>${label}</span>`

  // First entry in the footer: it is the only one aimed at someone who has not
  // installed the app yet, so it should not sit below Settings.
  footer.prepend(link)

  void upgradeDownloadHref(os, link)
}
