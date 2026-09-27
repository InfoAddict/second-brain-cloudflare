import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanTemp } from "../helpers/tmp";

afterEach(cleanTemp);

const HOOKS = resolve(import.meta.dirname, "../../integrations/gemini-cli-hooks");
const hasBash = process.platform !== "win32" && spawnSync("bash", ["--version"]).status === 0;

describe.skipIf(!hasBash)("integrations/gemini-cli-hooks/install.sh", () => {
  let home: string;
  let settings: string;
  let config: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sb-install-"));
    settings = join(home, ".gemini", "settings.json");
    config = join(home, ".config", "second-brain", "config.json");
  });

  // stdin is closed so a missing-argument prompt can never hang the suite.
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync("bash", [join(HOOKS, "install.sh"), ...args], {
      env: { PATH: process.env.PATH!, HOME: home, ...env } as unknown as NodeJS.ProcessEnv, // wrangler's types make AUTH_TOKEN required; the installer must not inherit it
      stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    });
  const read = () => JSON.parse(readFileSync(settings, "utf8"));

  it("writes the hook with a timeout and no token anywhere in settings.json", () => {
    const r = run(["https://w.example/", "tok"]);
    expect(r.status, r.stderr).toBe(0);
    const s = read();
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.SessionStart[0].hooks[0].command).toMatch(/^node ".*\/gemini-cli-hooks\/session-start\.js"$/);
    expect(s.hooks.SessionStart[0].hooks[0].timeout).toBeGreaterThanOrEqual(4000);
    // No SessionEnd half - this adapter is SessionStart injection only.
    expect(s.hooks.SessionEnd).toBeUndefined();
    expect(readFileSync(settings, "utf8")).not.toContain("tok");
    // Credentials live in the shared file, mode 600, trailing slash stripped.
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ workerUrl: "https://w.example", authToken: "tok" });
    expect(statSync(config).mode & 0o777).toBe(0o600);
  });

  it("is idempotent and replaces a prior install in place, preserving unrelated settings", () => {
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(settings, JSON.stringify({
      someOtherSetting: true,
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "SECOND_BRAIN_URL=x SECOND_BRAIN_TOKEN=y node /old/checkout/integrations/gemini-cli-hooks/session-start.js" }] },
          { hooks: [{ type: "command", command: "echo someone-elses-hook" }] },
        ],
      },
    }));
    expect(run(["https://w.example", "tok"]).status).toBe(0);
    expect(run(["https://w.example", "tok"]).status).toBe(0);
    const s = read();
    expect(s.someOtherSetting).toBe(true);
    expect(s.hooks.SessionStart).toHaveLength(2);
    expect(s.hooks.SessionStart.filter((e: any) => e.hooks[0].command.includes("someone-elses-hook"))).toHaveLength(1);
    expect(s.hooks.SessionStart.filter((e: any) => e.hooks[0].command.includes("session-start.js"))).toHaveLength(1);
  });

  it("refuses a malformed settings.json and leaves it untouched", () => {
    mkdirSync(join(home, ".gemini"), { recursive: true });
    const broken = '{ "someOtherSetting": true, }\n';
    writeFileSync(settings, broken);
    const r = run(["https://w.example", "tok"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not valid JSON");
    expect(readFileSync(settings, "utf8")).toBe(broken);
  });

  it("reuses an existing config file when called with no arguments", () => {
    mkdirSync(join(home, ".config", "second-brain"), { recursive: true });
    writeFileSync(config, JSON.stringify({ workerUrl: "https://w.example", authToken: "tok" }));
    const r = run([]);
    expect(r.status, r.stderr).toBe(0);
    expect(read().hooks.SessionStart).toHaveLength(1);
  });

  it("exits 2 instead of prompting when there is no TTY and no credentials", () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(existsSync(settings)).toBe(false);
  });

  it("--uninstall removes only our entry", () => {
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo keep-me" }] }] } }));
    expect(run(["https://w.example", "tok"]).status).toBe(0);
    expect(run(["--uninstall"]).status).toBe(0);
    const s = read();
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe("echo keep-me");
  });

  it("never touches the real home directory", () => {
    const real = join(process.env.HOME!, ".gemini", "settings.json");
    const before = existsSync(real) ? statSync(real).mtimeMs : null;
    run(["https://w.example", "tok"]);
    expect(existsSync(real) ? statSync(real).mtimeMs : null).toBe(before);
  });

  it("honours GEMINI_SETTINGS_FILE for a project-scoped file", () => {
    const projectSettings = join(home, "project", ".gemini", "settings.json");
    mkdirSync(join(home, "project", ".gemini"), { recursive: true });
    const r = run(["https://w.example", "tok"], { GEMINI_SETTINGS_FILE: projectSettings });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(projectSettings, "utf8")).hooks.SessionStart).toHaveLength(1);
    expect(existsSync(settings)).toBe(false);
  });
});
