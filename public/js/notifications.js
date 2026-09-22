// Web Push notifications: enable/disable this device, and a content-free
// toggle (hide memory content in the notification itself). See src/push/
// (VAPID key, RFC 8291 encryption) and src/routes/push.ts for the Worker side.

/** This device's current subscription state, refreshed by loadNotificationsState(). */
let notificationsSubscribed = false

function notificationsSupported() {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator &&
    typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window
}

/** applicationServerKey wants a Uint8Array, GET /push/vapid-public-key answers base64url. */
function urlBase64ToUint8Array(base64Url) {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4)
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

async function currentPushSubscription() {
  if (!notificationsSupported()) return null
  const reg = await navigator.serviceWorker.getRegistration('/sw.js')
  return reg ? reg.pushManager.getSubscription() : null
}

async function loadNotificationsState() {
  renderNotificationsState() // unsupported/default state first, before any await
  if (!notificationsSupported()) return
  try {
    notificationsSubscribed = !!(await currentPushSubscription())
  } catch {
    notificationsSubscribed = false
  }
  renderNotificationsState()
}

function renderNotificationsState() {
  const btn = document.getElementById('notifications-toggle-btn')
  if (!btn) return
  const hint = document.getElementById('notifications-hint')
  const toggle = document.getElementById('notifications-content-free-toggle')

  if (!notificationsSupported()) {
    btn.disabled = true
    btn.textContent = t('notifications.unsupported')
    if (hint) hint.textContent = ''
    if (toggle) toggle.disabled = true
    return
  }

  btn.disabled = false
  btn.textContent = notificationsSubscribed ? t('notifications.disable') : t('notifications.enable')
  if (hint) hint.textContent = notificationsSubscribed ? t('notifications.enabled') : t('notifications.disabledHint')
  if (toggle) toggle.disabled = !notificationsSubscribed
}

async function toggleNotifications() {
  const btn = document.getElementById('notifications-toggle-btn')
  const wasSubscribed = notificationsSubscribed
  if (btn) btn.disabled = true
  try {
    if (wasSubscribed) await disableNotifications()
    else await enableNotifications()
  } catch (e) {
    showToast(wasSubscribed
      ? t('notifications.disableFailed', { message: e.message })
      : t('notifications.enableFailed', { message: e.message }))
  } finally {
    renderNotificationsState()
  }
}

async function enableNotifications() {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error(t('notifications.permissionDenied'))

  const reg = await navigator.serviceWorker.register('/sw.js')
  const keyRes = await fetch(`${WORKER_URL}/push/vapid-public-key`, {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  })
  const keyData = await keyRes.json()
  if (!keyData.ok) throw new Error(keyData.error || 'failed')

  const contentFreeToggle = document.getElementById('notifications-content-free-toggle')
  const contentFree = !!(contentFreeToggle && contentFreeToggle.checked)

  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(keyData.publicKey),
  })

  const res = await fetch(`${WORKER_URL}/push/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
    body: JSON.stringify({ subscription: subscription.toJSON(), content_free: contentFree }),
  })
  const data = await res.json()
  if (!data.ok) throw new Error(data.error || 'failed')
  notificationsSubscribed = true
}

async function disableNotifications() {
  const sub = await currentPushSubscription()
  if (sub) {
    const endpoint = sub.endpoint
    await sub.unsubscribe()
    await fetch(`${WORKER_URL}/push/unsubscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ endpoint }),
    })
  }
  notificationsSubscribed = false
}

/** The content-free toggle's onchange: re-subscribes with the flag flipped, same endpoint. */
async function setNotificationsContentFree(checked) {
  if (!notificationsSubscribed) return
  try {
    const sub = await currentPushSubscription()
    if (!sub) return
    const res = await fetch(`${WORKER_URL}/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ subscription: sub.toJSON(), content_free: checked }),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'failed')
  } catch (e) {
    showToast(t('notifications.enableFailed', { message: e.message }))
  }
}
