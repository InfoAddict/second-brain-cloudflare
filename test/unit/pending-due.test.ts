/**
 * public/js/pending-due.js: the shared IndexedDB helper public/sw.js and
 * public/js/due.js both load (see the file's own comment for how). No real
 * indexedDB in Node and no third-party fake allowed (dependency-free), so
 * this is a small hand-rolled fake sufficient for exactly the operations
 * pending-due.js performs: open-with-upgrade, and a single-key
 * put/get/delete inside one object store.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { makeFakeIndexedDB } from "../helpers/fake-indexeddb";

const ROOT = resolve(import.meta.dirname, "../..");

function load() {
  const ctx: any = {
    console,
    module: { exports: {} },
    indexedDB: makeFakeIndexedDB(),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(resolve(ROOT, "public/js/pending-due.js"), "utf8"), ctx);
  return ctx.module.exports;
}

describe("pending-due.js", () => {
  it("returns null when nothing has been stashed", async () => {
    const { readPendingDueRecord } = load();
    expect(await readPendingDueRecord()).toBeNull();
  });

  it("stashes and reads back an id with a timestamp", async () => {
    const { stashPendingDueId, readPendingDueRecord } = load();
    const before = Date.now();

    await stashPendingDueId("e1");
    const record = await readPendingDueRecord() as { id: string; at: number };

    expect(record.id).toBe("e1");
    expect(record.at).toBeGreaterThanOrEqual(before);
  });

  it("a later stash overwrites the earlier one — one record, not a queue", async () => {
    const { stashPendingDueId, readPendingDueRecord } = load();

    await stashPendingDueId("e1");
    await stashPendingDueId("e2");
    const record = await readPendingDueRecord() as { id: string };

    expect(record.id).toBe("e2");
  });

  it("clears the stashed record", async () => {
    const { stashPendingDueId, readPendingDueRecord, clearPendingDueRecord } = load();
    await stashPendingDueId("e1");

    await clearPendingDueRecord();

    expect(await readPendingDueRecord()).toBeNull();
  });

  it("clearing when nothing is stashed does not throw", async () => {
    const { clearPendingDueRecord } = load();
    await expect(clearPendingDueRecord()).resolves.not.toThrow();
  });

  it("stash is best-effort: does not throw when indexedDB is unavailable", async () => {
    const ctx: any = { console, module: { exports: {} } };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(readFileSync(resolve(ROOT, "public/js/pending-due.js"), "utf8"), ctx);

    await expect(ctx.module.exports.stashPendingDueId("e1")).resolves.not.toThrow();
  });

  it("read is best-effort: resolves null when indexedDB is unavailable", async () => {
    const ctx: any = { console, module: { exports: {} } };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(readFileSync(resolve(ROOT, "public/js/pending-due.js"), "utf8"), ctx);

    await expect(ctx.module.exports.readPendingDueRecord()).resolves.toBeNull();
  });
});
