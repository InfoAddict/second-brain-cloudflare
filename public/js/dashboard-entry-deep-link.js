function entryIdFromSearch(search) {
  try {
    const value = new URLSearchParams(String(search || '')).get('entry')
    const entryId = value && value.trim()
    return entryId && entryId.length <= 256 ? entryId : null
  } catch (_) {
    return null
  }
}

let forkRequestedEntryId = typeof window === 'undefined'
  ? null
  : entryIdFromSearch(window.location.search)
let forkRequestedEntryOpening = false

async function openForkRequestedEntry() {
  if (!forkRequestedEntryId || forkRequestedEntryOpening) return
  const entryId = forkRequestedEntryId
  forkRequestedEntryOpening = true
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
    forkRequestedEntryId = null
    forkRequestedEntryOpening = false
  }
}

function withDashboardEntryDeepLink(baseShowApp) {
  return function showAppWithDashboardEntryDeepLink(...args) {
    const result = baseShowApp.apply(this, args)
    void openForkRequestedEntry()
    return result
  }
}

if (typeof showApp === 'function') {
  showApp = withDashboardEntryDeepLink(showApp)
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { entryIdFromSearch, withDashboardEntryDeepLink }
}
