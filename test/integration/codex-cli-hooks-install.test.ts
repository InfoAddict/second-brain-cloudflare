import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanTemp } from "../helpers/tmp";

afterEach(cleanTemp);

const HOOKS = resolve(import.meta.dirname, "../../integrations/codex-cli-hooks");
const hasBash = process.platform !== "win32" && spawnSync("bash", ["--version"]).status === 0;

describe.skipIf(!hasBash)("integrations/codex-cli-hooks/install.sh", () => {
  let home: string;
  let hooksFile: string;
  let config: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sb-codex-install-"));
    hooksFile = join(home, ".codex", "hooks.json");
    config = join(home, ".config", "second-brain", "config.json");
  });

  // stdin is closed so a missing-argument prompt can never hang the suite.
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync("bash", [join(HOOKS, "install.sh"), ...args], {
      env: { PATH: process.env.PATH!, HOME: home, ...env } as unknown as NodeJS.ProcessEnv, // wrangler's types make AUTH_TOKEN required; the installer must not inherit it
      stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    });
  const read = () => JSON.parse(readFileSync(hooksFile, "utf8"));

  it("writes both hooks with a SessionEnd timeout, and no token anywhere in hooks.json", () => {
    const r = run(["https://w.example/", "tok"]);
    expect(r.status, r.stderr).toBe(0);
    const s = read();
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.SessionStart[0].hooks[0].command).toMatch(/^node ".*\/codex-cli-hooks\/session-start\.js"$/);
    expect(s.hooks.SessionEnd).toHaveLength(1);
    expect(s.hooks.SessionEnd[0].hooks[0].command).toMatch(/^node ".*\/codex-cli-hooks\/session-end\.js"$/);
    expect(s.hooks.SessionEnd[0].hooks[0].timeout).toBeGreaterThanOrEqual(3000);
    expect(readFileSync(hooksFile, "utf8")).not.toContain("tok");
    // Credentials live in the CLI's shared file, mode 600, trailing slash stripped.
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ workerUrl: "https://w.example", authToken: "tok" });
    expect(statSync(config).mode & 0o777).toBe(0o600);
  });

  it("is idempotent: re-running does not duplicate entries", () => {
    expect(run(["https://w.example", "tok"]).status).toBe(0);
    expect(run(["https://w.example", "tok"]).status).toBe(0);
    const s = read();
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.SessionEnd).toHaveLength(1);
  });

  it("preserves an unrelated existing entry and everything else in the file", () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(hooksFile, JSON.stringify({
      someOtherSetting: true,
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "echo someone-elses-hook" }] }],
      },
    }));
    expect(run(["https://w.example", "tok"]).status).toBe(0);
    const s = read();
    expect(s.someOtherSetting).toBe(true);
    expect(s.hooks.SessionStart).toHaveLength(2);
    expect(s.hooks.SessionStart.filter((e: any) => e.hooks[0].command.includes("someone-elses-hook"))).toHaveLength(1);
    expect(s.hooks.SessionStart.filter((e: any) => e.hooks[0].command.includes("session-start.js"))).toHaveLength(1);
  });

  it("refuses a malformed hooks.json and leaves it untouched", () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    const broken = '{ "hooks": { "SessionStart": [] }, }\n';
    writeFileSync(hooksFile, broken);
    const r = run(["https://w.example", "tok"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not valid JSON");
    expect(readFileSync(hooksFile, "utf8")).toBe(broken);
  });

  it("reuses an existing config file when called with no arguments", () => {
    mkdirSync(join(home, ".config", "second-brain"), { recursive: true });
    writeFileSync(config, JSON.stringify({ workerUrl: "https://w.example", authToken: "tok" }));
    const r = run([]);
    expect(r.status, r.stderr).toBe(0);
    expect(read().hooks.SessionEnd).toHaveLength(1);
  });

  it("exits 2 instead of prompting when there is no TTY and no credentials", () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(existsSync(hooksFile)).toBe(false);
  });

  it("--uninstall removes only our entries", () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(hooksFile, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo keep-me" }] }] } }));
    expect(run(["https://w.example", "tok"]).status).toBe(0);
    expect(run(["--uninstall"]).status).toBe(0);
    const s = read();
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe("echo keep-me");
    expect(s.hooks.SessionEnd).toBeUndefined();
  });

  it("never touches the real home directory", () => {
    const real = join(process.env.HOME!, ".codex", "hooks.json");
    const before = existsSync(real) ? statSync(real).mtimeMs : null;
    run(["https://w.example", "tok"]);
    expect(existsSync(real) ? statSync(real).mtimeMs : null).toBe(before);
  });

  it("respects CODEX_HOOKS_FILE for an alternate (e.g. project-level) location", () => {
    const altFile = join(home, "project", ".codex", "hooks.json");
    mkdirSync(join(home, "project", ".codex"), { recursive: true });
    const r = run(["https://w.example", "tok"], { CODEX_HOOKS_FILE: altFile });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(altFile, "utf8")).hooks.SessionStart).toHaveLength(1);
    expect(existsSync(hooksFile)).toBe(false);
  });
});
