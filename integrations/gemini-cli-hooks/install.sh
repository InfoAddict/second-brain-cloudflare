#!/usr/bin/env bash
# Installs, upgrades, checks or removes the Second Brain SessionStart hook in
# Gemini CLI's user settings (~/.gemini/settings.json).
#
#   bash install.sh https://your-worker.workers.dev your-token   install or upgrade
#   bash install.sh                                              reuse ~/.config/second-brain/config.json, or prompt
#   bash install.sh --check                                      prove the hook reaches the Worker
#   bash install.sh --uninstall                                  remove only our entry
#
# Credentials go to ~/.config/second-brain/config.json (the same file the CLI,
# the desktop app and every other adapter already use), never into
# settings.json or the hook command line. Re-running always reconciles: our
# entry is replaced, everything else in the file is preserved byte-for-byte as
# JSON, and a malformed file is refused.
#
# This is SessionStart only - recall injection, no capture. Gemini CLI's own
# docs describe SessionEnd as advisory with no full transcript, so this
# adapter does not attempt one.
#
# This writes the USER-level settings file only. For a project-level install
# instead, see README.md for the .gemini/settings.json snippet to paste by
# hand - Gemini CLI fingerprints project hook commands and warns if they
# change, so a silent project-level write would trip that trust prompt on
# every teammate's next run.

set -euo pipefail

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETTINGS_FILE="${GEMINI_SETTINGS_FILE:-$HOME/.gemini/settings.json}"
CONFIG_DIR="$HOME/.config/second-brain"
CONFIG_FILE="$CONFIG_DIR/config.json"

MODE="install"
case "${1:-}" in
  --check) MODE="check"; shift ;;
  --uninstall) MODE="uninstall"; shift ;;
  -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required to run the hook script." >&2
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

mkdir -p "$(dirname "$SETTINGS_FILE")"

SETTINGS_FILE="$SETTINGS_FILE" HOOKS_DIR="$HOOKS_DIR" MODE="$MODE" node - <<'NODEEOF'
const fs = require('fs');
const { SETTINGS_FILE, HOOKS_DIR, MODE } = process.env;

let settings = {};
if (fs.existsSync(SETTINGS_FILE)) {
  const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
  if (raw.trim()) {
    try { settings = JSON.parse(raw); } catch (e) {
      console.error(`Refusing to touch ${SETTINGS_FILE}: it is not valid JSON (${e.message}).`);
      console.error('Gemini CLI settings must be plain JSON - no comments or trailing commas. Fix the file and re-run.');
      process.exit(1);
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      console.error(`Refusing to touch ${SETTINGS_FILE}: expected a JSON object at the top level.`);
      process.exit(1);
    }
  }
}

// Ours = any entry whose command runs session-start.js from this folder,
// regardless of the checkout path. Windows paths normalised.
const isOurs = (entry) => Array.isArray(entry?.hooks) && entry.hooks.some((h) =>
  typeof h?.command === 'string' && h.command.replace(/\\/g, '/').includes('/gemini-cli-hooks/session-start.js'));

settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
settings.hooks.SessionStart = (Array.isArray(settings.hooks.SessionStart) ? settings.hooks.SessionStart : []).filter((e) => !isOurs(e));

if (MODE !== 'uninstall') {
  const q = (p) => `"${p.replace(/"/g, '\\"')}"`;
  settings.hooks.SessionStart.push({
    hooks: [{
      type: 'command',
      command: `node ${q(`${HOOKS_DIR}/session-start.js`)}`,
      // Belt and suspenders: the hook's own performRecall call is capped at
      // 3000ms internally, so this is a generous margin, not the real limit -
      // the vendor docs do not specify a default timeout for this event.
      timeout: 4000,
    }],
  });
}
if (!settings.hooks.SessionStart.length) delete settings.hooks.SessionStart;
if (!Object.keys(settings.hooks).length) delete settings.hooks;

if (fs.existsSync(SETTINGS_FILE)) fs.copyFileSync(SETTINGS_FILE, `${SETTINGS_FILE}.bak-${Date.now()}`);
const tmp = `${SETTINGS_FILE}.tmp-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
fs.renameSync(tmp, SETTINGS_FILE);
console.log(`${MODE === 'uninstall' ? 'Removed the Second Brain hook from' : 'Updated'} ${SETTINGS_FILE}`);
NODEEOF

if [[ "$MODE" == "uninstall" ]]; then
  echo "Done. Credentials in $CONFIG_FILE were left in place."
  exit 0
fi

echo
echo "Done. Second Brain SessionStart hook installed for Gemini CLI."
echo "  SessionStart (startup, clear; resume is skipped): recalls context for the current project"
echo
echo "This writes the USER-level settings file. If you also install a hook at"
echo "the PROJECT level (.gemini/settings.json, see README.md), Gemini CLI"
echo "fingerprints that command and prompts to re-trust it whenever it changes -"
echo "expect that prompt the first time a teammate runs an upgraded install."
echo "Verify with: bash $HOOKS_DIR/install.sh --check"
