import { AsyncLocalStorage, createHook } from "node:async_hooks";

/*
 * Per-query attribution for async work the code under test starts and does not await. A call started beside the
 * query embedding and whose failure the caller swallows (as the retired tag-inference call was) can still be
 * running, or not yet started, when the recall promise settles if the embedding rejects first. `run` tags everything a
 * query starts with its id (AsyncLocalStorage); `settle` waits until every tracked resource created under that id
 * has finished: promises (until resolved), and timers, immediates and nextTick callbacks (until they have run or
 * been cleared), since any of those can create a promise later.
 *
 * Limits: work started before the hook was enabled is not seen (enable happens in `run`, before the scope's code
 * starts, so this only matters for resources created outside a scope); callbacks from native resources (sockets,
 * fs, child processes) are not tracked, so I/O the scope started and did not await may still be pending; and a
 * repeating timer the scope never clears keeps `settle` waiting until its timeout, which then throws.
 * The timeout runs on performance.now(), not Date.now, because runVariant freezes Date.now for the whole run.
 */

interface Store { id: string; open: number }

/** Resource types that can hand control back to the scope's code later; released on resolve (promises) or destroy (the rest). */
const TRACKED = new Set(["PROMISE", "Timeout", "Immediate", "TickObject"]);

export class QueryScopes {
  private readonly als = new AsyncLocalStorage<Store>();
  private readonly owner = new Map<number, Store>();
  private readonly live = new Map<string, Set<Store>>();
  private readonly hook = createHook({
    init: (asyncId, type) => {
      if (!TRACKED.has(type)) return;
      const store = this.als.getStore();
      if (store) { store.open++; this.owner.set(asyncId, store); }
    },
    promiseResolve: asyncId => this.release(asyncId),
    destroy: asyncId => this.release(asyncId), // timers and ticks after they ran or were cleared; a promise collected unresolved
  });

  constructor(private readonly timeoutMs = 10_000) {}

  /** The id of the scope this code runs under, if any. */
  id(): string | undefined { return this.als.getStore()?.id; }

  run<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const store: Store = { id, open: 0 };
    let stores = this.live.get(id);
    if (!stores) this.live.set(id, stores = new Set());
    this.hook.enable();
    stores.add(store);
    return this.als.run(store, fn);
  }

  /** Resolves when everything started under `id` has finished; throws if it has not within the timeout. */
  async settle(id: string): Promise<void> {
    const stores = this.live.get(id);
    if (!stores) return;
    const deadline = performance.now() + this.timeoutMs; // not Date.now: the runner freezes it
    try {
      while ([...stores].some(s => s.open > 0)) {
        if (performance.now() > deadline) throw new Error(`async work started for query ${id} did not settle within ${this.timeoutMs}ms`);
        await new Promise<void>(r => setImmediate(r));
      }
    } finally {
      this.live.delete(id);
      for (const s of stores) for (const [k, v] of this.owner) if (v === s) this.owner.delete(k);
      if (!this.live.size) this.hook.disable();
    }
  }

  private release(asyncId: number): void {
    const store = this.owner.get(asyncId);
    if (!store) return;
    this.owner.delete(asyncId);
    store.open--;
  }
}
