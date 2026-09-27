// ── Brain-version what's-new line (T-0101.8.4, TR-3) ──────────────────────
//
// Shown for 14 days from history_since (the 3.7-to-4.0 upgrade marker),
// to every reader — owners and teammates alike (Q8). Dismissing it is
// permanent for that browser; nothing else nags about it again.
//
// There is no static container for this in index.html (5.3: this lane's
// only index.html regions are the Memories foot, the menu groups and the
// two new sheets), so the line builds and inserts its own element, once,
// directly above the board tiles.

const WHATS_NEW_DISMISS_KEY = 'sb-whats-new-4';
/** Fallback clock for a brain whose /health has no history_since (older Worker,
 * or the marker was never set) — 14 days from the first time THIS browser saw it. */
const WHATS_NEW_FIRST_SEEN_KEY = 'sb-whats-new-4-first-seen';
const WHATS_NEW_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

function whatsNewMajor(version) {
  const m = String(version || '').match(/^(\d+)\./);
  return m ? Number(m[1]) : null;
}

function whatsNewIsDismissed() {
  try {
    return localStorage.getItem(WHATS_NEW_DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

/** history_since when the Worker sent one; otherwise this browser's own
 * first-seen marker, set the first time this function is asked. */
function whatsNewWindowStart(historySince) {
  if (typeof historySince === 'number') return historySince;
  try {
    const stored = localStorage.getItem(WHATS_NEW_FIRST_SEEN_KEY);
    if (stored != null) return Number(stored);
    const now = Date.now();
    localStorage.setItem(WHATS_NEW_FIRST_SEEN_KEY, String(now));
    return now;
  } catch {
    return Date.now();
  }
}

function dismissWhatsNew() {
  try {
    localStorage.setItem(WHATS_NEW_DISMISS_KEY, '1');
  } catch {}
  const el = document.getElementById('whats-new-line');
  if (el) el.hidden = true;
}

function hideWhatsNewLine() {
  const el = document.getElementById('whats-new-line');
  if (el) el.hidden = true;
}

function ensureWhatsNewLine() {
  let el = document.getElementById('whats-new-line');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'whats-new-line';
  el.className = 'whats-new-line';
  if (typeof el.setAttribute === 'function') el.setAttribute('role', 'status');
  const tiles = document.getElementById('board-tiles');
  if (tiles && tiles.parentNode) tiles.parentNode.insertBefore(el, tiles);
  else if (document.body) document.body.appendChild(el);
  return el;
}

/**
 * @param {{version?: string, history_since?: number}|null|undefined} health
 *   the /health body renderRailNote already fetched, passed through rather
 *   than fetched a second time.
 */
async function renderWhatsNewLine(health) {
  const major = whatsNewMajor(health && health.version);
  if (major == null || major < 4 || whatsNewIsDismissed()) {
    hideWhatsNewLine();
    return;
  }

  const windowStart = whatsNewWindowStart(health && health.history_since);
  if (Date.now() >= windowStart + WHATS_NEW_WINDOW_MS) {
    hideWhatsNewLine();
    return;
  }

  // Best-effort: readTeamConfig() is the same coalesced GET /config the
  // settings panel uses. A failed read still shows the line, with the
  // shipped default rather than blocking on it.
  let retentionDays = 14;
  try {
    const data = await readTeamConfig();
    if (typeof data?.config?.TRASH_RETENTION_DAYS === 'number') retentionDays = data.config.TRASH_RETENTION_DAYS;
  } catch {}

  const el = ensureWhatsNewLine();
  el.innerHTML = `
    <span class="whats-new-text">${escHtml(t('whatsNew.line', { n: retentionDays }))}</span>
    <button type="button" class="whats-new-see" onclick="openTrashSheet()">${escHtml(t('whatsNew.seeTrash'))}</button>
    <button type="button" class="whats-new-dismiss" onclick="dismissWhatsNew()" aria-label="${escAttr(t('whatsNew.dismissLabel'))}" title="${escAttr(t('whatsNew.dismiss'))}"><i class="ti ti-x"></i></button>`;
  el.hidden = false;
}
