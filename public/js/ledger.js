// The decision log (Design 4.4, 7.4, T-0089.7.2): a sheet listing every
// logged decision (`ledger:decision`) with its outcome, plus a calibration
// dot plot showing how often confident calls came true. See GET /decisions,
// GET /decisions/calibration (src/routes/ledger.ts).
//
// The chart is pure layout math (bucketRows, xScale) plus a render function,
// the same split chart.js uses — but a purpose-built dot plot, not a reused
// stacked area: one row per confidence bucket, a hollow ring at "you said"
// and a filled dot at "came true", joined by a connector.

const LEDGER_BUCKET_LABELS = { '50-59': '50-59%', '60-69': '60-69%', '70-79': '70-79%', '80-89': '80-89%', '90-95': '90-95%' }

/**
 * Maps a calibration result (GET /decisions/calibration) to one row per
 * bucket, in order. Not ready: no rows, so the caller draws nothing (Design
 * 7.4 item 3: "not-ready state draws no chart"). A bucket below the Worker's
 * own disclosure gate (`shown: false`, `n < CALIBRATION_MIN_BUCKET_N`)
 * carries no marks: meanStated/hitRate come back null rather than the
 * render function having to re-check `shown` itself.
 */
function bucketRows(result) {
  if (!result || !result.ready) return []
  return (result.buckets || []).map((b) => ({
    bucket: b.bucket,
    label: LEDGER_BUCKET_LABELS[b.bucket] || b.bucket,
    n: b.n,
    nStated: b.nStated,
    nInferred: b.nInferred,
    shown: b.shown,
    meanStated: b.shown ? b.meanStated : null,
    hitRate: b.shown ? b.hitRate : null,
  }))
}

/** A 0-100 confidence percent to a 0-1 fraction of the x axis (Design 7.4 item 3: "x axis runs 0% to 100%"), clamped to the axis. */
function xScale(pct) {
  if (typeof pct !== 'number' || Number.isNaN(pct)) return 0
  return Math.max(0, Math.min(1, pct / 100))
}

/** "70-79%: you said 74%, came true 52% of the time, 14 decisions (9 stated, 5 estimated)" or the not-enough-yet line — pure, so the tooltip and the aria-label can share it without either drifting from the other. */
function calibrationTooltipText(row) {
  if (!row) return ''
  if (!row.shown) return `${row.label}: ${t('ledger.notEnoughYet', { n: row.n })}`
  const stated = t('ledger.tipStated', { pct: Math.round(row.meanStated * 100) })
  const hit = t('ledger.tipHit', { pct: Math.round(row.hitRate * 100) })
  const n = tPlural('ledger.tipN', row.n, { stated: row.nStated, inferred: row.nInferred })
  return `${row.label}: ${stated}, ${hit}, ${n}`
}

/**
 * "○ You said · ● Came true". UX advisor round 2: only when the chart
 * itself is drawn, not "always" as Design 7.4 item 3 first had it — a
 * legend with no chart under it read as a second empty element next to the
 * not-ready sentence, not as a promise of what the chart will show later.
 */
function renderLedgerLegend(el) {
  if (!el) return
  el.innerHTML =
    `<span class="legend-item"><i class="cal-mark cal-mark--ring"></i>${escHtml(t('ledger.legendStated'))}</span>` +
    `<span class="legend-item"><i class="cal-mark cal-mark--dot"></i>${escHtml(t('ledger.legendHit'))}</span>`
}

/**
 * Every bucket, shown or not (Design 7.4 item 3: "table view mirrors every
 * value"), reusing chart.js's table-toggle wording since it is the same
 * pattern, not a new one.
 *
 * UI review (390px): five separate columns clipped "Came true" with no
 * scroll cue. "You said" and "Came true" fold into one column ("74% →
 * 52%") from the two already-approved headers, not a new string, so four
 * columns fit instead of five.
 */
function renderLedgerTable(el, rows) {
  if (!el) return
  const toggleBtn = document.getElementById('ledger-table-toggle')
  if (toggleBtn) toggleBtn.textContent = el.hidden ? t('board.chartShowTable') : t('board.chartHideTable')
  const caption = el.querySelector('caption')
  if (caption) caption.textContent = t('ledger.tableCaption')
  const thead = el.querySelector('thead')
  const tbody = el.querySelector('tbody')
  const statedVsHitHeader = `${t('ledger.tableColStated')} → ${t('ledger.tableColHit')}`
  if (thead) {
    thead.innerHTML = `<tr><th>${escHtml(t('ledger.tableColBucket'))}</th><th>${escHtml(t('ledger.tableColN'))}</th><th>${escHtml(statedVsHitHeader)}</th><th>${escHtml(t('ledger.tableColSplit'))}</th></tr>`
  }
  if (tbody) {
    tbody.innerHTML = rows
      .map((row) => {
        const statedVsHitCell = row.shown ? `${Math.round(row.meanStated * 100)}% → ${Math.round(row.hitRate * 100)}%` : t('ledger.notEnoughYet', { n: row.n })
        const splitCell = row.shown ? `${row.nStated}/${row.nInferred}` : ''
        return `<tr><td>${escHtml(row.label)}</td><td class="num">${row.n}</td><td class="num">${escHtml(statedVsHitCell)}</td><td class="num">${escHtml(splitCell)}</td></tr>`
      })
      .join('')
  }
  // UI review round 2 (MAJOR): the right-edge fade (.has-overflow, board.css)
  // only makes sense when the table is actually wider than its scroll box —
  // a table that already fits gets no redundant cue.
  const scrollEl = el.closest ? el.closest('.ledger-table-scroll') : null
  if (scrollEl) scrollEl.classList.toggle('has-overflow', scrollEl.scrollWidth > scrollEl.clientWidth)
}

function toggleLedgerTable() {
  const table = document.getElementById('ledger-table')
  const btn = document.getElementById('ledger-table-toggle')
  if (!table) return
  table.hidden = !table.hidden
  if (btn) btn.textContent = table.hidden ? t('board.chartShowTable') : t('board.chartHideTable')
  // A hidden table reports scrollWidth/clientWidth as 0/0 (renderLedgerTable
  // ran while it was still collapsed), so the overflow fade is only knowable
  // once it is actually visible.
  const scrollEl = table.closest ? table.closest('.ledger-table-scroll') : null
  if (scrollEl && !table.hidden) scrollEl.classList.toggle('has-overflow', scrollEl.scrollWidth > scrollEl.clientWidth)
}

function hideLedgerTip() {
  const tip = document.getElementById('board-tip')
  if (tip) tip.classList.remove('on')
}

function showLedgerTip(target, row) {
  const tip = document.getElementById('board-tip')
  if (!tip) return
  // Plain textContent, not innerHTML: Design 7.4 item 3, "Text uses text
  // tokens, never the series color" — nothing here needs markup, so a text
  // node is both simpler and accessible-name-safe by construction.
  tip.textContent = calibrationTooltipText(row)
  const r = target && target.getBoundingClientRect ? target.getBoundingClientRect() : { left: 0, top: 0, width: 0 }
  tip.style.left = r.left + r.width / 2 + 'px'
  tip.style.top = r.top - 8 - (tip.offsetHeight || 0) + 'px'
  tip.classList.add('on')
}

/**
 * Draws the calibration dot plot into `chartEl` (the `.chart` container,
 * holding an `<svg>` child), its legend, scope note and table (siblings
 * under `chartEl.parentElement`, chart.js's own convention).
 *
 * UX advisor round 2: not ready draws nothing at all here, legend included
 * (loadLedgerCalibration below hides the whole wrap in that case too, but
 * this stays correct standalone). The scope note explains why the chart
 * itself never changes between the Open and Resolved tabs: it is always
 * every scored decision, since calibration has no state filter of its own.
 */
function renderCalibrationChart(chartEl, result) {
  const wrap = chartEl && chartEl.parentElement
  const legendEl = wrap && wrap.querySelector('.legend')
  const scopeEl = wrap && wrap.querySelector('.ledger-chart-scope')
  const tableEl = wrap && wrap.querySelector('.data-table')
  const ready = !!(result && result.ready)
  if (legendEl) { if (ready) renderLedgerLegend(legendEl); else legendEl.innerHTML = '' }
  if (scopeEl) scopeEl.textContent = ready ? t('ledger.chartScopeNote') : ''

  if (!chartEl) return
  const svg = chartEl.querySelector('svg')
  const rows = bucketRows(result)
  if (!ready || !svg) {
    if (svg) svg.innerHTML = ''
    renderLedgerTable(tableEl, [])
    return
  }

  const W = chartEl.clientWidth || 320
  const padL = 58, padR = 44, padT = 10, rowH = 30
  const innerW = W - padL - padR
  const H = padT * 2 + rows.length * rowH

  let out = '<g class="cal-grid">'
  ;[0, 25, 50, 75, 100].forEach((pct) => {
    const x = padL + xScale(pct) * innerW
    out += `<line x1="${x}" x2="${x}" y1="${padT}" y2="${H - padT}"/>`
  })
  out += '</g>'

  rows.forEach((row, i) => {
    const y = padT + i * rowH + rowH / 2
    out += `<text x="0" y="${y + 4}" class="cal-bucket-label">${escHtml(row.label)}</text>`
    if (row.shown) {
      const x1 = padL + xScale(row.meanStated * 100) * innerW
      const x2 = padL + xScale(row.hitRate * 100) * innerW
      out += `<line class="cal-connector" x1="${x1}" x2="${x2}" y1="${y}" y2="${y}"/>`
      out += `<circle class="cal-mark-ring" cx="${x1}" cy="${y}" r="5"/>`
      out += `<circle class="cal-mark-dot" cx="${x2}" cy="${y}" r="5"/>`
      // Direct label: only the n, at the row end (Design 7.4 item 3), never a value on the dots themselves.
      // The visible digit alone; the full reading (n plus the stated/estimated split) is the aria-label, same text the tooltip shows.
      out += `<text x="${W}" y="${y + 4}" class="cal-n-label" text-anchor="end" aria-label="${escAttr(tPlural('ledger.tipN', row.n, { stated: row.nStated, inferred: row.nInferred }))}">${row.n}</text>`
    } else {
      out += `<text x="${padL}" y="${y + 4}" class="cal-not-enough">${escHtml(t('ledger.notEnoughYet', { n: row.n }))}</text>`
    }
  })
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.innerHTML = out

  // The row hit targets (>= 24px tall, Design 7.4 item 3, covering the full
  // width so hover/focus works whether or not the bucket has marks) are real
  // elements appended after the static markup above, not more of the same
  // string: they need to be queryable and listenable, which only a DOM API
  // call guarantees — setting innerHTML again here would also wipe the marks
  // just drawn.
  const svgNs = 'http://www.w3.org/2000/svg'
  const makeSvgEl = typeof document.createElementNS === 'function' ? (tag) => document.createElementNS(svgNs, tag) : (tag) => document.createElement(tag)
  rows.forEach((row, i) => {
    const y = padT + i * rowH + rowH / 2
    const g = makeSvgEl('g')
    g.setAttribute('class', 'cal-row-hit')
    g.setAttribute('tabindex', '0')
    g.setAttribute('role', 'img')
    g.setAttribute('aria-label', calibrationTooltipText(row))
    g.setAttribute('data-row', String(i))
    const rect = makeSvgEl('rect')
    rect.setAttribute('x', '0')
    rect.setAttribute('y', String(y - 15))
    rect.setAttribute('width', String(W))
    rect.setAttribute('height', '30')
    rect.setAttribute('fill', 'transparent')
    g.appendChild(rect)
    const show = () => showLedgerTip(g, row)
    g.addEventListener('mouseenter', show)
    g.addEventListener('mouseleave', hideLedgerTip)
    g.addEventListener('focus', show)
    g.addEventListener('blur', hideLedgerTip)
    svg.appendChild(g)
  })

  renderLedgerTable(tableEl, rows)
}

// ── The sheet: filters, the sentence, the chart, the topic line and the list ──

/** Which confidence source is showing (Design 7.4 item 1). */
let ledgerSource = 'all'
/** Which decision state is showing. */
let ledgerState = 'open'
/** GET /decisions's own rows for the currently showing state, kept so a row tap can look itself up without a refetch. */
let loadedDecisions = []

function openLedgerSheet() {
  closeMenu()
  ledgerSource = 'all'
  ledgerState = 'open'
  updateLedgerFilterTabs()
  document.getElementById('ledger-sheet').classList.add('open')
  return loadLedger()
}

function closeLedgerSheet() {
  document.getElementById('ledger-sheet').classList.remove('open')
}

const LEDGER_SOURCE_TABS = { 'ledger-source-all': 'all', 'ledger-source-stated': 'stated', 'ledger-source-inferred': 'inferred' }
const LEDGER_STATE_TABS = { 'ledger-state-open': 'open', 'ledger-state-resolved': 'resolved' }

function updateLedgerFilterTabs() {
  for (const id in LEDGER_SOURCE_TABS) {
    const el = document.getElementById(id)
    if (!el) continue
    const active = LEDGER_SOURCE_TABS[id] === ledgerSource
    el.classList.toggle('active', active)
    el.setAttribute('aria-selected', String(active))
  }
  for (const id in LEDGER_STATE_TABS) {
    const el = document.getElementById(id)
    if (!el) continue
    const active = LEDGER_STATE_TABS[id] === ledgerState
    el.classList.toggle('active', active)
    el.setAttribute('aria-selected', String(active))
  }
}

/**
 * Both filters re-fetch and re-render the sentence, the chart and the list
 * together (Design 7.4 item 1: "The source filter scopes the sentence, the
 * chart and the list"), through loadLedger below, even though GET
 * /decisions itself has no source parameter (only /decisions/calibration
 * does). A state change and a source change read identically either way,
 * rather than one silently leaving stale data on screen.
 */
function setLedgerSource(source) {
  if (source === ledgerSource) return
  ledgerSource = source
  updateLedgerFilterTabs()
  return loadLedger()
}

function setLedgerState(state) {
  if (state === ledgerState) return
  ledgerState = state
  updateLedgerFilterTabs()
  return loadLedger()
}

/**
 * Placeholder field names for the calibration rate line's structured
 * numbers (18-copy-deck.md section 8.6). GET /decisions/calibration does
 * not return these yet; T7-C will report the real names once it does, and
 * this is the one place to rename them.
 */
const LEDGER_LINE_FIELDS = { statedPct: 'line_stated_pct', hitPct: 'line_hit_pct', n: 'line_n' }

/**
 * The calibration sentence, localized when the structured fields above are
 * present, or the server's own English sentence when they are not (an
 * older Worker, or before T7-C ships them) — pure, so a test can cover both
 * shapes without a fetch.
 */
function calibrationSentence(result) {
  if (!result) return ''
  const statedPct = result[LEDGER_LINE_FIELDS.statedPct]
  const hitPct = result[LEDGER_LINE_FIELDS.hitPct]
  const n = result[LEDGER_LINE_FIELDS.n]
  if (statedPct == null || hitPct == null || n == null) return result.line || ''
  return t('ledger.lineRate', { stated: statedPct, hit: hitPct, n })
}

function renderLedgerSentence(result) {
  const el = document.getElementById('ledger-sentence')
  if (el) el.textContent = calibrationSentence(result)
}

function renderLedgerTopicLine(result) {
  const el = document.getElementById('ledger-topic')
  if (!el) return
  const line = (result && result.ready && result.topicLine) || ''
  el.hidden = !line
  el.textContent = line
}

function renderLedgerCaption(result) {
  const el = document.getElementById('ledger-caption')
  if (!el) return
  if (!result || !result.ready) {
    el.hidden = true
    el.textContent = ''
    return
  }
  el.hidden = false
  el.textContent = t('ledger.caption', { brier: result.brier.toFixed(2) })
}

/** Icon and CSS tone per outcome, kept separate from the label text below so no translation lookup is ever built from a variable key. */
const LEDGER_OUTCOME_TONE = {
  right: { icon: 'ti-check', tone: 'good' },
  wrong: { icon: 'ti-x', tone: 'danger' },
  mixed: { icon: 'ti-wave-sine', tone: 'warn' },
  unknown: { icon: 'ti-help', tone: 'neutral' },
}

function decisionOutcomeLabel(outcome) {
  if (outcome === 'right') return t('ledger.outcomeRight')
  if (outcome === 'wrong') return t('ledger.outcomeWrong')
  if (outcome === 'mixed') return t('ledger.outcomeMixed')
  if (outcome === 'unknown') return t('due.cantTellYet')
  return ''
}

function decisionOutcomeChip(outcome) {
  const spec = LEDGER_OUTCOME_TONE[outcome]
  if (!spec) return ''
  return `<span class="ledger-chip ledger-chip--${spec.tone}"><i class="ti ${spec.icon}"></i> ${escHtml(decisionOutcomeLabel(outcome))}</span>`
}

function decisionConfidenceLine(item) {
  if (item.confidence == null) return t('ledger.noConfidence')
  const pct = Math.round(item.confidence * 100)
  return item.confidence_source === 'stated' ? t('ledger.confidenceStated', { pct }) : t('ledger.confidenceInferred', { pct })
}

/** Open, or resolved-unknown-with-a-future-rearm: a review date. Otherwise a scored outcome's chip. Never both (Design 4.2: unknown still writes outcome:unknown, so "resolved" and "still has a review date" are not mutually exclusive states, but the sheet shows only one line per row.) */
function decisionStateHtml(item) {
  if (item.outcome) return decisionOutcomeChip(item.outcome)
  if (item.review_at) {
    return `<span class="digest-note">${escHtml(t('ledger.reviewAround', { date: formatDateUI(item.review_at, { year: 'numeric', month: 'short', day: 'numeric' }) }))}</span>`
  }
  return ''
}

function openLedgerEntry(id) {
  const item = loadedDecisions.find((d) => d.id === id)
  if (!item) return
  closeLedgerSheet()
  if (typeof openView === 'function') openView({ id: item.id, content: item.content })
}

function decisionRow(item) {
  const editedNote = item.edited_since_recorded ? ` · ${t('ledger.editedSince')}` : ''
  return `
    <div class="task" id="ledger-row-${escAttr(item.id)}" role="button" tabindex="0" onclick="openLedgerEntry('${escAttr(item.id)}')">
      <div class="task-t">${escHtml(titleLine(item.content, 140))}<span>${escHtml(decisionConfidenceLine(item))}${escHtml(editedNote)}</span></div>
      ${decisionStateHtml(item)}
    </div>`
}

/** The Open tab's own empty line (UX advisor round 2), so a brain with resolved decisions but nothing currently open does not read the "no decisions yet" onboarding line meant for a brain with none at all. */
function renderLedgerList() {
  const el = document.getElementById('ledger-list')
  if (!el) return
  if (!loadedDecisions.length) {
    const emptyText = ledgerState === 'open' ? t('ledger.emptyOpen') : t('ledger.empty')
    el.innerHTML = `<p class="digest-note">${escHtml(emptyText)}</p>`
    return
  }
  el.innerHTML = loadedDecisions.map(decisionRow).join('')
}

/**
 * The calibration read and chart (UX advisor round 2): rendered only once
 * its own fetch returns and qualifies. Loading and not-ready both show just
 * the sentence, with the chart wrap (legend, chart, table) hidden rather
 * than sitting there blank. A failure here degrades quietly, with no error
 * text of its own — the list below is a separate fetch (loadLedgerList) and
 * keeps working even if this one does not.
 */
async function loadLedgerCalibration() {
  const sentenceEl = document.getElementById('ledger-sentence')
  const wrapEl = document.getElementById('ledger-chart-wrap')
  if (sentenceEl) sentenceEl.textContent = t('integrations.loading')
  if (wrapEl) wrapEl.hidden = true
  renderLedgerTopicLine(null)
  renderLedgerCaption(null)
  try {
    const res = await fetch(`${WORKER_URL}/decisions/calibration?source=${ledgerSource}`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'failed')
    renderLedgerSentence(data)
    renderLedgerTopicLine(data)
    renderLedgerCaption(data)
    if (wrapEl) wrapEl.hidden = !data.ready
    if (data.ready) renderCalibrationChart(document.getElementById('ledger-chart'), data)
  } catch {
    if (sentenceEl) sentenceEl.textContent = ''
    if (wrapEl) wrapEl.hidden = true
  }
}

/** The decisions list for the current state filter: its own fetch, its own loading and error states, independent of the calibration read above. */
async function loadLedgerList() {
  const listEl = document.getElementById('ledger-list')
  if (listEl) listEl.innerHTML = `<p class="digest-note">${escHtml(t('integrations.loading'))}</p>`
  try {
    const res = await fetch(`${WORKER_URL}/decisions?state=${ledgerState}`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'failed')
    loadedDecisions = data.decisions || []
    renderLedgerList()
  } catch {
    if (listEl) {
      listEl.innerHTML = `<p class="digest-note"><i class="ti ti-wifi-off"></i> ${escHtml(t('ledger.loadFailed'))}</p>` +
        `<button type="button" class="digest-more" onclick="loadLedgerList()">${escHtml(t('ledger.tryAgain'))}</button>`
    }
  }
}

/** Both filters re-fetch and re-render the sentence, the chart and the list together (Design 7.4 item 1), through these two independent loads. */
function loadLedger() {
  return Promise.all([loadLedgerCalibration(), loadLedgerList()])
}
