import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { summarize } from "./metrics";
import type { VariantReport } from "./types";

export class LockRefused extends Error {}

export interface BaselineSummary {
  variant: string; corpus: string; embeddingModel: string; queries: number;
  recall5: number; recall10: number; mrr10: number; ndcg10: number;
  errors: number; degraded: number; leaks: number;
}

export interface HistoryEntry {
  date: string;
  reason: string;
  /** old is "" for a file's first appearance (the genesis entry). */
  files: Record<string, { old: string; new: string }>;
  /** Absent on the genesis entry, which predates any lock. */
  baseline?: BaselineSummary;
}

export interface Manifest { files: Record<string, string>; history?: HistoryEntry[]; [key: string]: unknown }

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Every .jsonl golden-data file in the directory, hashed; this is the fingerprint reports carry. */
export function hashDataDir(dataDir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dataDir).filter(n => n.endsWith(".jsonl")).sort().map(n => [n, sha(resolve(dataDir, n))]));
}

export function currentHashes(dataDir: string, manifest: Manifest): Record<string, string> {
  return Object.fromEntries(Object.keys(manifest.files).map(name => [name, sha(resolve(dataDir, name))]));
}

export function summarizeBaseline(r: VariantReport): BaselineSummary {
  const s = summarize(r.results).allQueries;
  return {
    variant: r.variant, corpus: r.corpus, embeddingModel: r.embeddingModel, queries: s.n,
    recall5: s.metrics.recall5, recall10: s.metrics.recall10, mrr10: s.metrics.mrr10, ndcg10: s.metrics.ndcg10,
    errors: s.errors, degraded: s.degraded, leaks: s.leaks,
  };
}

/**
 * Problems with a manifest's own audit trail. The history starts with a genesis entry that anchors every
 * file, each entry continues the last, and the chain ends at manifest.files, so editing a data file and its
 * hash together (or dropping a key) breaks the chain from day one.
 */
export function historyProblems(manifest: Manifest): string[] {
  const history = manifest.history ?? [];
  const problems: string[] = [];
  if (!history.length) return ["manifest has no history: it needs a genesis entry that records the current hashes"];
  if (history[0].reason !== "genesis") problems.push('history[0] must be the "genesis" entry');
  const running = new Map<string, string>();
  history.forEach((h, i) => {
    if (!h.reason?.trim()) problems.push(`history[${i}] has no reason`);
    for (const [name, { old, new: next }] of Object.entries(h.files)) {
      const seen = running.get(name);
      if (seen !== undefined && seen !== old) problems.push(`history[${i}] ${name}: old hash does not continue the previous entry`);
      running.set(name, next);
    }
  });
  for (const name of Object.keys(manifest.files)) {
    if (!running.has(name)) problems.push(`${name}: listed in manifest.files but never recorded in the history`);
  }
  for (const [name, hash] of running) {
    if (manifest.files[name] !== hash) problems.push(`${name}: manifest hash is not the last history entry's new hash (edited without a history entry)`);
  }
  return problems;
}

export interface LockDiff {
  fingerprintMismatch: boolean;
  /** Query ids whose top-10 differs from the lock. */
  changed: string[];
  /** In the lock, absent now. */
  missing: string[];
  /** Present now, absent from the lock. */
  extra: string[];
}

const stable = (f?: Record<string, string>) => JSON.stringify(Object.entries(f ?? {}).sort(([a], [b]) => a.localeCompare(b)));

/** Aligns by queryId, never by index, so inserting a query cannot shift every later comparison. */
export function compareToLock(lock: VariantReport, current: VariantReport): LockDiff {
  const locked = new Map(lock.results.map(r => [r.queryId, r] as const));
  const now = new Map(current.results.map(r => [r.queryId, r] as const));
  return {
    fingerprintMismatch: stable(lock.dataFingerprint) !== stable(current.dataFingerprint),
    changed: [...now].filter(([id, r]) => locked.has(id) && JSON.stringify(locked.get(id)!.rankedIds) !== JSON.stringify(r.rankedIds)).map(([id]) => id),
    missing: [...locked.keys()].filter(id => !now.has(id)),
    extra: [...now.keys()].filter(id => !locked.has(id)),
  };
}

/**
 * The baseline-lock tripwire. Data files that differ from the manifest are refused unless the caller
 * accepts the change with a reason; an accepted change is recorded in manifest.history, never rewritten silently.
 */
export async function applyLock(o: {
  dataDir: string;
  lockPath: string;
  acceptReason?: string;
  runBaseline: () => Promise<VariantReport>;
  now?: () => Date;
}): Promise<{ lockPath: string; dataChanged: boolean }> {
  const manifestPath = resolve(o.dataDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const trail = historyProblems(manifest);
  if (trail.length) throw new LockRefused(`manifest history is inconsistent: ${trail.join("; ")}`);
  const onDisk = Object.keys(hashDataDir(o.dataDir));
  const listed = Object.keys(manifest.files).sort();
  if (JSON.stringify(onDisk) !== JSON.stringify(listed)) {
    throw new LockRefused(`manifest.files must list exactly the data files on disk (on disk: ${onDisk.join(", ")}; listed: ${listed.join(", ")})`);
  }
  const now = currentHashes(o.dataDir, manifest);
  const changed = Object.keys(now).filter(name => now[name] !== manifest.files[name]);
  const reason = o.acceptReason?.trim();
  if (changed.length && !reason) {
    throw new LockRefused(`golden data changed since the manifest was written (${changed.join(", ")}). Re-lock only if that is deliberate: pass --accept-data-change "<reason>" and it is recorded in the manifest history.`);
  }
  const report = await o.runBaseline();
  const baseline = summarizeBaseline(report);
  if (baseline.errors || baseline.degraded || baseline.leaks) {
    throw new LockRefused(`refusing to lock a broken baseline (${baseline.errors} error(s), ${baseline.degraded} degraded, ${baseline.leaks} leak(s))`);
  }
  mkdirSync(dirname(o.lockPath), { recursive: true });
  const stable: VariantReport = { ...report, results: report.results.map(r => ({ ...r, cost: { ...r.cost, wallMs: 0 } })) };
  writeFileSync(o.lockPath, `${JSON.stringify(stable, null, 1)}\n`);
  if (changed.length) {
    const entry: HistoryEntry = {
      date: (o.now?.() ?? new Date()).toISOString(),
      reason: reason!,
      files: Object.fromEntries(changed.map(name => [name, { old: manifest.files[name], new: now[name] }])),
      baseline,
    };
    manifest.history = [...(manifest.history ?? []), entry];
    manifest.files = now;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return { lockPath: o.lockPath, dataChanged: changed.length > 0 };
}
