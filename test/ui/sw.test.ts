/**
 * public/sw.js: the service worker behind Web Push (T-0046). Two handlers,
 * both plain functions — this loads the file in a vm sandbox and calls them
 * directly, the same way test/ui/loops.test.ts exercises dashboard modules,
 * since there is no real ServiceWorkerGlobalScope in Node.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect, vi } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

function load() {
  const listeners = new Map<string, (ev: any) => void>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const matchAllResult: any[] = [];

  const ctx: any = {
    console,
    module: { exports: {} },
    self: {
      addEventListener: (type: string, fn: (ev: any) => void) => listeners.set(type, fn),
      registration: { showNotification },
      clients: {
        matchAll: vi.fn().mockImplementation(async () => matchAllResult),
        openWindow,
      },
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(resolve(ROOT, "public/sw.js"), "utf8"), ctx);

  return { ctx, listeners, showNotification, openWindow, matchAllResult };
}

describe("sw.js — push", () => {
  it("registers a push listener", () => {
    const { listeners } = load();
    expect(listeners.has("push")).toBe(true);
  });

  it("shows a notification with the payload's title and body", async () => {
    const { ctx, showNotification } = load();
    const event = { data: { json: () => ({ title: "File the report", body: "due 2027-01-30 - from your second brain", entry_id: "e1" }) }, waitUntil: (p: Promise<unknown>) => p };

    await ctx.module.exports.handlePush(event);

    expect(showNotification).toHaveBeenCalledWith(
      "File the report",
      expect.objectContaining({ body: "due 2027-01-30 - from your second brain", data: { entry_id: "e1" } }),
    );
  });

  it("falls back to a fixed title when the payload has none (content-free)", async () => {
    const { ctx, showNotification } = load();
    const event = { data: { json: () => ({}) }, waitUntil: (p: Promise<unknown>) => p };

    await ctx.module.exports.handlePush(event);

    expect(showNotification).toHaveBeenCalledWith("Second Brain", expect.anything());
  });

  it("does not throw on a push with no data", async () => {
    const { ctx, showNotification } = load();
    const event = { waitUntil: (p: Promise<unknown>) => p };

    await expect(ctx.module.exports.handlePush(event)).resolves.not.toThrow();
    expect(showNotification).toHaveBeenCalled();
  });
});

describe("sw.js — notificationclick", () => {
  it("registers a notificationclick listener", () => {
    const { listeners } = load();
    expect(listeners.has("notificationclick")).toBe(true);
  });

  it("closes the notification", async () => {
    const { ctx } = load();
    const close = vi.fn();
    const event = { notification: { close, data: { entry_id: "e1" } }, waitUntil: (p: Promise<unknown>) => p };

    await ctx.module.exports.handleNotificationClick(event);

    expect(close).toHaveBeenCalled();
  });

  it("focuses and navigates an already-open client to the due deep link", async () => {
    const { ctx, matchAllResult } = load();
    const navigate = vi.fn().mockResolvedValue(undefined);
    const focus = vi.fn().mockResolvedValue(undefined);
    matchAllResult.push({ focus, navigate });
    const event = { notification: { close: () => {}, data: { entry_id: "e1" } }, waitUntil: (p: Promise<unknown>) => p };

    await ctx.module.exports.handleNotificationClick(event);

    expect(navigate).toHaveBeenCalledWith("/#due/e1");
    expect(focus).toHaveBeenCalled();
  });

  it("opens a new window at the deep link when nothing is open", async () => {
    const { ctx, openWindow } = load();
    const event = { notification: { close: () => {}, data: { entry_id: "e1" } }, waitUntil: (p: Promise<unknown>) => p };

    await ctx.module.exports.handleNotificationClick(event);

    expect(openWindow).toHaveBeenCalledWith("/#due/e1");
  });

  it("opens the app root when the notification carries no entry_id", async () => {
    const { ctx, openWindow } = load();
    const event = { notification: { close: () => {}, data: {} }, waitUntil: (p: Promise<unknown>) => p };

    await ctx.module.exports.handleNotificationClick(event);

    expect(openWindow).toHaveBeenCalledWith("/");
  });
});
