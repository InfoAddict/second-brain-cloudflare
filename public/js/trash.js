// ── Trash (T-0101.2.2, TR-1) ──────────────────────────────────────────────
//
// Forgotten memories wait here for TRASH_RETENTION_DAYS, then they are
// removed for good. Delete forever lives in this sheet ONLY (Q11) — the
// memory sheet's own button is gone (SH-4), so this is the sole reachable
// path to it, and it still runs through memory-crud.js's
// openDeleteForeverConfirm, the one function this lane is allowed to touch
// there.
//
// GET /trash (contract 4.3, BE-2) already filters to what the reader can
// restore — a member never receives a row it cannot act on (Q10) — so this
// view only has to render what it is sent and explain that filtering in one
// line for a non-admin teammate.

/** Loaded so far, in load order (newest deleted first, per the Worker). */
let trashItems = [];
/** Keyset cursor for the next page, or null at the end. */
let trashNextCursor = null;
/** TRASH_RETENTION_DAYS as the Worker resolved it, for the intro line. */
let trashRetentionDays = null;

function openTrashSheet() {
  closeMenu();
  trashItems = [];
  trashNextCursor = null;
  document.getElementById('trash-sheet').classList.add('open');
  loadTrashPage();
}

function closeTrashSheet() {
  document.getElementById('trash-sheet').classList.remove('open');
}

function renderTrashIntro() {
  const intro = document.getElementById('trash-intro');
  if (intro) intro.textContent = tPlural('trash.intro', trashRetentionDays ?? 14);
  const note = document.getElementById('trash-teammate-note');
  if (note) {
    // A note explaining the filtering only means something to a teammate who
    // is NOT an admin — an admin's trash already includes everyone's company
    // rows, and a solo owner has no teammates to be filtered from.
    const showNote = typeof TEAM_MODE !== 'undefined' && TEAM_MODE && teamIsAdmin === false;
    note.hidden = !showNote;
    if (showNote) note.textContent = t('trash.teammateNote');
  }
}

/**
 * Who deleted it, and how.
 *
 * `deleted_by_name` is `resolveActorLabel`'s output (src/lib/actors.ts),
 * which already resolves the viewer's own id to the literal string "You" -
 * that is the "is this me" signal, not something this view has to guess.
 */
function trashWhoLine(item) {
  const date = formatDateUI(item.deleted_at, { year: 'numeric', month: 'short', day: 'numeric' });
  if (item.reason === 'mirror') return t('trash.removedBySync', { date, provider: providerName(item.source) || '' });
  if (item.reason === 'disconnect') return t('trash.removedByDisconnect', { date, provider: providerName(item.source) || '' });
  if (item.channel === 'mcp') {
    return item.client ? t('trash.deletedByClient', { date, client: item.client }) : t('trash.deletedByAgent', { date });
  }
  if (item.deleted_by_name === 'You') return t('trash.deletedByYou', { date });
  return t('trash.deletedByPerson', { date, name: item.deleted_by_name });
}

function trashDaysLine(item) {
  return item.days_left > 0 ? tPlural('trash.daysLeft', item.days_left) : t('trash.daysZero');
}

function trashRow(item) {
  const actions = [];
  if (item.can_restore) {
    actions.push(
      `<button type="button" class="trash-btn trash-btn--primary" data-action="restore"><i class="ti ti-rotate"></i> ${escHtml(t('trash.restore'))}</button>`,
    );
  }
  if (item.can_delete_forever) {
    actions.push(
      `<button type="button" class="trash-btn trash-btn--danger" data-action="delete-forever"><i class="ti ti-trash-x"></i> ${escHtml(t('memories.deleteForever'))}</button>`,
    );
  }
  return `
    <div class="trash-item" data-id="${escAttr(item.id)}">
      <p class="trash-item-text">${escHtml(item.preview)}</p>
      <span class="trash-item-meta">${escHtml(trashWhoLine(item))}</span>
      <span class="trash-item-days">${escHtml(trashDaysLine(item))}</span>
      <div class="trash-item-actions">${actions.join('')}</div>
    </div>`;
}

function renderTrashList() {
  renderTrashIntro();
  const list = document.getElementById('trash-list');
  if (!list) return;
  list.innerHTML = trashItems.length
    ? trashItems.map(trashRow).join('')
    : `<p class="digest-note"><i class="ti ti-trash"></i> ${escHtml(t('trash.empty'))}</p>`;
  const more = document.getElementById('trash-more');
  if (more) {
    more.hidden = !trashNextCursor;
    more.textContent = t('trash.more');
  }
}

async function loadTrashPage({ append = false } = {}) {
  const list = document.getElementById('trash-list');
  if (!append && list) list.innerHTML = `<p class="digest-note">${escHtml(t('integrations.loading'))}</p>`;
  try {
    const params = new URLSearchParams({ limit: '20' });
    if (append && trashNextCursor) params.set('cursor', trashNextCursor);
    const res = await fetch(`${WORKER_URL}/trash?${params}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || String(res.status));
    trashItems = append ? [...trashItems, ...data.items] : data.items;
    trashNextCursor = data.next_cursor;
    trashRetentionDays = data.retention_days;
    renderTrashList();
  } catch (e) {
    if (!append && list) {
      list.innerHTML = `<p class="digest-note"><i class="ti ti-wifi-off"></i> ${escHtml(t('trash.loadFailed', { message: e.message }))}</p>`;
    }
  }
}

function loadMoreTrash(btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = t('integrations.loading');
  }
  loadTrashPage({ append: true });
}

/** Map a failed /restore onto the copy the trash view promises. */
function trashRestoreErrorMessage(status, data) {
  if (status === 404) return t('trash.alreadyGone');
  if (status === 409) return t('trash.conflict');
  if (status === 502) return t('trash.reindexFailed');
  return data?.error || t('team.actionFailed');
}

async function performTrashRestore(item) {
  try {
    const res = await fetch(`${WORKER_URL}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ id: item.id }),
    });
    let data = {};
    try {
      data = await res.json();
    } catch {}
    if (!res.ok || !data.ok) {
      showToast(trashRestoreErrorMessage(res.status, data));
      return;
    }
    trashItems = trashItems.filter((i) => i.id !== item.id);
    renderTrashList();
    showToast(t('trash.restored'), {
      action: t('trash.open'),
      onAction: () => {
        closeTrashSheet();
        if (typeof openView === 'function') openView({ id: item.id, content: item.preview || '', tags: [] }, null);
      },
    });
  } catch (e) {
    showToast(e.message || t('team.actionFailed'));
  }
}

/**
 * Restore, asking first only when the source integration might undo it.
 *
 * A mirrored memory's trash row can reflect a deletion the sync will simply
 * repeat next run, so that one case gets a confirm; every other reason
 * restores on the first tap, matching the sheet's own promise ("Restore",
 * not "Restore?").
 */
function handleTrashRestore(item) {
  if (!item) return;
  if (item.reason === 'mirror') {
    openDangerConfirm({
      title: t('trash.mirrorTitle'),
      body: t('trash.mirrorBody', { provider: providerName(item.source) || '' }),
      confirmLabel: t('trash.restore'),
      tone: 'primary',
      onConfirm: async (_checked, done) => {
        await performTrashRestore(item);
        done();
      },
    });
    return;
  }
  performTrashRestore(item);
}

function handleTrashDeleteForever(id) {
  openDeleteForeverConfirm(id, null, {
    onDone: () => {
      trashItems = trashItems.filter((i) => i.id !== id);
      renderTrashList();
    },
  });
}

/**
 * Delegated, like stale.js's row actions: escAttr on a preview that contains
 * a quote breaks an inline onclick's JS literal, and the loaded list already
 * holds the row this reads from.
 */
function onTrashListClick(ev) {
  const btn = ev.target.closest('[data-action]');
  if (!btn) return;
  const row = btn.closest('.trash-item');
  if (!row) return;
  const item = trashItems.find((i) => i.id === row.dataset.id);
  if (!item) return;
  const action = btn.dataset.action;
  if (action === 'restore') handleTrashRestore(item);
  else if (action === 'delete-forever') handleTrashDeleteForever(item.id);
}

document.getElementById('trash-list')?.addEventListener('click', onTrashListClick);
