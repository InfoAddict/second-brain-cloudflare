/**
 * Retraction marker rule (T-0089.2.1, spec 14-t2-time-spec.md 5.2): every place that marks an entry
 * wrong (`withStatus(…, "deprecated")`) or deletes it from `entries` must say, within 3 lines above,
 * whether it runs the retraction hook (D-RET: a closed window needs a live closer):
 * `// validity: retraction-hooked` or `// validity: retraction-exempt: <why>`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { writerSpans } from "../../scripts/check-scope.mjs";

const ROOT = join(import.meta.dirname, "../..");
const MARKER = /\/\/\s*validity:\s*(retraction-hooked|retraction-exempt:\s*\S.*)/;
const DEPRECATE = /withStatus\(.*"deprecated"/;
const DELETE_ENTRIES = /\bDELETE\s+FROM\s+["`[]?entries\b(?![_\w])/i;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (name.endsWith(".ts")) yield path;
  }
}

export interface RetractionSite { file: string; line: number; kind: "hooked" | "exempt" | null }

export function retractionSites(file: string, text: string): RetractionSite[] {
  const lines = text.split("\n");
  const at = new Set<number>();
  lines.forEach((l, i) => { if (DEPRECATE.test(l) && !/^\s*(\*|\/\/)/.test(l)) at.add(i + 1); });
  for (const span of writerSpans(text) as { start: number; end: number }[]) {
    if (DELETE_ENTRIES.test(text.slice(span.start + 1, span.end))) at.add(text.slice(0, span.start).split("\n").length);
  }
  return [...at].sort((a, b) => a - b).map(line => {
    for (let l = line; l >= Math.max(1, line - 3); l--) {
      const m = MARKER.exec(lines[l - 1] ?? "");
      if (m) return { file, line, kind: m[1].startsWith("retraction-hooked") ? "hooked" as const : "exempt" as const };
    }
    return { file, line, kind: null };
  });
}

const PENDING = new Set<string>([]);

function scan(): RetractionSite[] {
  const out: RetractionSite[] = [];
  for (const path of walk(join(ROOT, "src"))) out.push(...retractionSites(relative(ROOT, path), readFileSync(path, "utf8")));
  return out;
}

describe("retraction marker rule", () => {
  it("flags an unmarked deprecate and an unmarked entries delete", () => {
    const fixture = [
      "const a = withStatus(tags, \"deprecated\");",
      "db.prepare(`DELETE FROM entries WHERE id = ?`);",
      "// validity: retraction-hooked",
      "const b = withStatus(JSON.parse(t), \"deprecated\");",
      "// validity: retraction-exempt: member removal deletes closers and targets together",
      "db.prepare(`DELETE FROM entries WHERE workspace_id = ?`);",
      "db.prepare(`DELETE FROM entries_trash WHERE id = ?`);",
    ].join("\n");
    expect(retractionSites("f.ts", fixture)).toEqual([
      { file: "f.ts", line: 1, kind: null },
      { file: "f.ts", line: 2, kind: null },
      { file: "f.ts", line: 4, kind: "hooked" },
      { file: "f.ts", line: 6, kind: "exempt" },
    ]);
  });

  it("every site in src/ is marked", () => {
    const unmarked = scan().filter(s => s.kind === null).map(s => s.file);
    // Task A5 hooks these and empties the list (A3 removed the contradiction deprecate).
    expect(unmarked.filter(f => !PENDING.has(f))).toEqual([]);
  });
});
