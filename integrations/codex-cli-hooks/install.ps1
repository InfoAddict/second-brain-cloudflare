<#
.SYNOPSIS
  Installs, upgrades, checks or removes the Second Brain hooks in Codex CLI's
  user hooks file (%USERPROFILE%\.codex\hooks.json).

.DESCRIPTION
  The PowerShell mirror of install.sh, for Windows machines without Git Bash.
  Same guarantees: credentials go to ~/.config/second-brain/config.json (the
  file the CLI, the desktop app and every other adapter already use), never
  into hooks.json and never onto the hook command line; re-running reconciles
  our own entries instead of appending; a hooks.json that is not valid JSON is
  refused, not overwritten.

  Node.js does the JSON editing so this script and install.sh cannot drift.

  The exact hooks.json schema this writes (field names, whether a "matcher"
  concept exists, the timeout field's unit) is UNVERIFIED against a real Codex
  CLI install - see README.md's "Unverified" section.

.PARAMETER WorkerUrl
  Worker origin, e.g. https://your-worker.workers.dev. Prompted for when absent.

.PARAMETER Token
  AUTH_TOKEN for that worker. Prompted for when absent.

.PARAMETER Check
  Prove the hooks reach the Worker and show what they would do.

.PARAMETER Uninstall
  Remove only our entries from hooks.json. Credentials are left in place.

.EXAMPLE
  .\install.ps1 -WorkerUrl https://your-worker.workers.dev -Token your-token

.EXAMPLE
  .\install.ps1 -Check

.EXAMPLE
  .\install.ps1 -Uninstall
#>

param(
  [string]$WorkerUrl,
  [string]$Token,
  [switch]$Check,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

function Stop-WithError {
  param([string]$Message, [int]$Code = 1)
  [Console]::Error.WriteLine($Message)
  exit $Code
}

$HooksDir = $PSScriptRoot
$HomeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$HooksFile = if ($env:CODEX_HOOKS_FILE) { $env:CODEX_HOOKS_FILE } else { Join-Path $HomeDir ".codex/hooks.json" }
$ConfigDir = Join-Path $HomeDir ".config/second-brain"
$ConfigFile = Join-Path $ConfigDir "config.json"
$Mode = if ($Uninstall) { "uninstall" } else { "install" }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Stop-WithError "Error: Node.js is required to run the hook scripts."
}

if ($Check) {
  $PSNativeCommandUseErrorActionPreference = $false
  $ErrorActionPreference = "Continue"
  & node (Join-Path $HooksDir "check.js")
  exit $LASTEXITCODE
}

function Invoke-NodeScript {
  param([string]$Script)
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("sb-hooks-" + [Guid]::NewGuid().ToString("N") + ".js")
  try {
    Set-Content -Path $tmp -Value $Script -Encoding utf8
    $PSNativeCommandUseErrorActionPreference = $false
    $ErrorActionPreference = "Continue"
    & node $tmp 2>&1 | Out-Host
    return $LASTEXITCODE
  } finally {
    Remove-Item -Force -ErrorAction SilentlyContinue $tmp
  }
}

$ConfigWriter = @'
const fs = require('fs');
const { WORKER_URL, TOKEN, CONFIG_FILE } = process.env;
let existing = {};
try { existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch {}
const next = { ...existing, workerUrl: WORKER_URL, authToken: TOKEN };
const tmp = `${CONFIG_FILE}.tmp-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
fs.renameSync(tmp, CONFIG_FILE);
'@

$HooksWriter = @'
const fs = require('fs');
const { HOOKS_FILE, HOOKS_DIR, MODE } = process.env;

let config = {};
if (fs.existsSync(HOOKS_FILE)) {
  const raw = fs.readFileSync(HOOKS_FILE, 'utf8');
  if (raw.trim()) {
    try { config = JSON.parse(raw); } catch (e) {
      console.error(`Refusing to touch ${HOOKS_FILE}: it is not valid JSON (${e.message}).`);
      console.error('Codex CLI hooks.json must be plain JSON - no comments or trailing commas. Fix the file and re-run.');
      process.exit(1);
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      console.error(`Refusing to touch ${HOOKS_FILE}: expected a JSON object at the top level.`);
      process.exit(1);
    }
  }
}

const isOurs = (entry) => Array.isArray(entry?.hooks) && entry.hooks.some((h) =>
  typeof h?.command === 'string' && h.command.replace(/\\/g, '/').includes('/codex-cli-hooks/'));

config.hooks = config.hooks && typeof config.hooks === 'object' ? config.hooks : {};
for (const ev of ['SessionStart', 'SessionEnd']) {
  config.hooks[ev] = (Array.isArray(config.hooks[ev]) ? config.hooks[ev] : []).filter((e) => !isOurs(e));
}

if (MODE !== 'uninstall') {
  const q = (p) => `"${p.replace(/"/g, '\\"')}"`;
  config.hooks.SessionStart.push({
    hooks: [{ type: 'command', command: `node ${q(`${HOOKS_DIR}/session-start.js`)}` }],
  });
  config.hooks.SessionEnd.push({
    // Codex's hooks.json documents this field in SECONDS, not milliseconds.
    hooks: [{ type: 'command', command: `node ${q(`${HOOKS_DIR}/session-end.js`)}`, timeout: 3 }],
  });
}
for (const ev of ['SessionStart', 'SessionEnd']) if (!config.hooks[ev].length) delete config.hooks[ev];
if (!Object.keys(config.hooks).length) delete config.hooks;

if (fs.existsSync(HOOKS_FILE)) fs.copyFileSync(HOOKS_FILE, `${HOOKS_FILE}.bak-${Date.now()}`);
const tmp = `${HOOKS_FILE}.tmp-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
fs.renameSync(tmp, HOOKS_FILE);
console.log(`${MODE === 'uninstall' ? 'Removed Second Brain hooks from' : 'Updated'} ${HOOKS_FILE}`);
'@

if ($Mode -eq "install") {
  if ([string]::IsNullOrWhiteSpace($WorkerUrl) -and [string]::IsNullOrWhiteSpace($Token) -and (Test-Path $ConfigFile)) {
    Write-Host "Using credentials from $ConfigFile"
  } else {
    if ([string]::IsNullOrWhiteSpace($WorkerUrl) -or [string]::IsNullOrWhiteSpace($Token)) {
      if ([Console]::IsInputRedirected -or -not [Environment]::UserInteractive) {
        Stop-WithError "Usage: .\install.ps1 -WorkerUrl <worker-url> -Token <auth-token>   (no console to prompt on)" 2
      }
      if ([string]::IsNullOrWhiteSpace($WorkerUrl)) {
        $WorkerUrl = Read-Host "Enter your Second Brain worker URL (e.g. https://your-worker.workers.dev)"
      }
      if ([string]::IsNullOrWhiteSpace($Token)) {
        $secure = Read-Host "Enter your AUTH_TOKEN" -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $Token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
      }
    }
    $WorkerUrl = $WorkerUrl.Trim().TrimEnd("/")
    if ($WorkerUrl -notmatch "^https?://") {
      Stop-WithError "Error: worker URL must start with http:// or https:// (got: $WorkerUrl)"
    }
    New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
    $env:WORKER_URL = $WorkerUrl
    $env:TOKEN = $Token
    $env:CONFIG_FILE = $ConfigFile
    $code = Invoke-NodeScript $ConfigWriter
    $env:TOKEN = $null
    if ($code -ne 0) { Stop-WithError "Error: could not write $ConfigFile" $code }
    Write-Host "Wrote $ConfigFile"
  }
}

New-Item -ItemType Directory -Path (Split-Path -Parent $HooksFile) -Force | Out-Null

$env:HOOKS_FILE = $HooksFile
$env:HOOKS_DIR = $HooksDir.Replace("\", "/")
$env:MODE = $Mode
$code = Invoke-NodeScript $HooksWriter
if ($code -ne 0) { exit $code }

if ($Mode -eq "uninstall") {
  Write-Host "Done. Credentials in $ConfigFile were left in place."
  exit 0
}

Write-Host ""
Write-Host "Done. Second Brain hooks installed for Codex CLI."
Write-Host "  SessionStart (startup, resume, clear, compact): recalls context for the current project"
Write-Host "  SessionEnd (close, archive, delete, idle):       saves the conversation (needs Worker 3.0+)"
Write-Host ""
Write-Host "Sessions already open keep the old hook config - restart them."
Write-Host "Verify with: powershell -File `"$HooksDir\install.ps1`" -Check"
