async function loadTags() {
  try {
    const res = await fetch(`${WORKER_URL}/tags`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    // Filtering by `kind:episodic` is a thing the brain does, not a thing a
    // person browses by — the dropdown offers the user's own vocabulary only.
    const tags = humanTags(await res.json())
    ;['tag-filter-recent', 'tag-filter-recall'].forEach((id) => {
      const sel = document.getElementById(id)
      if (!sel) return
      sel.innerHTML = '<option value="">All tags</option>'
      tags.forEach((t) => {
        const opt = document.createElement('option')
        opt.value = t
        opt.textContent = t
        if (t === selectedTag) opt.selected = true
        sel.appendChild(opt)
      })
    })
  } catch {}
}

function onTagChange(tag) {
  selectedTag = tag
  ;['tag-filter-recent', 'tag-filter-recall'].forEach((id) => {
    const el = document.getElementById(id)
    if (el) el.value = tag
  })
  if (currentTab === 'recent') applyRecentFilters()
}

function onTimeRangeChange(val) {
  selectedTimeRange = val
  applyRecentFilters()
}

function applyRecentFilters() {
  let entries = allEntries
  if (selectedTag) {
    const tag = selectedTag.replace(/^#/, '').toLowerCase().trim()
    entries = entries.filter((e) => {
      try {
        return JSON.parse(e.tags || '[]').some((t) => t.toLowerCase() === tag)
      } catch {
        return false
      }
    })
  }
  if (selectedTimeRange) {
    const now = Date.now(),
      MS_DAY = 86400000
    let cutoff
    if (selectedTimeRange === 'today') {
      const d = new Date()
      cutoff = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    } else if (selectedTimeRange === 'month') {
      const d = new Date()
      cutoff = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
    } else {
      cutoff = now - parseInt(selectedTimeRange) * MS_DAY
    }
    entries = entries.filter((e) => e.created_at >= cutoff)
  }
  renderRecent(entries)
}

function switchTab(tab) {
  currentTab = tab
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'))
  document.querySelectorAll('.nav-tab, .sb-tab').forEach((t) => t.classList.remove('active'))
  document.getElementById('screen-' + tab).classList.add('active')
  document.getElementById('tab-' + tab).classList.add('active')
  const sbTab = document.getElementById('sb-tab-' + tab)
  if (sbTab) sbTab.classList.add('active')
  if (tab === 'recent') loadRecent()
  if (tab === 'graph') loadGraph()
}

async function updateStatus() {
  try {
    const res = await fetch(`${WORKER_URL}/count`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    const data = await res.json()
    currentCount = data.count ?? 0
    const text = currentCount === 0 ? 'always remembers' : `${currentCount} memor${currentCount === 1 ? 'y' : 'ies'} stored`
    document.getElementById('topbar-status').textContent = text
    const sb = document.getElementById('sb-status')
    if (sb) sb.textContent = text
  } catch {}
}

async function checkVectorize() {
  try {
    const res = await fetch(`${WORKER_URL}/health`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    const data = await res.json()
    renderVectorizeBanner(vectorizeHealthBanner(data))
  } catch {}
}

// Thin wrapper over the unit-tested syncVectorizeBanner in utils.js, which
// owns the mount/update/remove + body-offset logic against the real document.
function renderVectorizeBanner(banner) {
  syncVectorizeBanner(document, banner)
}

// Row overflow menus close on any outside click or Escape — they are transient
// affordances, not state, and leaving one open behind a scroll is a trap.
document.addEventListener('click', () => {
  document.querySelectorAll('.card-overflow-menu').forEach((m) => (m.hidden = true))
  document.querySelectorAll('.card--menu-open').forEach((c) => c.classList.remove('card--menu-open'))
  document.querySelectorAll('.overflow-btn').forEach((b) => b.setAttribute('aria-expanded', 'false'))
})
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  document.querySelectorAll('.card-overflow-menu').forEach((m) => (m.hidden = true))
  document.querySelectorAll('.card--menu-open').forEach((c) => c.classList.remove('card--menu-open'))
})
