/**
 * A minimal hand-rolled fake of the raw IndexedDB API, sufficient for exactly
 * what public/js/pending-due.js does (open-with-upgrade, and a single-key
 * put/get/delete inside one object store) — nothing else. Shared by
 * test/unit/pending-due.test.ts, test/ui/sw.test.ts and test/ui/due.test.ts
 * so the fake itself has one definition rather than three that could drift.
 * No real indexedDB in Node, and no third-party fake allowed
 * (dependency-free), which is why this exists at all.
 */
export function makeFakeIndexedDB() {
  const databases = new Map<string, { stores: Map<string, Map<string, unknown>> }>();

  return {
    open(name: string) {
      const req: any = { onsuccess: null, onerror: null, onupgradeneeded: null, result: undefined };
      queueMicrotask(() => {
        let db = databases.get(name);
        const isNew = !db;
        if (isNew) {
          db = { stores: new Map() };
          databases.set(name, db);
        }
        const dbHandle = {
          objectStoreNames: { contains: (n: string) => db!.stores.has(n) },
          createObjectStore(n: string) {
            db!.stores.set(n, new Map());
            return {};
          },
          transaction(storeName: string) {
            const store = db!.stores.get(storeName)!;
            const tx: any = { oncomplete: null, onerror: null };
            tx.objectStore = () => ({
              put: (value: unknown, key: string) => { store.set(key, value); return {}; },
              get: (key: string) => {
                const r: any = { result: store.get(key), onsuccess: null, onerror: null };
                queueMicrotask(() => { if (r.onsuccess) r.onsuccess(); });
                return r;
              },
              delete: (key: string) => { store.delete(key); return {}; },
            });
            queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete(); });
            return tx;
          },
          close() {},
        };
        req.result = dbHandle;
        if (isNew && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
}
