async function loadRecent() {
  const list = document.getElementById('recent-list')
  const btn = document.getElementById('refresh-btn')
  btn.classList.add('spinning')
  list.innerHTML = `<div class="empty-state"><i class="ti ti-clock"></i><span>Loading...</span></div>`
  try {
    allEntries = await apiList(50)
    renderRecent(allEntries)
    showFirstRunIfEmpty(allEntries.length === 0)
    updateStatus()
    loadTags()
  } catch {
    list.innerHTML = `<div class="empty-state"><i class="ti ti-wifi-off"></i><span>Could not load memories.</span></div>`
  }
  btn.classList.remove('spinning')
}

// A brand-new brain has nothing to recall, so the usual prompt and its
// suggestions would all come back empty. Say where things live instead.
function showFirstRunIfEmpty(isEmpty) {
  const welcome = document.getElementById('recall-welcome')
  const suggestions = document.querySelector('.suggestions-row')
  if (!welcome) return
  if (!isEmpty) {
    if (suggestions) suggestions.style.display = ''
    welcome.classList.remove('first-run')
    return
  }
  if (suggestions) suggestions.style.display = 'none'
  welcome.classList.add('first-run')
  welcome.innerHTML =
    `<div class="eyebrow">Getting started</div>` +
    `<div class="hero-line">Your Second Brain is empty. Here is where everything lives.</div>` +
    `<ol class="first-run-steps">` +
    `<li><b>Remember</b> saves something. Try it with a decision you made this week.</li>` +
    `<li><b>Recall</b> finds it later by meaning, so you do not need the words you used.</li>` +
    `<li><b>Settings</b> is where you connect Claude, ChatGPT, Cursor, your email and calendar, ` +
    `so they read from and add to this same memory.</li>` +
    `</ol>`
}

function renderRecent(entries) {
  const list = document.getElementById('recent-list')
  if (!entries.length) {
    list.innerHTML = `<div class="empty-state"><i class="ti ti-brain"></i><span>No memories yet.<br>Use Remember to save your first one.</span></div>`
    return
  }
  const groups = {},
    now = new Date()
  const today = toDateStr(now),
    yesterday = toDateStr(new Date(now - 86400000))
  const sevenDaysAgo = now.getTime() - 7 * 86400000
  entries.forEach((entry) => {
    const d = new Date(entry.created_at),
      ds = toDateStr(d)
    let label
    if (ds === today) {
      label = 'Today'
    } else if (ds === yesterday) {
      label = 'Yesterday'
    } else if (entry.created_at >= sevenDaysAgo) {
      label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    } else {
      // Group by week: find the Monday of that week
      const dow = d.getDay()
      const diff = dow === 0 ? -6 : 1 - dow
      const weekStart = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff)
      label = 'Week of ' + weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    }
    if (!groups[label]) groups[label] = []
    groups[label].push(entry)
  })
  list.innerHTML = ''
  Object.entries(groups).forEach(([label, group]) => {
    const g = document.createElement('div')
    g.className = 'date-group'
    g.innerHTML = `<div class="date-label">${label}</div>`
    const cards = document.createElement('div')
    cards.className = 'recent-cards'
    group.forEach((e) => cards.appendChild(makeRecentCard(e)))
    g.appendChild(cards)
    list.appendChild(g)
  })
}

function makeRecentCard(entry) {
  let tags = []
  try {
    tags = JSON.parse(entry.tags || '[]')
  } catch {}
  const isSynthesized = tags.includes('synthesized')
  const isRolledUp = tags.includes('rolled-up')
  const isStale = tags.includes('stale:as-of')

  let vectorIds = []
  try {
    vectorIds = JSON.parse(entry.vector_ids || '[]')
  } catch {}
  const vectorized = vectorIds.length > 0
  // Pending state is computed at render time; won't auto-flip — reload required
  const pending = !vectorized && Date.now() - (entry.created_at || 0) < vectorizeGraceMs
  const vec = vectorized ? 'on' : pending ? 'pending' : 'off'

  const vecChip =
    vec === 'on'
      ? `<span class="tag-chip vec-chip vec-chip--on" title="Vectorized — searchable via recall"><i class="ti ti-circle-check"></i></span>`
      : vec === 'pending'
        ? `<span class="tag-chip vec-chip vec-chip--pending" title="Vectorizing… (just captured)"><i class="ti ti-clock"></i></span>`
        : `<span class="tag-chip vec-chip vec-chip--off" title="Not vectorized — won't appear in recall">Not indexed</span>`

  const card = document.createElement('div')
  card.className = 'memory-card' + (isSynthesized ? ' card--synthesized' : '') + (isRolledUp ? ' card--rolled-up' : '') + (isStale ? ' card--stale' : '')
  card.dataset.id = entry.id
  card.innerHTML = `
<div class="card-content" style="cursor: pointer;">${escHtml(entry.content)}</div>
<div class="card-footer">
  <div class="card-tags">${tags.map((t) => `<span class="tag-chip${t === 'synthesized' ? ' tag-chip--synthesized' : ''}">${escHtml(t)}</span>`).join('')}${vecChip}</div>
  <div class="card-actions">
    <button class="card-action-btn" onclick="openAppend('${escAttr(entry.id)}', '${escAttr(entry.content.slice(0, 80))}')"><i class="ti ti-writing"></i> Append</button>
    <button class="card-action-btn edit-btn"><i class="ti ti-pencil"></i> Edit</button>
    <button class="card-action-btn" onclick="openConfirm('${escAttr(entry.id)}', this)"><i class="ti ti-x"></i> Forget</button>
  </div>
</div>`
  card.querySelector('.card-content').onclick = () => openView({ id: entry.id, content: entry.content, tags }, card)
  card.querySelector('.edit-btn').onclick = () => openEdit(entry.id, entry.content, tags)
  return card
}
