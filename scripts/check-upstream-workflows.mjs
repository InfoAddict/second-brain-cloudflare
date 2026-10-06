import { execFileSync } from "node:child_process";

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

/**
 * Returns workflow files introduced, changed, or removed by the upstream
 * release itself. Fork-only workflow files are deliberately excluded.
 */
export function findUpstreamWorkflowChanges({ cwd = process.cwd(), head = "HEAD", sourceTag }) {
  if (!sourceTag) {
    throw new Error("A source tag is required.");
  }

  const mergeBase = git(cwd, ["merge-base", head, sourceTag]);
  const changed = git(cwd, [
    "diff",
    "--name-only",
    "--diff-filter=ACDMRT",
    mergeBase,
    sourceTag,
    "--",
    ".github/workflows",
  ]);

  return changed ? changed.split("\n") : [];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const path of findUpstreamWorkflowChanges({ sourceTag: process.argv[2] })) {
    console.log(path);
  }
}
