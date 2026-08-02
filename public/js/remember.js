function handleRememberKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendRemember()
  }
}

async function sendRemember() {
  const input = document.getElementById('remember-input')
  const raw = input.value.trim()
  if (!raw) return
  const msgs = document.getElementById('remember-messages')
  const tags = [],
    tagRe = /#([a-zA-Z0-9_-]+)/g
  let m
  while ((m = tagRe.exec(raw)) !== null) tags.push(m[1])
  const content = raw.replace(/#[a-zA-Z0-9_-]+/g, '').trim()
  const userRow = document.createElement('div')
  userRow.className = 'capture-note'
  const introEl = document.getElementById('remember-intro')
  if (introEl) introEl.remove()
  userRow.innerHTML = raw.replace(/#([a-zA-Z0-9_-]+)/g, '<span class="hashtag">#$1</span>')
  msgs.appendChild(userRow)
  input.value = ''
  autoResize(input)
  msgs.scrollTop = msgs.scrollHeight
  const loadingEl = appendLoading(msgs)
  msgs.scrollTop = msgs.scrollHeight
  try {
    const result = await apiCapture(content || raw, tags, 'web-ui')
    loadingEl.remove()
    if (result.duplicate) {
      appendBrainBubble(msgs, 'Already kept \u2014 I have something very similar, so I skipped the duplicate.', 'sys-note')
    } else {
      appendBrainBubble(msgs, "Kept. I'll remember that.", 'sys-note')
      if (tags.length) {
        const confirmEl = document.createElement('div')
        confirmEl.className = 'confirm-block'
        confirmEl.innerHTML = `<div class="confirm-line"><i class="ti ti-circle-check"></i> Tagged as:</div><div class="confirm-tags">${tags.map((t) => `<span class="confirm-tag">${escHtml(t)}</span>`).join('')}</div>`
        msgs.appendChild(confirmEl)
      }
      updateStatus()
    }
    document.getElementById('remember-clear-btn').style.display = 'flex'
  } catch {
    loadingEl.remove()
    appendBrainBubble(msgs, 'Something went wrong. Try again.', 'sys-note')
  }
  msgs.scrollTop = msgs.scrollHeight
}
