/**
 * Codex review class A (T-0089.4.2): "no call to Vectorize upsert or storeEntry outside the
 * gate." The gate is `upsertEntryVectors`'s own `if (isHeld(tags)) throw HeldRowEmbedRefusedError`
 * (src/capture/store.ts) — every caller that embeds a row's real content (storeEntry,
 * reembedOrThrow, reembedOrDegrade, undo's reembedForRevert/reembedForRelease, trash restore,
 * mirror sync, the embedding migration, vectorize-pending) already goes through it. This scans
 * src/ for every OTHER direct `env.VECTORIZE.upsert(`/`.insert(` call site — the ones the gate
 * cannot see — and requires each to be named here with why it is still safe, so a new one added
 * without routing through the gate (or without an equally explicit reason) fails loudly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { HeldRowEmbedRefusedError, upsertEntryVectors } from "../../src/capture/store";
import { withHold } from "../../src/quarantine/tags";
import { makeAIMock, makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";

const ROOT = join(import.meta.dirname, "../..");

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (name.endsWith(".ts")) yield path;
  }
}

interface Site { file: string; line: number }

function scanDirectCalls(): Site[] {
  const sites: Site[] = [];
  const CALL = /\benv\.VECTORIZE\.(?:upsert|insert)\s*\(/g;
  for (const path of walk(join(ROOT, "src"))) {
    const file = relative(ROOT, path);
    const text = readFileSync(path, "utf8");
    for (const m of text.matchAll(CALL)) {
      const line = text.slice(0, m.index).split("\n").length;
      sites.push({ file, line });
    }
  }
  return sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/**
 * Every direct `env.VECTORIZE.upsert`/`.insert` site OUTSIDE upsertEntryVectors itself, with why
 * it needs no gate. A writer added here without one of these two shapes is the bug class A
 * exists to catch: an embed of a row whose current tags were never checked.
 */
const ACCOUNTED_FOR: { file: string; line: number; why: string }[] = [
  {
    file: "src/capture/store.ts", line: 204,
    why: "upsertEntryVectors' OWN upsert loop — the gate that refuses held tags sits at the top of this same function, before any chunking or embedding runs.",
  },
  {
    file: "src/capture/store.ts", line: 832,
    why: "appendToEntry's short branch: gated inline by `!heldTags && !alreadyHeld && !chunk` immediately above — a newly-held or already-held row never reaches this call. A retry that discovers the row became held after an earlier attempt's chunk landed here retires and forgets that chunk before re-checking the gate (Codex recheck, T-0089.4.2).",
  },
  {
    file: "src/capture/share.ts", line: 171,
    why: "restampVectorWorkspace re-stamps EXISTING vectors' metadata (workspace_id) fetched by getByIds — it embeds no new content and adds no vector. Codex recheck (T-0089.4.2, class A): the earlier reasoning here (\"a held row has vector_ids = '[]' so the loop never runs\") assumed the vectorIds this fire-and-forget call re-stamps were read at the SAME moment as the check — they are read earlier by its caller, and a hold landing in that gap empties vector_ids in D1 and deletes its vectors separately, not atomically, so a stale-but-not-yet-deleted vector could still be named here. Fixed with a fresh isHeld re-check of each vector's owning row immediately before the upsert, proven by test/unit/restamp-held-race.test.ts — not by this comment alone.",
  },
];

describe("every direct Vectorize upsert/insert call outside upsertEntryVectors's own gate is accounted for", () => {
  const sites = scanDirectCalls();

  it("finds at least the known call sites (the scanner itself is not a no-op)", () => {
    expect(sites.length).toBeGreaterThanOrEqual(3);
  });

  it("matches the accounted-for list exactly", () => {
    const actual = sites.map(s => `${s.file}:${s.line}`).sort();
    const expected = ACCOUNTED_FOR.map(s => `${s.file}:${s.line}`).sort();
    expect(actual).toEqual(expected);
  });
});

describe("upsertEntryVectors' own gate", () => {
  it("refuses tags that are still held", async () => {
    const env = makeTestEnv(makeTestDb(), { VECTORIZE: makeVectorizeMock(), AI: makeAIMock() });
    await expect(
      upsertEntryVectors(env, "e1", "content", withHold(["work"], "instruction"), "api", Date.now()),
    ).rejects.toThrow(HeldRowEmbedRefusedError);
  });

  it("embeds normally when the tags are not held", async () => {
    const env = makeTestEnv(makeTestDb(), { VECTORIZE: makeVectorizeMock(), AI: makeAIMock() });
    const result = await upsertEntryVectors(env, "e1", "content", ["work"], "api", Date.now());
    expect(result.vectorIds.length).toBeGreaterThan(0);
  });
});
