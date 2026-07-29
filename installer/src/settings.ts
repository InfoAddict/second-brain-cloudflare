// The "Brain settings" window (#246) — the only place Second Brain's behaviour
// can be tuned. The Worker stores and reads config; this app is its only
// writer, which is why there is deliberately no settings UI in the dashboard.
//
// Six controls are named levels rather than sliders: each moves two or three
// config keys that must stay coherent, and two pairs carry invariants the
// Worker resets wholesale if crossed. Offering independent sliders would let a
// user produce a config that silently snaps back.
import { invoke } from "@tauri-apps/api/core";
import { h } from "./shared";
import { LOCALE_CHANGE_EVENT, initI18n, settingsSection, t } from "./i18n";
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

/** Which section each control belongs under, in display order. */
const SECTIONS: { key: "sectionRecall" | "sectionSaving"; controls: string[] }[] = [
  { key: "sectionRecall", controls: ["recency", "variety", "connections", "detail"] },
  { key: "sectionSaving", controls: ["duplicates", "compression"] },
];

const app = document.querySelector<HTMLDivElement>("#app")!;

let view: SettingsView | null = null;
/** Guards against a second click while a write is in flight. */
let busy = false;

function status(message: string, kind: "ok" | "error" | "pending" = "ok"): void {
  const el = document.querySelector<HTMLDivElement>("#sb-status");
  if (!el) return;
  el.textContent = message;
  el.className = `settings-status settings-status-${kind}`;
}

async function mutate(fn: () => Promise<SettingsView>): Promise<void> {
  if (busy) return;
  busy = true;
  status(t("settingsPanel.saving"), "pending");
  try {
    // Every command returns the freshly re-read view: the Worker clamps and
    // invariant-checks on resolve, so rendering the request rather than the
    // response could show a state the brain is not actually in.
    view = await fn();
    render();
    status(t("settingsPanel.saved"), "ok");
  } catch (e) {
    // The Worker's message names the offending key or the invariant it
    // crosses; it is the only thing that tells the user what went wrong.
    status(typeof e === "string" ? e : String(e), "error");
  } finally {
    busy = false;
  }
}

function controlCard(c: ControlView): HTMLElement {
  // Typed so the dotted keys below still satisfy t()'s Path type rather
  // than widening to a bare string.
  const base: `settingsPanel.${string}` = `settingsPanel.${c.id}`;
  const card = h("div", { class: "card settings-control" });

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
    (input as HTMLInputElement).checked = c.level === levelId;
    (input as HTMLInputElement).disabled = busy;
    input.addEventListener("change", () => {
      void mutate(() =>
        invoke<SettingsView>("set_control_level", { control: c.id, level: levelId }),
      );
    });
    group.append(
      h("label", { class: "settings-level" }, [input, t(`${base}.levels.${levelId}.name`)]),
    );
    // Hovering a level previews its notice; leaving restores the selected one.
    group.lastElementChild?.addEventListener("mouseenter", () => paint(levelId));
    group.lastElementChild?.addEventListener("mouseleave", () => paint(c.level));
  }
  card.append(group);

  if (c.level === null) {
    card.append(h("div", { class: "settings-custom" }, [t("settingsPanel.custom")]));
  }

  paint(c.level);
  card.append(notice);

  // Forward-only controls cannot rewrite what is already stored. Marked
  // because presenting them as ordinary settings generates support questions.
  if (c.forwardOnly) {
    card.append(h("div", { class: "settings-forward-note" }, [`ⓘ ${t(`${base}.note`)}`]));
  }

  const reset = h("button", { class: "btn-secondary settings-reset", type: "button" }, [
    t("settingsPanel.reset"),
  ]);
  (reset as HTMLButtonElement).disabled = busy || c.level === c.defaultLevel;
  reset.addEventListener("click", () => {
    void mutate(() => invoke<SettingsView>("reset_control_setting", { control: c.id }));
  });
  card.append(reset);

  return card;
}

function modelCard(v: SettingsView): HTMLElement {
  const card = h("div", { class: "card settings-control" });
  card.append(
    h("div", { class: "url-label" }, [t("settingsPanel.model.label")]),
    h("div", { class: "url-desc" }, [t("settingsPanel.model.desc")]),
  );

  const select = h("select", { class: "locale-select" }) as HTMLSelectElement;
  for (const model of v.llmModels) {
    select.append(h("option", { value: model }, [model]));
  }
  // A model set outside the app (or removed from the curated list) must still
  // show as selected rather than silently reading as the first entry.
  if (v.llmModel && !v.llmModels.includes(v.llmModel)) {
    select.append(h("option", { value: v.llmModel }, [v.llmModel]));
  }
  select.value = v.llmModel;
  select.disabled = busy;
  select.addEventListener("change", () => {
    void mutate(() => invoke<SettingsView>("set_brain_llm_model", { model: select.value }));
  });

  card.append(
    select,
    h("div", { class: "settings-notice" }, [t("settingsPanel.model.sizeNote")]),
    h("div", { class: "settings-forward-note" }, [`ⓘ ${t("settingsPanel.model.neuronsNote")}`]),
  );
  return card;
}

function render(): void {
  app.replaceChildren();
  if (!view) return;

  app.append(
    h("h1", { class: "settings-title" }, [t("settingsPanel.title")]),
    h("p", { class: "settings-lede" }, [t("settingsPanel.lede")]),
    h("div", { id: "sb-status", class: "settings-status" }),
  );

  const byId = new Map(view.controls.map(c => [c.id, c]));
  for (const section of SECTIONS) {
    app.append(h("h2", { class: "settings-section" }, [t(`settingsPanel.${section.key}`)]));
    for (const id of section.controls) {
      const c = byId.get(id);
      // Skip silently rather than throwing: a Worker running an older version
      // may not expose every control yet.
      if (c) app.append(controlCard(c));
    }
  }

  app.append(
    h("h2", { class: "settings-section" }, [t("settingsPanel.sectionAi")]),
    modelCard(view),
    settingsSection(() => render()),
  );
}

async function boot(): Promise<void> {
  initI18n();
  app.replaceChildren(h("p", { class: "settings-lede" }, [t("settingsPanel.saving")]));
  try {
    view = await invoke<SettingsView>("get_brain_settings");
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

window.addEventListener(LOCALE_CHANGE_EVENT, () => render());
void boot();
