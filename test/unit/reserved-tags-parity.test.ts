/**
 * Guard for the Track 7 (and future Track 4) reserved-tag registration
 * (16-t3-t4-trust-spec.md Task 0, 15-t7-wow-spec.md Task 1, Design 1.4).
 *
 * Four lists enumerate reserved tags today: src/tags/system.ts,
 * src/compression/eligibility.ts, public/utils.js and src/projects/registry.ts.
 * They already differ on purpose (eligibility and utils include `project:`;
 * eligibility reserves `stale:as-of` where system.ts reserves the `stale:`
 * prefix), so this file pins the documented allow-list and fails the moment
 * any *other* difference appears -- including a future Track 4 addition
 * (`quarantine:`, `edited-canonical:`, or a later `retracted-source`) that
 * lands in one list and not the others.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import { installI18n } from "../ui/_i18n-harness";
import {
  applyTagReplacement,
  isWorkerOwnedTag,
  RESERVED_TAG_PREFIXES as SYSTEM_RESERVED_TAG_PREFIXES,
} from "../../src/tags/system";
import { isReservedTag, isTopicTag, isTopicTagSql, RESERVED_TAG_PREFIXES as ELIGIBILITY_RESERVED_TAG_PREFIXES } from "../../src/compression/eligibility";
import { QUARANTINE_TAG_PREFIX, EDITED_CANONICAL_TAG_PREFIX } from "../../src/quarantine/tags";
import {
  COUNTERPARTY_TAG_PREFIX,
  LEDGER_TAG,
  OWED_TO_ME_TAG,
  STANDING_TAG,
  T7_TAG_NAMES,
  T7_TAG_PREFIXES,
  stripT7CallerTags,
} from "../../src/tags/t7";
import { InvalidProjectInputError, createProject } from "../../src/projects/registry";
import { inferQueryTags } from "../../src/recall/distill";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";

const ROOT = resolve(import.meta.dirname, "../..");

// system.ts does not export RESERVED_TAG_PREFIXES today; the module is
// extended to for this guard (see the file diff). Fall back gracefully if a
// future refactor removes the export again, so this test fails loudly rather
// than silently passing on an empty list.
const SYSTEM_SET = new Set((SYSTEM_RESERVED_TAG_PREFIXES ?? []).map(p => p.toLowerCase()));
const ELIGIBILITY_SET = new Set(ELIGIBILITY_RESERVED_TAG_PREFIXES.map(p => p.toLowerCase()));

const ALL_NEW_PREFIXES = [QUARANTINE_TAG_PREFIX, EDITED_CANONICAL_TAG_PREFIX, ...T7_TAG_PREFIXES];
const ALL_NEW_NAMES = [OWED_TO_ME_TAG];

function loadUtils(): any {
  const ctx: any = { console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  vm.runInContext(readFileSync(resolve(ROOT, "public/utils.js"), "utf8"), ctx);
  return ctx;
}

describe("every T7 and trust-tag namespace is worker-owned", () => {
  it("isWorkerOwnedTag is true for a sample value of each prefix and each bare marker", () => {
    for (const prefix of ALL_NEW_PREFIXES) expect(isWorkerOwnedTag(`${prefix}sample`), prefix).toBe(true);
    for (const name of ALL_NEW_NAMES) expect(isWorkerOwnedTag(name), name).toBe(true);
  });

  it("applyTagReplacement drops a caller-supplied standing:active and keeps the existing one", () => {
    expect(applyTagReplacement([STANDING_TAG, "x"], ["y"])).toEqual([STANDING_TAG, "y"]);
  });

  it("keeps a quarantine tag an update tries to drop", () => {
    expect(applyTagReplacement([`${QUARANTINE_TAG_PREFIX}instruction`, "x"], ["y"])).toEqual([`${QUARANTINE_TAG_PREFIX}instruction`, "y"]);
  });
});

describe("every T7 and trust-tag namespace is never a digest or insight topic", () => {
  it("isReservedTag and isTopicTag agree on the TS side", () => {
    for (const prefix of ALL_NEW_PREFIXES) {
      const tag = `${prefix}sample`;
      expect(isReservedTag(tag), tag).toBe(true);
      expect(isTopicTag(tag), tag).toBe(false);
    }
    for (const name of ALL_NEW_NAMES) {
      expect(isTopicTag(name), name).toBe(false);
    }
  });

  it("isTopicTagSql excludes each sample on real SQLite", () => {
    const db = new DatabaseSync(":memory:");
    const samples = [...ALL_NEW_PREFIXES.map(p => `${p}sample`), ...ALL_NEW_NAMES];
    const stmt = db.prepare(`SELECT value FROM json_each(?) WHERE ${isTopicTagSql()}`);
    const rows = stmt.all(JSON.stringify(samples)) as { value: string }[];
    expect(rows.map(r => r.value)).toEqual([]);
  });
});

describe("case-insensitive in both lists", () => {
  it("Standing:Active and OWED-TO-ME are still reserved", () => {
    expect(isWorkerOwnedTag("Standing:Active")).toBe(true);
    expect(isWorkerOwnedTag("OWED-TO-ME")).toBe(true);
    expect(isReservedTag("Standing:Active")).toBe(true);
    expect(isTopicTag("OWED-TO-ME")).toBe(false);
  });
});

describe("the dashboard hides every T7 and trust tag as a system tag, when its value matches the system's own format", () => {
  // Codex cross-vendor review, MINOR (T-0102): a bare "sample" suffix is not
  // itself a value the system ever writes, so isSystemTag now correctly
  // shows it as an ordinary tag rather than hiding it (isRecognizedReservedTagFormat,
  // src/tags/system.ts). Realistic values are used here instead.
  const REALISTIC_VALUES = [
    `${QUARANTINE_TAG_PREFIX}instruction`,
    `${EDITED_CANONICAL_TAG_PREFIX}2026-09-26`,
    STANDING_TAG,
    LEDGER_TAG,
  ];

  it("isSystemTag is true for a realistic value of each trust and ledger/standing tag", () => {
    const { isSystemTag } = loadUtils();
    for (const value of REALISTIC_VALUES) expect(isSystemTag(value), value).toBe(true);
    for (const name of ALL_NEW_NAMES) expect(isSystemTag(name), name).toBe(true);
  });

  it("isSystemTag is true for a realistic value of every remaining T7 prefix", () => {
    const { isSystemTag } = loadUtils();
    const realistic: Record<string, string> = {
      "confidence:": "confidence:0.70",
      "confidence-source:": "confidence-source:stated",
      "outcome:": "outcome:right",
      "review-rearms:": "review-rearms:1",
      "counterparty:": "counterparty:priya",
    };
    for (const [prefix, value] of Object.entries(realistic)) {
      expect(T7_TAG_PREFIXES as readonly string[], prefix).toContain(prefix);
      expect(isSystemTag(value), value).toBe(true);
    }
  });

  it("a bare prefix-shaped placeholder that is NOT a real system value is NOT hidden", () => {
    const { isSystemTag } = loadUtils();
    // counterparty: accepts any grammar-valid slug by design (Design 1.1: "the
    // PROJECT_SLUG_RE grammar"), and "sample" is one, so it is correctly
    // recognized -- excluded here, not a special case in the guard itself.
    for (const prefix of ALL_NEW_PREFIXES) {
      if (prefix === COUNTERPARTY_TAG_PREFIX) continue;
      expect(isSystemTag(`${prefix}sample`), prefix).toBe(false);
    }
    expect(isSystemTag(`${COUNTERPARTY_TAG_PREFIX}has space`)).toBe(false);
  });

  it("a pre-existing user tag that merely looks like a reserved namespace stays a normal tag", () => {
    // Rahil's own examples from the review: outcome:won, confidence:high.
    const { isSystemTag, humanTags } = loadUtils();
    expect(isSystemTag("outcome:won")).toBe(false);
    expect(isSystemTag("confidence:high")).toBe(false);
    expect(humanTags(["outcome:won", "confidence:high", "work"])).toEqual(["outcome:won", "confidence:high", "work"]);
  });
});

describe("project aliases cannot use a T7 namespace", () => {
  it("rejects counterparty:x as an alias", async () => {
    await expect(createProject({} as any, "ws", { name: "P", aliases: [`${COUNTERPARTY_TAG_PREFIX}x`] }))
      .rejects.toThrow(InvalidProjectInputError);
  });
});

describe("system.ts reserved set is a subset of eligibility's, except the documented differences", () => {
  // The allow-list this generic check guards: any OTHER divergence -- past,
  // present or a future Track 4 addition landing in one list and not the
  // other -- fails this test.
  const SYSTEM_ONLY_DOCUMENTED = new Set(["stale:"]);
  const ELIGIBILITY_ONLY_DOCUMENTED = new Set(["stale:as-of", "project:"]);

  it("has no undocumented divergence", () => {
    const systemOnly = [...SYSTEM_SET].filter(p => !ELIGIBILITY_SET.has(p));
    const eligibilityOnly = [...ELIGIBILITY_SET].filter(p => !SYSTEM_SET.has(p));
    expect(systemOnly.filter(p => !SYSTEM_ONLY_DOCUMENTED.has(p))).toEqual([]);
    expect(eligibilityOnly.filter(p => !ELIGIBILITY_ONLY_DOCUMENTED.has(p))).toEqual([]);
  });

  it("every T7 and trust-tag prefix landed in both lists", () => {
    for (const prefix of ALL_NEW_PREFIXES) {
      expect(SYSTEM_SET.has(prefix), `system.ts missing ${prefix}`).toBe(true);
      expect(ELIGIBILITY_SET.has(prefix), `eligibility.ts missing ${prefix}`).toBe(true);
    }
  });
});

describe("stripT7CallerTags", () => {
  it("removes every T7 tag and reports it, keeping ordinary tags", () => {
    const input = ["work", STANDING_TAG, `${COUNTERPARTY_TAG_PREFIX}priya`, OWED_TO_ME_TAG, "idea"];
    const { kept, ignored } = stripT7CallerTags(input);
    expect(kept).toEqual(["work", "idea"]);
    expect(ignored).toEqual([STANDING_TAG, `${COUNTERPARTY_TAG_PREFIX}priya`, OWED_TO_ME_TAG]);
  });

  it("is case-insensitive and trims", () => {
    const { kept, ignored } = stripT7CallerTags([" Standing:Active ", "OWED-TO-ME"]);
    expect(kept).toEqual([]);
    expect(ignored).toEqual(["Standing:Active", "OWED-TO-ME"]);
  });

  it("leaves the bare words decision and standing alone -- they are not T7 tags", () => {
    const { kept, ignored } = stripT7CallerTags(["decision", "standing"]);
    expect(kept).toEqual(["decision", "standing"]);
    expect(ignored).toEqual([]);
  });
});

describe("inferQueryTags never proposes a T7 tag", () => {
  it("skips a vocabulary tag in a T7 namespace or the bare marker", async () => {
    const db = makeTestDb();
    db.entries.push({
      id: "e1",
      content: "Note about what Priya owes me for the standing meeting",
      tags: `["${COUNTERPARTY_TAG_PREFIX}priya","${OWED_TO_ME_TAG}","${STANDING_TAG}"]`,
      source: "api",
      created_at: 1000,
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 0,
    });
    const env = makeTestEnv(db);
    const tags = await inferQueryTags("what does priya owe me about the standing meeting", env);
    expect(tags).not.toContain(`${COUNTERPARTY_TAG_PREFIX}priya`);
    expect(tags).not.toContain(OWED_TO_ME_TAG);
    expect(tags).not.toContain(STANDING_TAG);
  });
});

describe("P7.2: the bare words are ordinary tags, not reserved namespaces", () => {
  it("isWorkerOwnedTag('decision') and ('standing') are false", () => {
    expect(isWorkerOwnedTag("decision")).toBe(false);
    expect(isWorkerOwnedTag("standing")).toBe(false);
  });

  it("isTopicTag treats them as ordinary topics", () => {
    expect(isTopicTag("decision")).toBe(true);
    expect(isTopicTag("standing")).toBe(true);
  });

  it("T7_TAG_NAMES holds only the bare inbound-commitment marker", () => {
    expect(T7_TAG_NAMES.has("decision")).toBe(false);
    expect(T7_TAG_NAMES.has("standing")).toBe(false);
    expect(T7_TAG_NAMES.has(OWED_TO_ME_TAG)).toBe(true);
  });
});
