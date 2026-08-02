// ── Integrations (registry-driven) ────────────────────────────────────

// Ordered category groups for the two-level integrations UI. Only categories
// that have at least one registered provider are shown, so Email appears
// automatically once email providers are registered.
const CATEGORY_META = [
  { id: 'knowledge', name: 'Knowledge', icon: 'ti-notebook' },
  { id: 'calendar', name: 'Calendars', icon: 'ti-calendar' },
  { id: 'email', name: 'Email', icon: 'ti-mail' },
]

const INTEGRATION_ICONS = {
  notion: 'ti-brand-notion',
  'calendar-google': 'ti-brand-google',
  'calendar-outlook': 'ti-brand-windows',
  'calendar-icloud': 'ti-brand-apple',
}
// Notion keeps its bespoke connect copy; calendar providers ship their own connectHint.
const NOTION_HINT =
  'Create an internal <b>connection</b> (not a personal access token) at ' +
  '<a href="https://app.notion.com/developers/connections" target="_blank" rel="noopener noreferrer">app.notion.com/developers/connections</a>, ' +
  'share the pages you want remembered with it (page menu &rarr; Connections), then paste its secret here.'

async function loadIntegrations() {
  const el = document.getElementById('integrations-list')
  try {
    const res = await fetch(`${WORKER_URL}/integrations`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    const data = await res.json()
    integrationsInfo = data.integrations || []
    renderIntegrations()
  } catch {
    el.innerHTML = '<p class="digest-note">Could not load integrations.</p>'
  }
}

// Resolve a provider's category id, falling back to 'other' so nothing is lost.
function integrationCategoryId(info) {
  return CATEGORY_META.some((c) => c.id === info.category) ? info.category : 'other'
}

function categoryMeta(id) {
  return CATEGORY_META.find((c) => c.id === id) || { id, name: 'Other', icon: 'ti-plug' }
}

// Categories present in the data, in CATEGORY_META order, with any leftover
// 'other' bucket last.
function presentCategories() {
  const present = new Set(integrationsInfo.map(integrationCategoryId))
  const ordered = CATEGORY_META.filter((c) => present.has(c.id))
  if (present.has('other')) ordered.push(categoryMeta('other'))
  return ordered
}

// Header back-button / title / intro reflect the current level.
function renderIntegrationsChrome() {
  const back = document.getElementById('integrations-back')
  const title = document.getElementById('integrations-title')
  const intro = document.getElementById('integrations-intro')
  if (currentCategory) {
    title.textContent = categoryMeta(currentCategory).name
    back.setAttribute('title', 'Back to integrations')
    back.onclick = backToCategoryList
    intro.style.display = 'none'
  } else {
    title.textContent = 'Integrations'
    back.setAttribute('title', 'Back to settings')
    back.onclick = backToMenu
    intro.style.display = ''
  }
}

function renderIntegrations() {
  renderIntegrationsChrome()
  const el = document.getElementById('integrations-list')
  if (!integrationsInfo.length) {
    el.innerHTML = '<p class="digest-note">No integrations available.</p>'
    return
  }
  if (currentCategory) {
    const cards = integrationsInfo
      .filter((i) => integrationCategoryId(i) === currentCategory)
      .map(renderIntegrationCard)
      .join('')
    el.innerHTML = cards || '<p class="digest-note">Nothing here yet.</p>'
    return
  }
  el.innerHTML = presentCategories().map(renderCategoryRow).join('')
}

function renderCategoryRow(cat) {
  const items = integrationsInfo.filter((i) => integrationCategoryId(i) === cat.id)
  const connected = items.filter((i) => i.connected).length
  const summary = connected > 0 ? `${connected} connected` : 'Not connected'
  return `
    <button class="integration-category-row" onclick="openCategory('${cat.id}')">
      <i class="ti ${cat.icon}"></i>
      <span class="integration-category-name">${escHtml(cat.name)}</span>
      <span class="integration-category-summary">${summary}</span>
      <i class="ti ti-chevron-right integration-category-chevron"></i>
    </button>`
}

function openCategory(id) {
  currentCategory = id
  renderIntegrations()
}
function backToCategoryList() {
  currentCategory = null
  renderIntegrations()
}

function renderIntegrationCard(info) {
  const p = info.provider
  const icon = INTEGRATION_ICONS[p] || 'ti-plug'
  if (!info.connected) {
    const hint = p === 'notion' ? NOTION_HINT : (info.connectHint || '')
    const label = escHtml(info.connectLabel || 'Paste your secret')
    const isEmail = p.startsWith('email')
    let inputs
    if (isEmail) {
      // Email needs two fields; connectIntegration packs them into the token.
      inputs =
        `<input type="email" id="email-${p}" placeholder="you@example.com" aria-label="Email address" autocomplete="off" />` +
        `<input type="password" id="tok-${p}" placeholder="${escHtml(info.connectPlaceholder || 'app password')}" aria-label="App password" autocomplete="off" />`
    } else {
      const placeholder = escHtml(info.connectPlaceholder || (p === 'notion' ? 'Integration secret (ntn_…)' : 'https://…'))
      inputs = `<input type="password" id="tok-${p}" placeholder="${placeholder}" aria-label="${label}" autocomplete="off" />`
    }
    return `
      <div class="integration-row">
        <div class="integration-head"><i class="ti ${icon}"></i><span>${escHtml(info.name)}</span><span class="integration-state">Not connected</span></div>
        <p class="digest-note">${hint}</p>
        <div class="integration-connect-row${isEmail ? ' integration-connect-col' : ''}">
          ${inputs}
          <button class="digest-btn" onclick="connectIntegration('${p}', this)">Connect</button>
        </div>
        <div class="integration-error" id="err-${p}"></div>
      </div>`
  }
  const last = info.lastSyncedAt ? new Date(info.lastSyncedAt).toLocaleString() : 'never'
  const noun = p.startsWith('calendar') ? 'event' : p.startsWith('email') ? 'email' : 'item'
  const count = `${info.itemCount} ${noun}${info.itemCount === 1 ? '' : 's'} synced`
  const err = info.lastSyncError ? `<div class="integration-error">Last sync failed: ${escHtml(info.lastSyncError)}</div>` : ''
  return `
    <div class="integration-row">
      <div class="integration-head"><i class="ti ${icon}"></i><span>${escHtml(info.name)}</span><span class="integration-state connected">${escHtml(info.workspaceName || 'Connected')}</span></div>
      <p class="digest-note" id="note-${p}">${count} &middot; Last sync: ${escHtml(last)}</p>
      ${err}
      <div class="integration-actions">
        <button class="digest-btn" onclick="syncIntegration('${p}', this)"><i class="ti ti-refresh"></i> Sync now</button>
        <button class="digest-btn danger" onclick="disconnectIntegration('${p}', this)">Disconnect</button>
      </div>
    </div>`
}

async function connectIntegration(provider, btn) {
  const errEl = document.getElementById(`err-${provider}`)
  let token
  if (provider.startsWith('email')) {
    const email = (document.getElementById(`email-${provider}`).value || '').trim()
    const pw = (document.getElementById(`tok-${provider}`).value || '').trim()
    if (!email || !pw) { errEl.textContent = 'Enter your email and app password.'; return }
    token = JSON.stringify({ email: email, appPassword: pw })
  } else {
    token = (document.getElementById(`tok-${provider}`).value || '').trim()
    if (!token) { errEl.textContent = 'Paste your secret first.'; return }
  }
  btn.disabled = true
  btn.textContent = 'Connecting…'
  errEl.textContent = ''
  try {
    const res = await fetch(`${WORKER_URL}/integrations/${provider}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ token }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || 'Could not connect')
    await loadIntegrations()
    // Kick off the first sync automatically.
    const syncBtn = document.querySelector(`[onclick^="syncIntegration('${provider}'"]`)
    if (syncBtn) syncIntegration(provider, syncBtn)
  } catch (e) {
    errEl.textContent = e.message || 'Could not connect.'
    btn.disabled = false
    btn.textContent = 'Connect'
  }
}

async function syncIntegration(provider, btn) {
  btn.disabled = true
  btn.classList.add('digest-btn--loading')
  btn.innerHTML = '<i class="ti ti-loader-2"></i> Syncing…'
  const note = document.getElementById(`note-${provider}`)
  const noun = provider.startsWith('calendar') ? 'event' : provider.startsWith('email') ? 'email' : 'item'
  try {
    // Each call processes a bounded batch and reports what's left — loop
    // until the backlog drains (same pattern as runVectorize).
    let remaining = 1, processed = 0, guard = 0
    while (remaining > 0 && guard < 40) {
      guard++
      const res = await fetch(`${WORKER_URL}/integrations/${provider}/sync`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || 'Sync failed')
      processed += (data.created ?? 0) + (data.updated ?? 0)
      remaining = data.remaining ?? 0
      if (note) note.textContent = `Syncing… ${processed} ${noun}${processed === 1 ? '' : 's'} so far`
      // A batch with zero progress means everything in it failed — stop.
      if ((data.created ?? 0) + (data.updated ?? 0) + (data.deleted ?? 0) === 0 && remaining > 0) break
    }
    btn.classList.remove('digest-btn--loading')
    btn.innerHTML = `<i class="ti ti-check"></i> ${processed} synced`
    btn.style.color = 'var(--good)'
    setTimeout(loadIntegrations, 900)
    loadRecent()
    loadTags()
    updateStatus()
  } catch (e) {
    btn.classList.remove('digest-btn--loading')
    btn.innerHTML = '<i class="ti ti-alert-triangle"></i> Sync failed'
    btn.style.color = 'var(--danger)'
    setTimeout(loadIntegrations, 3000)
  }
}

async function disconnectIntegration(provider, btn) {
  const info = integrationsInfo.find((i) => i.provider === provider) || {}
  if (!confirm(`Disconnect ${info.name || provider}? It will stop syncing.`)) return
  let purge = false
  if (info.itemCount > 0) {
    purge = confirm(
      `Also delete the ${info.itemCount} synced memor${info.itemCount === 1 ? 'y' : 'ies'}?\n\nOK = delete them\nCancel = keep them as regular memories`,
    )
  }
  btn.disabled = true
  btn.textContent = 'Disconnecting…'
  try {
    const res = await fetch(`${WORKER_URL}/integrations/${provider}/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ purge }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || 'Disconnect failed')
    await loadIntegrations()
    if (purge) { loadRecent(); loadTags(); updateStatus() }
  } catch (e) {
    btn.disabled = false
    btn.textContent = 'Disconnect'
    alert(e.message || 'Disconnect failed')
  }
}
