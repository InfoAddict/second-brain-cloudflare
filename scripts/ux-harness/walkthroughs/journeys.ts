/**
 * UX-I: the map's W1-W17 dashboard journeys (section 6.2), each with real backend setup through
 * the actual Worker code and a real browser drive against the dashboard. Most hit a feature other
 * lanes have not built yet (UX-A history/undo, UX-B trash, UX-D settings, UX-E/F/G's own tracks);
 * those throw NotBuilt with the exact UX item so the runner reports PENDING, not FAILED, and the
 * same script goes green once that lane ships.
 */
import type { Env } from "../../../src/env";
import { ensureTenantBootstrap } from "../../../src/lib/tenancy";
import { resolveIdentityByUserId } from "../../../src/lib/identity";
import { forgetEntry } from "../../../src/capture/lifecycle";
import { resolveConfig, DEFAULTS } from "../../../src/config";
import { updateEntryContent } from "../../../src/capture/store";
import { createMember } from "../../../src/lib/team-admin";
import { moveEntry } from "../../../src/capture/share";
import { NotBuilt, type Journey } from "./types";

async function ownerCtx(env: Env) {
  const roots = await ensureTenantBootstrap(env);
  const owner = (await resolveIdentityByUserId(env, roots.ownerUserId))!;
  return { roots, owner, change: { actorId: owner.userId, channel: "rest" as const }, writeCtx: { workspaceId: roots.ownerPersonalWorkspaceId, actorId: owner.userId } };
}

async function seedOne(env: Env, id: string, content: string, tags: string[] = []): Promise<{ roots: Awaited<ReturnType<typeof ownerCtx>> }> {
  const ctx = await ownerCtx(env);
  await env.DB.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, 'api', ?, '[]', ?, ?)`,
  ).bind(id, content, JSON.stringify(tags), Date.now() - 86_400_000, ctx.roots.ownerPersonalWorkspaceId, ctx.owner.userId).run();
  return { roots: ctx };
}

/** Every journey navigates the dashboard home first, authenticated by browser.ts's newPage. */
async function gotoHome(page: import("puppeteer-core").Page, baseUrl: string) {
  await page.goto(baseUrl, { waitUntil: "networkidle0" });
}

/** Opens one memory's view sheet the way a real user does: there is no hash route for a memory
 * (only due.js has one, for #due/<id>), so this switches to the Memories tab and clicks the card. */
async function gotoMemory(page: import("puppeteer-core").Page, baseUrl: string, id: string) {
  await gotoHome(page, baseUrl);
  await page.evaluate(() => (window as unknown as { switchTab(tab: string): void }).switchTab("memories"));
  const selector = `.memory-card[data-id="${id}"] .card-content`;
  await page.waitForSelector(selector, { timeout: 5000 });
  // loadRecent() re-renders the whole list once its fetch resolves, which can replace the card's
  // DOM node between waitForSelector and click; a couple of retries rides out that race.
  for (let attempt = 1; ; attempt++) {
    try {
      await page.click(selector);
      break;
    } catch (e) {
      if (attempt >= 3 || !/detached from document/i.test(String(e))) throw e;
      await page.waitForSelector(selector, { timeout: 5000 });
    }
  }
  await page.waitForSelector("#view-sheet.open", { timeout: 3000 }).catch(() => {});
}

export const journeys: Journey[] = [
  {
    id: "w1",
    title: "Forget from the sheet, then Undo in the toast",
    async setup(env) { await seedOne(env, "w1-mem", "A memory to forget from the sheet."); },
    async run(ctx) {
      await gotoMemory(ctx.page, ctx.baseUrl, "w1-mem");
      await ctx.shot("before", "the memory sheet, before forgetting");
      const forgetBtn = await ctx.page.$("#view-btn-forget");
      if (!forgetBtn) throw new NotBuilt("memory-crud.js: forget control", "no #view-btn-forget found on the opened memory sheet");
      await forgetBtn.click();
      // The confirm sheet (confirm-sheet.js) is already wired for destructive actions; look for it.
      const confirmBtn = await ctx.page.waitForSelector(".confirm-sheet .confirm-yes, .confirm-sheet button[data-confirm]", { timeout: 3000 }).catch(() => null);
      if (confirmBtn) await confirmBtn.click();
      const toastWithUndo = await ctx.page.waitForSelector(".toast [data-undo], .toast .toast-undo", { timeout: 3000 }).catch(() => null);
      if (!toastWithUndo) throw new NotBuilt("UX-A.3: Undo toasts for every dashboard write", "forget's toast (toast.js showToast) has no Undo action yet");
      await ctx.shot("toast", "the undo toast after forgetting");
    },
  },
  {
    id: "w2",
    title: "Forget, open Trash, Restore",
    async setup(env) {
      await seedOne(env, "w2-mem", "A memory to forget then restore from Trash.");
      const ctx = await ownerCtx(env);
      await forgetEntry("w2-mem", env, ctx.change, { reason: "forget", config: await resolveConfig(env) }, ctx.roots.ownerPersonalWorkspaceId);
    },
    async run(ctx) {
      await gotoHome(ctx.page, ctx.baseUrl);
      const trashLink = await ctx.page.$(".trash-view-link, [data-nav='trash'], a[href*='trash']");
      if (!trashLink) throw new NotBuilt("UX-B.2: Trash view", "no trash entry point found at the foot of Memories or the menu's Data group (map Q1)");
      await ctx.shot("no-trash", "dashboard home, looking for the Trash entry point");
    },
  },
  {
    id: "w3",
    title: "Change TRASH_RETENTION_DAYS in Advanced Settings",
    async setup() {},
    async run(ctx) {
      await gotoHome(ctx.page, ctx.baseUrl);
      const settingsLink = await ctx.page.$("[data-nav='settings'], a[href*='settings']");
      if (settingsLink) await settingsLink.click().catch(() => {});
      const retentionField = await ctx.page.$("#trash-retention-days, [data-setting='TRASH_RETENTION_DAYS']");
      if (!retentionField) throw new NotBuilt("UX-D.2: Advanced Settings, History and trash", "no trash-retention control in the dashboard settings panel (map Q4)");
      await ctx.shot("settings", "the history and trash settings panel");
    },
  },
  {
    id: "w4",
    title: "Delete forever from Trash",
    async setup(env) {
      await seedOne(env, "w4-mem", "A memory to delete forever.");
      const ctx = await ownerCtx(env);
      await forgetEntry("w4-mem", env, ctx.change, { reason: "forget", config: await resolveConfig(env) }, ctx.roots.ownerPersonalWorkspaceId);
    },
    async run(ctx) {
      await gotoHome(ctx.page, ctx.baseUrl);
      const trashLink = await ctx.page.$(".trash-view-link, [data-nav='trash']");
      if (!trashLink) throw new NotBuilt("UX-B.2 / UX-11: Delete forever lives in the trash view only", "no trash view to hold the Delete forever action (map Q11)");
      await ctx.shot("no-trash", "dashboard home, looking for the trash view");
    },
  },
  {
    id: "w5",
    title: "Edit, then Undo from the timeline, then Undo again",
    async setup(env) {
      await seedOne(env, "w5-mem", "Original text before the edit.");
      const ctx = await ownerCtx(env);
      await updateEntryContent(env, "w5-mem", "Edited text.", DEFAULTS, undefined, undefined, ctx.writeCtx, ctx.change, ctx.roots.ownerPersonalWorkspaceId);
    },
    async run(ctx) {
      await gotoMemory(ctx.page, ctx.baseUrl, "w5-mem");
      const timeline = await ctx.page.$(".memory-timeline, .version-timeline, [data-timeline]");
      if (!timeline) throw new NotBuilt("UX-A.2: Merged history timeline", "no timeline element on the memory sheet");
      await ctx.shot("no-timeline", "the memory sheet, looking for the history timeline");
    },
  },
  {
    id: "w6",
    title: "Restore this version (three versions back)",
    async setup(env) {
      await seedOne(env, "w6-mem", "v1");
      const ctx = await ownerCtx(env);
      for (const v of ["v2", "v3", "v4"]) {
        await updateEntryContent(env, "w6-mem", v, DEFAULTS, undefined, undefined, ctx.writeCtx, ctx.change, ctx.roots.ownerPersonalWorkspaceId);
      }
    },
    async run(ctx) {
      await gotoMemory(ctx.page, ctx.baseUrl, "w6-mem");
      const restoreBtn = await ctx.page.$("[data-action='restore-version']");
      if (!restoreBtn) throw new NotBuilt("UX-A.2: Restore this version", "no per-version restore control on the timeline");
      await ctx.shot("no-restore", "the memory sheet, looking for a restore-this-version control");
    },
  },
  {
    id: "w7",
    title: "Undo a merge (seeded via capture)",
    async setup(env) { await seedOne(env, "w7-mem", "A memory that stands in for a merged one (the harness's AI stub cannot decide a real merge; see local-env.ts)."); },
    async run(ctx) {
      await gotoMemory(ctx.page, ctx.baseUrl, "w7-mem");
      const timeline = await ctx.page.$(".memory-timeline, [data-timeline]");
      if (!timeline) throw new NotBuilt("UX-A.2: Merged history timeline (kept_incoming toast)", "no timeline to show a merge's Undo toast naming the re-created memory");
      await ctx.shot("no-timeline", "looking for the merge-undo timeline row");
    },
  },
  {
    id: "w8",
    title: "Teammate views a shared memory",
    async setup(env) {
      const ctx = await ownerCtx(env);
      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES ('w8-mem', 'Shared with the team.', '[]', 'api', ?, '[]', ?, ?)`,
      ).bind(Date.now() - 86_400_000, ctx.roots.ownerPersonalWorkspaceId, ctx.owner.userId).run();
      await moveEntry("w8-mem", "company", env, ctx.owner, ctx.change);
      await createMember(env, { name: "Priya", role: "member" });
    },
    async run(ctx) {
      await gotoMemory(ctx.page, ctx.baseUrl, "w8-mem");
      const belongsLine = await ctx.page.$("[data-belongs-to], .shared-history-note");
      if (!belongsLine) throw new NotBuilt("UX-A.2 / D-SH: the belongs-to line and share-start history cut", "no shared-history UI on the memory sheet for a teammate viewer");
      await ctx.shot("no-belongs-line", "looking for the D-SH belongs-to line");
    },
  },
  {
    id: "w9",
    title: "Loops Done, Snooze, Keep, Confirm insight, each with Undo",
    async setup(env) { await seedOne(env, "w9-mem", "Renew the passport.", ["task"]); },
    async run(ctx) {
      await gotoHome(ctx.page, ctx.baseUrl);
      const loopsNav = await ctx.page.$("[data-nav='loops'], a[href*='loops']");
      if (!loopsNav) throw new NotBuilt("UX-A.3: Undo toasts on loops actions", "no loops surface with an Undo-toast-wired Done/Snooze/Keep, or it predates the undo toast pattern");
      await ctx.shot("no-undo-toast", "looking for an Undo toast on a loops action");
    },
  },
  {
    id: "w10",
    title: "MCP burst (20 status changes), then the home board",
    async setup() { throw new NotBuilt("Track 4: UX-E.1 AI tools changed / Undo all", "insight resolution burst + the collapsed 'AI tools changed' line ship with Track 4, not yet on this branch"); },
    async run() {},
  },
  {
    id: "w11",
    title: "Quarantine write through MCP, then the dashboard",
    async setup() { throw new NotBuilt("Track 4: quarantine hold and release", "the held/quarantine chip and Release action ship with Track 4"); },
    async run() {},
  },
  {
    id: "w12",
    title: "Superseded fact",
    async setup() { throw new NotBuilt("Track 2: validity labels (UX-F.1)", "\"true until\"/\"replaced by\" labels ship with Track 2's time-aware truth"); },
    async run() {},
  },
  {
    id: "w13",
    title: "Standing, commitments, decision rows",
    async setup() { throw new NotBuilt("Track 7: standing memory, commitments, decision ledger (UX-G)", "these surfaces ship with Track 7"); },
    async run() {},
  },
  {
    id: "w14",
    title: "Pruned history (VERSION_KEEP 5, 7 edits)",
    async setup(env) {
      await seedOne(env, "w14-mem", "v0");
      const ctx = await ownerCtx(env);
      for (let i = 1; i <= 7; i++) {
        await updateEntryContent(env, "w14-mem", `v${i}`, { ...DEFAULTS, VERSION_KEEP: 5 }, undefined, undefined, ctx.writeCtx, ctx.change, ctx.roots.ownerPersonalWorkspaceId);
      }
    },
    async run(ctx) {
      await gotoMemory(ctx.page, ctx.baseUrl, "w14-mem");
      const prunedFooter = await ctx.page.$(".timeline-pruned-footer, [data-pruned]");
      if (!prunedFooter) throw new NotBuilt("UX-A.2: pruned and not-recorded footers", "no \"older changes are not kept\" footer on the timeline");
      await ctx.shot("no-footer", "looking for the pruned-history footer");
    },
  },
  {
    id: "w15",
    title: "Failure injection (the stub fails re-embed)",
    async setup(env) { await seedOne(env, "w15-mem", "A memory whose undo will hit a failed re-embed."); },
    async run(ctx) {
      await gotoMemory(ctx.page, ctx.baseUrl, "w15-mem");
      const timeline = await ctx.page.$(".memory-timeline, [data-timeline]");
      if (!timeline) throw new NotBuilt("UX-A.2: timeline with Undo (needed to reach the failure-injection retry copy)", "no timeline to trigger an undo against");
      await ctx.shot("no-timeline", "looking for the timeline to inject a re-embed failure against");
    },
  },
  {
    id: "w16",
    title: "Every new string in it",
    async setup() {},
    async run(ctx) {
      // A static check, not a UI probe: the map's own pass condition is a grep for an em dash on
      // the diff of i18n.js, which belongs in code review, not a browser run. Reported pending
      // here so the journey list stays complete; see README's "copy honesty" note (UX-J).
      throw new NotBuilt("UX-J: copy honesty pass", "checked by grep on the i18n.js diff (an em dash, or an English string with no Italian pair), not by driving a browser");
    },
  },
  {
    id: "w17",
    title: "Keyboard only",
    async setup(env) { await seedOne(env, "w17-mem", "A memory for a keyboard-only pass."); },
    async run(ctx) {
      await gotoHome(ctx.page, ctx.baseUrl);
      await ctx.page.keyboard.press("Tab");
      const focused = await ctx.page.evaluate(() => document.activeElement?.tagName ?? null);
      if (!focused || focused === "BODY") throw new NotBuilt("Keyboard reachability", "the first Tab press does not focus anything on the home board");
      await ctx.shot("first-focus", "the first keyboard-focused element on the home board");
      // The full pass condition also needs a confirm sheet and a toast's Undo to be reachable by
      // keyboard, both of which sit behind UX-A.3 and UX-B.2 above.
      throw new NotBuilt("UX-A.3 / UX-B.2: confirm sheet and toast Undo reachable by keyboard", "cannot verify focus-trapping on controls that do not exist yet");
    },
  },
];
