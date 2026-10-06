import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findUpstreamWorkflowChanges } from "../../scripts/check-upstream-workflows.mjs";

const repositories: string[] = [];

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(cwd: string, path: string, contents: string) {
  mkdirSync(join(cwd, path, ".."), { recursive: true });
  writeFileSync(join(cwd, path), contents);
}

function commit(cwd: string, message: string) {
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", message);
}

function createFixture() {
  const cwd = mkdtempSync(join(tmpdir(), "sb-upstream-workflow-"));
  repositories.push(cwd);
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "Workflow test");
  git(cwd, "config", "user.email", "workflow-test@example.test");
  write(cwd, "README.md", "base\n");
  write(cwd, ".github/workflows/existing.yml", "name: existing\n");
  commit(cwd, "base");
  const base = git(cwd, "rev-parse", "HEAD");

  git(cwd, "checkout", "-b", "upstream");
  return { base, cwd };
}

function finishUpstreamAndReturnToFork(cwd: string, base: string) {
  commit(cwd, "upstream release");
  git(cwd, "tag", "v4.0.0");
  git(cwd, "checkout", "-B", "main", base);
  write(cwd, "README.md", "fork-only change\n");
  commit(cwd, "fork change");
}

afterEach(() => {
  for (const cwd of repositories.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe("findUpstreamWorkflowChanges", () => {
  it.each([
    ["changed", (cwd: string) => write(cwd, ".github/workflows/existing.yml", "name: updated\n"), ".github/workflows/existing.yml"],
    ["added", (cwd: string) => write(cwd, ".github/workflows/ci.yml", "name: ci\n"), ".github/workflows/ci.yml"],
    ["deleted", (cwd: string) => rmSync(join(cwd, ".github/workflows/existing.yml")), ".github/workflows/existing.yml"],
  ])("reports upstream %s workflow files", (_kind, update, expected) => {
    const { base, cwd } = createFixture();
    update(cwd);
    finishUpstreamAndReturnToFork(cwd, base);

    expect(findUpstreamWorkflowChanges({ cwd, sourceTag: "v4.0.0" })).toEqual([expected]);
  });

  it("does not report a workflow added only by the fork", () => {
    const { base, cwd } = createFixture();
    write(cwd, "src/version.ts", "export const version = '4.0.0';\n");
    finishUpstreamAndReturnToFork(cwd, base);
    write(cwd, ".github/workflows/fork-only.yml", "name: fork only\n");
    commit(cwd, "fork workflow");

    expect(findUpstreamWorkflowChanges({ cwd, sourceTag: "v4.0.0" })).toEqual([]);
  });

  it("is clean when the upstream release does not change workflows", () => {
    const { base, cwd } = createFixture();
    write(cwd, "src/version.ts", "export const version = '4.0.0';\n");
    finishUpstreamAndReturnToFork(cwd, base);

    expect(findUpstreamWorkflowChanges({ cwd, sourceTag: "v4.0.0" })).toEqual([]);
  });
});
