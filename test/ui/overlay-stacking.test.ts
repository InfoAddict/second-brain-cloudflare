/**
 * Which overlay paints on top.
 *
 * Every bottom sheet and dialog shared one z-index, so the winner was decided by
 * document order. That held only while no sheet could open another. The
 * out-of-date queue is the first that can — Edit, Append and Forget all launch
 * from inside it — and all three are declared earlier in index.html, so they
 * opened BEHIND the queue. On a phone that is indistinguishable from the tap
 * doing nothing: the sheet stays put, no dialog appears, and the memory sits
 * there apparently unresponsive until you close the queue and find the confirm
 * dialog waiting underneath.
 *
 * Reordering the markup would fix that instance and break again the next time a
 * sheet is added below them. The layer is the thing being asserted here, so the
 * fix is a named layer and this is the test that keeps it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
// Comments stripped first: they sit immediately above a rule and would
// otherwise be read as part of its first selector.
const CSS = readFileSync(resolve(ROOT, "public/css/main.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Every z-index declared for a selector, across all rules including media
 * queries. Rules are found by splitting on braces rather than parsed properly —
 * enough for a stacking assertion, and it fails loudly if a selector is absent.
 */
function zIndexesFor(selector: string): number[] {
  const found: number[] = [];
  for (const block of CSS.split("}")) {
    const brace = block.lastIndexOf("{");
    if (brace === -1) continue;
    const selectors = block.slice(0, brace);
    const body = block.slice(brace + 1);
    // Whole-token match, so `#edit-sheet` is not found inside `#edit-sheet-foo`,
    // and an `.open` / `:hover` suffix still counts as the same element.
    const escaped = selector.replace(/[.*+?^${}()|[\]\\#]/g, "\\$&");
    const listed = new RegExp(`(^|[,\\s])${escaped}(\\.[a-z-]+|:[a-z-]+)?\\s*(,|$)`, "m").test(selectors);
    if (!listed) continue;
    const m = /z-index:\s*(\d+)/.exec(body);
    if (m) found.push(Number(m[1]));
  }
  return found;
}

/** Modals that act on one memory. Always launched from somewhere else. */
const ACTION_MODALS = ["#confirm-dialog", "#append-sheet", "#edit-sheet"];

/** Surfaces that hold a list and can launch an action modal from a row. */
const CONTAINER_SHEETS = ["#stale-sheet", "#patterns-sheet", "#menu-sheet", "#integrations-sheet"];

describe("overlay stacking", () => {
  it("declares a z-index for every overlay it is guarding", () => {
    // Without this the assertion below passes vacuously if a selector is renamed.
    for (const sel of [...ACTION_MODALS, ...CONTAINER_SHEETS]) {
      expect(zIndexesFor(sel).length, `${sel} should declare a z-index`).toBeGreaterThan(0);
    }
  });

  it("puts action modals above the sheets that launch them", () => {
    // Last declaration wins, which is what the cascade does when specificity is
    // equal — and it is equal here, every one of these is a single id. The
    // modals are deliberately listed in the shared sheet rule first and raised
    // afterwards, so taking the minimum would read the value they are being
    // lifted OUT of.
    const effective = (sel: string) => zIndexesFor(sel).at(-1) as number;

    for (const modal of ACTION_MODALS) {
      for (const sheet of CONTAINER_SHEETS) {
        expect(
          effective(modal),
          `${modal} must paint above ${sheet}, else a tap inside the sheet opens a dialog behind it`,
        ).toBeGreaterThan(effective(sheet));
      }
    }
  });
});
