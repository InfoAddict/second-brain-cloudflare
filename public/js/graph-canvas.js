// ── Force-directed graph view (issue #16) ─────────────────────────────────

// Graph nodes only carry an 80-char label; fetch the full memory on tap so the
// view sheet shows the whole thing. Falls back to the label if the fetch fails
// (offline etc.) so the graph never dead-ends.
async function openNodeView(node) {
  try {
    const res = await fetch(`${WORKER_URL}/entry?id=${encodeURIComponent(node.id)}`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    const data = await res.json()
    if (data.ok && data.entry) {
      openView({ id: data.entry.id, content: data.entry.content, tags: data.entry.tags }, null)
      return
    }
    throw new Error('entry fetch failed')
  } catch {
    openView({ id: node.id, content: node.label, tags: node.tags }, null)
  }
}

async function loadGraph() {
  const canvas = document.getElementById('graph-canvas')
  const emptyEl = document.getElementById('graph-empty')
  if (!canvas) return
  try {
    const res = await fetch(`${WORKER_URL}/graph`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    const data = await res.json()
    if (!data.ok || !data.nodes || !data.nodes.length) {
      graphState = null
      canvas.style.display = 'none'
      emptyEl.style.display = 'block'
      return
    }
    emptyEl.style.display = 'none'
    canvas.style.display = 'block'
    initGraphSim(canvas, data.nodes, data.edges)
  } catch (e) {
    emptyEl.textContent = 'Could not load the graph.'
    emptyEl.style.display = 'block'
  }
}

function graphNodeColor(n) {
  return n.clusterColor || '#9a958a'
}

function initGraphSim(canvas, nodes, edges) {
  const dpr = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  const W = rect.width || 600
  const H = rect.height || 420
  canvas.width = W * dpr
  canvas.height = H * dpr
  const ctx = canvas.getContext('2d')

  const byId = {}
  nodes.forEach((n) => {
    byId[n.id] = n
  })
  const links = edges.map((e) => ({ s: byId[e.source], t: byId[e.target], w: e.weight, p: e.provenance })).filter((l) => l.s && l.t)

  // No physics: node positions are computed deterministically below (static packed
  // clusters), after topic clustering.

  // Topic clusters (reagraph-style clusterAttribute): assignGraphClusters (utils.js, unit
  // tested) tags each node with n.cluster (its broad category) and n.sub (a shared
  // sub-topic within that category, or null). The clusters drive the static packed
  // layout, the outline rings, the cluster labels, and the legend below.
  assignGraphClusters(nodes)

  // Order clusters (largest first, sentinels last), assign palette colors + dense index.
  const CLUSTER_PALETTE = ['#fd540a', '#4a7c8c', '#7a9a5b', '#a9739e', '#c99a3f', '#5b8a8f', '#8c6f5b', '#6a7bb0', '#b0685f', '#5f8c6a', '#9a7bb0', '#7d8c4f']
  const SENTINEL_COLOR = { __other__: '#9a958a', __untagged__: '#b8b3a8', __autopattern__: '#9aa7ad' }
  const SENTINEL_CLUSTER = new Set(['__other__', '__untagged__', '__autopattern__'])
  const clusterLabelOf = (id) =>
    id === '__other__' ? 'Other' : id === '__untagged__' ? 'Untagged' : id === '__autopattern__' ? 'Auto-patterns' : id
  const clusterHue = (s) => {
    let h = 0
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
    return `hsl(${h % 360}, 45%, 52%)`
  }
  const clusterColor = new Map()
  const clusterLegend = []
  {
    const sz = new Map()
    for (const n of nodes) sz.set(n.cluster, (sz.get(n.cluster) || 0) + 1)
    const ordered = [...sz.keys()].sort((a, b) => {
      const sa = SENTINEL_CLUSTER.has(a),
        sb = SENTINEL_CLUSTER.has(b)
      if (sa !== sb) return sa ? 1 : -1
      return sz.get(b) - sz.get(a) || (a < b ? -1 : 1)
    })
    let pi = 0
    ordered.forEach((id) => {
      const color = SENTINEL_CLUSTER.has(id) ? SENTINEL_COLOR[id] : pi < CLUSTER_PALETTE.length ? CLUSTER_PALETTE[pi++] : clusterHue(id)
      clusterColor.set(id, color)
      clusterLegend.push({ label: clusterLabelOf(id), color, count: sz.get(id) })
    })
  }
  for (const n of nodes) n.clusterColor = clusterColor.get(n.cluster)

  // Nested packed layout (static, no physics). Two levels: pack each sub-topic's nodes into
  // a small disc, pack those sub-discs plus the category's loose nodes inside the category's
  // outer disc, then pack the outer discs on the canvas. Everything is final; nothing
  // animates. clusterList drives the outer rings/labels, subList the inner ones.
  const NODE_PACK_R = 9 // representative node radius used for packing spacing
  const GAP_SUB = 7 // gap between sub-discs / loose nodes inside a category
  const GAP_OUT = 24 // gap between category discs
  // packGraphNodes / packGraphCircles (utils.js, unit tested) do the geometry: phyllotaxis
  // node offsets within a disc, and non-overlapping closest-to-center circle packing.

  const clusterList = [] // outer category discs: { color, label, cx, cy, R }
  const subList = [] // inner sub-topic discs: { color, label, cx, cy, R }
  {
    const byOuter = new Map()
    for (const n of nodes) {
      if (!byOuter.has(n.cluster)) byOuter.set(n.cluster, [])
      byOuter.get(n.cluster).push(n)
    }
    const outerObjs = []
    for (const [id, members] of byOuter) {
      const color = clusterColor.get(id)
      // split members into sub-topic groups + loose members
      const bySub = new Map()
      const loose = []
      for (const n of members) {
        if (!n.sub) {
          loose.push(n)
          continue
        }
        if (!bySub.has(n.sub)) bySub.set(n.sub, [])
        bySub.get(n.sub).push(n)
      }
      const subs = []
      for (const [tag, subMembers] of bySub) {
        const spread = subMembers.length <= 1 ? 0 : 7 + 8 * Math.sqrt(subMembers.length)
        const local = packGraphNodes(subMembers.length, spread)
        subMembers.forEach((n, i) => {
          n.slx = local[i].x
          n.sly = local[i].y
        })
        subs.push({ tag, members: subMembers, ringR: spread + NODE_PACK_R + 3 })
      }
      // pack sub-discs (radius ringR) + loose nodes (radius NODE_PACK_R+3) inside the category
      const items = [...subs.map((s) => s.ringR), ...loose.map(() => NODE_PACK_R + 4)]
      const packed = packGraphCircles(items, GAP_SUB)
      subs.forEach((s, i) => {
        s.cx = packed.centers[i].x
        s.cy = packed.centers[i].y
      })
      loose.forEach((n, i) => {
        const c = packed.centers[subs.length + i]
        n.olx = c.x
        n.oly = c.y
      })
      outerObjs.push({ id, color, label: clusterLabelOf(id), subs, loose, R: packed.R + 9 })
    }
    // pack the category discs on the canvas (largest first)
    const outerPacked = packGraphCircles(
      outerObjs.map((o) => o.R),
      GAP_OUT,
    )
    outerObjs.forEach((o, i) => {
      o.cx = outerPacked.centers[i].x
      o.cy = outerPacked.centers[i].y
    })
    // resolve absolute node positions and build the draw lists
    for (const o of outerObjs) {
      clusterList.push({ color: o.color, label: o.label, cx: o.cx, cy: o.cy, R: o.R })
      for (const s of o.subs) {
        const scx = o.cx + s.cx
        const scy = o.cy + s.cy
        subList.push({ color: o.color, label: s.tag, cx: scx, cy: scy, R: s.ringR })
        for (const n of s.members) {
          n.x = scx + n.slx
          n.y = scy + n.sly
        }
      }
      for (const n of o.loose) {
        n.x = o.cx + n.olx
        n.y = o.cy + n.oly
      }
    }
  }

  // cam maps world → screen: screen = world * scale + (x, y). Node coords are in world space.
  const cam = { x: 0, y: 0, scale: 1 }
  const pointers = new Map()
  const state = {
    hover: null,
    pressNode: null,
    panning: false,
    panStart: null,
    moved: false,
    downId: null,
    pinch: null,
    cam,
  }
  graphState = state

  const SHOW_LABELS = nodes.length <= 50 // hide always-on labels on big graphs (hover still works)
  const nodeRadius = (n) => 5 + Math.min(6, n.importance || 0)

  const localXY = (ev) => {
    const r = canvas.getBoundingClientRect()
    return { x: ev.clientX - r.left, y: ev.clientY - r.top }
  }
  const screenToWorld = (sx, sy) => ({ x: (sx - cam.x) / cam.scale, y: (sy - cam.y) / cam.scale })
  function nodeAt(sx, sy) {
    const w = screenToWorld(sx, sy)
    const tol = 18 / cam.scale
    let best = null,
      bestD = tol * tol
    for (const n of nodes) {
      const dx = n.x - w.x,
        dy = n.y - w.y,
        d = dx * dx + dy * dy
      if (d < bestD) {
        bestD = d
        best = n
      }
    }
    return best
  }

  // ── camera: zoom toward a screen point, and fit-to-view ──
  const clampScale = (s) => Math.max(0.05, Math.min(4, s)) // floor low enough to fit an uncapped graph
  function zoomAround(sx, sy, factor) {
    const ns = clampScale(cam.scale * factor)
    cam.x = sx - (sx - cam.x) * (ns / cam.scale)
    cam.y = sy - (sy - cam.y) * (ns / cam.scale)
    cam.scale = ns
    requestDraw()
  }
  function fit() {
    if (!nodes.length) return
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity
    for (const n of nodes) {
      minX = Math.min(minX, n.x)
      maxX = Math.max(maxX, n.x)
      minY = Math.min(minY, n.y)
      maxY = Math.max(maxY, n.y)
    }
    const pad = 70
    const gw = maxX - minX || 1,
      gh = maxY - minY || 1
    cam.scale = clampScale(Math.min((W - pad) / gw, (H - pad) / gh, 1.4))
    cam.x = W / 2 - ((minX + maxX) / 2) * cam.scale
    cam.y = H / 2 - ((minY + maxY) / 2) * cam.scale
    requestDraw()
  }
  state.api = { zoomBy: (f) => zoomAround(W / 2, H / 2, f), fit, redraw: () => requestDraw() }

  // ── input: wheel zoom, pointer drag/pan, two-pointer pinch ──
  canvas.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault()
      const p = localXY(ev)
      zoomAround(p.x, p.y, Math.exp(-ev.deltaY * 0.0015))
    },
    { passive: false },
  )

  const twoPointers = () => [...pointers.values()]
  function startPinch() {
    const [a, b] = twoPointers()
    state.pressNode = null
    state.panning = false
    state.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale: cam.scale }
  }
  function movePinch() {
    const [a, b] = twoPointers()
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    zoomAround(mid.x, mid.y, (dist / state.pinch.dist) * (state.pinch.scale / cam.scale))
  }

  canvas.addEventListener('pointerdown', (ev) => {
    canvas.setPointerCapture(ev.pointerId)
    const p = localXY(ev)
    pointers.set(ev.pointerId, p)
    if (pointers.size === 2) {
      startPinch()
      return
    }
    state.moved = false
    state.downId = ev.pointerId
    state.pressNode = nodeAt(p.x, p.y) // remembered for tap-to-open; any drag pans the canvas
    state.panning = true
    state.panStart = { x: ev.clientX - cam.x, y: ev.clientY - cam.y }
    canvas.style.cursor = 'grabbing'
  })

  canvas.addEventListener('pointermove', (ev) => {
    const p = localXY(ev)
    if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, p)
    if (state.pinch && pointers.size === 2) {
      movePinch()
      return
    }
    if (state.panning) {
      cam.x = ev.clientX - state.panStart.x
      cam.y = ev.clientY - state.panStart.y
      state.moved = true
      requestDraw()
    } else {
      const prev = state.hover
      state.hover = nodeAt(p.x, p.y)
      canvas.style.cursor = state.hover ? 'pointer' : 'grab'
      if (prev !== state.hover) draw()
    }
  })

  function endPointer(ev) {
    pointers.delete(ev.pointerId)
    try {
      canvas.releasePointerCapture(ev.pointerId)
    } catch (e) {}
    if (state.pinch && pointers.size < 2) state.pinch = null
    if (ev.pointerId === state.downId) {
      if (state.pressNode && !state.moved) openNodeView(state.pressNode)
      state.pressNode = null
      state.panning = false
      state.downId = null
      canvas.style.cursor = 'grab'
      requestDraw()
    }
  }
  canvas.addEventListener('pointerup', endPointer)
  canvas.addEventListener('pointercancel', endPointer)
  canvas.addEventListener('pointerleave', () => {
    if (!state.panning && state.hover) {
      state.hover = null
      draw()
    }
  })

  function shortLabel(n) {
    const t = (n.label || '').replace(/\s+/g, ' ').trim()
    return t.length > 22 ? t.slice(0, 22).trimEnd() + '…' : t
  }
  // A rounded label pill centered horizontally at cx, with its top at topY (world coords).
  function labelPill(text, cx, topY, emphasize, alpha) {
    ctx.font = (emphasize ? '600 ' : '') + '11px "Geist", system-ui, sans-serif'
    const tw = ctx.measureText(text).width
    const padX = 5,
      h = 16,
      rr = 5
    const x = cx - tw / 2 - padX
    const w = tw + padX * 2
    ctx.globalAlpha = alpha
    ctx.fillStyle = emphasize ? 'rgba(252,251,247,0.97)' : 'rgba(252,251,247,0.82)'
    ctx.beginPath()
    ctx.moveTo(x + rr, topY)
    ctx.arcTo(x + w, topY, x + w, topY + h, rr)
    ctx.arcTo(x + w, topY + h, x, topY + h, rr)
    ctx.arcTo(x, topY + h, x, topY, rr)
    ctx.arcTo(x, topY, x + w, topY, rr)
    ctx.fill()
    ctx.fillStyle = emphasize ? '#161616' : '#68635f'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, cx, topY + h / 2)
    ctx.globalAlpha = 1
  }

  function requestDraw() {
    draw()
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    ctx.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, dpr * cam.x, dpr * cam.y)
    const hover = state.hover
    // Theme-aware ink: dark strokes on the light theme, light strokes on the dark theme,
    // so edges and the hover ring stay visible in both. Slightly more alpha in dark mode
    // since light lines read fainter on a dark background.
    const darkTheme = document.documentElement.getAttribute('data-theme') === 'dark'
    const inkRGB = darkTheme ? '242,239,236' : '22,22,22'
    const inkHex = darkTheme ? '#f2efec' : '#161616'
    const edgeA = darkTheme ? 0.15 : 0.06
    const edgeDimA = darkTheme ? 0.07 : 0.03
    // Outer category rings: a barely-there fill plus a screen-constant stroke (a boundary,
    // not a shaded blob). c.R already includes the ring padding.
    for (const c of clusterList) {
      ctx.beginPath()
      ctx.arc(c.cx, c.cy, c.R, 0, Math.PI * 2)
      ctx.globalAlpha = 0.045
      ctx.fillStyle = c.color
      ctx.fill()
      ctx.globalAlpha = 0.5
      ctx.strokeStyle = c.color
      ctx.lineWidth = 1.25 / cam.scale
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    // Inner sub-topic rings: same hue, thinner and dashed, no fill.
    ctx.setLineDash([4 / cam.scale, 4 / cam.scale])
    for (const s of subList) {
      ctx.beginPath()
      ctx.arc(s.cx, s.cy, s.R, 0, Math.PI * 2)
      ctx.globalAlpha = 0.4
      ctx.strokeStyle = s.color
      ctx.lineWidth = 1 / cam.scale
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    ctx.setLineDash([])
    for (const l of links) {
      const dim = l.s.status === 'deprecated' || l.t.status === 'deprecated'
      const lit = hover && (l.s === hover || l.t === hover)
      // Edge dash encodes provenance: solid = you linked, dashed = auto-inferred, dotted = system.
      ctx.setLineDash(
        l.p === 'explicit' ? [] :
        l.p === 'system' ? [1 / cam.scale, 2 / cam.scale] :
        [3 / cam.scale, 3 / cam.scale],
      )
      ctx.strokeStyle = lit ? 'rgba(178,102,65,0.55)' : dim ? `rgba(${inkRGB}, ${edgeDimA})` : `rgba(${inkRGB}, ${edgeA})`
      ctx.lineWidth = lit ? Math.max(1.5, l.w * 2.5) : Math.max(0.4, l.w * 1.5)
      ctx.beginPath()
      ctx.moveTo(l.s.x, l.s.y)
      ctx.lineTo(l.t.x, l.t.y)
      ctx.stroke()
    }
    ctx.setLineDash([])
    for (const n of nodes) {
      const r = nodeRadius(n)
      ctx.globalAlpha = n.status === 'deprecated' ? 0.4 : 1
      ctx.fillStyle = graphNodeColor(n)
      ctx.beginPath()
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
      ctx.fill()
      if (n === hover) {
        ctx.globalAlpha = 1
        ctx.strokeStyle = inkHex
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(n.x, n.y, r + 3, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    }
    // labels scale with zoom; hide the always-on ones when zoomed far out to avoid clutter
    if (SHOW_LABELS && cam.scale >= 0.5) {
      for (const n of nodes) {
        if (n === hover) continue
        labelPill(shortLabel(n), n.x, n.y + nodeRadius(n) + 4, false, n.status === 'deprecated' ? 0.5 : 1)
      }
    }
    // Cluster labels: a bold, cluster-colored pill above each cluster's top edge.
    if (cam.scale >= 0.4) {
      for (const c of clusterList) {
        const cx = c.cx
        const cy = c.cy - c.R - 16
        ctx.font = '700 13px "Geist", system-ui, sans-serif'
        const tw = ctx.measureText(c.label).width
        const padX = 7
        const h = 20
        const rr = 6
        const x = cx - tw / 2 - padX
        const w = tw + padX * 2
        const topY = cy - h / 2
        ctx.globalAlpha = 0.92
        ctx.fillStyle = 'rgba(252,251,247,0.9)'
        ctx.beginPath()
        ctx.moveTo(x + rr, topY)
        ctx.arcTo(x + w, topY, x + w, topY + h, rr)
        ctx.arcTo(x + w, topY + h, x, topY + h, rr)
        ctx.arcTo(x, topY + h, x, topY, rr)
        ctx.arcTo(x, topY, x + w, topY, rr)
        ctx.fill()
        ctx.fillStyle = c.color
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(c.label, cx, cy)
        ctx.globalAlpha = 1
      }
    }
    // Inner sub-topic labels (smaller; shown only when zoomed in enough to read them).
    if (cam.scale >= 0.7) {
      for (const s of subList) {
        const cx = s.cx
        const cy = s.cy - s.R - 9
        ctx.font = '600 10px "Geist", system-ui, sans-serif'
        const tw = ctx.measureText(s.label).width
        const padX = 5
        const h = 15
        const rr = 5
        const x = cx - tw / 2 - padX
        const w = tw + padX * 2
        const topY = cy - h / 2
        ctx.globalAlpha = 0.9
        ctx.fillStyle = 'rgba(252,251,247,0.88)'
        ctx.beginPath()
        ctx.moveTo(x + rr, topY)
        ctx.arcTo(x + w, topY, x + w, topY + h, rr)
        ctx.arcTo(x + w, topY + h, x, topY + h, rr)
        ctx.arcTo(x, topY + h, x, topY, rr)
        ctx.arcTo(x, topY, x + w, topY, rr)
        ctx.fill()
        ctx.fillStyle = s.color
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(s.label, cx, cy)
        ctx.globalAlpha = 1
      }
    }
    if (hover) {
      const full = (hover.label || '').replace(/\s+/g, ' ').trim()
      const text = full.length > 48 ? full.slice(0, 48).trimEnd() + '…' : full
      const withKind = hover.kind ? `${hover.kind} · ${text}` : text
      labelPill(withKind, hover.x, hover.y + nodeRadius(hover) + 4, true, 1)
    }
    // Legend (screen space): color swatch + label + count per cluster, top-left,
    // fixed while the graph pans/zooms. Ivory pill + dark text reads on both themes.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (clusterLegend.length) {
      const rows = clusterLegend.slice(0, 10)
      ctx.font = '600 11px "Geist", system-ui, sans-serif'
      let maxW = 0
      for (const r of rows) maxW = Math.max(maxW, ctx.measureText(r.label).width + ctx.measureText(String(r.count)).width)
      const padX = 8
      const rowH = 17
      const sw = 10
      const gap = 24
      const boxW = padX * 2 + sw + 6 + maxW + gap
      const boxH = padX + rows.length * rowH
      ctx.globalAlpha = 0.92
      ctx.fillStyle = 'rgba(252,251,247,0.9)'
      ctx.beginPath()
      ctx.rect(10, 10, boxW, boxH)
      ctx.fill()
      ctx.globalAlpha = 1
      ctx.textBaseline = 'middle'
      rows.forEach((r, i) => {
        const y = 10 + padX + i * rowH + rowH / 2 - 4
        ctx.fillStyle = r.color
        ctx.beginPath()
        ctx.arc(10 + padX + sw / 2, y, sw / 2, 0, Math.PI * 2)
        ctx.fill()
        ctx.textAlign = 'left'
        ctx.fillStyle = '#161616'
        ctx.fillText(r.label, 10 + padX + sw + 6, y)
        ctx.textAlign = 'right'
        ctx.fillStyle = '#68635f'
        ctx.fillText(String(r.count), 10 + boxW - padX, y)
      })
    }
  }

  fit()
}

function graphZoom(factor) {
  if (graphState && graphState.api) graphState.api.zoomBy(factor)
}
function graphFit() {
  if (graphState && graphState.api) graphState.api.fit()
}
