import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const updateWorkflow = readFileSync(".github/workflows/upstream-release-update.yml", "utf8");
const deployWorkflow = readFileSync(".github/workflows/deploy-cloudflare.yml", "utf8");

describe("upstream release workflow safety", () => {
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
});
