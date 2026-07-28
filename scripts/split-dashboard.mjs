#!/usr/bin/env node
/**
 * One-shot splitter for public/index.html → css/ + js/ modules.
 * Run from repo root: node scripts/split-dashboard.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const htmlPath = resolve(root, 'public/index.html')
const lines = readFileSync(htmlPath, 'utf8').split(/\r?\n/)

// Inline script: between <script> after credits.js and closing </script>
const scriptStart = lines.findIndex((l, i) => i > 2900 && l.trim() === '<script>' && lines[i - 1]?.includes('credits.js'))
const scriptEnd = lines.findIndex((l, i) => i > scriptStart && l.trim() === '</script>')
const scriptLines = lines.slice(scriptStart + 1, scriptEnd)
const script = scriptLines.join('\n')

function slice(startLine, endLine) {
  // 1-based inclusive line numbers in original file
  const chunk = lines.slice(startLine - 1, endLine).join('\n')
  // strip leading 6 spaces from each line (indentation inside script tag)
  return chunk
    .split('\n')
    .map((l) => (l.startsWith('      ') ? l.slice(6) : l))
    .join('\n')
    .trim()
}

const jsDir = resolve(root, 'public/js')
mkdirSync(jsDir, { recursive: true })

const modules = {
  'state.js': slice(2909, 2919) + '\nlet pendingEditId = null\nlet integrationsInfo = []\nlet currentCategory = null\nlet graphState = null',
  'api.js': slice(3093, 3119),
  'theme.js': slice(4946, 4961),
  'ui-chat.js': slice(4849, 4944),
  'auth.js': [slice(2937, 2972), slice(3042, 3053)].join('\n\n'),
  'nav.js': [slice(2974, 3040), slice(3055, 3091)].join('\n\n'),
  'recall.js': slice(3121, 3263),
  'recent.js': [slice(3265, 3280), slice(3299, 3407)].join('\n\n'),
  'remember.js': slice(3409, 3458),
  'memory-crud.js': [slice(3460, 3573), slice(4171, 4263)].join('\n\n'),
  'settings.js': [slice(3575, 3802), slice(4062, 4169)].join('\n\n'),
  'integrations.js': slice(3804, 4060),
  'graph-canvas.js': slice(4265, 4828),
  'app.js': [slice(2921, 2935), slice(4830, 4847), 'init()'].join('\n\n'),
}

for (const [name, body] of Object.entries(modules)) {
  writeFileSync(resolve(jsDir, name), body + '\n', 'utf8')
  console.log('wrote js/' + name, '(' + body.split('\n').length + ' lines)')
}

// Build new index.html
const headEnd = 18 // through manifest link
const headPrefix = lines.slice(0, headEnd).join('\n')
const headLinks = `    <link rel="stylesheet" href="css/main.css" />
    <link rel="stylesheet" href="css/graph.css" />`

// Body: lines 2477-2693 (before graph style), then 2827-2904 (after graph style), no inline styles/scripts
const bodyPart1 = lines.slice(2476, 2693).join('\n') // 2477-2693
const bodyPart2 = lines.slice(2826, 2904).join('\n') // 2827-2904

const scripts = [
  'utils.js',
  'credits.js',
  'js/state.js',
  'js/api.js',
  'js/theme.js',
  'js/ui-chat.js',
  'js/recall.js',
  'js/recent.js',
  'js/remember.js',
  'js/memory-crud.js',
  'js/settings.js',
  'js/integrations.js',
  'js/graph-canvas.js',
  'js/nav.js',
  'js/auth.js',
  'js/app.js',
]
  .map((s) => `    <script src="${s}"></script>`)
  .join('\n')

const newHtml = `${headPrefix}
${headLinks}
  </head>

${bodyPart1}

${bodyPart2}

${scripts}
  </body>
</html>
`

writeFileSync(htmlPath, newHtml, 'utf8')
console.log('wrote index.html (' + newHtml.split('\n').length + ' lines)')
