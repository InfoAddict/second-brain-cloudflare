async function apiMcp(toolName, args) {
  const res = await fetch(`${WORKER_URL}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${AUTH_TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: toolName, arguments: args } }),
  })
  const text = await res.text()
  const match = text.match(/data: ({.+})/s)
  if (!match) throw new Error(t('common.invalidResponse'))
  const json = JSON.parse(match[1])
  if (json.error) throw new Error(json.error.message || t('common.mcpError'))
  return json.result?.content?.[0]?.text ?? ''
}

async function apiCapture(content, tags, source) {
  const res = await fetch(`${WORKER_URL}/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
    body: JSON.stringify({ content, tags, source: source || 'web-ui' }),
  })
  return res.json()
}

async function apiList(n = 50) {
  const res = await fetch(`${WORKER_URL}/list?n=${n}`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
  return res.json()
}
