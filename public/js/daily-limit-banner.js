// ── Free-plan daily database limit banner (T-0101.10) ─────────────────────
//
// Rahil's rule: a team on the free plan must hit a clear, visible limit,
// never silent breakage. Any dashboard API call can answer 429 with
// { ok:false, error:"daily_limit", limit, resets_at, message } (BE lane,
// v4/ux-be-2). Wrapping fetch once here, rather than editing every call
// site across every lane, is what makes "any call" true without touching
// files this lane does not own.
//
// The banner is appended to document.body directly (there is no static
// container for it, and it has to be visible regardless of which screen
// is active) and persists across screens until a later call succeeds.

/**
 * The BE contract given for this task names these "d1_rows_written" and
 * "d1_rows_read"; the copywriter's deck (drafted from the same lane's work
 * in progress) names them "rows_written" and "rows_read". Both spellings
 * are accepted rather than betting on which one ships.
 */
const DAILY_LIMIT_WRITE_KEYS = new Set(['rows_written', 'd1_rows_written']);

/**
 * Cloudflare's own dashboard deep-link pattern for the Workers & Pages
 * section (where the free-to-paid usage model change lives), documented at
 * developers.cloudflare.com/workers/platform/pricing/ and
 * developers.cloudflare.com/style-guide/build-the-page/components/dash-button/.
 * ":account" is resolved by the dashboard to the signed-in viewer's own
 * account, so one static link works for every Second Brain owner.
 */
const DAILY_LIMIT_UPGRADE_URL = 'https://dash.cloudflare.com/?to=/:account/workers-and-pages';

let dailyLimitShown = false;

function ensureDailyLimitBanner() {
  let el = document.getElementById('daily-limit-banner');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'daily-limit-banner';
  el.className = 'daily-limit-banner';
  el.setAttribute('role', 'status');
  el.hidden = true;
  if (document.body) document.body.appendChild(el);
  return el;
}

function hideDailyLimitBanner() {
  if (!dailyLimitShown) return;
  dailyLimitShown = false;
  const el = document.getElementById('daily-limit-banner');
  if (el) el.hidden = true;
  updateDailyLimitOffset();
}

/**
 * The banner is a fixed overlay (it has to survive every screen, and #app's
 * own height:100vh/100svh would otherwise fight a normal-flow banner for
 * space, with body's overflow:hidden clipping whichever one loses), so #app
 * has to be told how tall the banner actually is. Wrapped text (a longer
 * locale, or a narrow width) can grow the banner to two or three lines, so
 * this is measured rather than guessed at a fixed height.
 */
function updateDailyLimitOffset() {
  const el = document.getElementById('daily-limit-banner');
  const height = el && !el.hidden ? el.offsetHeight || 0 : 0;
  if (document.documentElement && document.documentElement.style) {
    document.documentElement.style.setProperty('--daily-limit-height', height + 'px');
  }
  if (document.body && document.body.classList) {
    document.body.classList.toggle('daily-limit-active', height > 0);
  }
}

/**
 * The owner is always an admin (settings-panel.js and the desktop lane
 * both read teamIsAdmin the same way), so a solo brain - where team.js's
 * probe may not have resolved yet - defaults to showing the upgrade link
 * rather than wrongly telling an owner to go ask themselves.
 */
function dailyLimitViewerIsAdmin() {
  return typeof teamIsAdmin === 'undefined' || teamIsAdmin !== false;
}

function showDailyLimitBanner(data) {
  const el = ensureDailyLimitBanner();
  if (!el) return;
  dailyLimitShown = true;
  const time = formatDateUI(data.resets_at, { hour: 'numeric', minute: '2-digit' });
  const key = DAILY_LIMIT_WRITE_KEYS.has(data.limit) ? 'limits.bannerWrite' : 'limits.bannerRead';
  const action = dailyLimitViewerIsAdmin()
    ? `<a class="daily-limit-upgrade" href="${escAttr(DAILY_LIMIT_UPGRADE_URL)}" target="_blank" rel="noopener">${escHtml(t('limits.upgrade'))}</a>`
    : `<span class="daily-limit-ask">${escHtml(t('limits.askOwner'))}</span>`;
  el.innerHTML = `<span class="daily-limit-text">${escHtml(t(key, { time }))}</span>${action}`;
  el.hidden = false;
  updateDailyLimitOffset();
}

/**
 * Read the body without consuming it for the real caller: every other
 * module's existing `await res.json()` still has to work exactly as it did
 * with no wrapper here at all.
 */
async function checkDailyLimitResponse(res) {
  if (res.status !== 429) {
    if (res.ok) hideDailyLimitBanner();
    return;
  }
  try {
    const data = await res.clone().json();
    if (data && data.ok === false && data.error === 'daily_limit') showDailyLimitBanner(data);
  } catch {}
}

const _dailyLimitOriginalFetch = window.fetch ? window.fetch.bind(window) : null;

if (_dailyLimitOriginalFetch) {
  window.fetch = async function dailyLimitAwareFetch(...args) {
    const res = await _dailyLimitOriginalFetch(...args);
    await checkDailyLimitResponse(res);
    return res;
  };
}
