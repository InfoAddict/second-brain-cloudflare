function appendBrainBubble(container, text, cls) {
  const el = document.createElement('div')
  el.className = cls || 'recall-sys'
  el.textContent = text
  container.appendChild(el)
}

// Lightweight markdown → HTML for AI answers (headings, bold/italic, bullet & numbered lists).
function renderAnswerMarkdown(src) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (s) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')

  // Some models stream lists inline ("... tools: * a * b * c") with no newlines.
  // Re-break a run of " * " markers onto their own lines so they parse as a list.
  let text = String(src || '').replace(/\r/g, '')
  if (!/\n\s*[*-]\s/.test(text) && (text.match(/\s\*\s/g) || []).length >= 2) {
    text = text.replace(/\s\*\s+/g, '\n* ')
  }

  const lines = text.split('\n')
  let html = ''
  let listType = null // 'ul' | 'ol'
  const closeList = () => {
    if (listType) {
      html += `</${listType}>`
      listType = null
    }
  }

  lines.forEach((line) => {
    const t = line.trim()
    if (!t) {
      closeList()
      return
    }

    let m
    if ((m = t.match(/^(#{1,4})\s+(.*)$/))) {
      closeList()
      const lvl = Math.min(m[1].length + 2, 4) // h3/h4
      html += `<h${lvl}>${inline(m[2])}</h${lvl}>`
    } else if ((m = t.match(/^[*\-•]\s+(.*)$/))) {
      if (listType !== 'ul') {
        closeList()
        html += '<ul>'
        listType = 'ul'
      }
      html += `<li>${inline(m[1])}</li>`
    } else if ((m = t.match(/^\d+[.)]\s+(.*)$/))) {
      if (listType !== 'ol') {
        closeList()
        html += '<ol>'
        listType = 'ol'
      }
      html += `<li>${inline(m[1])}</li>`
    } else {
      closeList()
      html += `<p>${inline(t)}</p>`
    }
  })
  closeList()
  return html
}
function appendUserBubble(container, text) {
  const q = document.createElement('div')
  q.className = 'ex-q'
  q.innerHTML = '<span class="q-label">You asked</span><span class="q-dash">\u2014</span><span class="q-text"></span>'
  q.querySelector('.q-text').textContent = text
  container.appendChild(q)
}
function appendLoading(container) {
  const row = document.createElement('div')
  row.className = 'bubble-row brain'
  row.innerHTML = `<div class="loading-dots"><span></span><span></span><span></span></div>`
  container.appendChild(row)
  return row
}
function autoResize(el) {
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 80) + 'px'
}
function clearRemember() {
  const msgs = document.getElementById('remember-messages')
  msgs.innerHTML = `<div class="recall-hero" id="remember-intro"><div class="eyebrow">Remember</div><div class="hero-line">What's worth keeping? Write it down &mdash; add <span class="hashtag">#tags</span> anywhere and I'll file it.</div></div>`
  document.getElementById('remember-clear-btn').style.display = 'none'
}
function clearRecall() {
  const msgs = document.getElementById('recall-messages')
  msgs.innerHTML = `<div class="recall-hero" id="recall-welcome"><div class="eyebrow">Recall</div><div class="hero-line">Ask me anything you've stored away &mdash; I'll find it and answer in your own words.</div></div>`
  document.getElementById('recall-clear-btn').style.display = 'none'
}
