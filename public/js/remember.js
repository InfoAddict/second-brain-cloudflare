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
      msgs.appendChild(captureReceipt(result, tags))
      updateStatus()
    }
    document.getElementById('remember-clear-btn').style.display = 'flex'
  } catch {
    loadingEl.remove()
    appendBrainBubble(msgs, 'Something went wrong. Try again.', 'sys-note')
  }
  msgs.scrollTop = msgs.scrollHeight
}

/**
 * What the brain did with what you just wrote.
 *
 * Saving used to answer "Kept. I'll remember that." and, if you had typed
 * hashtags, echo them back — which told you only what you already knew. The
 * capture pipeline does considerably more: it files under the tags it found,
 * notices when a memory contradicts something older, merges near-duplicates,
 * and flags similar entries. All of that came back in the response and none of
 * it was shown. The marketing site's demo card ("● stored to brain") is this
 * moment; this makes the product keep that promise.
 */
function captureReceipt(result, typedTags) {
  const el = document.createElement('div')
  el.className = 'receipt'

  // The Worker reports what actually landed on the row, which includes tags it
  // pulled out of the content itself — not just the ones typed here.
  const filed = humanTags(result.tags && result.tags.length ? result.tags : typedTags || [])

  let headline = 'stored to brain'
  const notes = []
  if (result.action === 'merged') {
    headline = 'merged into an existing memory'
    notes.push('You had written about this before, so the two are now one memory.')
  } else if (result.action === 'replaced') {
    headline = 'replaced an outdated memory'
    notes.push('The older version is gone; this one supersedes it.')
  } else if (result.resolved_conflict) {
    headline = 'stored, and something older now disagrees'
    notes.push('Your brain noticed this conflicts with an earlier memory and kept the newer one.')
  } else if (result.kept_canonical) {
    headline = 'stored as a draft'
    notes.push('This conflicts with a memory you have confirmed, so it is kept unconfirmed rather than overriding it.')
  } else if (result.warning === 'similar') {
    headline = 'stored, close to something you already had'
    notes.push('Flagged as a possible duplicate so you can compare them later.')
  }

  el.innerHTML =
    `<div class="receipt-headline"><span class="receipt-dot"></span>${escHtml(headline)}</div>` +
    (filed.length
      ? `<div class="receipt-filed">filed under ${filed.map((t) => `<span class="confirm-tag">${escHtml(t)}</span>`).join('')}</div>`
      : '') +
    notes.map((n) => `<div class="receipt-note">${escHtml(n)}</div>`).join('')
  return el
}
