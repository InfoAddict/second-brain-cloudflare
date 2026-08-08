function sendSuggestion(text) {
  document.getElementById('recall-input').value = text
  sendRecall()
}
function handleRecallKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendRecall()
  }
}

async function sendRecall() {
  const input = document.getElementById('recall-input')
  const query = input.value.trim()
  if (!query) return
  const msgs = document.getElementById('recall-messages')
  const welcome = document.getElementById('recall-welcome')
  if (welcome) welcome.remove()
  appendUserBubble(msgs, query)
  input.value = ''
  autoResize(input)
  const loadingEl = appendLoading(msgs)
  msgs.scrollTop = msgs.scrollHeight
  try {
    // Use the REST endpoint for structured results — parsing the MCP tool's
    // formatted text miscounts sources when memory content contains list items
    // hops=1 lets recall follow relationship edges one step out; direct matches
    // always outrank expanded ones (worker applies a graph-distance penalty)
    // full=1: the dashboard renders whole memories in its cards, so it opts out
    // of the snippet shortening that keeps API/agent responses small
    const params = new URLSearchParams({ query, topK: '5', hops: '1', full: '1' })
    if (selectedTag) params.set('tag', selectedTag)
    const recallRes = await fetch(`${WORKER_URL}/recall?${params}`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    const data = await recallRes.json()
    // Server/auth errors must not render as "no results" — let the catch handle them
    if (!recallRes.ok || !data.ok) throw new Error(data.error || 'recall failed')
    loadingEl.remove()
    if (!data.results || !data.results.length) {
      appendBrainBubble(msgs, "I couldn't find anything matching that. Try different words, or check Recent.", 'recall-sys')
    } else {
      // REST scores are already 0–100 (one decimal); map directly rather than via
      // normalizeEntry, whose 0–1 rescale heuristic would turn a 0.8% match into 80%
      const entries = data.results.map((m) => ({ id: m.id, content: m.content, tags: m.tags || [], score: Math.min(100, Math.round(m.score)), hop: m.hop || 0 }))
      const answerBubble = document.createElement('div')
      answerBubble.className = 'ex-a-row'
      const answerEl = document.createElement('div')
      answerEl.className = 'ex-a'
      answerBubble.appendChild(answerEl)
      msgs.appendChild(answerBubble)

      // Serialize results for the /chat LLM context, mirroring the MCP tool's
      // format — dates/tags/source are needed for temporal questions
      const memories =
        (data.insight ? `Insight: ${data.insight}\n\n` : '') +
        data.results
          .map((m, i) => {
            const date = new Date(m.created_at).toLocaleDateString()
            const tagList = m.tags && m.tags.length ? ` [${m.tags.join(', ')}]` : ''
            const src = m.source ? ` · ${m.source}` : ''
            const related = m.hop > 0 ? ` [related, ${m.hop} hop${m.hop > 1 ? 's' : ''}]` : ''
            return `${i + 1}. [${date}${src}${tagList}] (${Math.min(100, Math.round(m.score))}% match)${m.updated ? ' [updated]' : ''}${related}\n${m.content}`
          })
          .join('\n\n')
      const res = await fetch(`${WORKER_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
        body: JSON.stringify({ query, memories }),
      })

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let fullText = ''
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const chunk = decoder.decode(value)
          chunk.split('\n').forEach((line) => {
            if (line.startsWith('data: ')) {
              const raw = line.slice(6).trim()
              if (raw === '[DONE]') return
              try {
                const d = JSON.parse(raw)
                if (d.response) {
                  fullText += d.response
                  answerEl.textContent = fullText
                }
              } catch {}
            }
          })
          msgs.scrollTop = msgs.scrollHeight
        }
      } finally {
        reader.releaseLock()
      }

      // Render markdown once the stream is complete (kept plain while streaming for speed)
      answerEl.innerHTML = renderAnswerMarkdown(fullText)

      // 2. Sources toggle
      const sourcesToggle = document.createElement('div')
      sourcesToggle.className = 'sources-toggle'
      sourcesToggle.innerHTML = `<button onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'flex' : 'none'">
      <i class="ti ti-files"></i> ${entries.length} source${entries.length === 1 ? '' : 's'}
    </button>
    <div class="brain-cards-wrapper" style="display:none"></div>`
      entries.forEach((e) => sourcesToggle.querySelector('.brain-cards-wrapper').appendChild(makeRecallCard(e)))
      msgs.appendChild(sourcesToggle)
      document.getElementById('recall-clear-btn').style.display = 'flex'
    }
  } catch {
    loadingEl.remove()
    appendBrainBubble(msgs, 'Something went wrong. Check your connection and try again.', 'recall-sys')
  }
  msgs.scrollTop = msgs.scrollHeight
}

function makeRecallCard(entry) {
  const card = document.createElement('div')
  const isSynthesized = entry.tags.includes('synthesized')
  const isRolledUp = entry.tags.includes('rolled-up')
  const isStale = entry.stale_as_of || entry.tags.includes('stale:as-of')
  card.className = 'memory-card' + (isSynthesized ? ' card--synthesized' : '') + (isRolledUp ? ' card--rolled-up' : '') + (isStale ? ' card--stale' : '')
  card.innerHTML = `
    <div class="match-line">
<span class="match-pct">${entry.score}%</span>
${entry.hop > 0 ? `<span class="tag-chip" style="background:var(--accent-soft);color:var(--accent);flex-shrink:0">related · ${entry.hop} hop${entry.hop > 1 ? 's' : ''}</span>` : ''}
<div class="match-bar-bg"><div class="match-bar-fill" style="width:${entry.score}%"></div></div>
    </div>
    <div class="card-content" style="cursor: pointer;">${escHtml(stripToPlainText(entry.content))}</div>
    <div class="card-footer">
<div class="card-tags">${humanTags(entry.tags).map((t) => `<span class="tag-chip">${escHtml(t)}</span>`).join('')}</div>
<div class="card-actions">
  ${
    entry.id
      ? `<button class="card-action-btn" onclick="openAppend('${escAttr(entry.id)}', '${escAttr(entry.content.slice(0, 80))}')"><i class="ti ti-writing"></i> Append</button>`
      : `<button class="card-action-btn" onclick="openAppendFromContent('${escAttr(entry.content)}')"><i class="ti ti-writing"></i> Append</button>`
  }
</div>
    </div>`
  card.querySelector('.card-content').onclick = () => openView(entry, card)
  return card
}
