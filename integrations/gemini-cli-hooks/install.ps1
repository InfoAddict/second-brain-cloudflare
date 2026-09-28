<#
.SYNOPSIS
  Installs, upgrades, checks or removes the Second Brain SessionStart hook in
  Gemini CLI's user settings (%USERPROFILE%\.gemini\settings.json).

.DESCRIPTION
  The PowerShell mirror of install.sh, for Windows machines. Same guarantees:
  credentials go to ~/.config/second-brain/config.json (the file the CLI, the
  desktop app and every other adapter already share), never into settings.json
  and never onto the hook command line; re-running reconciles our own entry
  instead of appending; a settings.json that is not valid JSON is refused, not
  overwritten.

  Node.js does the JSON editing so this script and install.sh cannot drift:
  PowerShell's ConvertTo-Json would flatten deeply nested settings.

  This is SessionStart only (recall injection, no capture) - see README.md.
  Windows behaviour for Gemini CLI hooks specifically is UNVERIFIED (unlike
  Codex/Cursor/Copilot, where it is documented); this script is shipped for
  parity with the other adapters' installers, not because it has been proven
  against a real Gemini CLI session on Windows.

.PARAMETER WorkerUrl
  Worker origin, e.g. https://your-worker.workers.dev. Prompted for when absent.

.PARAMETER Token
  AUTH_TOKEN for that worker. Prompted for when absent.

.PARAMETER Check
  Prove the hook reaches the Worker and show what it would print.

.PARAMETER Uninstall
  Remove only our entry from settings.json. Credentials are left in place.

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

# Write-Error under -ErrorActionPreference Stop always ends the script with exit
# code 1; the installer needs its own codes (2 = no credentials and no console).
function Stop-WithError {
  param([string]$Message, [int]$Code = 1)
  [Console]::Error.WriteLine($Message)
  exit $Code
}

$HooksDir = $PSScriptRoot
$HomeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$SettingsFile = if ($env:GEMINI_SETTINGS_FILE) { $env:GEMINI_SETTINGS_FILE } else { Join-Path $HomeDir ".gemini/settings.json" }
$ConfigDir = Join-Path $HomeDir ".config/second-brain"
$ConfigFile = Join-Path $ConfigDir "config.json"
$Mode = if ($Uninstall) { "uninstall" } else { "install" }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Stop-WithError "Error: Node.js is required to run the hook script."
}

if ($Check) {
  # check.js reports its own failures and exits non-zero; that is a result, not
  # a terminating error, so PowerShell 7.4 must not throw on it.
  $PSNativeCommandUseErrorActionPreference = $false
  $ErrorActionPreference = "Continue"
  & node (Join-Path $HooksDir "check.js")
  exit $LASTEXITCODE
}

# Node reads the script from a temp file rather than stdin so a console encoding
# cannot corrupt it. Node's own output goes straight to the host, so the only
# value this function returns is node's exit code.
function Invoke-NodeScript {
  param([string]$Script)
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("sb-hooks-" + [Guid]::NewGuid().ToString("N") + ".js")
  try {
    Set-Content -Path $tmp -Value $Script -Encoding utf8
    # A non-zero exit from node is a result to inspect, not a terminating error;
    # PowerShell 7.4 would otherwise throw before the exit code can be read.
    # Both assignments are function-local.
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
// mode 0600 is a no-op on NTFS; the file still stays out of settings.json.
fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
fs.renameSync(tmp, CONFIG_FILE);
'@

$SettingsWriter = @'
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
      // Matches the hook's own internal cap exactly (CAP_MS in session-start.js).
      // Never declare more time to the host than the hook is actually allowed
      // to take.
      timeout: 3000,
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
'@

if ($Mode -eq "install") {
  if ([string]::IsNullOrWhiteSpace($WorkerUrl) -and [string]::IsNullOrWhiteSpace($Token) -and (Test-Path $ConfigFile)) {
    Write-Host "Using credentials from $ConfigFile"
  } else {
    if ([string]::IsNullOrWhiteSpace($WorkerUrl) -or [string]::IsNullOrWhiteSpace($Token)) {
      # The analogue of bash's `[[ ! -t 0 ]]`: never hang a scripted install on a prompt.
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

New-Item -ItemType Directory -Path (Split-Path -Parent $SettingsFile) -Force | Out-Null

$env:SETTINGS_FILE = $SettingsFile
# Forward slashes so the written command reads the same as install.sh's; node
# and Gemini CLI both accept them on Windows.
$env:HOOKS_DIR = $HooksDir.Replace("\", "/")
$env:MODE = $Mode
$code = Invoke-NodeScript $SettingsWriter
if ($code -ne 0) { exit $code }

if ($Mode -eq "uninstall") {
  Write-Host "Done. Credentials in $ConfigFile were left in place."
  exit 0
}

Write-Host ""
Write-Host "Done. Second Brain SessionStart hook installed for Gemini CLI."
Write-Host "  SessionStart (startup, clear; resume is skipped): recalls context for the current project"
Write-Host ""
Write-Host "This writes the USER-level settings file. If you also install a hook at"
Write-Host "the PROJECT level (.gemini/settings.json, see README.md), Gemini CLI"
Write-Host "fingerprints that command and prompts to re-trust it whenever it changes -"
Write-Host "expect that prompt the first time a teammate runs an upgraded install."
Write-Host "Verify with: powershell -File `"$HooksDir\install.ps1`" -Check"
