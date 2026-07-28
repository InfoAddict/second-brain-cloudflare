function openAppend(id, preview) {
  pendingAppendId = id
  document.getElementById('append-context-preview').textContent = preview + '...'
  document.getElementById('append-textarea').value = ''
  document.getElementById('append-sheet').classList.add('open')
  setTimeout(() => document.getElementById('append-textarea').focus(), 100)
}
function openAppendFromContent() {
  switchTab('remember')
  document.getElementById('remember-input').focus()
}
function closeAppend() {
  document.getElementById('append-sheet').classList.remove('open')
  pendingAppendId = null
}
async function saveAppend() {
  const addition = document.getElementById('append-textarea').value.trim()
  if (!addition || !pendingAppendId) return
  const btn = document.getElementById('append-save-btn')
  btn.disabled = true
  btn.textContent = 'Saving...'
  try {
    await apiMcp('append', { id: pendingAppendId, addition })
    closeAppend()
    loadRecent()
    updateStatus()
  } catch (e) {
    btn.disabled = false
    btn.textContent = 'Update'
    alert('Append failed: ' + e.message)
  }
}

function openEdit(id, content, tags) {
  pendingEditId = id
  const tagsEl = document.getElementById('edit-existing-tags')
  tagsEl.innerHTML = tags && tags.length ? tags.map((t) => `<span class="tag-chip">${escHtml(t)}</span>`).join('') : ''
  const ta = document.getElementById('edit-textarea')
  ta.value = content
  ta.style.height = 'auto'
  ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
  document.getElementById('edit-sheet').classList.add('open')
  setTimeout(() => ta.focus(), 100)
}

function closeEdit() {
  document.getElementById('edit-sheet').classList.remove('open')
  pendingEditId = null
}

async function saveEdit() {
  const newContent = document.getElementById('edit-textarea').value.trim()
  if (!newContent || !pendingEditId) return
  const btn = document.getElementById('edit-save-btn')
  btn.disabled = true
  btn.textContent = 'Saving...'
  try {
    const res = await fetch(`${WORKER_URL}/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ id: pendingEditId, content: newContent }),
    })
    if (!res.ok) throw new Error(`Server error: ${res.status}`)
    closeEdit()
    loadRecent()
  } catch (e) {
    btn.disabled = false
    btn.textContent = 'Save'
    alert('Edit failed: ' + e.message)
  }
}

function openConfirm(id, btnOrCard) {
  pendingForgetId = id
  pendingForgetCard = btnOrCard ? (btnOrCard.classList?.contains('memory-card') ? btnOrCard : btnOrCard.closest('.memory-card')) : null
  document.getElementById('confirm-dialog').classList.add('open')
}
function closeConfirm() {
  document.getElementById('confirm-dialog').classList.remove('open')
  pendingForgetId = null
  pendingForgetCard = null
}
async function confirmForget() {
  if (!pendingForgetId) return
  const idToForget = pendingForgetId
  const cardElement = pendingForgetCard
  const btn = document.querySelector('#confirm-dialog .btn-delete')
  if (btn) {
    btn.disabled = true
    btn.textContent = 'Forgetting...'
  }

  try {
    await apiMcp('forget', { id: idToForget })
    closeConfirm()
    if (cardElement) {
      cardElement.style.transition = 'none'
      cardElement.classList.add('explode-out')
      setTimeout(() => cardElement?.remove(), 400)
    }
    allEntries = allEntries.filter((e) => e.id !== idToForget)
    updateStatus()
    loadTags()
  } catch (e) {
    alert('Could not forget: ' + e.message)
  } finally {
    if (btn) {
      btn.disabled = false
      btn.textContent = 'Forget'
    }
  }
}

function openView(entry, cardElement) {
  document.getElementById('view-content-text').textContent = entry.content
  const tagsContainer = document.getElementById('view-tags-container')
  tagsContainer.innerHTML = ''
  if (entry.tags && entry.tags.length > 0) {
    tagsContainer.innerHTML = entry.tags.map((t) => `<span class="tag-chip">${escHtml(t)}</span>`).join('')
  }
  const relatedEl = document.getElementById('view-related')
  relatedEl.style.display = 'none'
  relatedEl.innerHTML = ''
  if (entry.id) loadRelated(entry.id, relatedEl)
  const appendBtn = document.getElementById('view-btn-append')
  if (entry.id) {
    appendBtn.onclick = () => {
      closeView()
      openAppend(entry.id, entry.content.slice(0, 80))
    }
  } else {
    appendBtn.onclick = () => {
      closeView()
      openAppendFromContent(entry.content)
    }
  }
  const forgetBtn = document.getElementById('view-btn-forget')
  if (entry.id) {
    forgetBtn.onclick = () => {
      closeView()
      openConfirm(entry.id, cardElement || null)
    }
    forgetBtn.style.display = 'flex'
  } else {
    forgetBtn.style.display = 'none'
  }
  const editBtn = document.getElementById('view-btn-edit')
  if (entry.id) {
    editBtn.onclick = () => {
      closeView()
      openEdit(entry.id, entry.content, entry.tags || [])
    }
    editBtn.style.display = 'flex'
  } else {
    editBtn.style.display = 'none'
  }
  document.getElementById('view-sheet').classList.add('open')
}
function closeView() {
  document.getElementById('view-sheet').classList.remove('open')
}

// ── Related memories (issue #16) ──────────────────────────────────────────
async function loadRelated(id, el) {
  try {
    const res = await fetch(`${WORKER_URL}/connections?id=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })
    const data = await res.json()
    if (!data.ok || !data.connections || !data.connections.length) {
      // also handles the refresh after the last link is removed
      el.style.display = 'none'
      el.innerHTML = ''
      return
    }
    el.innerHTML =
      `<div class="view-related-label">Related</div>` +
      data.connections
        .map(
          (c) => {
            const who = c.provenance === 'explicit' ? 'you linked' : c.provenance === 'system' ? 'system-linked' : 'auto-linked'
            const when = c.linkedAt ? ' · ' + new Date(c.linkedAt).toLocaleDateString() : ''
            return `<div class="related-item" data-id="${escHtml(c.id)}" data-type="${escHtml(c.type)}"><button class="related-open"><span class="related-type">${escHtml(c.label)} · ${who}${when}</span>${escHtml((c.content || '').slice(0, 80))}</button><button class="related-unlink" title="Remove link"><i class="ti ti-unlink"></i></button></div>`
          },
        )
        .join('')
    el.style.display = 'block'
    el.querySelectorAll('.related-item').forEach((row) => {
      row.querySelector('.related-open').onclick = () => {
        const c = data.connections.find((x) => x.id === row.dataset.id)
        if (c) openView({ id: c.id, content: c.content, tags: c.tags }, null)
      }
      row.querySelector('.related-unlink').onclick = async () => {
        if (!confirm('Remove this link? The memories stay; only the connection is deleted.')) return
        try {
          await fetch(`${WORKER_URL}/unlink`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
            body: JSON.stringify({ source_id: id, target_id: row.dataset.id, type: row.dataset.type }),
          })
        } catch {}
        loadRelated(id, el)
      }
    })
  } catch {}
}
