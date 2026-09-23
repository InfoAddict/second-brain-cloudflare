// Service worker for Web Push (round 3, T-0046). Two jobs only: show a
// notification when a push arrives, and focus/open the app when the user
// taps it. Deliberately NO fetch handler and NO caching — a service worker
// that intercepts navigation can serve a stale app shell after a deploy,
// which is a worse failure than this one having nothing to do offline.
//
// Handlers are plain functions, exported at the bottom for
// test/ui/sw.test.ts (the fake-DOM/vm harness has no ServiceWorkerGlobalScope,
// so it calls these directly rather than dispatching real events).
//
// importScripts, not a bundler: this is a classic (non-module) service
// worker, and pending-due.js's stash/read/clear helpers are plain globals
// both this file and public/js/due.js load — due.js via a <script> tag,
// this file via importScripts — so the IndexedDB schema behind the
// notification-tap fallback (see handleNotificationClick) lives in one
// place rather than two copies that could drift.
if (typeof importScripts === "function") {
  importScripts("/js/pending-due.js");
}

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

/**
 * 'notificationclick' — because iOS PWAs are notorious for dropping or
 * ignoring a notification's target URL and, live-tested, ALSO for resuming a
 * backgrounded window without ever running the boot code or delivering a
 * postMessage a frozen page cannot receive: openWindow can land on
 * start_url with the URL discarded entirely, a same-document
 * client.navigate() has been observed silently ignored, and focusing an
 * existing client that was suspended, not closed, means no boot, no
 * navigation, no hashchange — the page simply resumes.
 *
 * The IndexedDB stash (public/js/pending-due.js) is therefore the one
 * channel that survives all of those: it happens UNCONDITIONALLY, before
 * either branch below touches focus, postMessage, or openWindow, so it is
 * always there for public/js/due.js to find — on boot AND on resume
 * (visibilitychange/pageshow/focus). postMessage and the URL remain faster
 * paths when they do land; the stash is what makes them optional rather than
 * load-bearing.
 *
 *   1. An existing window: focus it AND postMessage — far more reliably
 *      delivered than client.navigate() (dropped, not used here at all).
 *   2. No window: open one at a query param (iOS preserves query/path more
 *      reliably than a fragment) with the hash appended too, for browsers
 *      that do honor it.
 *
 * public/js/due.js's handleDueLink checks all of postMessage, the hash, the
 * search param, and the IndexedDB fallback, in that shape, on boot and on
 * every resume signal.
 */
function handleNotificationClick(event) {
  const notification = event && event.notification;
  if (notification && typeof notification.close === "function") notification.close();

  const entryId = notification && notification.data && notification.data.entry_id;

  const task = self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clientList) => {
    // Unconditional, before either branch below — see the comment above.
    if (entryId && typeof stashPendingDueId === "function") await stashPendingDueId(entryId);

    for (const client of clientList) {
      if ("focus" in client) {
        if (entryId && typeof client.postMessage === "function") {
          client.postMessage({ type: "due-deep-link", entry_id: entryId });
        }
        return client.focus();
      }
    }
    const targetUrl = entryId ? `/?due=${encodeURIComponent(entryId)}#due/${encodeURIComponent(entryId)}` : "/";
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
