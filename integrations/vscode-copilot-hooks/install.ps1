<#
.SYNOPSIS
  Installs, upgrades, checks or removes the Second Brain SessionStart hook in
  VS Code GitHub Copilot's Local harness user-level hooks file
  (%USERPROFILE%\.copilot\hooks\second-brain.json).

.DESCRIPTION
  The PowerShell mirror of install.sh, for Windows machines. Local harness
  ONLY (not Copilot CLI / cloud agent / Agent Host - see README.md). Same
  guarantees: credentials go to ~/.config/second-brain/config.json (the file
  every other Second Brain hook adapter and the CLI already share), never into
  the hooks file and never onto the hook command line; re-running reconciles
  our own entry instead of appending; a hooks file that is not valid JSON is
  refused, not overwritten.

  Node.js does the JSON editing so this script and install.sh cannot drift.

.PARAMETER WorkerUrl
  Worker origin, e.g. https://your-worker.workers.dev. Prompted for when absent.

.PARAMETER Token
  AUTH_TOKEN for that worker. Prompted for when absent.

.PARAMETER Check
  Prove the hook reaches the Worker and is present in the hooks file.

.PARAMETER Uninstall
  Remove only our entry from the hooks file. Credentials are left in place.

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
$HooksFile = if ($env:COPILOT_HOOKS_FILE) { $env:COPILOT_HOOKS_FILE } else { Join-Path $HomeDir ".copilot/hooks/second-brain.json" }
$ConfigDir = Join-Path $HomeDir ".config/second-brain"
$ConfigFile = Join-Path $ConfigDir "config.json"
$Mode = if ($Uninstall) { "uninstall" } else { "install" }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Stop-WithError "Error: Node.js is required to run the hook script."
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

if ($Check) {
  $env:CORE_PATH = (Join-Path $HooksDir "../agent-hooks-core/core.js")
  $env:HOOKS_FILE = $HooksFile
  $CheckScript = @'
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
  console.log(installed ? `SessionStart hook found in ${file}` : `SessionStart hook NOT found in ${file} -- run install.ps1 to install it`);
  process.exit(installed ? 0 : 1);
})();
'@
  $code = Invoke-NodeScript $CheckScript
  exit $code
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
      console.error('The Copilot hooks file must be plain JSON -- no comments or trailing commas. Fix the file and re-run.');
      process.exit(1);
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      console.error(`Refusing to touch ${HOOKS_FILE}: expected a JSON object at the top level.`);
      process.exit(1);
    }
  }
}

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
Write-Host "Done. Second Brain SessionStart hook installed for VS Code Copilot (Local harness)."
Write-Host "  SessionStart: recalls context for the current project when a chat session opens"
Write-Host ""
Write-Host "Sessions already open keep the old hook config -- restart VS Code (or reload the window)."
Write-Host "Verify with: powershell -File `"$HooksDir\install.ps1`" -Check"
