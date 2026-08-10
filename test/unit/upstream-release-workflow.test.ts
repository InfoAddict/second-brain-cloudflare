import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const updateWorkflow = readFileSync(".github/workflows/upstream-release-update.yml", "utf8");
const deployWorkflow = readFileSync(".github/workflows/deploy-cloudflare.yml", "utf8");

describe("upstream release workflow safety", () => {
  it("tracks installer releases by their bundled Worker version", () => {
    expect(updateWorkflow).toContain("^installer-v[0-9]+");
    expect(updateWorkflow).toContain('git show "${SOURCE_TAG}:src/env.ts"');
    expect(updateWorkflow).toContain("SB_VERSION");
    expect(updateWorkflow).toContain('release_tag="v${worker_version}"');
    expect(updateWorkflow).toContain("Current branch already reports Worker v${current_version}.");
  });

  it("refuses to deploy an older upstream Worker", () => {
    expect(updateWorkflow).toContain("sort -V");
    expect(updateWorkflow).toContain("refusing to downgrade");
  });

  it("only reports an update as applied after the tested branch reaches main", () => {
    expect(updateWorkflow).toContain("update_applied: ${{ steps.publish.outputs.applied }}");
    expect(updateWorkflow).toContain('echo "applied=true" >> "$GITHUB_OUTPUT"');
    expect(updateWorkflow).not.toContain("update_applied: ${{ steps.update.outputs.needed }}");
    expect(updateWorkflow).toContain("run: npm run predeploy");
    expect(updateWorkflow).toContain("run: npx wrangler deploy --dry-run");
  });

  it("turns merge conflicts into a draft PR without deploying them", () => {
    expect(updateWorkflow).toContain("git checkout --ours --");
    expect(updateWorkflow).toContain("gh pr create");
    expect(updateWorkflow).toContain("--draft");
    expect(updateWorkflow).toContain("steps.merge.outputs.blocked != 'true'");
    expect(updateWorkflow).toContain("Main and the live Worker were not changed.");
  });

  it("emails a newly blocked release and leaves repeat runs deduplicated", () => {
    expect(updateWorkflow).toContain("conflict_pr_created");
    expect(updateWorkflow).toContain("notification_status=\"blocked\"");
    expect(updateWorkflow).toContain("needs.update-from-upstream-release.outputs.conflict_pr_created == 'true'");
  });

  it("marks a blocked release run as failed after notification", () => {
    expect(updateWorkflow).toContain("mark-upstream-release-blocked:");
    expect(updateWorkflow).toContain("requires conflict resolution");
  });

  it("does not deploy a clean upstream push twice", () => {
    expect(updateWorkflow).toContain('Upstream-Deployment: reusable');
    expect(deployWorkflow).toContain("!contains(github.event.head_commit.message, 'Upstream-Deployment: reusable')");
  });

  it("parses the shared JSONC config before injecting deployment IDs", () => {
    expect(deployWorkflow).toContain("node scripts/write-deploy-config.mjs wrangler.jsonc wrangler.deploy.json");
    expect(deployWorkflow).not.toContain("wrangler.jsonc > wrangler.deploy.json");
  });
});
