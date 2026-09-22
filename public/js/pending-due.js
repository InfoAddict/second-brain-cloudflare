// A tiny raw-IndexedDB helper for one thing: stashing/reading/clearing the
// due-item id a notification tap was for, when neither an existing window
// (postMessage) nor the opened window's own URL survives the OS's PWA-launch
// handling — a real, observed iOS weakness (openWindow can land on start_url
// with the URL discarded entirely). No dependency, no DOM: indexedDB is a
// global in both the page and the service worker, which is what makes this
// file shared between them possible — public/js/due.js loads it via a plain
// <script> tag, public/sw.js via importScripts(), so the one schema lives in
// one place rather than two copies that could drift.
//
// Every function is best-effort: IndexedDB can be unavailable (private
// browsing, a broken profile) or fail for reasons unrelated to whether this
// feature matters, and a stash/read/clear failure here must never be the
// thing that breaks the OTHER two deep-link channels (postMessage, the URL).

const PENDING_DUE_DB_NAME = 'sb-push'
const PENDING_DUE_STORE = 'pending'
/** One record, not a queue — a later tap simply overwrites it. */
const PENDING_DUE_KEY = 'due'

function openPendingDueDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('indexedDB unavailable')); return }
    const req = indexedDB.open(PENDING_DUE_DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(PENDING_DUE_STORE)) {
        req.result.createObjectStore(PENDING_DUE_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Stores {id, at: Date.now()} as the one pending record. */
async function stashPendingDueId(id) {
  try {
    const db = await openPendingDueDb()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PENDING_DUE_STORE, 'readwrite')
      tx.objectStore(PENDING_DUE_STORE).put({ id, at: Date.now() }, PENDING_DUE_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  } catch {
    // This fallback channel just isn't available; the other two still are.
  }
}

/** Reads (without removing) the pending record, or null if absent/unreadable. */
async function readPendingDueRecord() {
  try {
    const db = await openPendingDueDb()
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction(PENDING_DUE_STORE, 'readonly')
      const req = tx.objectStore(PENDING_DUE_STORE).get(PENDING_DUE_KEY)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => reject(req.error)
    })
    db.close()
    return record
  } catch {
    return null
  }
}

async function clearPendingDueRecord() {
  try {
    const db = await openPendingDueDb()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PENDING_DUE_STORE, 'readwrite')
      tx.objectStore(PENDING_DUE_STORE).delete(PENDING_DUE_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  } catch {
    // Nothing to clear, or nothing that could clear it — either way, fine.
  }
}

if (typeof module !== 'undefined') {
  module.exports = {
    stashPendingDueId, readPendingDueRecord, clearPendingDueRecord,
    PENDING_DUE_DB_NAME, PENDING_DUE_STORE, PENDING_DUE_KEY,
  }
}
