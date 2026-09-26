import { describe, expect, it } from "vitest";
import { EVAL_NOW } from "./corpus/types";
import { freezeClock } from "./runner";
import { QueryScopes } from "./query-scope";

const tick = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("QueryScopes", () => {
  it("carries the id into everything the scope starts, awaited or not", async () => {
    const scopes = new QueryScopes();
    const seen: (string | undefined)[] = [];
    await scopes.run("q1", async () => {
      seen.push(scopes.id());
      void tick(5).then(() => seen.push(scopes.id()));
      await Promise.resolve();
    });
    await scopes.settle("q1");
    expect(seen).toEqual(["q1", "q1"]);
    expect(scopes.id()).toBeUndefined();
  });

  it("settle waits for work the scope left running after its own promise finished", async () => {
    const scopes = new QueryScopes();
    let done = false;
    await scopes.run("q1", async () => { void tick(40).then(() => tick(20)).then(() => { done = true; }); });
    expect(done).toBe(false);
    await scopes.settle("q1");
    expect(done).toBe(true);
  });

  it("waits for work that has not started yet when the scope's own promise rejects", async () => {
    const scopes = new QueryScopes();
    let late = false;
    await scopes.run("q1", async () => {
      void (async () => { await tick(10); await tick(10); late = true; })(); // the orphan (tag inference beside a failed embedding)
      throw new Error("embedding boom");
    }).catch(() => undefined);
    await scopes.settle("q1");
    expect(late).toBe(true);
  });

  it("does not wait on another scope's work", async () => {
    const scopes = new QueryScopes();
    let slow = false;
    await scopes.run("slow", async () => { void tick(150).then(() => { slow = true; }); });
    await scopes.run("fast", async () => undefined);
    await scopes.settle("fast");
    expect(slow).toBe(false);
    await scopes.settle("slow");
    expect(slow).toBe(true);
  });

  it("fails loudly instead of hanging on work that never finishes", async () => {
    const scopes = new QueryScopes(60);
    const forever: Promise<unknown>[] = []; // held, so it is never collected
    await scopes.run("q1", async () => { forever.push(new Promise(() => {})); });
    await expect(scopes.settle("q1")).rejects.toThrow(/did not settle within 60ms/);
  });

  it("times out under the runner's frozen Date.now", async () => {
    const scopes = new QueryScopes(60);
    const forever: Promise<unknown>[] = [];
    await scopes.run("q1", async () => { forever.push(new Promise(() => {})); });
    const restore = freezeClock(EVAL_NOW); // runVariant freezes Date.now for the whole run
    try {
      const started = performance.now();
      await expect(scopes.settle("q1")).rejects.toThrow(/did not settle within 60ms/);
      expect(performance.now() - started).toBeLessThan(2000);
    } finally { restore(); }
  });

  it("waits for a timer that has not fired, and for the promise it creates when it does", async () => {
    const scopes = new QueryScopes();
    let late = false;
    await scopes.run("q1", async () => { setTimeout(() => { void Promise.resolve().then(() => tick(10)).then(() => { late = true; }); }, 30); });
    await scopes.settle("q1");
    expect(late).toBe(true);
  });

  it("waits through setImmediate and process.nextTick hops into a later timer", async () => {
    const scopes = new QueryScopes();
    const hit: string[] = [];
    await scopes.run("q1", async () => {
      setImmediate(() => { setTimeout(() => hit.push("immediate"), 20); });
      process.nextTick(() => { setTimeout(() => hit.push("tick"), 20); });
    });
    await scopes.settle("q1");
    expect(hit.sort()).toEqual(["immediate", "tick"]);
  });

  it("does not wait for a timer that was cleared", async () => {
    const scopes = new QueryScopes(200);
    await scopes.run("q1", async () => { clearTimeout(setTimeout(() => {}, 5_000)); });
    const started = performance.now();
    await scopes.settle("q1");
    expect(performance.now() - started).toBeLessThan(150);
  });

  it("gives up on a repeating timer the scope never cleared, rather than waiting forever", async () => {
    const scopes = new QueryScopes(60);
    let handle: NodeJS.Timeout | undefined;
    await scopes.run("q1", async () => { handle = setInterval(() => {}, 10); });
    try { await expect(scopes.settle("q1")).rejects.toThrow(/did not settle/); } finally { clearInterval(handle); }
  });
});
