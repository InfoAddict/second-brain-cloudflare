import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanTemp } from "../helpers/tmp";

afterEach(cleanTemp);

const HOOKS = resolve(import.meta.dirname, "../../integrations/vscode-copilot-hooks");
const hasBash = process.platform !== "win32" && spawnSync("bash", ["--version"]).status === 0;

describe.skipIf(!hasBash)("integrations/vscode-copilot-hooks/install.sh", () => {
  let home: string;
  let hooksFile: string;
  let config: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sb-vscode-install-"));
    hooksFile = join(home, ".copilot", "hooks", "second-brain.json");
    config = join(home, ".config", "second-brain", "config.json");
  });

  // stdin is closed so a missing-argument prompt can never hang the suite.
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync("bash", [join(HOOKS, "install.sh"), ...args], {
      env: { PATH: process.env.PATH!, HOME: home, ...env } as unknown as NodeJS.ProcessEnv, // wrangler's types make AUTH_TOKEN required; the installer must not inherit it
      stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    });
  const read = () => JSON.parse(readFileSync(hooksFile, "utf8"));

  it("writes the SessionStart hook and no token anywhere in the hooks file", () => {
    const r = run(["https://w.example/", "tok"]);
    expect(r.status, r.stderr).toBe(0);
    const s = read();
    expect(s.SessionStart).toHaveLength(1);
    expect(s.SessionStart[0].hooks[0].type).toBe("command");
    expect(s.SessionStart[0].hooks[0].command).toMatch(/^node ".*\/vscode-copilot-hooks\/session-start\.js"$/);
    expect(readFileSync(hooksFile, "utf8")).not.toContain("tok");
    // Credentials live in the shared config file, mode 600, trailing slash stripped.
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ workerUrl: "https://w.example", authToken: "tok" });
    expect(statSync(config).mode & 0o777).toBe(0o600);
  });

  it("is idempotent: re-running replaces our entry instead of duplicating it", () => {
    expect(run(["https://w.example", "tok"]).status).toBe(0);
    expect(run(["https://w.example", "tok"]).status).toBe(0);
    const s = read();
    expect(s.SessionStart).toHaveLength(1);
  });

  it("preserves an unrelated entry already in the hooks file", () => {
    mkdirSync(join(home, ".copilot", "hooks"), { recursive: true });
    writeFileSync(hooksFile, JSON.stringify({
      SessionStart: [{ hooks: [{ type: "command", command: "echo someone-elses-hook" }] }],
      PreToolUse: [{ hooks: [{ type: "command", command: "echo untouched" }] }],
    }));
    expect(run(["https://w.example", "tok"]).status).toBe(0);
    const s = read();
    expect(s.SessionStart).toHaveLength(2);
    expect(s.SessionStart.filter((e: any) => e.hooks[0].command.includes("someone-elses-hook"))).toHaveLength(1);
    expect(s.SessionStart.filter((e: any) => e.hooks[0].command.includes("session-start.js"))).toHaveLength(1);
    expect(s.PreToolUse).toEqual([{ hooks: [{ type: "command", command: "echo untouched" }] }]);
  });

  it("refuses a malformed hooks file and leaves it untouched", () => {
    mkdirSync(join(home, ".copilot", "hooks"), { recursive: true });
    const broken = '{ "SessionStart": [ }\n';
    writeFileSync(hooksFile, broken);
    const r = run(["https://w.example", "tok"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not valid JSON");
    expect(readFileSync(hooksFile, "utf8")).toBe(broken);
  });

  it("backs up the hooks file before writing to it", () => {
    mkdirSync(join(home, ".copilot", "hooks"), { recursive: true });
    writeFileSync(hooksFile, JSON.stringify({ SessionStart: [{ hooks: [{ type: "command", command: "echo keep-me" }] }] }));
    expect(run(["https://w.example", "tok"]).status).toBe(0);
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const backups = readdirSync(join(home, ".copilot", "hooks")).filter((f) => f.startsWith("second-brain.json.bak-"));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  it("reuses an existing config file when called with no arguments", () => {
    mkdirSync(join(home, ".config", "second-brain"), { recursive: true });
    writeFileSync(config, JSON.stringify({ workerUrl: "https://w.example", authToken: "tok" }));
    const r = run([]);
    expect(r.status, r.stderr).toBe(0);
    expect(read().SessionStart).toHaveLength(1);
  });

  it("exits 2 instead of prompting when there is no TTY and no credentials", () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(existsSync(hooksFile)).toBe(false);
  });

  it("--check reports the hook as installed only after install.sh has run", () => {
    expect(run(["--check"]).status).toBe(1);
    expect(run(["https://w.example", "tok"]).status).toBe(0);
  });

  it("--uninstall removes only our entry", () => {
    mkdirSync(join(home, ".copilot", "hooks"), { recursive: true });
    writeFileSync(hooksFile, JSON.stringify({ SessionStart: [{ hooks: [{ type: "command", command: "echo keep-me" }] }] }));
    expect(run(["https://w.example", "tok"]).status).toBe(0);
    expect(run(["--uninstall"]).status).toBe(0);
    const s = read();
    expect(s.SessionStart).toHaveLength(1);
    expect(s.SessionStart[0].hooks[0].command).toBe("echo keep-me");
  });

  it("--uninstall leaves credentials in place", () => {
    expect(run(["https://w.example", "tok"]).status).toBe(0);
    expect(run(["--uninstall"]).status).toBe(0);
    expect(existsSync(config)).toBe(true);
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ workerUrl: "https://w.example", authToken: "tok" });
  });

  it("never touches the real home directory", () => {
    const real = join(process.env.HOME!, ".copilot", "hooks", "second-brain.json");
    const before = existsSync(real) ? statSync(real).mtimeMs : null;
    run(["https://w.example", "tok"]);
    expect(existsSync(real) ? statSync(real).mtimeMs : null).toBe(before);
  });
});
