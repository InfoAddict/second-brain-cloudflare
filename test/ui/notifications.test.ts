/**
 * The notifications card (js/notifications.js): enable/disable this device
 * for Web Push, and a content-free toggle. Mocks the browser Push API
 * surface (Notification, ServiceWorkerRegistration, PushManager) rather than
 * the Worker's crypto — that is test/unit/push-crypto.test.ts's job.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect, vi } from "vitest";
import { installI18n } from "./_i18n-harness";

const ROOT = resolve(import.meta.dirname, "../..");

function makeSubscription(endpoint = "https://push.example.com/s1") {
  return {
    endpoint,
    unsubscribe: vi.fn().mockResolvedValue(true),
    toJSON: () => ({ endpoint, keys: { p256dh: "p256dh-key", auth: "auth-key" } }),
  };
}

function load(opts: {
  supported?: boolean;
  permission?: "granted" | "denied" | "default";
  existingSubscription?: any;
  fetchResponses?: Record<string, any>;
} = {}) {
  const {
    supported = true,
    permission = "granted",
    existingSubscription = null,
    fetchResponses = {},
  } = opts;

  const els = new Map<string, any>();
  const makeEl = (id?: string) => ({
    id,
    hidden: false,
    disabled: false,
    checked: false,
    innerHTML: "",
    textContent: "",
    style: {} as Record<string, string>,
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener() {},
  });

  let currentSubscription = existingSubscription;
  const subscribeMock = vi.fn().mockImplementation(async () => {
    currentSubscription = makeSubscription();
    return currentSubscription;
  });
  const pushManager = {
    getSubscription: vi.fn().mockImplementation(async () => currentSubscription),
    subscribe: subscribeMock,
  };
  const registration = { pushManager };
  const registerMock = vi.fn().mockResolvedValue(registration);
  const getRegistrationMock = vi.fn().mockResolvedValue(registration);

  const fetchCalls: { url: string; init?: any }[] = [];
  const ctx: any = {
    console,
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: "t",
    showToast: () => {},
    atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
    Notification: { requestPermission: vi.fn().mockResolvedValue(permission) },
    navigator: supported ? { serviceWorker: { register: registerMock, getRegistration: getRegistrationMock } } : {},
    window: supported ? { PushManager: function () {}, Notification: function () {} } : {},
    fetch: async (url: string, init?: any) => {
      fetchCalls.push({ url, init });
      const path = url.replace("https://example.test", "");
      const body = fetchResponses[path] ?? { ok: true };
      return { ok: true, json: async () => body };
    },
    document: {
      getElementById: (id: string) => {
        if (!els.has(id)) els.set(id, makeEl(id));
        return els.get(id);
      },
      createElement: () => makeEl(),
      addEventListener() {},
      querySelectorAll: () => [],
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  for (const f of ["public/utils.js", "public/js/notifications.js"]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  ctx.__els = els;
  ctx.__fetchCalls = fetchCalls;
  ctx.__registerMock = registerMock;
  ctx.__subscribeMock = subscribeMock;
  ctx.__getSubscription = () => currentSubscription;
  return ctx;
}

describe("notificationsSupported / loadNotificationsState", () => {
  it("disables the control and explains when push is unsupported", async () => {
    const ctx = load({ supported: false });

    await ctx.loadNotificationsState();

    const btn = ctx.__els.get("notifications-toggle-btn");
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain("not supported");
  });

  it("shows enable when supported and not yet subscribed", async () => {
    const ctx = load({ existingSubscription: null });

    await ctx.loadNotificationsState();

    const btn = ctx.__els.get("notifications-toggle-btn");
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe("Enable notifications");
  });

  it("shows disable when a subscription already exists", async () => {
    const ctx = load({ existingSubscription: makeSubscription() });

    await ctx.loadNotificationsState();

    expect(ctx.__els.get("notifications-toggle-btn").textContent).toBe("Disable notifications");
    expect(ctx.__els.get("notifications-hint").textContent).toContain("on for this device");
  });
});

describe("enableNotifications", () => {
  it("registers the service worker, fetches the VAPID key, subscribes, and posts to /push/subscribe", async () => {
    const ctx = load({
      fetchResponses: { "/push/vapid-public-key": { ok: true, publicKey: "abcd" } },
    });

    await ctx.enableNotifications();

    expect(ctx.__registerMock).toHaveBeenCalledWith("/sw.js");
    expect(ctx.__subscribeMock).toHaveBeenCalled();
    const subscribeCall = ctx.__fetchCalls.find((c: any) => c.url === "https://example.test/push/subscribe");
    expect(subscribeCall).toBeTruthy();
    const body = JSON.parse(subscribeCall.init.body);
    expect(body.subscription.endpoint).toBe("https://push.example.com/s1");
    expect(body.content_free).toBe(false);
  });

  it("throws when permission is denied, without subscribing", async () => {
    const ctx = load({ permission: "denied" });

    await expect(ctx.enableNotifications()).rejects.toThrow();
    expect(ctx.__subscribeMock).not.toHaveBeenCalled();
  });

  it("sends content_free: true when the toggle is checked", async () => {
    const ctx = load({ fetchResponses: { "/push/vapid-public-key": { ok: true, publicKey: "abcd" } } });
    ctx.document.getElementById("notifications-content-free-toggle").checked = true;

    await ctx.enableNotifications();

    const subscribeCall = ctx.__fetchCalls.find((c: any) => c.url === "https://example.test/push/subscribe");
    expect(JSON.parse(subscribeCall.init.body).content_free).toBe(true);
  });
});

describe("disableNotifications", () => {
  it("unsubscribes locally and posts to /push/unsubscribe", async () => {
    const sub = makeSubscription();
    const ctx = load({ existingSubscription: sub });

    await ctx.disableNotifications();

    expect(sub.unsubscribe).toHaveBeenCalled();
    const call = ctx.__fetchCalls.find((c: any) => c.url === "https://example.test/push/unsubscribe");
    expect(JSON.parse(call.init.body)).toEqual({ endpoint: "https://push.example.com/s1" });
  });

  it("is a no-op when there is nothing to unsubscribe", async () => {
    const ctx = load({ existingSubscription: null });

    await expect(ctx.disableNotifications()).resolves.not.toThrow();
    expect(ctx.__fetchCalls.find((c: any) => c.url.includes("/push/unsubscribe"))).toBeUndefined();
  });
});

describe("toggleNotifications", () => {
  it("enables when not subscribed, then reflects the new state", async () => {
    const ctx = load({ fetchResponses: { "/push/vapid-public-key": { ok: true, publicKey: "abcd" } } });

    await ctx.toggleNotifications();

    expect(ctx.__els.get("notifications-toggle-btn").textContent).toBe("Disable notifications");
  });

  it("disables when already subscribed", async () => {
    const sub = makeSubscription();
    const ctx = load({ existingSubscription: sub });
    await ctx.loadNotificationsState();

    await ctx.toggleNotifications();

    expect(ctx.__els.get("notifications-toggle-btn").textContent).toBe("Enable notifications");
  });
});

describe("setNotificationsContentFree", () => {
  it("re-subscribes the same endpoint with content_free flipped", async () => {
    const sub = makeSubscription();
    const ctx = load({ existingSubscription: sub });
    await ctx.loadNotificationsState();

    await ctx.setNotificationsContentFree(true);

    const call = ctx.__fetchCalls.find((c: any) => c.url === "https://example.test/push/subscribe");
    const body = JSON.parse(call.init.body);
    expect(body.subscription.endpoint).toBe("https://push.example.com/s1");
    expect(body.content_free).toBe(true);
  });

  it("does nothing when not currently subscribed", async () => {
    const ctx = load({ existingSubscription: null });
    await ctx.loadNotificationsState();

    await ctx.setNotificationsContentFree(true);

    expect(ctx.__fetchCalls.find((c: any) => c.url.includes("/push/subscribe"))).toBeUndefined();
  });
});
