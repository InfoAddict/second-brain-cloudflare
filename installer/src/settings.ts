// The "Advanced Settings" window (#246) — the only place Second Brain's
// behaviour can be tuned. The Worker stores and reads config; this app is its
// only writer, which is why there is deliberately no settings UI in the
// dashboard.
//
// Six controls are named levels rather than sliders: each moves two or three
// config keys that must stay coherent, and two pairs carry invariants the
// Worker resets wholesale if crossed. Offering independent sliders would let a
// user produce a config that silently snaps back.
//
// Edits are STAGED, not written on change. These settings alter how recall
// behaves, so a mis-click must not silently retune the user's brain — nothing
// reaches the Worker until Save, and Cancel discards the batch.
import { invoke } from "@tauri-apps/api/core";
import { h } from "./shared";
import { LOCALE_CHANGE_EVENT, initI18n, t } from "./i18n";
import "./style.css";

type ControlView = {
  id: string;
  levels: string[];
  /** null when the stored config matches no level — shown as "Custom". */
  level: string | null;
  defaultLevel: string;
  forwardOnly: boolean;
};

type SettingsView = {
  controls: ControlView[];
  llmModel: string;
  llmModels: string[];
};

/** A control's staged state: pick a level, or reset it to the shipped default. */
type Staged = { kind: "level"; id: string } | { kind: "reset" };

/**
 * Left-rail sections, mirroring the Connections window. Only the active pane
 * renders — seven controls stacked in one column was a long scroll, and the
 * grouping is what tells a user whether a setting affects recall or capture.
 *
 * "ai" holds the model dropdown rather than level controls, so it has no
 * entry in `controls`.
 */
type SectionId = "recall" | "remember" | "ai";

const SECTIONS: { id: SectionId; labelKey: "sectionRecall" | "sectionRemember" | "sectionAi"; controls: string[] }[] = [
  { id: "recall", labelKey: "sectionRecall", controls: ["recency", "variety", "connections", "detail"] },
  { id: "remember", labelKey: "sectionRemember", controls: ["duplicates", "compression"] },
  { id: "ai", labelKey: "sectionAi", controls: [] },
];

/** Recall is the default pane. */
let active: SectionId = "recall";

const app = document.querySelector<HTMLDivElement>("#app")!;

/** Last state read from the Worker — the baseline every diff is taken against. */
let saved: SettingsView | null = null;
/** Staged edits, keyed by control id. Empty means nothing to save. */
let staged = new Map<string, Staged>();
let stagedModel: string | null = null;
let busy = false;
let message: { text: string; kind: "ok" | "error" } | null = null;

/** What a control shows right now: its staged value if edited, else saved. */
function effectiveLevel(c: ControlView): string | null {
  const s = staged.get(c.id);
  if (!s) return c.level;
  return s.kind === "reset" ? c.defaultLevel : s.id;
}

function isDirty(): boolean {
  return staged.size > 0 || stagedModel !== null;
}

function stage(controlId: string, next: Staged, c: ControlView): void {
  // Staging back to the saved value is not a change — drop it so Save stays
  // disabled and the count stays honest.
  const backToSaved =
    (next.kind === "level" && next.id === c.level) ||
    (next.kind === "reset" && c.level === c.defaultLevel);
  if (backToSaved) staged.delete(controlId);
  else staged.set(controlId, next);
  message = null;
  render();
}

function discard(): void {
  staged = new Map();
  stagedModel = null;
  message = null;
  render();
}

async function save(): Promise<void> {
  if (busy || !isDirty()) return;
  busy = true;
  message = null;
  render();
  try {
    const levels: [string, string][] = [];
    const resets: string[] = [];
    for (const [id, s] of staged) {
      if (s.kind === "reset") resets.push(id);
      else levels.push([id, s.id]);
    }
    // The command returns the freshly re-read view: the Worker clamps and
    // invariant-checks on resolve, so what it stored may differ from what was
    // asked for. Rendering the request would show a state the brain is not in.
    saved = await invoke<SettingsView>("save_brain_settings", {
      levels,
      resets,
      model: stagedModel,
    });
    staged = new Map();
    stagedModel = null;
    message = { text: t("settingsPanel.saved"), kind: "ok" };
  } catch (e) {
    // The Worker's message names the offending key or the invariant it
    // crosses; it is the only thing that tells the user what went wrong. The
    // staged edits are kept so nothing chosen is lost on a rejection.
    message = { text: typeof e === "string" ? e : String(e), kind: "error" };
  } finally {
    busy = false;
    render();
  }
}

function controlCard(c: ControlView): HTMLElement {
  // Typed so the dotted keys below still satisfy t()'s Path type rather
  // than widening to a bare string.
  const base: `settingsPanel.${string}` = `settingsPanel.${c.id}`;
  const shown = effectiveLevel(c);
  const edited = staged.has(c.id);

  const card = h("div", { class: `card settings-control${edited ? " settings-edited" : ""}` });
  card.append(
    h("div", { class: "url-label" }, [t(`${base}.label`)]),
    h("div", { class: "url-desc" }, [t(`${base}.desc`)]),
  );

  const notice = h("div", { class: "settings-notice" });
  const paint = (levelId: string | null) => {
    notice.textContent = levelId
      ? t(`${base}.levels.${levelId}.notice`)
      : t("settingsPanel.customNote");
  };

  const group = h("div", { class: "settings-levels", role: "radiogroup" });
  group.setAttribute("aria-label", t(`${base}.label`));

  for (const levelId of c.levels) {
    const input = h("input", { type: "radio", name: `sb-${c.id}`, value: levelId });
    (input as HTMLInputElement).checked = shown === levelId;
    (input as HTMLInputElement).disabled = busy;
    input.addEventListener("change", () => stage(c.id, { kind: "level", id: levelId }, c));
    const label = h("label", { class: "settings-level" }, [
      input,
      t(`${base}.levels.${levelId}.name`),
    ]);
    // Hovering previews that level's notice; leaving restores the shown one.
    label.addEventListener("mouseenter", () => paint(levelId));
    label.addEventListener("mouseleave", () => paint(shown));
    group.append(label);
  }
  card.append(group);

  if (shown === null) {
    card.append(h("div", { class: "settings-custom" }, [t("settingsPanel.custom")]));
  }
  paint(shown);
  card.append(notice);

  // Forward-only controls cannot rewrite what is already stored. Marked
  // because presenting them as ordinary settings generates support questions.
  if (c.forwardOnly) {
    card.append(h("div", { class: "settings-forward-note" }, [`ⓘ ${t(`${base}.note`)}`]));
  }

  const reset = h("button", { class: "btn-secondary settings-reset", type: "button" }, [
    t("settingsPanel.reset"),
  ]);
  // Reset is itself staged, so it can be cancelled like any other edit.
  (reset as HTMLButtonElement).disabled = busy || shown === c.defaultLevel;
  reset.addEventListener("click", () => stage(c.id, { kind: "reset" }, c));
  card.append(reset);

  return card;
}

function modelCard(v: SettingsView): HTMLElement {
  const card = h("div", { class: `card settings-control${stagedModel ? " settings-edited" : ""}` });
  card.append(
    h("div", { class: "url-label" }, [t("settingsPanel.model.label")]),
    h("div", { class: "url-desc" }, [t("settingsPanel.model.desc")]),
  );

  const current = stagedModel ?? v.llmModel;
  const select = h("select", { class: "locale-select" }) as HTMLSelectElement;
  for (const model of v.llmModels) {
    select.append(h("option", { value: model }, [model]));
  }
  // A model set outside the app (or dropped from the curated list) must still
  // show as selected rather than silently reading as the first entry.
  if (current && !v.llmModels.includes(current)) {
    select.append(h("option", { value: current }, [current]));
  }
  select.value = current;
  select.disabled = busy;
  select.addEventListener("change", () => {
    stagedModel = select.value === v.llmModel ? null : select.value;
    message = null;
    render();
  });

  card.append(
    select,
    h("div", { class: "settings-notice" }, [t("settingsPanel.model.sizeNote")]),
    h("div", { class: "settings-forward-note" }, [`ⓘ ${t("settingsPanel.model.neuronsNote")}`]),
  );
  return card;
}

/** Sticky footer: nothing reaches the Worker except through Save. */
function actionBar(): HTMLElement {
  const count = staged.size + (stagedModel ? 1 : 0);
  const bar = h("div", { class: "settings-actions" });

  const status = h("div", { class: "settings-actions-status" });
  if (message) {
    status.textContent = message.text;
    status.classList.add(`settings-status-${message.kind}`);
  } else if (count > 0) {
    status.textContent =
      count === 1
        ? t("settingsPanel.unsavedOne")
        : t("settingsPanel.unsaved", { count: String(count) });
    status.classList.add("settings-status-pending");
  }

  const cancel = h("button", { class: "btn-secondary", type: "button" }, [
    t("settingsPanel.cancel"),
  ]);
  (cancel as HTMLButtonElement).disabled = busy || !isDirty();
  cancel.addEventListener("click", discard);

  const saveBtn = h("button", { class: "btn-primary", type: "button" }, [
    busy ? t("settingsPanel.saving") : t("settingsPanel.save"),
  ]);
  (saveBtn as HTMLButtonElement).disabled = busy || !isDirty();
  saveBtn.addEventListener("click", () => void save());

  bar.append(status, cancel, saveBtn);
  return bar;
}

function render(): void {
  const scroll = window.scrollY;
  app.replaceChildren();
  if (!saved) return;

  const rail = h("nav", { class: "rail" });
  for (const section of SECTIONS) {
    const edits = countEdits(section.id);
    const btn = h("button", { class: section.id === active ? "rail-btn on" : "rail-btn", type: "button" }, [
      t(`settingsPanel.${section.labelKey}`),
    ]);
    // A dot on an inactive section, so staged edits are not hidden by the pane
    // the user happens to be looking at.
    if (edits > 0) btn.append(h("span", { class: "rail-dot" }, ["●"]));
    btn.addEventListener("click", () => {
      active = section.id;
      render();
    });
    rail.append(btn);
  }

  const section = SECTIONS.find(s => s.id === active)!;
  const pane = h("section", { class: "pane" });
  pane.append(
    h("h2", { class: "pane-title" }, [t(`settingsPanel.${section.labelKey}`)]),
    h("p", { class: "settings-lede" }, [t("settingsPanel.lede")]),
  );

  const byId = new Map(saved.controls.map(c => [c.id, c]));
  for (const id of section.controls) {
    const c = byId.get(id);
    // Skip silently rather than throwing: a Worker running an older version
    // may not expose every control yet.
    if (c) pane.append(controlCard(c));
  }
  if (active === "ai") pane.append(modelCard(saved));

  app.append(h("div", { class: "panel" }, [rail, pane]), actionBar());
  // Re-render replaces the whole tree; without this, staging an edit near the
  // bottom would jump the view back to the top.
  window.scrollTo({ top: scroll });
}

/** Staged edits belonging to one section, for the rail indicator. */
function countEdits(id: SectionId): number {
  const section = SECTIONS.find(s => s.id === id);
  if (!section) return 0;
  let n = section.controls.filter(c => staged.has(c)).length;
  if (id === "ai" && stagedModel) n += 1;
  return n;
}

async function boot(): Promise<void> {
  initI18n();
  app.replaceChildren(h("p", { class: "settings-lede" }, [t("settingsPanel.saving")]));
  try {
    saved = await invoke<SettingsView>("get_brain_settings");
    render();
  } catch (e) {
    app.replaceChildren(
      h("h1", { class: "settings-title" }, [t("settingsPanel.title")]),
      h("div", { class: "settings-status settings-status-error" }, [
        typeof e === "string" ? e : t("settingsPanel.loadFailed"),
      ]),
    );
  }
}

// Closing the window with staged edits would lose them silently.
window.addEventListener("beforeunload", event => {
  if (isDirty()) event.preventDefault();
});

window.addEventListener(LOCALE_CHANGE_EVENT, () => render());
void boot();
