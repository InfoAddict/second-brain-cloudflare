/**
 * ensureDbReady must not latch the ready flag on a failed init.
 *
 * This is the same shape as the defect in db/init.ts: rejection handling that nothing
 * exercises. If the .catch here set dbReady = true, the isolate would spend the rest of
 * its life believing a schema it never applied is in place — and, exactly as before, no
 * behavioural test elsewhere would notice, because every assertion about a *successful*
 * init passes either way.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { ensureDbReady, isDbReady, setDbReady } from "../../src/runtime/state";
import { resetDatabaseInit } from "../../src/db/init";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";

/** Captures what ensureDbReady hands to waitUntil, so the test can await and inspect it. */
function capturingCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext,
    pending,
  };
}

function failingEnv() {
  const DB = {
    async exec() { throw new Error("D1_ERROR: Network connection lost."); },
    prepare: () => { throw new Error("unexpected prepare"); },
  } as unknown as D1Database;
  return makeTestEnv(undefined, { DB });
}

describe("ensureDbReady", () => {
  beforeEach(() => {
    setDbReady(false);
    resetDatabaseInit();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("marks the database ready once the schema is applied", async () => {
    const { ctx, pending } = capturingCtx();

    ensureDbReady(ctx, makeTestEnv(makeTestDb()));
    await Promise.all(pending);

    expect(isDbReady()).toBe(true);
  });

  it("leaves the database not-ready when init fails, so the next request retries", async () => {
    const { ctx, pending } = capturingCtx();

    ensureDbReady(ctx, failingEnv());
    await Promise.all(pending);

    expect(isDbReady()).toBe(false);
  });

  it("swallows the failure rather than leaking an unhandled rejection into waitUntil", async () => {
    const { ctx, pending } = capturingCtx();

    ensureDbReady(ctx, failingEnv());

    expect(pending).toHaveLength(1);
    await expect(pending[0]).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it("recovers: a later successful init flips it ready", async () => {
    const first = capturingCtx();
    ensureDbReady(first.ctx, failingEnv());
    await Promise.all(first.pending);
    expect(isDbReady()).toBe(false);

    // No resetDatabaseInit here on purpose — this also pins that the memo in db/init.ts
    // cleared itself on rejection, which is what makes the retry reach the database.
    const second = capturingCtx();
    ensureDbReady(second.ctx, makeTestEnv(makeTestDb()));
    await Promise.all(second.pending);

    expect(isDbReady()).toBe(true);
  });

  it("does no work once the database is already ready", async () => {
    setDbReady(true);
    const { ctx, pending } = capturingCtx();

    ensureDbReady(ctx, failingEnv()); // would throw if it touched the database

    expect(pending).toEqual([]);
    expect(isDbReady()).toBe(true);
  });
});

describe("dbReady flag", () => {
  afterEach(() => { setDbReady(false); });

  it("round-trips through setDbReady/isDbReady", () => {
    setDbReady(true);
    expect(isDbReady()).toBe(true);
    setDbReady(false);
    expect(isDbReady()).toBe(false);
  });
});
