// Service worker for Web Push (round 3, T-0046). Two jobs only: show a
// notification when a push arrives, and focus/open the app when the user
// taps it. Deliberately NO fetch handler and NO caching — a service worker
// that intercepts navigation can serve a stale app shell after a deploy,
// which is a worse failure than this one having nothing to do offline.
//
// Handlers are plain functions, exported at the bottom for
// test/ui/sw.test.ts (the fake-DOM/vm harness has no ServiceWorkerGlobalScope,
// so it calls these directly rather than dispatching real events).

/** Best-effort JSON parse of the push payload; a malformed one still shows something. */
function parsePushPayload(event) {
  if (!event || !event.data) return {};
  try {
    return event.data.json();
  } catch {
    try {
      return { body: event.data.text() };
    } catch {
      return {};
    }
  }
}

/** 'push' — src/push/send.ts's payload: {title, body?, entry_id?}. */
function handlePush(event) {
  const payload = parsePushPayload(event);
  const title = payload.title || "Second Brain";
  const options = {
    body: payload.body,
    data: { entry_id: payload.entry_id || null },
  };
  const showing = self.registration.showNotification(title, options);
  if (event && typeof event.waitUntil === "function") event.waitUntil(showing);
  return showing;
}

/** 'notificationclick' — focus an already-open tab, or open one, at the due item's deep link. */
function handleNotificationClick(event) {
  const notification = event && event.notification;
  if (notification && typeof notification.close === "function") notification.close();

  const entryId = notification && notification.data && notification.data.entry_id;
  const targetUrl = entryId ? `/#due/${entryId}` : "/";

  const task = self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
    for (const client of clientList) {
      if ("focus" in client) {
        if ("navigate" in client) client.navigate(targetUrl).catch(() => {});
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    return undefined;
  });

  if (event && typeof event.waitUntil === "function") event.waitUntil(task);
  return task;
}

if (typeof self !== "undefined" && typeof self.addEventListener === "function") {
  self.addEventListener("push", handlePush);
  self.addEventListener("notificationclick", handleNotificationClick);
}

if (typeof module !== "undefined") {
  module.exports = { handlePush, handleNotificationClick, parsePushPayload };
}
