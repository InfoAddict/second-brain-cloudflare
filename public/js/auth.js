// Fork-owned deep-link handling stays in this module so upstream dashboard files
// can continue merging without carrying the feature across shared init code.
function entryIdFromSearch(search) {
  try {
    const value = new URLSearchParams(String(search || '')).get('entry')
    const entryId = value && value.trim()
    return entryId && entryId.length <= 256 ? entryId : null
  } catch (_) {
    return null
  }
}

let requestedEntryId = typeof window === 'undefined'
  ? null
  : entryIdFromSearch(window.location.search)
let requestedEntryOpening = false

async function connect() {
  const url = document.getElementById('auth-url').value.trim().replace(/\/$/, '')
  const tok = document.getElementById('auth-token').value.trim()
  const err = document.getElementById('auth-error')
  const btn = document.getElementById('auth-connect')
  if (!url || !tok) {
    err.textContent = t('auth.fillBoth')
    return
  }
  btn.textContent = t('auth.connecting')
  btn.disabled = true
  err.textContent = ''
  try {
    const res = await fetch(`${url}/list?n=1`, { headers: { Authorization: `Bearer ${tok}` } })
    if (res.status === 401) throw new Error(t('auth.invalidToken'))
    if (!res.ok) throw new Error(t('auth.serverError', { status: res.status }))
    localStorage.setItem('sb_url', url)
    localStorage.setItem('sb_token', tok)
    WORKER_URL = url
    AUTH_TOKEN = tok
    showApp()
  } catch (e) {
    err.textContent = e.message || t('auth.couldNotConnect')
    btn.textContent = t('auth.connect')
    btn.disabled = false
  }
}

function showApp() {
  document.getElementById('auth-overlay').style.display = 'none'
  document.getElementById('app').style.display = 'flex'
  if (typeof renderHome === 'function') renderHome(null) // greeting before the network
  refreshAll()
  checkVectorize()
  void openRequestedEntry()
}

async function openRequestedEntry() {
  if (!requestedEntryId || requestedEntryOpening) return
  const entryId = requestedEntryId
  requestedEntryOpening = true
  try {
    const res = await fetch(`${WORKER_URL}/entry?id=${encodeURIComponent(entryId)}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })
    const data = await res.json()
    if (!res.ok || !data.ok || !data.entry) throw new Error('linked memory was not found')
    openView({
      id: data.entry.id,
      content: data.entry.content,
      tags: data.entry.tags,
    }, null)
  } catch (error) {
    console.warn('Could not open linked memory:', error)
    alert('Could not open the linked memory. It may have been removed.')
  } finally {
    requestedEntryId = null
    requestedEntryOpening = false
  }
}

function logout() {
  closeMenu()
  localStorage.removeItem('sb_url')
  localStorage.removeItem('sb_token')
  WORKER_URL = ''
  AUTH_TOKEN = ''
  document.getElementById('app').style.display = 'none'
  document.getElementById('auth-overlay').style.display = 'flex'
  document.getElementById('auth-url').value = ''
  document.getElementById('auth-token').value = ''
  document.getElementById('auth-error').textContent = ''
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { entryIdFromSearch }
}
