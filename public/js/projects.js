// Projects: a named home for related memories.
//
// Membership is a reserved `project:<slug>` tag on ordinary entries, so this
// screen manages the registry only. Everything else in the dashboard already
// filters by tag and just gains a `project` parameter.

/** Rows from the last GET /projects, active and archived together. */
let projectsList = []
/** True when the Worker hit its scan cap: every count is then a lower bound. */
let projectsCountsApprox = false
let projectsLoadFailed = false
let projectsArchivedOpen = false
let projectCreateOpen = false
/** Whether the last render showed the empty state, so leaving it can close the form. */
let projectsEmptyShown = false
let projectCreating = false

/**
 * The slug a name will be saved under: lowercase, spaces to hyphens, accents
 * folded, everything else dropped. Null when nothing usable is left.
 *
 * The create form posts this as the id, so what the preview shows is exactly
 * what gets saved rather than a second derivation on the Worker.
 */
function deriveProjectSlug(name) {
  const slug = String(name == null ? '' : name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^[-_]+/, '')
    .slice(0, 64)
    .replace(/[-_]+$/, '')
  return PROJECT_SLUG_RE.test(slug) ? slug : null
}

async function loadProjects() {
  const list = document.getElementById('projects-list')
  // A cold screen says so; a refresh leaves the rows alone rather than blanking them.
  if (!projectsList.length && list) {
    list.innerHTML = `<div class="empty-state"><i class="ti ti-clock"></i><span>${escHtml(t('projects.loading'))}</span></div>`
  }
  try {
    const res = await apiProjects()
    if (!res.ok) throw new Error(String(res.status))
    projectsList = Array.isArray(res.data.projects) ? res.data.projects : []
    projectsCountsApprox = !!res.data.counts_approximate
    projectsLoadFailed = false
  } catch {
    // Rows already on screen stay; only a cold screen becomes the error state.
    projectsLoadFailed = !projectsList.length
    if (projectsList.length) showToast(t('projects.loadFailed'))
  }
  renderProjectsList()
}

function projectCountLabel(p) {
  if (typeof p.count !== 'number') return ''
  // A lower bound cannot claim a project is empty.
  if (projectsCountsApprox) return p.count > 0 ? t('projects.countApprox', { n: formatNumberUI(p.count) }) : ''
  if (p.count === 0) return t('projects.countNone')
  return tPlural('projects.count', p.count, { n: formatNumberUI(p.count) })
}

/** Workspace badge, team brains only: a solo brain has no other layer to tell apart. */
function projectLayerBadge(p) {
  if (!TEAM_MODE) return ''
  const shared = p.layer === 'company'
  const icon = shared ? '<i class="ti ti-users-group"></i> ' : ''
  return `<span class="tag-chip${shared ? ' tag-chip--shared' : ''}">${icon}${escHtml(shared ? t('home.layerShared') : t('home.layerPersonal'))}</span>`
}

function renderProjectRow(p) {
  const archived = p.status === 'archived'
  const desc = String(p.description || '').split('\n')[0].trim()
  const count = projectCountLabel(p)
  return (
    `<button type="button" class="project-row${archived ? ' project-row--archived' : ''}" onclick="openProject('${escAttr(p.id)}', '${escAttr(p.layer || '')}')">` +
    `<span class="project-row-main">` +
    `<span class="project-row-name">${escHtml(p.name || p.id)}</span>` +
    (desc ? `<span class="project-row-desc">${escHtml(desc)}</span>` : '') +
    `</span>` +
    `<span class="project-row-meta">` +
    `<code class="project-row-slug">${escHtml(p.id)}</code>` +
    projectLayerBadge(p) +
    (count ? `<span class="project-row-count num">${escHtml(count)}</span>` : '') +
    `</span>` +
    `<i class="ti ti-chevron-right project-row-go" aria-hidden="true"></i>` +
    `</button>`
  )
}

function renderProjectsList() {
  const list = document.getElementById('projects-list')
  const empty = document.getElementById('projects-empty')
  const archivedWrap = document.getElementById('projects-archived')
  const archivedList = document.getElementById('projects-archived-list')
  const archivedToggle = document.getElementById('projects-archived-toggle')
  const newBtn = document.getElementById('project-new-btn')
  const layerWrap = document.getElementById('project-layer-wrap')
  // Both branches, every render: the flag is only settled once /health answers.
  if (layerWrap) layerWrap.style.display = TEAM_MODE ? '' : 'none'

  if (projectsLoadFailed) {
    list.innerHTML =
      `<div class="empty-state"><i class="ti ti-wifi-off"></i><span>${escHtml(t('projects.loadFailed'))}</span>` +
      `<button type="button" class="btn btn-secondary btn-sm" onclick="loadProjects()">${escHtml(t('projects.retry'))}</button></div>`
    empty.hidden = true
    archivedWrap.hidden = true
    return
  }

  const active = projectsList.filter((p) => p.status !== 'archived')
  const archived = projectsList.filter((p) => p.status === 'archived')
  list.innerHTML = active.map(renderProjectRow).join('')

  archivedWrap.hidden = archived.length === 0
  archivedToggle.textContent = t('projects.archivedToggle', { n: archived.length })
  archivedToggle.setAttribute('aria-expanded', String(projectsArchivedOpen))
  archivedList.hidden = !projectsArchivedOpen
  archivedList.innerHTML = archived.map(renderProjectRow).join('')

  // Nothing to browse yet: explain, and put the form under the cursor. The
  // header button would only duplicate the open form.
  const isEmpty = active.length === 0
  empty.hidden = !isEmpty
  newBtn.hidden = isEmpty
  if (isEmpty) setProjectCreateOpen(true, { focus: true })
  else if (projectsEmptyShown) setProjectCreateOpen(false)
  else setProjectCreateOpen(projectCreateOpen)
  projectsEmptyShown = isEmpty
  onProjectNameInput()
}

function toggleProjectsArchived() {
  projectsArchivedOpen = !projectsArchivedOpen
  document.getElementById('projects-archived-toggle').setAttribute('aria-expanded', String(projectsArchivedOpen))
  document.getElementById('projects-archived-list').hidden = !projectsArchivedOpen
}

// ── Create form ───────────────────────────────────────────────────────────

function setProjectCreateOpen(open, opts) {
  projectCreateOpen = open
  document.getElementById('project-create').hidden = !open
  document.getElementById('project-new-btn').setAttribute('aria-expanded', String(open))
  if (open && opts && opts.focus) document.getElementById('project-name').focus()
}

function toggleProjectCreate() {
  setProjectCreateOpen(!projectCreateOpen, { focus: true })
}

/** Is this slug already used in the workspace the project would land in? */
function projectSlugTaken(slug) {
  const layer = TEAM_MODE ? document.getElementById('project-layer').value : ''
  // Auto could land in either layer, so any match counts; the Worker's 409 is
  // the backstop for the rest.
  return projectsList.some((p) => p.id === slug && (!layer || p.layer === layer))
}

/** Live slug preview and the Create button's readiness, on every keystroke. */
function onProjectNameInput() {
  const name = document.getElementById('project-name').value
  const slug = deriveProjectSlug(name)
  const taken = !!slug && projectSlugTaken(slug)
  const preview = document.getElementById('project-slug-preview')
  let text
  let tone = ''
  if (!name.trim()) text = t('projects.slugEmpty')
  else if (!slug) {
    text = t('projects.slugInvalid')
    tone = 'project-slug--error'
  } else if (taken) {
    text = t('projects.slugTaken')
    tone = 'project-slug--error'
  } else {
    text = t('projects.slugPreview', { slug })
    tone = 'project-slug--ready'
  }
  preview.textContent = text
  preview.className = `project-slug ${tone}`.trim()
  document.getElementById('project-create-btn').disabled = !slug || taken || projectCreating
  const err = document.getElementById('project-create-error')
  err.hidden = true
  err.textContent = ''
}

function showProjectCreateError(message) {
  const err = document.getElementById('project-create-error')
  err.textContent = message
  err.hidden = false
}

async function submitProject() {
  if (projectCreating) return
  const name = document.getElementById('project-name').value.trim()
  const slug = deriveProjectSlug(name)
  if (!slug || projectSlugTaken(slug)) return
  const body = { id: slug, name }
  const description = document.getElementById('project-desc').value.trim()
  if (description) body.description = description
  const layer = TEAM_MODE ? document.getElementById('project-layer').value : ''
  if (layer) body.workspace = layer

  projectCreating = true
  const btn = document.getElementById('project-create-btn')
  btn.disabled = true
  btn.textContent = t('projects.creating')
  let res = null
  try {
    res = await apiProjectCreate(body)
  } catch {}
  projectCreating = false
  btn.textContent = t('projects.create')

  if (!res || !res.ok) {
    // Recomputed first: it resets the error line, which is then set.
    onProjectNameInput()
    showProjectCreateError(
      !res ? t('projects.createFailed') : res.status === 409 ? t('projects.slugTaken') : res.data.error || t('projects.createFailed'),
    )
    return
  }

  document.getElementById('project-name').value = ''
  document.getElementById('project-desc').value = ''
  showToast(t('projects.createdToast', { name }))
  setProjectCreateOpen(false)
  await loadProjects()
}
