// The daily brief: what the brain did while you were away.
//
// Recall used to open on a hero line and a text box, with roughly 80% of the
// screen empty, on a brain holding thousands of memories that four nightly
// jobs had spent the night compressing, linking and judging. None of that work
// was visible anywhere until you went looking for it in a settings menu.
//
// Everything here is read back, never computed: one GET /brief, no AI calls.
// The brief is deliberately small and quiet — if nothing happened it says
// almost nothing rather than inventing activity, because a home screen that
// manufactures news to justify itself is worse than an empty one.

/** Cached for the session: the brief describes the night, not the minute. */
let briefData = null

async function loadBrief() {
  const el = document.getElementById('brief')
  if (!el) return
  try {
    const res = await fetch(`${WORKER_URL}/brief`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    if (!res.ok) return // an older Worker has no /brief; the hero stays
    briefData = await res.json()
    if (!briefData.ok) return
    if (typeof renderHome === 'function') renderHome(briefData)
    renderBrief(briefData)
  } catch {
    // Offline or a stale deploy — the welcome hero is a fine fallback.
  }
}

/**
 * Two weeks of captures as a bar strip. Deliberately unlabelled: the shape is
 * the information — whether the last fortnight was steady, bursty, or quiet —
 * and axis furniture would cost more space than it explains. Exact counts live
 * in the tooltips.
 */
function briefActivity(activity) {
  if (!activity || !activity.length) return ''
  const peak = Math.max(...activity.map((d) => d.count), 1)
  const bars = activity
    .map((d) => {
      const pct = Math.round((d.count / peak) * 100)
      const when = formatDateUI(d.day * 86400000, { month: 'short', day: 'numeric' })
      const title = tPlural('brief.activityTitle', d.count, { date: when })
      return `<span class="spark-bar${d.count ? '' : ' spark-bar--empty'}" style="height:${Math.max(pct, 3)}%" title="${escAttr(title)}"></span>`
    })
    .join('')
  return `<div class="brief-panel">
      <div class="brief-label">${escHtml(t('brief.lastDays', { n: activity.length }))}</div>
      <div class="spark">${bars}</div>
    </div>`
}

/** Where memories came from, as proportion rather than a list of numbers. */
function briefSources(sources) {
  if (!sources || !sources.length) return ''
  const total = sources.reduce((sum, s) => sum + s.count, 0) || 1
  const rows = sources
    .slice(0, 4)
    .map((s) => {
      const badge = sourceBadge(s.source)
      const pct = Math.round((s.count / total) * 100)
      return `<div class="src-row">
        <span class="src-name"><i class="ti ${badge.icon}"></i>${escHtml(badge.label)}</span>
        <span class="src-bar"><span class="src-fill" style="width:${pct}%"></span></span>
        <span class="src-n">${s.count}</span>
      </div>`
    })
    .join('')
  return `<div class="brief-panel">
      <div class="brief-label">${escHtml(t('brief.whereFrom'))}</div>
      ${rows}
    </div>`
}

/**
 * The only row that asks for anything. Silent when there is nothing to do,
 * because a dashboard that always shows a chore invents chores.
 */
function briefAttention(a) {
  if (!a) return ''
  const items = []
  if (a.unindexed > 0) {
    items.push(`<button class="attn" onclick="openMenu()"><i class="ti ti-eye-off"></i>${escHtml(t('brief.attentionUnindexed', { n: a.unindexed }))}</button>`)
  }
  if (a.stale > 0) {
    items.push(`<button class="attn" onclick="sendSuggestion('${escAttr(t('recall.sugOutOfDate'))}')"><i class="ti ti-clock-exclamation"></i>${escHtml(t('brief.attentionStale', { n: a.stale }))}</button>`)
  }
  if (!items.length) return ''
  return `<div class="brief-attention">${items.join('')}</div>`
}

function renderBrief(data) {
  const el = document.getElementById('brief')
  const hero = document.getElementById('recall-welcome')

  // Topics live under the home input, where they read as questions worth
  // asking. Repeating them here as a panel said the same thing twice on one
  // screen.
  const panels = [briefActivity(data.activity), briefSources(data.sources)].filter(Boolean)

  const cards = []
  // Patterns are excluded from recall until ruled on, so one sitting unseen in
  // a settings menu is the same as one thrown away.
  for (const p of (data.patterns || []).slice(0, 2)) {
    cards.push(`
      <div class="brief-card" data-pattern="${escAttr(p.id)}">
        <div class="brief-label">${escHtml(t('brief.patternNoticed'))}</div>
        <div class="brief-body">${escHtml(titleLine(p.content, 140))}</div>
        <div class="brief-actions">
          <button class="digest-btn" onclick="briefResolvePattern('${escAttr(p.id)}', 'confirm', this)">${escHtml(t('brief.confirm'))}</button>
          <button class="digest-btn danger" onclick="briefResolvePattern('${escAttr(p.id)}', 'dismiss', this)">${escHtml(t('brief.dismiss'))}</button>
        </div>
      </div>`)
  }
  if (data.resurface) {
    const when = data.resurface.created_at
      ? formatDateUI(data.resurface.created_at, { year: 'numeric', month: 'short', day: 'numeric' })
      : ''
    cards.push(`
      <div class="brief-card brief-card--quiet">
        <div class="brief-label">${escHtml(when ? `${t('brief.worthRereading')}${t('brief.fromDate', { date: when })}` : t('brief.worthRereading'))}</div>
        <div class="brief-body">${escHtml(titleLine(data.resurface.content, 180))}</div>
      </div>`)
  }

  const attention = briefAttention(data.attention)
  // Attention is the most actionable thing here, so it decides on its own
  // whether the brief has something to say. Gating it behind the panels meant a
  // brain whose only news was "2 not searchable" showed nothing at all.
  if (!attention && !panels.length && !cards.length) return

  // The home composition owns the top of the screen now, so the brief renders
  // below it and leads with the row that asks for something rather than with
  // the headline count, which the greeting already carries.
  if (hero) hero.style.display = 'none'
  el.style.display = ''
  el.innerHTML =
    attention +
    `<div class="brief-eyebrow">${escHtml(t('brief.eyebrow'))}</div>` +
    (panels.length ? `<div class="brief-grid">${panels.join('')}</div>` : '') +
    cards.join('')
}

/** Confirm or dismiss without leaving the brief; the row settles in place. */
async function briefResolvePattern(id, action, btn) {
  const card = btn.closest('.brief-card')
  card.querySelectorAll('button').forEach((b) => (b.disabled = true))
  btn.classList.add('digest-btn--loading')
  btn.innerHTML = `<i class="ti ti-loader-2"></i> ${escHtml(t('upkeep.working'))}`
  try {
    const res = await fetch(`${WORKER_URL}/patterns/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ id, action }),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'failed')
    card.innerHTML = `<div class="brief-label">${escHtml(action === 'confirm' ? t('brief.confirmed') : t('brief.dismissed'))}</div>`
    card.classList.add('brief-card--quiet')
  } catch {
    card.querySelectorAll('button').forEach((b) => (b.disabled = false))
    btn.classList.remove('digest-btn--loading')
    btn.innerHTML = escHtml(t('brief.failedRetry'))
  }
}
