/**
 * #347's connected-row "move already-synced memories" action: DOM-level
 * gating and drain behaviour, in the vm harness integration-layer-control.test.ts
 * already established for this file.
 *
 * Contract pinned here for the implementer (the plan does not name these —
 * see the test-author's final report for the complete list of choices):
 *   - GET /integrations gains a top-level `owner: boolean` field, mirroring
 *     the existing `admin` field, answering "is the caller the tenant owner".
 *     `loadIntegrations()` is expected to set a module-level `integrationsOwner`
 *     from it, the same way it already sets `integrationsAdmin` from `admin`.
 *   - The move control is gated on `TEAM_MODE && integrationsAdmin && integrationsOwner`
 *     — strictly narrower than the #346 layer control's `TEAM_MODE && integrationsAdmin`,
 *     because only the owner may run a move (locked decision 1). This is why
 *     it must render nothing extra on the two solo-brain fixtures pinned in
 *     integration-provenance.test.ts: those already run with TEAM_MODE false.
 *   - Button id `move-${p}`, calling `moveIntegrationMemories(provider, btn)`.
 *   - A dedicated progress/result element `id="move-note-${p}"`, distinct from
 *     the #346/sync `note-${p}` element (trap 11 in the UI contract: two
 *     drains writing the same node would fight over it).
 *   - `moveIntegrationMemories` drives `runMoveLoop` (see move-loop.test.ts)
 *     and, on a mid-drain failure, writes the `upkeep.restore*`-style "stopped
 *     partway, safe to resume" copy into `move-note-${p}` rather than the
 *     plain "failed" `syncIntegration` shows today, and never leaves the
 *     button in a success-styled state when the drain did not finish.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { installI18n } from "./_i18n-harness";

const ROOT = resolve(import.meta.dirname, "../..");

function makeEl() {
  const classes = new Set<string>();
  return {
    id: "",
    checked: false,
    disabled: false,
    value: "",
    textContent: "",
    innerHTML: "",
    style: {} as Record<string, string>,
    classList: {
      add: (c: string) => void classes.add(c),
      remove: (c: string) => void classes.delete(c),
      contains: (c: string) => classes.has(c),
    },
    setAttribute() {},
    appendChild() {},
    remove() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    dataset: {} as Record<string, string>,
  };
}

function load(teamMode: boolean, admin: boolean, owner: boolean, fetchImpl?: (url: string, init?: any) => Promise<any>) {
  const els = new Map<string, any>();
  const calls: { url: string; init?: any }[] = [];
  const ctx: any = {
    console,
    calls,
    document: {
      getElementById: (id: string) => {
        if (!els.has(id)) {
          const el = makeEl();
          el.id = id;
          els.set(id, el);
        }
        return els.get(id);
      },
      createElement: () => makeEl(),
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      body: { style: {}, appendChild(el: any) { if (el.id) els.set(el.id, el); } },
    },
    confirm: () => { throw new Error("confirm() must not be used"); },
    alert: () => { throw new Error("alert() must not be used"); },
    setTimeout: (fn: () => void) => { fn(); return 0; },
    clearTimeout: () => {},
    refreshAll: () => {},
    fetch: fetchImpl ?? (async (url: string, init?: any) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }),
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  for (const f of [
    "public/utils.js",
    "public/js/state.js",
    "public/js/toast.js",
    "public/js/confirm-sheet.js",
    "public/js/integrations.js",
  ]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  vm.runInContext(
    `WORKER_URL = "https://example.test"; AUTH_TOKEN = "tok"; var TEAM_MODE = ${teamMode}; integrationsAdmin = ${admin}; integrationsOwner = ${owner};`,
    ctx,
  );
  ctx.__els = els;
  return ctx;
}

const BASE = {
  provider: "notion",
  name: "Notion",
  connected: true,
  workspaceName: "Acme Notion",
  itemCount: 12,
  lastSyncedAt: 1771999999000,
};

describe("connected-row move-already-synced action", () => {
  // One test, not four: gating "off" is trivially true before the control
  // exists at all, so a standalone absence-only test would pass today for no
  // reason connected to the feature. Asserting the positive case FIRST is
  // what makes this fail now for the right reason (no control rendered
  // anywhere yet); the negative cases alongside it are the regression guard
  // that stays meaningful once the control exists.
  it("renders the move control only for the owner admin on a team brain, and nowhere else", () => {
    const ownerOnTeam = load(true, true, true);
    expect(ownerOnTeam.renderIntegrationCard({ ...BASE, mirrorWorkspace: "company" })).toContain(`id="move-notion"`);

    const nonOwnerAdmin = load(true, true, false);
    expect(nonOwnerAdmin.renderIntegrationCard({ ...BASE, mirrorWorkspace: "company" })).not.toContain(`id="move-notion"`);

    const plainMember = load(true, false, true);
    expect(plainMember.renderIntegrationCard({ ...BASE, mirrorWorkspace: "company" })).not.toContain(`id="move-notion"`);

    // Matches the pinned solo-brain fixtures in integration-provenance.test.ts.
    const soloBrain = load(false, true, true);
    expect(soloBrain.renderIntegrationCard({ ...BASE, mirrorWorkspace: "personal" })).not.toContain(`id="move-notion"`);
  });

  it("the move control's handler is a real function, not a typo'd name", () => {
    const ctx = load(true, true, true);
    const html = ctx.renderIntegrationCard({ ...BASE, mirrorWorkspace: "company" });
    const m = html.match(/id="move-notion"[^>]*onclick="([a-zA-Z_$][\w$]*)\(/);
    expect(m, 'expected an onclick="someHandler(...)" attribute on the move control').not.toBeNull();
    const handlerName = (m as RegExpMatchArray)[1];
    expect(typeof ctx[handlerName]).toBe("function");
  });

  it("drains a multi-page move to completion and shows a completed, non-partial result", async () => {
    let call = 0;
    const ctx = load(true, true, true, async (url: string) => {
      if (url.includes("/integrations/notion/move")) {
        call++;
        if (call === 1) return { ok: true, status: 200, json: async () => ({ ok: true, moved: 10, alreadyThere: 0, missing: 0, refused: 0, remaining: 2, cursor: "10" }) };
        return { ok: true, status: 200, json: async () => ({ ok: true, moved: 2, alreadyThere: 0, missing: 0, refused: 0, remaining: 0, cursor: null }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, integrations: [], admin: true, owner: true }) };
    });
    const btn = ctx.document.getElementById("move-notion");

    await ctx.moveIntegrationMemories("notion", btn);

    expect(call).toBe(2);
    const note = ctx.document.getElementById("move-note-notion");
    // Must not still read a "stopped partway" message once fully drained.
    expect(note.textContent.toLowerCase()).not.toContain("partway");
  });

  it("says plainly that it stopped partway and that resuming is safe, on a mid-drain failure — not a bare 'failed'", async () => {
    let call = 0;
    const ctx = load(true, true, true, async (url: string) => {
      if (url.includes("/integrations/notion/move")) {
        call++;
        if (call === 1) return { ok: true, status: 200, json: async () => ({ ok: true, moved: 10, alreadyThere: 0, missing: 0, refused: 0, remaining: 5, cursor: "10" }) };
        return { ok: false, status: 500, json: async () => ({ ok: false, error: "boom" }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, integrations: [], admin: true, owner: true }) };
    });
    const btn = ctx.document.getElementById("move-notion");

    await ctx.moveIntegrationMemories("notion", btn);

    const note = ctx.document.getElementById("move-note-notion");
    // The honesty requirement (locked decision 10): say it stopped partway
    // and that resuming is safe, following upkeep.restore*'s convention —
    // not syncIntegration's bare "Sync failed" with no count and no
    // reassurance.
    expect(note.textContent).toMatch(/partway|stopped/i);
    expect(note.textContent).toMatch(/resum|safe|try again/i);
    // 10 already moved must not be silently dropped from the message.
    expect(note.textContent).toMatch(/10/);
    // And the button must not end in the success-styled state — this is the
    // exact silent-success trap syncIntegration and runVectorize both fall
    // into today (UI contract §2, §5, §9 trap 10).
    expect(btn.innerHTML).not.toMatch(/ti-check/);
  });

  it("does not claim completion when the drain fails on the very first call", async () => {
    const ctx = load(true, true, true, async (url: string) => {
      if (url.includes("/integrations/notion/move")) {
        return { ok: false, status: 403, json: async () => ({ ok: false, error: "Only the owner may move these memories" }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, integrations: [], admin: true, owner: true }) };
    });
    const btn = ctx.document.getElementById("move-notion");

    await ctx.moveIntegrationMemories("notion", btn);

    expect(btn.innerHTML).not.toMatch(/ti-check/);
    const note = ctx.document.getElementById("move-note-notion");
    expect(note.textContent.length).toBeGreaterThan(0);
  });
});
