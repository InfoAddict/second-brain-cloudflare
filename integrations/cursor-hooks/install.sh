#!/usr/bin/env bash
# Installs, upgrades, checks or removes the Second Brain hooks in Cursor's
# user-level hooks file (~/.cursor/hooks.json).
#
#   bash install.sh https://your-worker.workers.dev your-token   install or upgrade
#   bash install.sh                                              reuse ~/.config/second-brain/config.json, or prompt
#   bash install.sh --check                                      prove the hooks reach the Worker
#   bash install.sh --uninstall                                  remove only our entries
#
# Credentials go to ~/.config/second-brain/config.json (the file the CLI and
# every other Second Brain hook adapter already share), never into hooks.json
# or the hook command line. Re-running always reconciles: our entries are
# replaced, everything else in the file is preserved byte-for-byte as JSON,
# and a malformed file is refused rather than overwritten.
#
# Registers sessionStart, beforeSubmitPrompt, sessionEnd and stop. sessionEnd
# and stop both run session-end.js: the hooks survey found `transcript_path`
# unconfirmed on either event specifically, and session-end.js already no-ops
# safely when a payload has none, so registering both costs nothing and
# maximises the chance capture actually fires. See README.md.
#
# Cursor also reads a PROJECT-level hooks.json at .cursor/hooks.json inside a
# repository; this installer only ever writes the user-level file above. See
# README.md for the project-level snippet if you would rather scope this to
# one project.

set -euo pipefail

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_FILE="${CURSOR_HOOKS_FILE:-$HOME/.cursor/hooks.json}"
CONFIG_DIR="$HOME/.config/second-brain"
CONFIG_FILE="$CONFIG_DIR/config.json"

MODE="install"
case "${1:-}" in
  --check) MODE="check"; shift ;;
  --uninstall) MODE="uninstall"; shift ;;
  -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required to run the hook scripts." >&2
  exit 1
fi

if [[ "$MODE" == "check" ]]; then
  exec node "$HOOKS_DIR/check.js"
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
      console.error('Cursor hooks.json must be plain JSON: no comments or trailing commas. Fix the file and re-run.');
      process.exit(1);
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      console.error(`Refusing to touch ${HOOKS_FILE}: expected a JSON object at the top level.`);
      process.exit(1);
    }
  }
}

// Ours = any entry whose command runs a script from this folder, regardless of
// the checkout path. Windows paths normalised.
const isOurs = (entry) => typeof entry?.command === 'string' && entry.command.replace(/\\/g, '/').includes('/cursor-hooks/');

const EVENTS = ['sessionStart', 'beforeSubmitPrompt', 'sessionEnd', 'stop'];
config.hooks = config.hooks && typeof config.hooks === 'object' ? config.hooks : {};
for (const ev of EVENTS) {
  config.hooks[ev] = (Array.isArray(config.hooks[ev]) ? config.hooks[ev] : []).filter((e) => !isOurs(e));
}

if (MODE !== 'uninstall') {
  const q = (p) => `"${p.replace(/"/g, '\\"')}"`;
  config.version = config.version || 1;
  config.hooks.sessionStart.push({ command: `node ${q(`${HOOKS_DIR}/session-start.js`)}` });
  config.hooks.beforeSubmitPrompt.push({ command: `node ${q(`${HOOKS_DIR}/before-submit-prompt.js`)}` });
  config.hooks.sessionEnd.push({ command: `node ${q(`${HOOKS_DIR}/session-end.js`)}` });
  config.hooks.stop.push({ command: `node ${q(`${HOOKS_DIR}/session-end.js`)}` });
}
for (const ev of EVENTS) if (!config.hooks[ev].length) delete config.hooks[ev];
if (!Object.keys(config.hooks).length) delete config.hooks;

if (fs.existsSync(HOOKS_FILE)) fs.copyFileSync(HOOKS_FILE, `${HOOKS_FILE}.bak-${Date.now()}`);
const tmp = `${HOOKS_FILE}.tmp-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
fs.renameSync(tmp, HOOKS_FILE);
console.log(`${MODE === 'uninstall' ? 'Removed Second Brain hooks from' : 'Updated'} ${HOOKS_FILE}`);
NODEEOF

if [[ "$MODE" == "uninstall" ]]; then
  echo "Done. Credentials in $CONFIG_FILE were left in place."
  exit 0
fi

echo
echo "Done. Second Brain hooks installed for Cursor."
echo "  sessionStart:        recalls context for the current project (fire-and-forget)"
echo "  beforeSubmitPrompt:  the same recall, run once per session as a synchronous safety net"
echo "  sessionEnd / stop:    saves the conversation when a transcript is available (needs Worker 3.0+)"
echo
echo "Restart Cursor, or reload the window, so it re-reads hooks.json."
echo "Verify with: bash $HOOKS_DIR/install.sh --check"
