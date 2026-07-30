/**
 * The app version lives in four files that must agree, and nothing but habit
 * kept them aligned.
 *
 * They drift in ways that are quiet and expensive. tauri.conf.json is what the
 * built app reports and what the updater compares against; Cargo.toml is what
 * `cargo` stamps into the binary; installer/package.json is what npm sees; and
 * Cargo.lock is regenerated from Cargo.toml, so a bump that forgets `cargo
 * update` leaves the lockfile behind and the next build rewrites it as an
 * unrelated diff.
 *
 * scripts/release.mjs writes the first three and runs cargo update for the
 * fourth. This test is what makes that the only correct path — a hand-edited
 * bump that misses a file fails CI on the branch rather than at release time.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const SEMVER = /^\d+\.\d+\.\d+$/;

function tauriConfVersion(): string {
  return JSON.parse(read("installer/src-tauri/tauri.conf.json")).version;
}

function installerPkgVersion(): string {
  return JSON.parse(read("installer/package.json")).version;
}

function cargoTomlVersion(): string {
  const m = read("installer/src-tauri/Cargo.toml").match(/^version = "([^"]+)"/m);
  if (!m) throw new Error("no version in installer/src-tauri/Cargo.toml");
  return m[1];
}

/** The version recorded for our own crate, not one of its dependencies. */
function cargoLockVersion(): string {
  const lock = read("installer/src-tauri/Cargo.lock");
  const m = lock.match(/name = "second-brain-desktop"\nversion = "([^"]+)"/);
  if (!m) throw new Error("second-brain-desktop not found in Cargo.lock");
  return m[1];
}

function workerVersion(): string {
  const m = read("src/env.ts").match(/SB_VERSION\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("no SB_VERSION in src/env.ts");
  return m[1];
}

describe("desktop app version is consistent", () => {
  const sources: [string, () => string][] = [
    ["installer/src-tauri/tauri.conf.json", tauriConfVersion],
    ["installer/package.json", installerPkgVersion],
    ["installer/src-tauri/Cargo.toml", cargoTomlVersion],
    ["installer/src-tauri/Cargo.lock", cargoLockVersion],
  ];

  it("every file carries the same version", () => {
    const found = sources.map(([name, get]) => [name, get()] as const);
    const distinct = [...new Set(found.map(([, v]) => v))];
    expect(
      distinct.length,
      `app version differs across files:\n${found.map(([n, v]) => `  ${v}  ${n}`).join("\n")}\n` +
        "Bump with `npm run deploy:app -- <version|patch|minor|major>`, which writes all four.",
    ).toBe(1);
  });

  for (const [name, get] of sources) {
    it(`${name} holds a plain semver`, () => {
      expect(get()).toMatch(SEMVER);
    });
  }
});

describe("Worker version", () => {
  it("SB_VERSION is a plain semver", () => {
    expect(workerVersion()).toMatch(SEMVER);
  });

  /**
   * The two tracks are deliberately independent — the Worker and the desktop app
   * ship separately — so this does NOT assert they match. It asserts only that
   * SB_VERSION exists and parses, because the desktop app compares it against
   * the deployed Worker to offer a one-click update, and a malformed value makes
   * that comparison silently meaningless.
   */
  it("is readable by the update check that compares it", () => {
    const [major, minor, patch] = workerVersion().split(".").map(Number);
    expect(Number.isInteger(major)).toBe(true);
    expect(Number.isInteger(minor)).toBe(true);
    expect(Number.isInteger(patch)).toBe(true);
  });
});

describe("release tooling stays the single path", () => {
  it("release.mjs still writes every app-version file this test checks", () => {
    const script = read("scripts/release.mjs");
    for (const f of ["tauri.conf.json", "installer/package.json", "Cargo.toml"]) {
      expect(script, `release.mjs no longer writes ${f}`).toContain(f);
    }
    // Cargo.lock is derived, so the script must run cargo rather than edit it.
    expect(script).toContain("cargo update -p second-brain-desktop");
  });
});
