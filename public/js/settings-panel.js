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

function applySettingsRole(admin) {
  const note = document.getElementById('settings-admin-note');
  if (note) note.hidden = admin;
  for (const id of ['setting-trash-retention', 'setting-version-keep']) {
    const sel = document.getElementById(id);
    if (sel) sel.disabled = !admin;
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
    showToast(t('settingsPanel.saved'), {
      action: t('team.undo'),
      onAction: async () => {
        try {
          await patchSetting(key, previous);
          settingsCurrent[key] = previous;
          renderSettingsOptions(selectId, SETTINGS_CHOICES[key], previous, SETTINGS_LABEL[key]);
        } catch (e) {
          showToast(e.message || t('team.actionFailed'));
        }
      },
    });
  } catch (e) {
    // A refused write leaves the effective value unchanged; the select goes
    // back to it rather than sitting on a value the Worker never accepted.
    renderSettingsOptions(selectId, SETTINGS_CHOICES[key], previous, SETTINGS_LABEL[key]);
    if (e.status === 403) {
      // The role may have changed since the sheet opened: re-probe rather
      // than assume this was a stale admin flag.
      applySettingsRole(false);
    } else {
      showToast(e.message || t('settingsPanel.failed', { message: '' }));
    }
  }
}
