/**
 * Trash retention and versions kept, in agreement everywhere (contract 4.6,
 * 13-ux-build-spec.md section 4.6).
 *
 * Two surfaces write the same two Worker config keys: the dashboard settings
 * panel here, and the desktop app's Advanced Settings "History and trash"
 * window (installer/src-tauri/src/settings.rs, T-0101.4.3). Whichever lane
 * lands first creates this file; the other extends it — this copy checks its
 * own dashboard half unconditionally, and checks the desktop half only once
 * settings.rs actually declares it, so a not-yet-merged desktop lane shows as
 * a visible skip rather than a false pass or a hard failure.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const CONTRACT = {
  TRASH_RETENTION_DAYS: { choices: [7, 14, 30, 90], default: 14, min: 1, max: 365 },
  VERSION_KEEP: { choices: [10, 20, 50], default: 20, min: 5, max: 500 },
} as const;

/**
 * The dashboard's choice list, read from its own source rather than rendered
 * markup: the selects are populated at runtime (renderSettingsOptions), so
 * public/index.html's <select> elements carry no static <option> tags.
 */
function dashboardChoices(key: string): number[] {
  const src = read("public/js/settings-panel.js");
  const m = src.match(new RegExp(`${key}:\\s*\\[([^\\]]+)\\]`));
  if (!m) throw new Error(`SETTINGS_CHOICES.${key} not found in public/js/settings-panel.js`);
  return m[1].split(",").map((s) => Number(s.trim()));
}

/** RULES[key], read as text — the same technique version-consistency.test.ts uses for Cargo files. */
function ruleRange(key: string): { min: number; max: number } {
  const src = read("src/config.ts");
  const m = src.match(new RegExp(`${key}:\\s*\\{\\s*kind:\\s*"number",\\s*min:\\s*(\\d+),\\s*max:\\s*(\\d+)`));
  if (!m) throw new Error(`RULES.${key} not found in src/config.ts`);
  return { min: Number(m[1]), max: Number(m[2]) };
}

function shippedDefault(key: string): number {
  const src = read("src/config.ts");
  const m = src.match(new RegExp(`^\\s*${key}:\\s*(\\d+),`, "m"));
  if (!m) throw new Error(`DEFAULTS.${key} not found in src/config.ts`);
  return Number(m[1]);
}

describe("history/trash settings parity (contract 4.6)", () => {
  for (const [key, expected] of Object.entries(CONTRACT)) {
    describe(key, () => {
      it("the dashboard's choice list matches the contract, in order", () => {
        expect(dashboardChoices(key)).toEqual(expected.choices);
      });

      it("every choice sits inside the Worker's enforced RULES range", () => {
        const range = ruleRange(key);
        expect(range).toEqual({ min: expected.min, max: expected.max });
        for (const choice of expected.choices) {
          expect(choice).toBeGreaterThanOrEqual(range.min);
          expect(choice).toBeLessThanOrEqual(range.max);
        }
      });

      it("the contract's default equals the Worker's shipped DEFAULTS", () => {
        expect(shippedDefault(key)).toBe(expected.default);
      });
    });
  }

  const settingsRs = read("installer/src-tauri/src/settings.rs");
  const desktopHasLanded = settingsRs.includes('id: "trash"') && settingsRs.includes('id: "versions"');
  const maybeIt = desktopHasLanded ? it : it.skip;

  maybeIt(
    "the desktop app's 'History and trash' controls (T-0101.4.3) match the same contract",
    () => {
      const trashBlock = settingsRs.match(/id:\s*"trash",[\s\S]*?\n {4}\},/)?.[0] ?? "";
      const versionsBlock = settingsRs.match(/id:\s*"versions",[\s\S]*?\n {4}\},/)?.[0] ?? "";
      expect(trashBlock, "Control \"trash\" not found in settings.rs").not.toBe("");
      expect(versionsBlock, "Control \"versions\" not found in settings.rs").not.toBe("");

      const trashChoices = [...trashBlock.matchAll(/"TRASH_RETENTION_DAYS"\s*=>\s*(\d+)/g)].map((m) => Number(m[1]));
      const versionChoices = [...versionsBlock.matchAll(/"VERSION_KEEP"\s*=>\s*(\d+)/g)].map((m) => Number(m[1]));
      expect(trashChoices).toEqual(CONTRACT.TRASH_RETENTION_DAYS.choices);
      expect(versionChoices).toEqual(CONTRACT.VERSION_KEEP.choices);

      const defaultLevels = settingsRs.match(/DEFAULT_LEVELS:[\s\S]*?\];/)?.[0] ?? "";
      const trashDefaultLevel = defaultLevels.match(/\("trash",\s*"(\w+)"\)/)?.[1];
      const versionsDefaultLevel = defaultLevels.match(/\("versions",\s*"(\w+)"\)/)?.[1];
      expect(trashDefaultLevel, "no DEFAULT_LEVELS entry for \"trash\"").toBeTruthy();
      expect(versionsDefaultLevel, "no DEFAULT_LEVELS entry for \"versions\"").toBeTruthy();
      expect(trashBlock).toContain(`lvl!("${trashDefaultLevel}", "TRASH_RETENTION_DAYS" => ${CONTRACT.TRASH_RETENTION_DAYS.default})`);
      expect(versionsBlock).toContain(`lvl!("${versionsDefaultLevel}", "VERSION_KEEP" => ${CONTRACT.VERSION_KEEP.default})`);
    },
  );
});
