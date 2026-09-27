import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanTemp } from "../helpers/tmp";

afterEach(cleanTemp);

const HOOKS = resolve(import.meta.dirname, "../../integrations/cursor-hooks");
const hasBash = process.platform !== "win32" && spawnSync("bash", ["--version"]).status === 0;

describe.skipIf(!hasBash)("integrations/cursor-hooks/install.sh", () => {
  let home: string;
  let hooksFile: string;
  let config: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sb-cursor-install-"));
    hooksFile = join(home, ".cursor", "hooks.json");
    config = join(home, ".config", "second-brain", "config.json");
  });

  // stdin is closed so a missing-argument prompt can never hang the suite.
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync("bash", [join(HOOKS, "install.sh"), ...args], {
      env: { PATH: process.env.PATH!, HOME: home, ...env } as unknown as NodeJS.ProcessEnv, // wrangler's types make AUTH_TOKEN required; the installer must not inherit it
      stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    });
  const read = () => JSON.parse(readFileSync(hooksFile, "utf8"));

  it("writes all four hook entries, and no token anywhere in hooks.json", () => {
    const r = run(["https://w.example/", "tok"]);
    expect(r.status, r.stderr).toBe(0);
    const s = read();
    expect(s.version).toBe(1);
    expect(s.hooks.sessionStart).toHaveLength(1);
    expect(s.hooks.sessionStart[0].command).toMatch(/^node ".*\/cursor-hooks\/session-start\.js"$/);
    expect(s.hooks.beforeSubmitPrompt).toHaveLength(1);
    expect(s.hooks.beforeSubmitPrompt[0].command).toMatch(/^node ".*\/cursor-hooks\/before-submit-prompt\.js"$/);
    expect(s.hooks.sessionEnd).toHaveLength(1);
    expect(s.hooks.sessionEnd[0].command).toMatch(/^node ".*\/cursor-hooks\/session-end\.js"$/);
    expect(s.hooks.stop).toHaveLength(1);
    expect(s.hooks.stop[0].command).toMatch(/^node ".*\/cursor-hooks\/session-end\.js"$/);
    expect(readFileSync(hooksFile, "utf8")).not.toContain("tok");
    // Credentials live in the CLI's shared file, mode 600, trailing slash stripped.
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ workerUrl: "https://w.example", authToken: "tok" });
    expect(statSync(config).mode & 0o777).toBe(0o600);
  });

  it("is idempotent: re-running does not duplicate entries", () => {
    expect(run(["https://w.example", "tok"]).status).toBe(0);
    expect(run(["https://w.example", "tok"]).status).toBe(0);
    const s = read();
    expect(s.hooks.sessionStart).toHaveLength(1);
    expect(s.hooks.beforeSubmitPrompt).toHaveLength(1);
    expect(s.hooks.sessionEnd).toHaveLength(1);
    expect(s.hooks.stop).toHaveLength(1);
  });

  it("preserves an existing hooks.json's other entries and events", () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(hooksFile, JSON.stringify({
      version: 1,
      hooks: {
        sessionStart: [{ command: "echo someone-elses-hook" }],
        preToolUse: [{ command: "echo keep-this-too" }],
      },
    }));
    expect(run(["https://w.example", "tok"]).status).toBe(0);
    const s = read();
    expect(s.hooks.sessionStart.filter((e: any) => e.command.includes("someone-elses-hook"))).toHaveLength(1);
    expect(s.hooks.sessionStart.filter((e: any) => e.command.includes("session-start.js"))).toHaveLength(1);
    expect(s.hooks.preToolUse).toEqual([{ command: "echo keep-this-too" }]);
  });

  it("refuses a malformed hooks.json and leaves it untouched", () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const broken = '{ "hooks": { "sessionStart": [] }, }\n';
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
    expect(read().hooks.sessionEnd).toHaveLength(1);
  });

  it("exits 2 instead of prompting when there is no TTY and no credentials", () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(existsSync(hooksFile)).toBe(false);
  });

  it("--uninstall removes only our entries", () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(hooksFile, JSON.stringify({ hooks: { sessionStart: [{ command: "echo keep-me" }] } }));
    expect(run(["https://w.example", "tok"]).status).toBe(0);
    expect(run(["--uninstall"]).status).toBe(0);
    const s = read();
    expect(s.hooks.sessionStart).toHaveLength(1);
    expect(s.hooks.sessionStart[0].command).toBe("echo keep-me");
    expect(s.hooks.beforeSubmitPrompt).toBeUndefined();
    expect(s.hooks.sessionEnd).toBeUndefined();
    expect(s.hooks.stop).toBeUndefined();
  });

  it("backs up the previous file before writing", () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(hooksFile, JSON.stringify({ hooks: {} }));
    expect(run(["https://w.example", "tok"]).status).toBe(0);
    const backups = require("node:fs").readdirSync(join(home, ".cursor")).filter((f: string) => f.startsWith("hooks.json.bak-"));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  it("never touches the real home directory", () => {
    const real = join(process.env.HOME!, ".cursor", "hooks.json");
    const before = existsSync(real) ? statSync(real).mtimeMs : null;
    run(["https://w.example", "tok"]);
    expect(existsSync(real) ? statSync(real).mtimeMs : null).toBe(before);
  });
});
