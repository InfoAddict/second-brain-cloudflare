// Privacy guards for the recall eval: real memories must never reach git.
//
// Four layers, each independently testable and each failing closed:
//   1. ignore rules   MUST_BE_IGNORED paths stay git-ignored (.gitignore is the source of truth).
//   2. allowlist      only the committed eval files may be tracked under test/eval/data/.
//   3. canary scan    tracked files carry no canary marker and no real-brain-shaped data.
//   4. output paths   assertIgnored() refuses any write that git would pick up.
//
// The golden set is synthetic (Decision 1), so there is no private tier. The design below is
// kept so one can be added without redesigning these guards (Decision 2).
//
// --allow-private-embed (designed, deliberately NOT implemented):
//   - A private corpus would use the id `private:<name>`, with its files under PRIVATE_DIR and its
//     replay cache under .eval-cache/private/ (both ignored). Neither path is on the allowlist.
//   - `prepare` on a `private:` corpus would refuse unless --allow-private-embed is passed, because
//     embedding sends real memory text to the embedding provider (today a local model, so nothing leaves
//     the machine; the flag exists so a future remote provider cannot be used silently). The refusal names
//     what would leave the machine. Without the flag a private corpus stays lexical-only.
//   - Every private artifact write (--json, exports, labels) goes through assertIgnored().
//   - The private corpus would be seeded with a CANARY_RE marker entry; the scan already fails on
//     any tracked file containing it, so a leaked export is caught even if the heuristics miss.
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

// Deliberately NOT SB_EVAL_ROOT: the guard must judge writes against the real checkout, and an env-derived root could be pointed away from it.
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** Local working caches, including the public corpora download. */
export const CACHE_DIR = ".eval-cache";
/** Reserved home for a future private tier (already covered by `docs/*`). */
export const PRIVATE_DIR = "docs/superpowers/eval-private";

/** Probe paths that must stay ignored: caches, public downloads, results, and the reserved private dir. */
export const MUST_BE_IGNORED = [
  `${CACHE_DIR}/replay/x.jsonl`,
  `${CACHE_DIR}/models/x/onnx/model.onnx`,
  `${CACHE_DIR}/public/scifact/corpus.jsonl`,
  `${CACHE_DIR}/private/x/corpus.jsonl`,
  `${PRIVATE_DIR}/x/corpus.jsonl`,
  `${PRIVATE_DIR}/captured-queries.jsonl`,
  "docs/superpowers/eval-results/r.json",
] as const;

/** Exactly the committed eval files: golden data, manifest, committed replay cache, baselines. */
export const DATA_ALLOWLIST: readonly RegExp[] = [
  /^test\/eval\/data\/core\/(?:needles|edges|queries)\.jsonl$/,
  /^test\/eval\/data\/core\/manifest\.json$/,
  /^test\/eval\/data\/core\/replay\.[\w.-]+\.jsonl\.gz$/,
  /^test\/eval\/data\/baselines\/[\w.-]+\.json$/,
];
const DATA_PREFIX = "test/eval/data/";

export const isAllowedDataFile = (rel: string): boolean => DATA_ALLOWLIST.some(re => re.test(rel));

/** Tracked files under test/eval/data/ that are not on the allowlist. */
export const dataAllowlistViolations = (files: readonly string[]): string[] =>
  files.filter(f => f.startsWith(DATA_PREFIX) && !isAllowedDataFile(f));

function git(root: string, args: string[]) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const inside = (root: string, path: string): string | null => {
  let cur = resolve(root, path);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = resolve(realpathSync(cur), ...rest);
      const rel = relative(realpathSync(root), real);
      return rel.startsWith("..") ? null : rel;
    } catch {
      const up = dirname(cur);
      if (up === cur) return null;
      rest.unshift(cur.slice(up.length + 1));
      cur = up;
    }
  }
};

/**
 * Throws unless git ignores `path` and does not track it. Symlinks are resolved first, so a link
 * inside an ignored directory cannot smuggle a write into a tracked one. Paths outside the repo
 * cannot be committed and pass.
 */
export function assertIgnored(path: string, root: string = REPO_ROOT): void {
  const rel = inside(root, path);
  if (rel === null) return;
  const ignored = git(root, ["check-ignore", "-q", "--no-index", "--", rel]).status === 0;
  if (!ignored) throw new Error(`refusing to write ${rel}: it is not git-ignored. Eval output belongs under ${CACHE_DIR}/ or docs/, or outside the repo.`);
  if (git(root, ["ls-files", "--error-unmatch", "--", rel]).status === 0) throw new Error(`refusing to write ${rel}: it is tracked by git.`);
}

/** Probe paths from MUST_BE_IGNORED that git does not ignore (empty when the rules hold). */
export const ignoreRuleViolations = (root: string = REPO_ROOT): string[] =>
  MUST_BE_IGNORED.filter(p => git(root, ["check-ignore", "-q", "--no-index", "--", p]).status !== 0);

/** Tracked files that a current ignore rule also matches (a force-added or pre-rule file). */
export const trackedButIgnored = (root: string = REPO_ROOT): string[] =>
  git(root, ["ls-files", "-ci", "--exclude-standard"]).stdout.split("\n").filter(Boolean);

/** Throws when git cannot list files (missing binary, not a repo): an empty listing must never read as "nothing to scan". */
export const trackedFiles = (root: string = REPO_ROOT): string[] => {
  const r = git(root, ["ls-files", "-z"]);
  if (r.error || r.status !== 0) throw new Error(`git ls-files failed in ${root} (${r.error?.message ?? r.stderr.trim() ?? `exit ${r.status}`}); refusing to scan an unknown file set`);
  return r.stdout.split("\0").filter(Boolean);
};

// Canary: a planted marker (prefix + 6 or more chars). The prefix is never written whole in
// source, so this module and its tests do not trip the scan they define.
export const CANARY_RE = /SB_EVAL_CANARY_[A-Za-z0-9]{6,}/;

const RESERVED_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net)|[\w-]+\.(?:test|invalid|example)|localhost)$/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g;
// NANP (555-01xx is the fictional block) and E.164-style international numbers.
const PHONE_RE = /(?<![\w.-])(?:\+?1[\s.-])?\(?[2-9]\d{2}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w-])|(?<![\w.-])\+\d{1,3}[\s.-]?\d(?:[\s.-]?\d){7,13}(?![\w-])/g;
// Production entry and edge ids are crypto.randomUUID() (v4).
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const CREDENTIAL_RE = /\b(?:cfut|cfat|ghp|sk)_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{20,}/g;

export interface Finding { file: string; rule: "canary" | "email" | "phone" | "entry-id" | "credential" | "unreadable"; sample: string }

/** Files the export-shape heuristics apply to; the canary scan covers everything tracked. */
export const isEvalScope = (rel: string): boolean => rel.startsWith("test/eval/") || rel.startsWith("scripts/eval-");

/** Findings in one file's text. `heuristics` off means canary only. */
export function scanText(file: string, text: string, heuristics: boolean): Finding[] {
  const out: Finding[] = [];
  const canary = CANARY_RE.exec(text);
  if (canary) out.push({ file, rule: "canary", sample: canary[0] });
  if (!heuristics) return out;
  for (const m of text.matchAll(EMAIL_RE)) if (!RESERVED_DOMAIN.test(m[1])) out.push({ file, rule: "email", sample: m[0] });
  for (const m of text.matchAll(PHONE_RE)) if (!/555[\s.-]01\d\d/.test(m[0])) out.push({ file, rule: "phone", sample: m[0] });
  for (const m of text.matchAll(UUID_RE)) out.push({ file, rule: "entry-id", sample: m[0] });
  for (const m of text.matchAll(CREDENTIAL_RE)) out.push({ file, rule: "credential", sample: `${m[0].slice(0, 8)}...` });
  return out;
}

/** Every string (keys and values) in a JSON document or a JSON-lines file; anything that does not parse contributes nothing. */
function jsonStrings(text: string): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); walk(x); }
  };
  try { walk(JSON.parse(text)); return out; } catch { /* not one document: try lines */ }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { walk(JSON.parse(line)); } catch { /* not JSON: the raw scan already covered it */ }
  }
  return out;
}

/**
 * Scans tracked files (gzip members are decompressed first, since a replay cache hides text). JSON, JSON-lines and
 * gzipped JSON are scanned twice: as raw bytes and as decoded string values, so a \uXXXX escape cannot hide a marker.
 * A tracked file that exists but cannot be read is a finding; one deleted from the work tree is skipped (nothing to leak).
 */
export function scanTracked(root: string = REPO_ROOT, files: readonly string[] = trackedFiles(root)): Finding[] {
  const out: Finding[] = [];
  for (const file of files) {
    const path = resolve(root, file);
    let buf: Buffer;
    try {
      buf = readFileSync(path);
    } catch (e) {
      let deleted = false;
      try { lstatSync(path); } catch { deleted = true; }
      if (!deleted) out.push({ file, rule: "unreadable", sample: (e as Error).message });
      continue;
    }
    if (file.endsWith(".gz")) { try { buf = gunzipSync(buf); } catch { /* not really gzip: scan raw */ } }
    const text = buf.toString("utf8");
    const heuristics = isEvalScope(file);
    const found = scanText(file, text, heuristics);
    if (/\.(?:jsonl?|gz)$/.test(file)) {
      const seen = new Set(found.map(f => `${f.rule}:${f.sample}`));
      for (const f of scanText(file, jsonStrings(text).join("\n"), heuristics)) if (!seen.has(`${f.rule}:${f.sample}`)) found.push(f);
    }
    out.push(...found);
  }
  return out;
}
