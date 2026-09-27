// ── Dashboard settings panel: trash retention and versions kept ──────────
// (T-0101.8.3, TR-2)
//
// Shares its keys, choices and ranges with the desktop Advanced Settings
// window (contract 4.6, installer/src-tauri/src/settings.rs) — a parity
// test pins both. A member sees the same effective values, read-only;
// admin status reuses team.js's existing GET /team/members probe
// (teamIsAdmin) rather than asking a second time.

const SETTINGS_CHOICES = {
  TRASH_RETENTION_DAYS: [7, 14, 30, 90],
  VERSION_KEEP: [10, 20, 50],
};

/** Must equal the Worker's shipped DEFAULTS (src/config.ts) — what Reset goes back to. */
const SETTINGS_DEFAULT = {
  TRASH_RETENTION_DAYS: 14,
  VERSION_KEEP: 20,
};

const SETTINGS_SELECT_ID = {
  TRASH_RETENTION_DAYS: 'setting-trash-retention',
  VERSION_KEEP: 'setting-version-keep',
};

const SETTINGS_RESET_BTN_ID = {
  TRASH_RETENTION_DAYS: 'setting-trash-retention-reset',
  VERSION_KEEP: 'setting-version-keep-reset',
};

/** The effective value each select currently shows, for Undo's "prior value". */
const settingsCurrent = { TRASH_RETENTION_DAYS: null, VERSION_KEEP: null };

function openSettingsSheet() {
  closeMenu();
  document.getElementById('settings-sheet').classList.add('open');
  loadSettingsPanel();
}

function closeSettingsSheet() {
  document.getElementById('settings-sheet').classList.remove('open');
}

/**
 * Rebuild one select's options from the fixed choices, plus a "Custom
 * (value)" entry when the effective value sits outside them — added, never
 * silently rewritten to the nearest choice. `formatLabel` defaults to the
 * bare number (versions kept); the retention select passes one that
 * pluralizes "day".
 */
function renderSettingsOptions(selectId, choices, value, formatLabel) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const label = formatLabel || ((c) => String(c));
  const options = choices.map((c) => `<option value="${c}">${escHtml(label(c))}</option>`);
  if (typeof value === 'number' && !choices.includes(value)) {
    options.push(`<option value="${value}">${escHtml(t('settingsPanel.custom', { value }))}</option>`);
  }
  sel.innerHTML = options.join('');
  if (typeof value === 'number') sel.value = String(value);
}

function retentionDaysLabel(n) {
  return tPlural('settingsPanel.days', n);
}

/** Same formatter each select was rendered with, so a rollback or an Undo
 * reconstructs the option text and not just the selected value. */
const SETTINGS_LABEL = { TRASH_RETENTION_DAYS: retentionDaysLabel, VERSION_KEEP: undefined };

/** Reset is an admin-only affordance, and only means something once the
 * effective value has actually left the shipped default. */
function updateResetVisibility(key, value) {
  const btn = document.getElementById(SETTINGS_RESET_BTN_ID[key]);
  if (!btn) return;
  btn.hidden = teamIsAdmin === false || value === SETTINGS_DEFAULT[key];
}

function applySettingsRole(admin) {
  const note = document.getElementById('settings-admin-note');
  if (note) note.hidden = admin;
  for (const key of Object.keys(SETTINGS_SELECT_ID)) {
    const sel = document.getElementById(SETTINGS_SELECT_ID[key]);
    if (sel) sel.disabled = !admin;
    updateResetVisibility(key, settingsCurrent[key]);
  }
}

async function loadSettingsPanel() {
  try {
    const data = await readTeamConfig();
    const cfg = data?.config || {};
    settingsCurrent.TRASH_RETENTION_DAYS = cfg.TRASH_RETENTION_DAYS;
    settingsCurrent.VERSION_KEEP = cfg.VERSION_KEEP;
    renderSettingsOptions('setting-trash-retention', SETTINGS_CHOICES.TRASH_RETENTION_DAYS, cfg.TRASH_RETENTION_DAYS, retentionDaysLabel);
    renderSettingsOptions('setting-version-keep', SETTINGS_CHOICES.VERSION_KEEP, cfg.VERSION_KEEP);
    // No visible stub until T-0089.5.5 gives the Worker a RECALL_LOG default;
    // presence in `defaults` is what turns this row on.
    const recallLogRow = document.getElementById('setting-recall-log-row');
    if (recallLogRow) recallLogRow.style.display = data?.defaults && 'RECALL_LOG' in data.defaults ? '' : 'none';
  } catch {}
  // A solo owner's GET /team/members also answers 200 (team.js's own note on
  // teamIsAdmin), so this reads the same as team.js's own admin-only rows.
  applySettingsRole(teamIsAdmin !== false);
}

async function patchSetting(key, value) {
  const res = await fetch(`${WORKER_URL}/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
    body: JSON.stringify({ [key]: value }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    const err = new Error(data.error || t('settingsPanel.failed', { message: String(res.status) }));
    err.status = res.status;
    throw err;
  }
}

async function onSettingChange(selectId, key) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const previous = settingsCurrent[key];
  const value = Number(sel.value);
  try {
    await patchSetting(key, value);
    settingsCurrent[key] = value;
    updateResetVisibility(key, value);
    showToast(t('settingsPanel.saved'), {
      action: t('team.undo'),
      onAction: async () => {
        try {
          await patchSetting(key, previous);
          settingsCurrent[key] = previous;
          renderSettingsOptions(selectId, SETTINGS_CHOICES[key], previous, SETTINGS_LABEL[key]);
          updateResetVisibility(key, previous);
        } catch (e) {
          showToast(e.message || t('team.actionFailed'));
        }
      },
    });
  } catch (e) {
    // A refused write leaves the effective value unchanged; the select goes
    // back to it rather than sitting on a value the Worker never accepted.
    renderSettingsOptions(selectId, SETTINGS_CHOICES[key], previous, SETTINGS_LABEL[key]);
    updateResetVisibility(key, previous);
    if (e.status === 403) {
      // The role may have changed since the sheet opened: re-probe rather
      // than assume this was a stale admin flag.
      applySettingsRole(false);
    } else {
      showToast(e.message || t('settingsPanel.failed', { message: '' }));
    }
  }
}

/**
 * Reset one key to the Worker's shipped default (DELETE /config/:key),
 * independent of the other setting — the same per-key reset the route
 * already offers admins elsewhere.
 */
async function resetSetting(key) {
  const selectId = SETTINGS_SELECT_ID[key];
  try {
    const res = await fetch(`${WORKER_URL}/config/${key}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || t('settingsPanel.failed', { message: String(res.status) }));
    settingsCurrent[key] = SETTINGS_DEFAULT[key];
    renderSettingsOptions(selectId, SETTINGS_CHOICES[key], SETTINGS_DEFAULT[key], SETTINGS_LABEL[key]);
    updateResetVisibility(key, SETTINGS_DEFAULT[key]);
    showToast(t('settingsPanel.wasReset'));
  } catch (e) {
    showToast(e.message || t('settingsPanel.failed', { message: '' }));
  }
}
