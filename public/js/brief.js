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
    renderBrief(briefData)
  } catch {
    // Offline or a stale deploy — the welcome hero is a fine fallback.
  }
}

/**
 * The stat line, in the marketing site's own idiom: a big sans numeral with an
 * italic serif unit ("2 min", "100%"). It is the one line that has to earn the
 * space, so it says what grew and where it came from.
 */
function briefStatLine(data) {
  if (!data.captured) return ''
  const sources = (data.sources || []).length
  return `
    <div class="brief-stat">
      <span class="brief-num">${data.captured}</span><span class="brief-unit">${data.captured === 1 ? 'memory' : 'memories'}</span>
      <span class="brief-sep">·</span>
      <span class="brief-num">${sources}</span><span class="brief-unit">${sources === 1 ? 'source' : 'sources'}</span>
      <span class="brief-since">in the last ${data.window_hours || 48} hours</span>
    </div>`
}

/**
 * Questions built from the brain's own vocabulary rather than a fixed list.
 * "What did I decide about signpath?" is worth asking; "Show my tasks" is
 * what every brain shows every user forever.
 */
function briefSuggestions(data) {
  const tags = humanTags(briefTopics(data))
  if (!tags.length) return ''
  return `
    <div class="brief-suggestions">
      ${tags
        .slice(0, 3)
        .map(
          (t) =>
            `<button class="suggestion-pill" onclick="sendSuggestion('What did I decide about ${escAttr(t)}?')">What about ${escHtml(t)}?</button>`,
        )
        .join('')}
    </div>`
}

/** Topic tags seen on the patterns and resurfaced memory the brief already has. */
function briefTopics(data) {
  const seen = []
  for (const p of data.patterns || []) {
    for (const t of extractInlineTags(p.content)) if (!seen.includes(t)) seen.push(t)
  }
  return seen
}

/** Hashtags a pattern's own text carries — no extra request to learn a topic. */
function extractInlineTags(content) {
  return (String(content || '').match(/#([a-zA-Z][\w-]{2,})/g) || []).map((t) => t.slice(1).toLowerCase())
}

function renderBrief(data) {
  const el = document.getElementById('brief')
  const hero = document.getElementById('recall-welcome')
  const blocks = []

  const stat = briefStatLine(data)
  if (stat) blocks.push(stat)

  // Patterns are excluded from recall until ruled on, so one sitting unseen in
  // a settings menu is the same as one thrown away.
  for (const p of (data.patterns || []).slice(0, 2)) {
    blocks.push(`
      <div class="brief-card" data-pattern="${escAttr(p.id)}">
        <div class="brief-label">Pattern noticed</div>
        <div class="brief-body">${escHtml(titleLine(p.content, 140))}</div>
        <div class="brief-actions">
          <button class="digest-btn" onclick="briefResolvePattern('${escAttr(p.id)}', 'confirm', this)">Confirm</button>
          <button class="digest-btn danger" onclick="briefResolvePattern('${escAttr(p.id)}', 'dismiss', this)">Dismiss</button>
        </div>
      </div>`)
  }

  if (data.resurface) {
    const when = data.resurface.created_at
      ? new Date(data.resurface.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      : ''
    blocks.push(`
      <div class="brief-card brief-card--quiet">
        <div class="brief-label">Worth re-reading${when ? ` · from ${escHtml(when)}` : ''}</div>
        <div class="brief-body">${escHtml(titleLine(data.resurface.content, 180))}</div>
      </div>`)
  }

  if (!blocks.length) return // nothing happened; the hero says it better

  if (hero) hero.style.display = 'none'
  el.style.display = ''
  el.innerHTML = `<div class="brief-eyebrow">Your brain, lately</div>${blocks.join('')}${briefSuggestions(data)}`
}

/** Confirm or dismiss without leaving the brief; the row settles in place. */
async function briefResolvePattern(id, action, btn) {
  const card = btn.closest('.brief-card')
  card.querySelectorAll('button').forEach((b) => (b.disabled = true))
  btn.classList.add('digest-btn--loading')
  btn.innerHTML = '<i class="ti ti-loader-2"></i> Working…'
  try {
    const res = await fetch(`${WORKER_URL}/patterns/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ id, action }),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'failed')
    card.innerHTML = `<div class="brief-label">${action === 'confirm' ? 'Confirmed — now recallable' : 'Dismissed'}</div>`
    card.classList.add('brief-card--quiet')
  } catch {
    card.querySelectorAll('button').forEach((b) => (b.disabled = false))
    btn.classList.remove('digest-btn--loading')
    btn.innerHTML = 'Failed — retry'
  }
}
