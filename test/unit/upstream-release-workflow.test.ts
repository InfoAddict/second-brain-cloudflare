import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SB_VERSION } from "../../src/env";

const updateWorkflow = readFileSync(".github/workflows/upstream-release-update.yml", "utf8");
const deployWorkflow = readFileSync(".github/workflows/deploy-cloudflare.yml", "utf8");
const releaseState = JSON.parse(readFileSync(".github/upstream-release.json", "utf8"));

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

  it("replays verified fork overlays and only blocks on unknown conflicts", () => {
    expect(updateWorkflow).toContain("node scripts/apply-fork-release-overlays.mjs");
    expect(updateWorkflow).toContain("overlay_conflicts");
    expect(updateWorkflow).toContain("manual_conflicts");
    expect(updateWorkflow).toContain('git checkout --theirs -- "${overlay_conflicts[@]}"');
    expect(updateWorkflow).toContain('if [[ "${#manual_conflicts[@]}" -eq 0 ]]');
  });

  it("preserves only fork-owned workflows while accepting upstream CI changes", () => {
    expect(updateWorkflow).toContain(".github/workflows/deploy-cloudflare.yml");
    expect(updateWorkflow).toContain(".github/workflows/upstream-release-update.yml");
    expect(updateWorkflow).not.toContain("-- .github/workflows\n");
  });

  it("emails a newly blocked release and leaves repeat runs deduplicated", () => {
    expect(updateWorkflow).toContain("conflict_pr_created");
    expect(updateWorkflow).toContain("notification_status=\"blocked\"");
    expect(updateWorkflow).toContain("needs.update-from-upstream-release.outputs.conflict_pr_created == 'true'");
  });

  it("records release metadata for clean and manually resolved updates", () => {
    expect(updateWorkflow).toContain("write_release_state()");
    expect(updateWorkflow.match(/write_release_state/g)).toHaveLength(3);
    expect(updateWorkflow).toContain(".github/upstream-release.json");
  });

  it("keeps release metadata consistent with the current Worker without pinning a release", () => {
    expect(SB_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(releaseState).toEqual({
      sourceTag: expect.stringMatching(/^(?:installer-v\d+\.\d+\.\d+|v?\d+\.\d+(?:\.\d+)?)$/),
      workerVersion: SB_VERSION,
      releaseTag: `v${SB_VERSION}`,
      releaseName: expect.stringMatching(/\S/),
      releaseUrl: `https://github.com/rahilp/second-brain-cloudflare/releases/tag/${releaseState.sourceTag}`,
    });

    // Desktop and Worker versions can differ, so derive each from its own source.
    if (releaseState.sourceTag.startsWith("installer-v")) {
      const desktopVersion = releaseState.sourceTag.slice("installer-v".length);
      expect(releaseState.releaseName).toBe(
        `Second Brain Worker v${SB_VERSION} (bundled with Desktop ${desktopVersion})`,
      );
    }
  });

  it("emails an applied result after a resolved release PR deploys", () => {
    expect(deployWorkflow).toContain("Email a manually resolved upstream release");
    expect(deployWorkflow).toContain("if: github.event_name == 'push'");
    expect(deployWorkflow).toContain('git show "${GITHUB_SHA}^1:${state_file}"');
    expect(deployWorkflow).toContain('if [[ "$current_state" == "$previous_state" ]]');
    expect(deployWorkflow).toContain('status: "applied"');
    expect(deployWorkflow).toContain("Recipient: dan@infoaddict.net");
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
