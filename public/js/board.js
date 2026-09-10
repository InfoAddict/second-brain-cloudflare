// The home board: tiles and panels rendered from data the Worker already returns.
// Every panel hides itself when its endpoint is missing (older Worker) or refused.
async function boardFetch(path) {
  try {
    const res = await fetch(`${WORKER_URL}${path}`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    if (!res.ok) return null
    const data = await res.json()
    return data && data.ok === false ? null : data
  } catch { return null }
}

// Some endpoints back both a tile and a panel (e.g. /stats/graph, /stats/recalled);
// this caches the first fetch of a render pass so the second reader gets the
// same response instead of hitting the Worker twice. Cleared at the top of
// every renderBoard() call so a refresh sees fresh data.
let _boardFetchCache = new Map()
async function boardFetchOnce(key, path) {
  if (_boardFetchCache.has(key)) return _boardFetchCache.get(key)
  const data = await boardFetch(path)
  _boardFetchCache.set(key, data)
  return data
}

function boardTile(id, { n, label, delta, quiet }) {
  const el = document.createElement('div')
  el.className = 'tile'; el.dataset.tile = id
  el.innerHTML = `<span class="tile-n">${escHtml(formatNumberUI(n))}</span><span class="tile-l">${escHtml(label)}</span>` +
    (delta ? `<span class="tile-d${quiet ? ' quiet' : ''}">${escHtml(delta)}</span>` : '')
  return el
}

// Built with createElement/appendChild rather than innerHTML+querySelector so
// the returned .body reference is live in both a real DOM and the lightweight
// fake-DOM harness test/ui files use (which does not parse innerHTML strings
// back into queryable nodes).
function boardPanel(id, { title, sub, action, span }) {
  const el = document.createElement('section')
  el.className = 'panel' + (span ? ` span${span}` : '')
  el.dataset.panel = id
  el.setAttribute('aria-labelledby', `h-${id}`)

  const head = document.createElement('div')
  head.className = 'panel-head'
  const heading = document.createElement('div')
  const h2 = document.createElement('h2')
  h2.id = `h-${id}`
  h2.textContent = title
  heading.appendChild(h2)
  if (sub) {
    const p = document.createElement('p')
    p.className = 'panel-sub'
    p.textContent = sub
    heading.appendChild(p)
    el.subEl = p
  }
  head.appendChild(heading)
  if (action) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'panel-act'
    btn.innerHTML = `${escHtml(action.label)} <i class="ti ti-arrow-right"></i>`
    btn.onclick = action.onClick
    head.appendChild(btn)
  }
  el.appendChild(head)
  el.head = head

  const body = document.createElement('div')
  body.className = 'panel-body'
  el.appendChild(body)
  el.body = body
  return el
}

/**
 * The decisions thread's one authored motion: it draws once through the
 * stops on first render. Looks within panel.body (not document) so it never
 * touches another panel's thread. A safe no-op wherever real layout is not
 * available (server-side, or the lightweight test harness, which does not
 * parse innerHTML back into queryable nodes).
 */
function fitThread(panel) {
  const body = panel && panel.body
  const thread = body && body.querySelector && body.querySelector('.thread')
  if (!thread) return
  const stops = body.querySelectorAll('.stop')
  if (!stops.length) return
  const first = stops[0], last = stops[stops.length - 1]
  const top = (first.offsetTop || 0) + 9, end = (last.offsetTop || 0) + 25
  thread.style.top = top + 'px'
  thread.style.height = Math.max(end - top, 0) + 'px'
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => fn()
  raf(() => thread.classList.add('drawn'))
}

/** Panel renderers register here in display order; each appends a .panel or nothing. */
const BOARD_PANELS = []

/**
 * One insight, in the exact card markup brief.js already emits (briefCard,
 * label, body, actions) so briefResolvePattern's `btn.closest('.brief-card')`
 * still finds it — the "stop" ledger classes ride alongside, not instead.
 */
function buildInsightStop(p) {
  const { text, shape } = splitInsightShape(p.content)
  const label = shape
    ? `${t('brief.patternNoticed')}${t('brief.shapeSuffix', { shape: t(`patterns.shapes.${shape}`) })}`
    : t('brief.patternNoticed')
  return `<article class="stop brief-card" data-insight data-pattern="${escAttr(p.id)}">
    <div class="brief-label" aria-live="polite">${escHtml(label)}</div>
    <div class="brief-body">${escHtml(text)}</div>
    <div class="brief-actions">
      <button class="digest-btn" onclick="briefResolvePattern('${escAttr(p.id)}', 'confirm', this)">${escHtml(t('brief.confirm'))}</button>
      <button class="digest-btn danger" onclick="briefResolvePattern('${escAttr(p.id)}', 'dismiss', this)">${escHtml(t('brief.dismiss'))}</button>
    </div>
  </article>`
}

/**
 * "Needs a decision": the two or three things a brain cannot decide by
 * itself, on the one thread. Appends nothing when there is nothing pending.
 */
function renderDecisionPanel(board, brief) {
  const pending = (brief && brief.patterns) || []
  const attention = (brief && brief.attention) || {}
  if (!pending.length && !(attention.stale > 0) && !(attention.unindexed > 0)) return

  const stops = pending.slice(0, 2).map(buildInsightStop)
  if (pending.length > 2) {
    const moreLabel =
      typeof brief.patternsTotal === 'number' && brief.patternsTotal > 2
        ? tPlural('brief.moreInsights', brief.patternsTotal - 2)
        : t('brief.moreInsightsGeneric')
    stops.push(`<article class="stop"><button class="more brief-more" type="button" onclick="openPatternsSheet()">${escHtml(moreLabel)}</button></article>`)
  }
  if (attention.stale > 0) {
    stops.push(`<article class="stop">
      <div class="stop-label">${escHtml(t('stale.title'))}</div>
      <div class="stop-actions"><button class="attn" type="button" onclick="openStaleSheet()"><i class="ti ti-clock-exclamation"></i>${escHtml(t('brief.attentionStale', { n: attention.stale }))}</button></div>
    </article>`)
  }
  if (attention.unindexed > 0) {
    stops.push(`<article class="stop">
      <div class="stop-actions"><button class="attn" type="button" onclick="openMenu()"><i class="ti ti-eye-off"></i>${escHtml(t('brief.attentionUnindexed', { n: attention.unindexed }))}</button></div>
    </article>`)
  }

  const panel = boardPanel('decide', { title: t('board.decideTitle'), sub: t('board.decideSub'), span: 4 })
  panel.body.innerHTML = `<div class="ledger"><div class="thread" aria-hidden="true"></div>${stops.join('')}</div>`
  board.appendChild(panel)
  fitThread(panel)
}
BOARD_PANELS.push(renderDecisionPanel)

/** Bars proportional to their own max, not to each other's panel's max. */
function boardBars(rows, onClick) {
  const max = Math.max(...rows.map((r) => r.count), 1)
  return `<div class="bars">${rows
    .map((r) => {
      const pct = Math.max(Math.round((r.count / max) * 100), 3)
      const label = escHtml(r.label)
      const btn = onClick
        ? `<button type="button" class="bar" onclick="${onClick(r)}"><span>${label}</span><span class="bar-track" style="--w:${pct}%"></span><span class="bar-n num">${escHtml(formatNumberUI(r.count))}</span></button>`
        : `<div class="bar"><span>${label}</span><span class="bar-track" style="--w:${pct}%"></span><span class="bar-n num">${escHtml(formatNumberUI(r.count))}</span></div>`
      return btn
    })
    .join('')}</div>`
}

/** "What it is about": the tags actually in use, as a click-to-ask list. */
function renderTopicsPanel(board, brief) {
  const rows = ((brief && brief.topics) || []).filter((t) => !isSystemTag(t.tag)).slice(0, 6)
  if (!rows.length) return
  const panel = boardPanel('topics', { title: t('board.topicsTitle'), sub: t('board.topicsSub'), span: 4 })
  panel.body.innerHTML = boardBars(
    rows.map((r) => ({ label: r.tag, count: r.count, tag: r.tag })),
    (r) => `askAbout('${escAttr(r.tag)}')`,
  )
  board.appendChild(panel)
}
BOARD_PANELS.push(renderTopicsPanel)

/** "Worth re-reading": the one high-importance memory nobody has recalled lately. */
function renderResurfacePanel(board, brief) {
  const m = brief && brief.resurface
  if (!m) return
  const panel = boardPanel('reread', { title: t('brief.worthRereading'), sub: t('board.rereadSub'), span: 4 })
  const meta = [m.source ? sourceBadge(m.source).label : null, m.created_at ? formatDateUI(m.created_at, { year: 'numeric', month: 'short', day: 'numeric' }) : null]
    .filter(Boolean)
    .join(' · ')
  const tags = humanTags(m.tags || [])
    .map((tag) => `<span class="tag">${escHtml(tag)}</span>`)
    .join('')
  panel.body.innerHTML = `
    <div class="memory-mark">
      <div class="memory-mark-head"><img class="memory-mark-icon" src="/brand-mark.png" width="36" height="22" alt=""><span class="memory-mark-label">${escHtml(t('board.saved'))}</span></div>
      ${meta ? `<span class="memory-mark-meta">${escHtml(meta)}</span>` : ''}
    </div>
    <p class="reread-text">${escHtml(titleLine(m.content, 180))}</p>
    <div class="memory-card-foot">
      ${tags}
      <button class="digest-btn" type="button" onclick="openAppend('${escAttr(m.id)}', '${escAttr((m.content || '').slice(0, 80))}')"><i class="ti ti-writing"></i> ${escHtml(t('memories.append'))}</button>
    </div>`
  board.appendChild(panel)
}
BOARD_PANELS.push(renderResurfacePanel)

// Task 1.4 had a temporary "Where from" proportion panel here. The growth
// chart legend below is its replacement (per the plan: "the 'Where from'
// proportion rows move into the chart legend"), so it is gone.

function capitalizeFirst(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

/**
 * Groups /stats/activity's per-source series (already sorted largest-first
 * by the Worker) into at most 5: the four biggest sources plus one "Other"
 * summing whatever is left, so the chart never grows a sixth color.
 */
function buildActivitySeries(data) {
  const top = data.series.slice(0, 4)
  const rest = data.series.slice(4)
  const defs = top.map((s) => ({ source: s.source, counts: s.counts }))
  if (rest.length) {
    const otherCounts = new Array(data.days).fill(0)
    for (const s of rest) s.counts.forEach((v, i) => { otherCounts[i] += v || 0 })
    defs.push({ source: null, counts: otherCounts, isOther: true })
  }
  return defs
}

/**
 * Buckets raw daily rows into the mode the range control asked for: 30 days
 * shows the raw counts, 90 a centered 7-day average, 365 weekly sums —
 * mirrors docs/design-mockups/dashboard/template.html's `bucketed()`. The
 * average's window can only look inside the fetched days (no data exists
 * before `start`), so it narrows near the two ends of whatever range is on
 * screen rather than reaching further back.
 */
function bucketActivityRows(rawRows, mode) {
  if (mode === 'day') return rawRows
  const seriesCount = rawRows.length ? rawRows[0].s.length : 0
  if (mode === 'avg7') {
    return rawRows.map((r, i) => {
      const lo = Math.max(0, i - 3), hi = Math.min(rawRows.length - 1, i + 3)
      const win = rawRows.slice(lo, hi + 1)
      const s = []
      for (let k = 0; k < seriesCount; k++) s.push(win.reduce((acc, w) => acc + w.s[k], 0) / win.length)
      return { d: r.d, label: r.label, s }
    })
  }
  const out = []
  for (let i = rawRows.length; i > 0; i -= 7) {
    const chunk = rawRows.slice(Math.max(0, i - 7), i)
    const s = []
    for (let k = 0; k < seriesCount; k++) s.push(chunk.reduce((acc, row) => acc + row.s[k], 0))
    out.unshift({ d: chunk[0].d, label: t('memories.weekOf', { date: chunk[0].label }), s })
  }
  return out
}

/**
 * "Memories over time": a stacked area chart from /stats/activity, by
 * source, with a live 30/90/365 range control. Falls back to the 14-day
 * single "All sources" strip /brief already returns, with the range control
 * disabled, when the Worker does not have the rollup endpoint yet.
 */
async function renderGrowthPanel(board, brief) {
  const brief14 = (brief && brief.activity) || []
  // One fetch decides both whether the panel shows at all and, when it does,
  // paints the default 90-day range — draw() below reuses this result rather
  // than fetching /stats/activity a second time for the initial paint.
  const initial = await boardFetch('/stats/activity?days=90')
  const live = !!(initial && Array.isArray(initial.series) && initial.series.length)
  if (!live && !brief14.length) return

  const panel = boardPanel('growth', { title: t('board.growthTitle'), sub: t('board.growthSubDay'), span: 8 })
  panel.className += ' growth'

  const seg = document.createElement('div')
  seg.className = 'seg'
  seg.setAttribute('role', 'radiogroup')
  seg.setAttribute('aria-label', 'Range')
  const segButtons = [['30', t('board.range30')], ['90', t('board.range90')], ['365', t('board.range365')]].map(([val, label]) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.setAttribute('role', 'radio')
    b.dataset.range = val
    const checked = live ? val === '90' : val === '30'
    b.setAttribute('aria-checked', String(checked))
    b.tabIndex = checked ? 0 : -1
    b.disabled = !live
    b.textContent = label
    seg.appendChild(b)
    return b
  })
  panel.head.appendChild(seg)

  const asTableBtn = document.createElement('button')
  asTableBtn.type = 'button'
  asTableBtn.className = 'digest-btn'
  asTableBtn.setAttribute('aria-expanded', 'false')
  asTableBtn.textContent = t('board.chartShowTable')
  panel.head.appendChild(asTableBtn)

  const chartEl = document.createElement('div')
  chartEl.className = 'chart'
  chartEl.setAttribute('role', 'img')
  chartEl.tabIndex = 0
  chartEl.setAttribute('aria-roledescription', 'stacked area chart')
  const svg = document.createElementNS ? document.createElementNS('http://www.w3.org/2000/svg', 'svg') : document.createElement('svg')
  svg.setAttribute('aria-hidden', 'true')
  chartEl.appendChild(svg)

  const legend = document.createElement('div')
  legend.className = 'legend'

  const tableScroll = document.createElement('div')
  tableScroll.className = 'table-scroll'
  const table = document.createElement('table')
  table.className = 'data-table'
  table.hidden = true
  const caption = document.createElement('caption')
  caption.className = 'vh'
  table.appendChild(caption)
  table.appendChild(document.createElement('thead'))
  table.appendChild(document.createElement('tbody'))
  tableScroll.appendChild(table)

  panel.body.appendChild(chartEl)
  panel.body.appendChild(legend)
  panel.body.appendChild(tableScroll)

  // The toggle updates itself in place and keeps focus; it never rebuilds the panel.
  asTableBtn.onclick = () => {
    table.hidden = !table.hidden
    asTableBtn.textContent = table.hidden ? t('board.chartShowTable') : t('board.chartHideTable')
    asTableBtn.setAttribute('aria-expanded', String(!table.hidden))
    asTableBtn.focus()
  }

  let range = 90
  let cachedInitial = initial

  async function draw() {
    const data = live ? (range === 90 && cachedInitial ? cachedInitial : await boardFetch(`/stats/activity?days=${range}`)) : null
    cachedInitial = null
    if (data && Array.isArray(data.series) && data.series.length) {
      const mode = range === 30 ? 'day' : range === 365 ? 'week' : 'avg7'
      const seriesDefs = buildActivitySeries(data)
      const seriesMeta = seriesDefs.map((sd) => ({
        name: sd.isOther ? t('board.seriesOther') : capitalizeFirst(sourceBadge(sd.source).label),
      }))
      const rawRows = []
      for (let i = 0; i < data.days; i++) {
        const dayNum = data.start + i
        rawRows.push({
          d: String(dayNum),
          label: formatDateUI(dayNum * 86400000, { month: 'short', day: 'numeric' }),
          s: seriesDefs.map((sd) => sd.counts[i] || 0),
        })
      }
      const rows = bucketActivityRows(rawRows, mode)
      if (typeof renderActivityChart === 'function') renderActivityChart(chartEl, { rows, series: seriesMeta, mode, subEl: panel.subEl })
    } else {
      // Older Worker (or a range refetch that failed): the 14-day single
      // series /brief already returns, honestly scoped as "last 14 days".
      if (panel.subEl) panel.subEl.textContent = t('board.growthSubBrief')
      const rows = brief14.map((d) => ({ d: String(d.day), label: formatDateUI(d.day * 86400000, { month: 'short', day: 'numeric' }), s: [d.count || 0] }))
      const series = [{ name: t('board.seriesAll') }]
      if (typeof renderActivityChart === 'function') renderActivityChart(chartEl, { rows, series, mode: 'day' })
    }
  }

  segButtons.forEach((b) => {
    b.onclick = () => {
      if (b.disabled) return
      range = Number(b.dataset.range)
      segButtons.forEach((o) => { const on = o === b; o.setAttribute('aria-checked', String(on)); o.tabIndex = on ? 0 : -1 })
      draw()
    }
  })
  seg.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const enabled = segButtons.filter((b) => !b.disabled)
    if (!enabled.length) return
    const i = enabled.indexOf(document.activeElement)
    const next = enabled[((i === -1 ? 0 : i) + (e.key === 'ArrowRight' ? 1 : enabled.length - 1)) % enabled.length]
    next.focus()
    next.onclick()
  })

  await draw()
  board.appendChild(panel)
}
BOARD_PANELS.push(renderGrowthPanel)

/**
 * "How it connects": a static packed preview of the same topic clusters the
 * Memories screen's graph draws (assignGraphClusters, packGraphNodes,
 * packGraphCircles — all pure, unit-tested helpers in utils.js). One level of
 * clustering only; the full graph's sub-topic nesting is more than a 560x340
 * preview needs.
 *
 * Per DIRECTION.md's review finding, topic clusters carry no hue meaning here
 * (unlike the chart's source palette) — every node and ring draws neutral, so
 * identity comes from the label, not a color that would fail a colorblind
 * reader on an arbitrary tag.
 */
async function renderGraphPanel(board, brief) {
  const data = await boardFetch('/graph?limit=120')
  const nodes = (data && data.nodes) || []
  if (nodes.length < 5) return
  const edges = (data && data.edges) || []
  assignGraphClusters(nodes, edges)

  const W = 560, H = 340, NODE_R = 9, GAP = 10, LOOSE = '__loose__'
  const byCluster = new Map()
  for (const n of nodes) {
    if (!byCluster.has(n.cluster)) byCluster.set(n.cluster, [])
    byCluster.get(n.cluster).push(n)
  }
  const clusters = []
  for (const [id, members] of byCluster) {
    if (id === LOOSE) continue
    const spread = members.length <= 1 ? 0 : 8 + 7 * Math.sqrt(members.length)
    const local = packGraphNodes(members.length, spread)
    members.forEach((n, i) => { n._lx = local[i].x; n._ly = local[i].y })
    clusters.push({ id, members, R: spread + NODE_R + 6 })
  }
  const loose = byCluster.get(LOOSE) || []
  const packed = packGraphCircles([...clusters.map((c) => c.R), ...loose.map(() => NODE_R + 4)], GAP)
  clusters.forEach((c, i) => { c.cx = packed.centers[i].x; c.cy = packed.centers[i].y })
  loose.forEach((n, i) => {
    const c = packed.centers[clusters.length + i]
    n.cx = c.x; n.cy = c.y
  })
  for (const c of clusters) for (const n of c.members) { n.cx = c.cx + n._lx; n.cy = c.cy + n._ly }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const n of nodes) { minX = Math.min(minX, n.cx); maxX = Math.max(maxX, n.cx); minY = Math.min(minY, n.cy); maxY = Math.max(maxY, n.cy) }
  for (const c of clusters) { minX = Math.min(minX, c.cx - c.R); maxX = Math.max(maxX, c.cx + c.R); minY = Math.min(minY, c.cy - c.R); maxY = Math.max(maxY, c.cy + c.R) }
  const pad = 24
  const scale = Math.min((W - pad * 2) / (maxX - minX || 1), (H - pad * 2) / (maxY - minY || 1), 1)
  const ox = W / 2 - ((minX + maxX) / 2) * scale, oy = H / 2 - ((minY + maxY) / 2) * scale
  const sx = (v) => v * scale + ox, sy = (v) => v * scale + oy

  const byId = new Map(nodes.map((n) => [n.id, n]))
  let svg = ''
  for (const e of edges) {
    const s = byId.get(e.source), tn = byId.get(e.target)
    if (!s || !tn) continue
    svg += `<line x1="${sx(s.cx).toFixed(1)}" y1="${sy(s.cy).toFixed(1)}" x2="${sx(tn.cx).toFixed(1)}" y2="${sy(tn.cy).toFixed(1)}" stroke="var(--line)" stroke-width="1"/>`
  }
  // fill/stroke-opacity (not a baked-in rgba) so the ring reads as a faint
  // wash of ink in either theme instead of vanishing on a dark ground.
  for (const c of clusters) svg += `<circle cx="${sx(c.cx).toFixed(1)}" cy="${sy(c.cy).toFixed(1)}" r="${(c.R * scale).toFixed(1)}" fill="var(--text-primary)" fill-opacity="0.045" stroke="var(--text-primary)" stroke-opacity="0.28"/>`
  for (const n of nodes) {
    const r = (3.5 + Math.min(2.5, (n.importance || 0) * 0.5)).toFixed(1)
    svg += `<circle cx="${sx(n.cx).toFixed(1)}" cy="${sy(n.cy).toFixed(1)}" r="${r}" fill="var(--text-secondary)" stroke="var(--bg-card)" stroke-width="2"/>`
  }
  for (const c of clusters) {
    svg += `<text class="graph-label" x="${sx(c.cx).toFixed(1)}" y="${(sy(c.cy - c.R) - 6).toFixed(1)}" text-anchor="middle">${escHtml(c.id)} <tspan class="graph-n">${c.members.length}</tspan></text>`
  }

  const panel = boardPanel('graph', {
    title: t('board.graphTitle'),
    sub: t('board.graphSub'),
    span: 7,
    action: { label: t('board.openGraph'), onClick: () => { switchTab('memories'); setMemoryView('graph') } },
  })
  const wrap = document.createElement('div')
  wrap.className = 'graph'
  wrap.innerHTML = `<svg class="graph-svg" viewBox="0 0 ${W} ${H}" aria-hidden="true">${svg}</svg>`
  const legend = document.createElement('p')
  legend.className = 'graph-legend num'
  legend.innerHTML = `<span>${escHtml(t('board.graphLegend', { shown: formatNumberUI(nodes.length), total: formatNumberUI((brief && brief.total) || nodes.length), topics: clusters.length }))}</span><span>${escHtml(t('board.graphSize'))}</span>`
  panel.body.appendChild(wrap)
  panel.body.appendChild(legend)
  board.appendChild(panel)
}
BOARD_PANELS.push(renderGraphPanel)

/**
 * "What you keep coming back to": the most-recalled memories, all time.
 * Shares its fetch with the recalls tile — renderBoard calls boardFetchOnce
 * with this same key first, so this never hits the Worker twice.
 */
async function renderRecalledPanel(board) {
  const data = await boardFetchOnce('recalled', '/stats/recalled?limit=5')
  const entries = (data && data.entries) || []
  if (!entries.length) return

  const panel = boardPanel('recalled', { title: t('board.recalledTitle'), sub: t('board.recalledSub'), span: 5 })
  panel.body.innerHTML = `<div class="rows">${entries
    .map((m) => {
      const badge = sourceBadge(m.source)
      const meta = [badge.label, m.created_at ? formatDateUI(m.created_at, { month: 'short', day: 'numeric' }) : null].filter(Boolean).join(' · ')
      return `<div class="row">
        <div class="row-t">${escHtml(titleLine(m.content))}</div>
        <div class="row-n num">${escHtml(tPlural('board.recalls', m.recall_count))}</div>
        <div class="row-m"><i class="ti ${badge.icon}"></i>${escHtml(meta)}</div>
      </div>`
    })
    .join('')}</div>`
  board.appendChild(panel)
}
BOARD_PANELS.push(renderRecalledPanel)

/**
 * "Last night": last night's maintenance summary from /stats/night. Hidden
 * when ranAt is null — nothing recorded yet, either a brand new Worker or
 * the nightly pass has not run once. insightsProposed is 0 on most nights
 * since the weekly insight pass runs on its own cron, not every night; that
 * row hides at 0 rather than showing a permanent zero.
 */
async function renderNightPanel(board) {
  const data = await boardFetch('/stats/night')
  if (!data || data.ranAt == null) return

  const rows = [{ n: data.linksInferred, label: t('board.nightLinks') }]
  if (data.insightsProposed > 0) rows.push({ n: data.insightsProposed, label: t('board.nightInsights') })
  rows.push({ n: data.digestsWritten, label: t('board.nightDigests') })
  rows.push({ n: data.claimsFlagged, label: t('board.nightClaims') })

  const sub = t('board.nightSub', { time: formatDateUI(data.ranAt, { hour: 'numeric', minute: '2-digit' }) })
  const panel = boardPanel('night', { title: t('board.nightTitle'), sub, span: 3 })
  panel.body.innerHTML = `<div class="night">${rows
    .map((r) => `<div class="night-row"><span class="night-n num">${escHtml(formatNumberUI(r.n))}</span><span class="night-t">${escHtml(r.label)}</span></div>`)
    .join('')}</div>`
  board.appendChild(panel)
}
BOARD_PANELS.push(renderNightPanel)

/**
 * One literal translate call per type, not a lookup keyed by a runtime
 * string — src/graph/types.ts's EDGE_TYPES is a closed set of 8, so this
 * reads like renderCapsulePanel's slotLabel further down: the i18n scanner only
 * credits a key it can read as a plain quoted literal.
 */
function edgeTypeLabel(type) {
  if (type === 'relates_to') return t('board.edge.relates_to')
  if (type === 'follows') return t('board.edge.follows')
  if (type === 'supersedes') return t('board.edge.supersedes')
  if (type === 'decided') return t('board.edge.decided')
  if (type === 'about_person') return t('board.edge.about_person')
  if (type === 'part_of_project') return t('board.edge.part_of_project')
  if (type === 'caused_by') return t('board.edge.caused_by')
  if (type === 'drawn_from') return t('board.edge.drawn_from')
  return type
}

/**
 * "Kinds of links": the edge-type histogram /stats/graph already returns for
 * the connections tile, reused here via boardFetchOnce rather than fetched
 * twice. The three biggest types draw as bars; the rest as a compact
 * two-column count list, so a long tail of rare types stays readable instead
 * of a row of near-invisible slivers.
 */
async function renderLinksPanel(board) {
  const data = await boardFetchOnce('graph', '/stats/graph')
  const edgeTypes = data && data.edgeTypes
  if (!edgeTypes) return
  const rows = Object.entries(edgeTypes)
    .map(([type, count]) => ({ type, label: edgeTypeLabel(type), count: Number(count) }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count)
  if (!rows.length) return

  const total = rows.reduce((n, r) => n + r.count, 0)
  const panel = boardPanel('links', { title: t('board.linksTitle'), sub: tPlural('board.linksSub', total), span: 4 })
  const rest = rows.slice(3)
  let html = boardBars(rows.slice(0, 3))
  if (rest.length) {
    html += `<div class="link-chips">${rest
      .map((r) => `<div class="link-chip"><span>${escHtml(r.label)}</span><span class="num">${escHtml(formatNumberUI(r.count))}</span></div>`)
      .join('')}</div>`
  }
  panel.body.innerHTML = html
  board.appendChild(panel)
}
BOARD_PANELS.push(renderLinksPanel)

/** Upkeep: the chores a brain can name but not do for itself. */
async function renderUpkeepPanel(board) {
  const data = await boardFetch('/stats')
  if (!data) return
  const candidates = data.digest_candidates || []
  const unvectorized = data.unvectorized || 0
  const unclassified = data.unclassified || 0
  if (!candidates.length && !unvectorized && !unclassified) return

  const rows = candidates
    .slice(0, 4)
    .map(
      (c) =>
        `<div class="task"><div class="task-t">${escHtml(c.tag)}<span>${escHtml(tPlural('upkeep.digestEntries', c.count))}</span></div><button class="digest-btn" type="button" onclick="runDigest('${escAttr(c.tag)}', this)">${escHtml(t('upkeep.digestAction'))}</button></div>`,
    )
  if (unvectorized > 0) {
    rows.push(
      `<div class="task"><div class="task-t">${escHtml(t('upkeep.vectorizeLabel'))}<span>${escHtml(tPlural('upkeep.vectorizeNote', unvectorized))}</span></div><button class="digest-btn" type="button" onclick="runVectorize(this)">${escHtml(t('upkeep.vectorizeAction'))}</button></div>`,
    )
  }
  if (unclassified > 0) {
    rows.push(
      `<div class="task"><div class="task-t">${escHtml(t('upkeep.classifyLabel'))}<span>${escHtml(tPlural('upkeep.classifyNote', unclassified))}</span></div><button class="digest-btn" type="button" onclick="runClassify(this)">${escHtml(t('upkeep.classifyAction'))}</button></div>`,
    )
  }

  const panel = boardPanel('upkeep', { title: t('board.upkeepTitle'), sub: t('board.upkeepSub'), span: 3 })
  panel.body.innerHTML = `<div class="rows">${rows.join('')}</div>`
  board.appendChild(panel)
}
BOARD_PANELS.push(renderUpkeepPanel)

function integrationIcon(provider) {
  if (/^email-/.test(provider)) return 'ti-mail'
  if (/^calendar-/.test(provider)) return 'ti-calendar'
  if (provider === 'notion') return 'ti-brand-notion'
  return 'ti-plug'
}

/** Connected sources, each with its own last-sync line or a way to connect it. */
async function renderSourcesStatusPanel(board) {
  const data = await boardFetch('/integrations')
  const rows = (data && data.integrations) || []
  if (!rows.length) return

  const panel = boardPanel('sources', {
    title: t('board.sourcesTitle'),
    sub: t('board.sourcesSub'),
    span: 3,
    action: { label: t('board.manage'), onClick: () => openIntegrations() },
  })
  panel.body.innerHTML = `<div class="rows">${rows
    .map((r) => {
      const icon = integrationIcon(r.provider)
      const meta = r.connected
        ? `<i class="src-dot" style="background:var(--good)"></i>${escHtml(t('board.synced', { when: relativeTime(r.lastSyncedAt) }))}`
        : `${escHtml(t('board.notConnected'))} &middot; <a href="#" onclick="openIntegrations(); return false">${escHtml(t('auth.connect'))}</a>`
      return `<div class="src"><i class="ti ${icon}"></i><span class="src-name">${escHtml(r.name)}<span class="src-meta">${meta}</span></span></div>`
    })
    .join('')}</div>`
  board.appendChild(panel)
}
BOARD_PANELS.push(renderSourcesStatusPanel)

/** The prompt capsule: what every connected tool loads before anything else. */
async function renderCapsulePanel(board) {
  const data = await boardFetch('/prompt-capsules/core')
  if (!data) return
  const bySlot = new Map((data.sections || []).map((s) => [s.slot, s]))
  const omitted = new Set(data.omitted_slots || [])
  // Labels are literal translate-function calls, not a lookup table keyed by
  // slot id: the i18n suite's static scanner only credits a key as "used"
  // when it can read the call site without evaluating anything.
  const slotLabel = (id) => {
    if (id === 'identity') return t('board.slotIdentity')
    if (id === 'preferences') return t('board.slotPreferences')
    if (id === 'constraints') return t('board.slotConstraints')
    return t('board.slotPrinciples')
  }
  const slotIds = ['identity', 'preferences', 'constraints', 'principles']
  const filled = slotIds.filter((id) => bySlot.has(id))
  if (data.populated === false && !filled.length) return

  const countBySlot = new Map()
  for (const s of data.sections || []) countBySlot.set(s.slot, (countBySlot.get(s.slot) || 0) + 1)

  const rows = slotIds.map((id) => {
    const has = bySlot.has(id) && !omitted.has(id)
    const icon = has ? 'ti-circle-check' : 'ti-circle'
    const detail = has ? tPlural('board.slotMemories', countBySlot.get(id) || 1) : t('board.slotEmpty')
    return `<div class="slot${has ? '' : ' empty'}"><i class="ti ${icon}"></i><span class="slot-body">${escHtml(slotLabel(id))}<small>${escHtml(detail)}</small></span></div>`
  })

  const panel = boardPanel('capsule', { title: t('board.capsuleTitle'), sub: t('board.capsuleSub'), span: 3 })
  panel.body.innerHTML = `<div class="slots">${rows.join('')}</div>`
  board.appendChild(panel)
}
BOARD_PANELS.push(renderCapsulePanel)

/** Worker version and index health, at the foot of the rail/top bar. */
async function renderRailNote() {
  const el = document.getElementById('sb-version-note')
  if (!el) return
  const health = await boardFetch('/health')
  if (!health) { el.textContent = ''; return }
  const indexOk = !health.vectorize || health.vectorize.ok !== false
  el.innerHTML = `<b>${escHtml(t('board.railVersion', { v: health.version || '' }))}</b>${escHtml(indexOk ? t('board.railIndexOk') : t('board.railIndexDegraded'))}`
}

async function renderBoard(brief) {
  const tilesEl = document.getElementById('board-tiles'), board = document.getElementById('board')
  if (!tilesEl || !board) return
  _boardFetchCache = new Map()
  tilesEl.innerHTML = ''; board.innerHTML = ''
  const week = ((brief && brief.activity) || []).slice(-7).reduce((n, d) => n + (d.count || 0), 0)
  if (brief && brief.total) tilesEl.appendChild(boardTile('memories', { n: brief.total, label: t('board.tileMemories'), delta: t('board.tileWeek', { n: formatNumberUI(week) }) }))
  const graph = await boardFetchOnce('graph', '/stats/graph')
  if (graph && graph.edgeTypes) {
    const total = Object.values(graph.edgeTypes).reduce((a, b) => a + Number(b), 0)
    tilesEl.appendChild(boardTile('connections', { n: total, label: t('board.tileConnections') }))
  }
  const recalled = await boardFetchOnce('recalled', '/stats/recalled?limit=5')
  if (recalled && typeof recalled.total_recalls === 'number') {
    tilesEl.appendChild(boardTile('recalls', { n: recalled.total_recalls, label: t('board.tileRecalls'), delta: t('board.tileRecallsDelta'), quiet: true }))
  }
  tilesEl.hidden = tilesEl.children.length === 0
  for (const fn of BOARD_PANELS) {
    try { await fn(board, brief) } catch (e) { console.error('board panel failed:', e) }
  }
  try { await renderRailNote() } catch (e) { console.error('rail note failed:', e) }
}
