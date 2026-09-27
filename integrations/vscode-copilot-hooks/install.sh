#!/usr/bin/env bash
# Installs, upgrades, checks or removes the Second Brain SessionStart hook in
# VS Code GitHub Copilot's Local harness user-level hooks file
# (~/.copilot/hooks/second-brain.json).
#
#   bash install.sh https://your-worker.workers.dev your-token   install or upgrade
#   bash install.sh                                              reuse ~/.config/second-brain/config.json, or prompt
#   bash install.sh --check                                      prove the hook reaches the Worker
#   bash install.sh --uninstall                                  remove only our entry
#
# Local harness ONLY (not Copilot CLI / cloud agent / Agent Host - see
# README.md). Credentials go to ~/.config/second-brain/config.json, the same
# file every other Second Brain hook adapter and the CLI already share, never
# into the hooks file or the hook command line. Re-running always reconciles:
# our entry is replaced, everything else in the file is preserved byte-for-byte
# as JSON, and a malformed file is refused rather than overwritten.

set -euo pipefail

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_FILE="${COPILOT_HOOKS_FILE:-$HOME/.copilot/hooks/second-brain.json}"
CONFIG_DIR="$HOME/.config/second-brain"
CONFIG_FILE="$CONFIG_DIR/config.json"

MODE="install"
case "${1:-}" in
  --check) MODE="check"; shift ;;
  --uninstall) MODE="uninstall"; shift ;;
  -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required to run the hook script." >&2
  exit 1
fi

if [[ "$MODE" == "check" ]]; then
  CORE_PATH="$HOOKS_DIR/../agent-hooks-core/core.js" HOOKS_FILE="$HOOKS_FILE" HOOKS_DIR="$HOOKS_DIR" node - <<'NODEEOF'
const path = require('path');
const fs = require('fs');
const { loadCredentials, fetchWithTimeout, CONFIG_PATH } = require(process.env.CORE_PATH);

(async () => {
  const creds = loadCredentials();
  if (!creds) {
    console.error(`No credentials: set SECOND_BRAIN_URL/SECOND_BRAIN_TOKEN or write ${CONFIG_PATH}`);
    process.exit(1);
  }
  let res;
  try {
    res = await fetchWithTimeout(`${creds.baseUrl}/health`, { headers: { Authorization: `Bearer ${creds.token}` } }, 10000);
  } catch (e) {
    console.error(`GET /health failed: ${e?.message ?? e}`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`GET /health -> HTTP ${res.status}. Token or URL is wrong.`);
    process.exit(1);
  }
  const health = await res.json();
  console.log(`Worker ${health.version} at ${creds.baseUrl} - recall: on`);

  const file = process.env.HOOKS_FILE;
  let installed = false;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    installed = Array.isArray(parsed?.SessionStart) && parsed.SessionStart.some((e) =>
      Array.isArray(e?.hooks) && e.hooks.some((h) => typeof h?.command === 'string' && h.command.replace(/\\/g, '/').includes('/vscode-copilot-hooks/session-start.js')));
  } catch { /* no hooks file yet, or unreadable */ }
  console.log(installed ? `SessionStart hook found in ${file}` : `SessionStart hook NOT found in ${file} - run install.sh to install it`);
  process.exit(installed ? 0 : 1);
})();
NODEEOF
  exit $?
fi

if [[ "$MODE" == "install" ]]; then
  WORKER_URL="${1:-}"
  TOKEN="${2:-}"
  if [[ -z "$WORKER_URL" && -z "$TOKEN" && -f "$CONFIG_FILE" ]]; then
    echo "Using credentials from $CONFIG_FILE"
  else
    if [[ -z "$WORKER_URL" || -z "$TOKEN" ]]; then
      if [[ ! -t 0 ]]; then
        echo "Usage: bash install.sh <worker-url> <auth-token>   (no TTY to prompt on)" >&2
        exit 2
      fi
      [[ -z "$WORKER_URL" ]] && read -rp "Enter your Second Brain worker URL (e.g. https://your-worker.workers.dev): " WORKER_URL
      [[ -z "$TOKEN" ]] && { read -rsp "Enter your AUTH_TOKEN: " TOKEN; echo; }
    fi
    while [[ "$WORKER_URL" == */ ]]; do WORKER_URL="${WORKER_URL%/}"; done
    if [[ ! "$WORKER_URL" =~ ^https?:// ]]; then
      echo "Error: worker URL must start with http:// or https://" >&2
      exit 1
    fi
    mkdir -p "$CONFIG_DIR"
    WORKER_URL="$WORKER_URL" TOKEN="$TOKEN" CONFIG_FILE="$CONFIG_FILE" node - <<'NODEEOF'
const fs = require('fs');
const { WORKER_URL, TOKEN, CONFIG_FILE } = process.env;
let existing = {};
try { existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch {}
const next = { ...existing, workerUrl: WORKER_URL, authToken: TOKEN };
const tmp = `${CONFIG_FILE}.tmp-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
fs.renameSync(tmp, CONFIG_FILE);
NODEEOF
    chmod 600 "$CONFIG_FILE"
    echo "Wrote $CONFIG_FILE (mode 600)"
  fi
fi

mkdir -p "$(dirname "$HOOKS_FILE")"

HOOKS_FILE="$HOOKS_FILE" HOOKS_DIR="$HOOKS_DIR" MODE="$MODE" node - <<'NODEEOF'
const fs = require('fs');
const { HOOKS_FILE, HOOKS_DIR, MODE } = process.env;

let config = {};
if (fs.existsSync(HOOKS_FILE)) {
  const raw = fs.readFileSync(HOOKS_FILE, 'utf8');
  if (raw.trim()) {
    try { config = JSON.parse(raw); } catch (e) {
      console.error(`Refusing to touch ${HOOKS_FILE}: it is not valid JSON (${e.message}).`);
      console.error('The Copilot hooks file must be plain JSON - no comments or trailing commas. Fix the file and re-run.');
      process.exit(1);
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      console.error(`Refusing to touch ${HOOKS_FILE}: expected a JSON object at the top level.`);
      process.exit(1);
    }
  }
}

// Ours = any entry whose command runs session-start.js from this folder,
// regardless of the checkout path. Windows paths normalised.
const isOurs = (entry) => Array.isArray(entry?.hooks) && entry.hooks.some((h) =>
  typeof h?.command === 'string' && h.command.replace(/\\/g, '/').includes('/vscode-copilot-hooks/session-start.js'));

config.SessionStart = (Array.isArray(config.SessionStart) ? config.SessionStart : []).filter((e) => !isOurs(e));

if (MODE !== 'uninstall') {
  const q = (p) => `"${p.replace(/"/g, '\\"')}"`;
  config.SessionStart.push({
    hooks: [{ type: 'command', command: `node ${q(`${HOOKS_DIR}/session-start.js`)}` }],
  });
}
if (!config.SessionStart.length) delete config.SessionStart;

if (fs.existsSync(HOOKS_FILE)) fs.copyFileSync(HOOKS_FILE, `${HOOKS_FILE}.bak-${Date.now()}`);
const tmp = `${HOOKS_FILE}.tmp-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
fs.renameSync(tmp, HOOKS_FILE);
console.log(`${MODE === 'uninstall' ? 'Removed Second Brain hook from' : 'Updated'} ${HOOKS_FILE}`);
NODEEOF

if [[ "$MODE" == "uninstall" ]]; then
  echo "Done. Credentials in $CONFIG_FILE were left in place."
  exit 0
fi

echo
echo "Done. Second Brain SessionStart hook installed for VS Code Copilot (Local harness)."
echo "  SessionStart: recalls context for the current project when a chat session opens"
echo
echo "Sessions already open keep the old hook config - restart VS Code (or reload the window)."
echo "Verify with: bash $HOOKS_DIR/install.sh --check"
