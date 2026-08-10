async function connect() {
  const url = document.getElementById('auth-url').value.trim().replace(/\/$/, '')
  const tok = document.getElementById('auth-token').value.trim()
  const err = document.getElementById('auth-error')
  const btn = document.getElementById('auth-connect')
  if (!url || !tok) {
    err.textContent = 'Please fill in both fields.'
    return
  }
  btn.textContent = 'Connecting...'
  btn.disabled = true
  err.textContent = ''
  try {
    const res = await fetch(`${url}/list?n=1`, { headers: { Authorization: `Bearer ${tok}` } })
    if (res.status === 401) throw new Error('Invalid token')
    if (!res.ok) throw new Error(`Server error: ${res.status}`)
    localStorage.setItem('sb_url', url)
    localStorage.setItem('sb_token', tok)
    WORKER_URL = url
    AUTH_TOKEN = tok
    showApp()
  } catch (e) {
    err.textContent = e.message || 'Could not connect.'
    btn.textContent = 'Connect'
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
