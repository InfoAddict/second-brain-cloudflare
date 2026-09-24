import { AsyncLocalStorage, createHook } from "node:async_hooks";

/*
 * Per-query attribution for async work the code under test starts and does not await. recall runs tag inference
 * beside the query embedding (search.ts) and distill.ts swallows its failures, so when the embedding rejects first
 * the tag call can still be running, or not yet started, when the recall promise settles. `run` tags everything a
 * query starts with its id (AsyncLocalStorage); `settle` waits until every promise created under that id has resolved.
 */

interface Store { id: string; open: number }

export class QueryScopes {
  private readonly als = new AsyncLocalStorage<Store>();
  private readonly owner = new Map<number, Store>();
  private readonly live = new Map<string, Set<Store>>();
  private readonly hook = createHook({
    init: (asyncId, type) => {
      if (type !== "PROMISE") return;
      const store = this.als.getStore();
      if (store) { store.open++; this.owner.set(asyncId, store); }
    },
    promiseResolve: asyncId => this.release(asyncId),
    destroy: asyncId => this.release(asyncId), // collected without ever resolving
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
    const deadline = Date.now() + this.timeoutMs;
    try {
      while ([...stores].some(s => s.open > 0)) {
        if (Date.now() > deadline) throw new Error(`async work started for query ${id} did not settle within ${this.timeoutMs}ms`);
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
