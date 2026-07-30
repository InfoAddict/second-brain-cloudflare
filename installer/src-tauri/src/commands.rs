//! Tauri commands — the only bridge between the webview UI and the Rust core.
//! Tokens and passwords flow IN through here (user input / OS keychain) but
//! never back out to the webview; the UI only ever receives URLs, booleans,
//! account names, and progress events.
use crate::cf::api::CfClient;
use crate::cf::backend::{DryRunBackend, LiveBackend};
use crate::cf::discover;
use crate::cf::oauth::{self, Tokens};
use crate::cf::provision::{self, ProvisionError, ProvisionOutcome};
use crate::cf::types::{Account, CfApiError};
use crate::app_menus::AppMenus;
use crate::i18n::{self, AppLocale, Key, Locale};
use crate::worker_url::subdomain_of;
use crate::{cli_config, mcp_config, password_check, secure_store, windows, worker_bundle};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// In-memory state for the setup flow. Dropped when the process exits;
/// nothing here is persisted except through `secure_store` on success.
pub struct SetupSession {
    pub dry_run: bool,
    password: Mutex<Option<String>>,
    tokens: Mutex<Option<Tokens>>,
    accounts: Mutex<Vec<Account>>,
    outcome: Mutex<Option<ProvisionOutcome>>,
    /// Set when the main window should boot straight into the Worker-update
    /// flow instead of the normal setup flow.
    pending_worker_update: Mutex<bool>,
    /// Account id + workers.dev subdomain from the most recent scan, held until
    /// a brain is actually connected. Non-secret, but pointless — and possibly
    /// wrong — to persist for a scan the user abandoned.
    cf_hints: Mutex<Option<(String, String)>>,
    /// Demo mode's stand-in for the outstanding-index note. Dry-run must never
    /// reach the keychain — every read there can raise an OS password prompt,
    /// which is #252 all over again — so the demo keeps its note in memory and
    /// the flow stays exercisable end to end.
    demo_previous_index: Mutex<Option<String>>,
}

impl SetupSession {
    pub fn new(dry_run: bool) -> Self {
        Self {
            dry_run,
            password: Mutex::new(None),
            tokens: Mutex::new(None),
            accounts: Mutex::new(Vec::new()),
            outcome: Mutex::new(None),
            pending_worker_update: Mutex::new(false),
            cf_hints: Mutex::new(None),
            demo_previous_index: Mutex::new(None),
        }
    }

    fn reset(&self) {
        *self.password.lock().unwrap() = None;
        *self.tokens.lock().unwrap() = None;
        self.accounts.lock().unwrap().clear();
        *self.outcome.lock().unwrap() = None;
        *self.pending_worker_update.lock().unwrap() = false;
        *self.cf_hints.lock().unwrap() = None;
        *self.demo_previous_index.lock().unwrap() = None;
    }
}

const MIN_PASSWORD_LEN: usize = 12;

fn locale_of(app: &AppHandle) -> Locale {
    app.try_state::<AppLocale>()
        .map(|l| l.get())
        .unwrap_or(Locale::En)
}

fn user_err(locale: Locale, key: Key) -> String {
    i18n::t(locale, key).to_string()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub mode: &'static str,
    pub dry_run: bool,
}

#[tauri::command]
pub fn get_app_state(session: State<'_, SetupSession>) -> AppState {
    // Dry-run is checked before the keychain read so demo mode never touches
    // secure storage (each read can raise a macOS permission prompt for
    // unsigned dev builds, which would block the setup UI's first paint).
    let mode = if *session.pending_worker_update.lock().unwrap() {
        "worker-update"
    } else if !session.dry_run && secure_store::load_setup().is_some() {
        "wrapper"
    } else {
        "setup"
    };
    AppState {
        mode,
        dry_run: session.dry_run,
    }
}

/// Strength + breach check for the password screen. Runs entirely in Rust so
/// the password only crosses the IPC boundary the same way submit does; the
/// breach lookup sends a 5-character hash prefix and nothing else.
#[tauri::command]
pub async fn check_password(password: String) -> Result<password_check::PasswordCheck, String> {
    Ok(password_check::check(password.trim()).await)
}

/// A fresh strong password for the "generate one for me" button.
#[tauri::command]
pub fn generate_password() -> String {
    password_check::generate()
}

#[tauri::command]
pub fn submit_password(
    password: String,
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<(), String> {
    let locale = locale_of(&app);
    let trimmed = password.trim();
    if trimmed.len() < MIN_PASSWORD_LEN {
        return Err(i18n::t_fmt(
            locale,
            Key::ErrorPasswordTooShort,
            &[("min", &MIN_PASSWORD_LEN.to_string())],
        ));
    }
    *session.password.lock().unwrap() = Some(trimmed.to_string());
    Ok(())
}

#[tauri::command]
pub async fn connect_cloudflare(
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<Vec<Account>, String> {
    if session.dry_run {
        let accounts = vec![Account {
            id: "dry-run-account".into(),
            name: "Demo Space".into(),
        }];
        *session.accounts.lock().unwrap() = accounts.clone();
        return Ok(accounts);
    }

    let opener_app = app.clone();
    let tokens = oauth::run_login_flow(move |url| {
        let _ = opener_app.opener().open_url(url, None::<&str>);
    })
    .await
    .map_err(|e| {
        log::warn!("oauth flow failed: {e}");
        e.to_string()
    })?;

    let locale = locale_of(&app);
    let accounts = CfClient::list_accounts(&tokens.access_token)
        .await
        .map_err(|e| {
            log::warn!("account listing failed: {e}");
            user_err(locale, Key::ErrorCfAccountListFailed)
        })?;
    if accounts.is_empty() {
        return Err(user_err(locale, Key::ErrorCfNoAccount));
    }

    *session.tokens.lock().unwrap() = Some(tokens);
    *session.accounts.lock().unwrap() = accounts.clone();
    Ok(accounts)
}

/// Looks through a Cloudflare account for Workers that answer like a Second
/// Brain, so the user does not have to find and type their own address.
///
/// Requires a prior [`connect_cloudflare`]. Every probe is unauthenticated —
/// the user's password is not involved and is not asked for until they have
/// picked an address. An empty list is a normal outcome, not an error: it means
/// the account holds no recognisable brain, and the UI falls back to manual
/// entry.
#[tauri::command]
pub async fn discover_brains(
    account_id: String,
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<Vec<discover::Candidate>, String> {
    let locale = locale_of(&app);

    if session.dry_run {
        return Ok(vec![discover::Candidate {
            name: "second-brain".into(),
            url: "https://second-brain.demo.workers.dev".into(),
        }]);
    }

    // Guards against a UI that forgot to sign in, and against an account id the
    // session never saw — the same check start_provisioning makes.
    if !session
        .accounts
        .lock()
        .unwrap()
        .iter()
        .any(|a| a.id == account_id)
    {
        return Err(user_err(locale, Key::ErrorCfSignInFirst));
    }

    let mut tokens = session
        .tokens
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| user_err(locale, Key::ErrorCfSignInFirst))?;
    if tokens.expires_at <= std::time::Instant::now() {
        tokens = oauth::refresh(&tokens).await.map_err(|e| {
            log::warn!("proactive token refresh failed: {e}");
            user_err(locale, Key::ErrorCfSignInExpired)
        })?;
        *session.tokens.lock().unwrap() = Some(tokens.clone());
    }

    let client = CfClient::new(tokens.access_token.clone(), account_id.clone());

    let manifest = worker_bundle::manifest();
    let found = discover::discover_in_account(
        &client,
        &manifest.script_name,
        &manifest.vectorize_name,
    )
    .await
    .map_err(|e| match e {
        // No workers.dev subdomain means no address to construct, which is a
        // different problem from "found nothing" and gets its own message.
        discover::DiscoverFailure::NoSubdomain => user_err(locale, Key::ErrorCfNoSubdomain),
        discover::DiscoverFailure::Api(err) => {
            log::warn!("brain discovery failed: {err}");
            user_err(locale, Key::ErrorCfDiscoverFailed)
        }
    })?;

    // Held in memory, not written yet. Persisting at scan time would leave a
    // Cloudflare account id in the keychain for someone who signed in, saw
    // nothing, and quit — and would record *this* account even if the user went
    // on to connect a brain living in a different one. connect_existing writes
    // it once a brain is actually connected.
    *session.cf_hints.lock().unwrap() = Some((account_id, found.subdomain.clone()));

    Ok(found.brains)
}

#[tauri::command]
pub async fn start_provisioning(
    account_id: String,
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<ProvisionOutcome, String> {
    let locale = locale_of(&app);
    let password = session
        .password
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| user_err(locale, Key::ErrorChoosePasswordFirst))?;
    let manifest = worker_bundle::manifest();

    let progress_app = app.clone();
    let progress = move |event: provision::StepEvent| {
        let _ = progress_app.emit("setup-progress", &event);
    };

    let outcome = if session.dry_run {
        provision::provision(&DryRunBackend, manifest, "Demo Space", &password, progress)
            .await
            .map_err(|e| {
                log::warn!("dry-run provision failed: {e}");
                user_err(locale, Key::ErrorFriendlyRetry)
            })?
    } else {
        let account_name = session
            .accounts
            .lock()
            .unwrap()
            .iter()
            .find(|a| a.id == account_id)
            .map(|a| a.name.clone())
            .ok_or_else(|| user_err(locale, Key::ErrorCfSignInFirst))?;
        let mut tokens = session
            .tokens
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| user_err(locale, Key::ErrorCfSignInFirst))?;

        // Refresh proactively if the access token already aged out (the user
        // may have sat on the password/progress screens for a while).
        if tokens.expires_at <= std::time::Instant::now() {
            tokens = oauth::refresh(&tokens).await.map_err(|e| {
                log::warn!("proactive token refresh failed: {e}");
                user_err(locale, Key::ErrorCfSignInExpired)
            })?;
            *session.tokens.lock().unwrap() = Some(tokens.clone());
        }

        // One transparent refresh+retry on auth expiry: provisioning is
        // idempotent, so re-running the pipeline is safe.
        let mut attempt = 0;
        loop {
            attempt += 1;
            let backend = LiveBackend {
                client: CfClient::new(tokens.access_token.clone(), account_id.clone()),
            };
            let progress_app = app.clone();
            let progress = move |event: provision::StepEvent| {
                let _ = progress_app.emit("setup-progress", &event);
            };
            match provision::provision(&backend, manifest, &account_name, &password, progress)
                .await
            {
                Ok(outcome) => break outcome,
                Err(ProvisionError::Api(CfApiError::Unauthorized)) if attempt == 1 => {
                    tokens = oauth::refresh(&tokens).await.map_err(|e| {
                        log::warn!("token refresh failed: {e}");
                        user_err(locale, Key::ErrorCfSignInExpired)
                    })?;
                    *session.tokens.lock().unwrap() = Some(tokens.clone());
                }
                Err(e) => {
                    log::warn!("provisioning failed: {e}");
                    return Err(format!(
                        "{}\n\n{}",
                        user_err(locale, Key::ErrorFriendlyRetry),
                        i18n::t_fmt(locale, Key::ErrorProvisioningDetail, &[("detail", &e.to_string())])
                    ));
                }
            }
        }
    };

    if !session.dry_run {
        secure_store::save_setup(&outcome.worker_url, &password).map_err(|e| {
            log::error!("secure store save failed: {e}");
            user_err(locale, Key::ErrorSecureStoreSetup)
        })?;
    }
    *session.outcome.lock().unwrap() = Some(outcome.clone());
    Ok(outcome)
}

/// Turns whatever the user pasted into a canonical `https://host` origin:
/// tolerates a missing scheme, trailing slashes, and pasted sub-paths
/// (e.g. their /mcp connector link or a dashboard page).
fn normalize_worker_url(input: &str, locale: Locale) -> Result<String, String> {
    let bad = || user_err(locale, Key::ErrorBadUrl);
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(bad());
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let parsed = url::Url::parse(&with_scheme).map_err(|_| bad())?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(bad());
    }
    // No legitimate Worker address carries credentials — this also catches
    // scheme-ish junk like "mailto:a@b.c" being read as user@host.
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(bad());
    }
    let host = parsed.host_str().ok_or_else(bad)?;
    let origin = match parsed.port() {
        Some(port) => format!("{}://{host}:{port}", parsed.scheme()),
        None => format!("{}://{host}", parsed.scheme()),
    };
    Ok(origin)
}

/// The "Already have a Second Brain?" path: validate the address + password
/// against the live Worker, then save them — no Cloudflare sign-in, no
/// provisioning, nothing in the user's account is touched.
#[tauri::command]
pub async fn connect_existing(
    address: String,
    password: String,
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<ProvisionOutcome, String> {
    let locale = locale_of(&app);
    let worker_url = normalize_worker_url(&address, locale)?;
    let password = password.trim().to_string();
    if password.is_empty() {
        return Err(user_err(locale, Key::ErrorEmptyPassword));
    }

    if !session.dry_run {
        use crate::cf::api::{probe_worker, WorkerProbe};
        match probe_worker(&worker_url, &password).await {
            Ok(WorkerProbe::Valid) => {}
            Ok(WorkerProbe::WrongPassword) => {
                return Err(user_err(locale, Key::ErrorWrongPassword));
            }
            Ok(WorkerProbe::NotABrain) => {
                return Err(user_err(locale, Key::ErrorNotABrain));
            }
            Err(e) => {
                log::warn!("existing-brain probe failed: {e}");
                return Err(user_err(locale, Key::ErrorCantReach));
            }
        }
        secure_store::save_setup(&worker_url, &password).map_err(|e| {
            log::error!("secure store save failed: {e}");
            user_err(locale, Key::ErrorSecureStoreConnect)
        })?;

        // Only now, and only if this brain came from a scan of that account. A
        // failure is not worth surfacing: it costs a lookup later, nothing more.
        let hints = session.cf_hints.lock().unwrap().clone();
        if let Some((account_id, subdomain)) = hints {
            if worker_url.contains(&format!(".{subdomain}.workers.dev")) {
                if let Err(e) = secure_store::save_cf_hints(&account_id, &subdomain) {
                    log::warn!("could not save Cloudflare hints: {e}");
                }
            }
        }
    }

    let outcome = ProvisionOutcome {
        mcp_url: format!("{worker_url}/mcp"),
        worker_url,
    };
    *session.outcome.lock().unwrap() = Some(outcome.clone());
    Ok(outcome)
}

fn details_from_anywhere(session: &SetupSession) -> Option<ProvisionOutcome> {
    if let Some(outcome) = session.outcome.lock().unwrap().clone() {
        return Some(outcome);
    }
    secure_store::load_setup().map(|info| ProvisionOutcome {
        mcp_url: format!("{}/mcp", info.worker_url.trim_end_matches('/')),
        worker_url: info.worker_url,
    })
}

#[tauri::command]
pub fn get_connection_details(
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<ProvisionOutcome, String> {
    details_from_anywhere(&session).ok_or_else(|| user_err(locale_of(&app), Key::ErrorSetupNotFinished))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub claude_code: bool,
    pub cursor: bool,
}

#[tauri::command]
pub fn detect_tools() -> ToolStatus {
    let home = dirs::home_dir().unwrap_or_default();
    ToolStatus {
        claude_code: mcp_config::detect(mcp_config::Tool::ClaudeCode, &home),
        cursor: mcp_config::detect(mcp_config::Tool::Cursor, &home),
    }
}

#[tauri::command]
pub fn connect_tool(
    tool: String,
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<String, String> {
    let locale = locale_of(&app);
    let tool = mcp_config::Tool::from_id(&tool).ok_or_else(|| user_err(locale, Key::ErrorUnknownTool))?;
    let outcome = details_from_anywhere(&session)
        .ok_or_else(|| user_err(locale, Key::ErrorSetupNotFinished))?;
    let home = dirs::home_dir().ok_or_else(|| user_err(locale, Key::ErrorNoHomeFolder))?;
    if session.dry_run {
        // Demo mode must not touch real tool configs.
        return Ok("(demo) no changes written".into());
    }
    let path = mcp_config::connect(tool, &home, &outcome.mcp_url).map_err(|e| {
        log::warn!("mcp config write failed: {e}");
        user_err(locale, Key::ErrorMcpConfigFailed)
    })?;
    Ok(path.display().to_string())
}

// ── CLI setup ────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    /// The `brain` command already resolves in the user's shell.
    pub installed: bool,
    /// npm resolves, so we can offer to install the CLI for them.
    pub npm_available: bool,
}

/// Resolved through the user's login shell so a GUI-app PATH doesn't hide npm.
#[tauri::command]
pub async fn detect_cli() -> CliStatus {
    // Shelling out can take a beat; keep it off the main thread.
    tauri::async_runtime::spawn_blocking(|| CliStatus {
        installed: cli_config::cli_installed(),
        npm_available: cli_config::npm_available(),
    })
    .await
    .unwrap_or(CliStatus {
        installed: false,
        npm_available: false,
    })
}

/// Writes the CLI's config file so `brain` uses this Second Brain immediately.
/// Reads the Worker URL + token straight from secure storage — they never reach
/// the webview.
#[tauri::command]
pub fn connect_cli(app: AppHandle, session: State<'_, SetupSession>) -> Result<String, String> {
    let locale = locale_of(&app);
    if session.dry_run {
        return Ok("(demo) no changes written".into());
    }
    let info = secure_store::load_setup().ok_or_else(|| user_err(locale, Key::ErrorSetupNotFinished))?;
    let home = dirs::home_dir().ok_or_else(|| user_err(locale, Key::ErrorNoHomeFolder))?;
    let path = cli_config::write_config(&home, &info.worker_url, &info.auth_token).map_err(|e| {
        log::warn!("cli config write failed: {e}");
        user_err(locale, Key::ErrorCliConfigFailed)
    })?;
    Ok(path.display().to_string())
}

/// Installs the CLI globally via npm through the user's login shell. Best-effort:
/// on failure the config is already written, so the user can install by hand.
#[tauri::command]
pub async fn install_cli(app: AppHandle) -> Result<String, String> {
    if app.state::<SetupSession>().dry_run {
        return Ok("(demo) skipped install".into());
    }
    tauri::async_runtime::spawn_blocking(cli_config::install)
        .await
        .map_err(|_| user_err(locale_of(&app), Key::ErrorInstallInterrupted))?
}

#[tauri::command]
pub fn copy_text(text: String, app: AppHandle) -> Result<(), String> {
    app.clipboard()
        .write_text(text)
        .map_err(|_| user_err(locale_of(&app), Key::ErrorClipboardFailed))
}

/// Opens a URL in the default browser (or the Obsidian app for `obsidian://`).
/// Restricted to the destinations the UI legitimately links to — the webview
/// cannot use this to open anything else.
#[tauri::command]
pub fn open_external(url: String, app: AppHandle) -> Result<(), String> {
    let allowed = url.starts_with("https://chatgpt.com/")
        || url.starts_with("https://claude.ai/")
        || url.starts_with("https://github.com/rahilp/")
        || url.starts_with("https://community.obsidian.md/")
        || url.starts_with("obsidian://")
        || url.starts_with("mailto:");
    if !allowed {
        return Err(user_err(locale_of(&app), Key::ErrorLinkNotAllowed));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| user_err(locale_of(&app), Key::ErrorOpenBrowserFailed))
}

// ── Guided integrations (extension / Obsidian / Notion) ───────────────────────

/// Obsidian's per-user config lists the user's vaults; its presence (or the
/// installed app on macOS) means Obsidian has run here. Best-effort only.
#[tauri::command]
pub fn detect_obsidian() -> bool {
    let home = dirs::home_dir().unwrap_or_default();
    #[cfg(target_os = "macos")]
    let candidates = [
        home.join("Library/Application Support/obsidian/obsidian.json"),
        std::path::PathBuf::from("/Applications/Obsidian.app"),
    ];
    #[cfg(target_os = "windows")]
    let candidates = [dirs::config_dir()
        .unwrap_or_default()
        .join("obsidian")
        .join("obsidian.json")];
    #[cfg(all(unix, not(target_os = "macos")))]
    let candidates = [home.join(".config/obsidian/obsidian.json")];
    candidates.iter().any(|p| p.exists())
}

/// Mirrors the worker's `GET /integrations` entry shape. The token is never
/// part of it — status only.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationStatus {
    pub provider: String,
    pub name: String,
    pub connected: bool,
    /// Settings-UI grouping id (knowledge / calendar / email). Used to group the
    /// desktop list the same way the dashboard groups its own.
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub workspace_name: Option<String>,
    #[serde(default)]
    pub last_synced_at: Option<i64>,
    #[serde(default)]
    pub item_count: Option<i64>,
}

/// Reads connection status for every integration from the user's own Worker.
#[tauri::command]
pub async fn integration_status(app: AppHandle) -> Result<Vec<IntegrationStatus>, String> {
    if app.state::<SetupSession>().dry_run {
        let demo = |provider: &str, name: &str, category: &str, connected: bool| IntegrationStatus {
            provider: provider.into(),
            name: name.into(),
            connected,
            category: Some(category.into()),
            workspace_name: None,
            last_synced_at: None,
            item_count: None,
        };
        return Ok(vec![
            demo("notion", "Notion", "knowledge", false),
            demo("calendar-google", "Google Calendar", "calendar", true),
            demo("calendar-outlook", "Outlook Calendar", "calendar", false),
            demo("calendar-icloud", "iCloud Calendar", "calendar", false),
            demo("email-gmail", "Gmail", "email", true),
            demo("email-icloud", "iCloud Mail", "email", false),
        ]);
    }
    let locale = locale_of(&app);
    let info = secure_store::load_setup().ok_or_else(|| user_err(locale, Key::ErrorSetupNotFinished))?;
    let worker = info.worker_url.trim_end_matches('/');
    let resp = reqwest::Client::new()
        .get(format!("{worker}/integrations"))
        .bearer_auth(&info.auth_token)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| {
            log::warn!("integrations fetch failed: {e}");
            user_err(locale, Key::ErrorReachBrain)
        })?;
    if !resp.status().is_success() {
        return Err(i18n::t_fmt(
            locale,
            Key::ErrorBrainHttpStatus,
            &[("status", &resp.status().as_u16().to_string())],
        ));
    }
    #[derive(serde::Deserialize)]
    struct Wrapper {
        integrations: Vec<IntegrationStatus>,
    }
    let body: Wrapper = resp
        .json()
        .await
        .map_err(|_| user_err(locale, Key::ErrorBrainUnexpected))?;
    Ok(body.integrations)
}

/// Runs Notion sync to completion against a Worker. The endpoint syncs one
/// bounded batch per call and reports `remaining`, so this loops until it drains
/// (capped so a runaway can't spin forever). Reusable by the command and the
/// menu-bar action.
pub async fn notion_sync(
    worker_url: &str,
    auth_token: &str,
    locale: Locale,
) -> Result<String, String> {
    let worker = worker_url.trim_end_matches('/');
    let client = reqwest::Client::new();
    let mut changed = 0i64;
    for _ in 0..30 {
        let resp = client
            .post(format!("{worker}/integrations/notion/sync"))
            .bearer_auth(auth_token)
            .timeout(std::time::Duration::from_secs(60))
            .send()
            .await
            .map_err(|e| {
                log::warn!("notion sync failed: {e}");
                user_err(locale, Key::ErrorReachBrain)
            })?;
        let ok_status = resp.status().is_success();
        let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
        if !ok_status || body.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            let err = body
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or(i18n::t(locale, Key::ErrorNotionSyncFailed));
            return Err(err.to_string());
        }
        let field = |k: &str| body.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
        changed += field("created") + field("updated") + field("deleted");
        if field("remaining") <= 0 {
            break;
        }
    }
    Ok(if changed > 0 {
        i18n::t_fmt(
            locale,
            Key::ErrorNotionSynced,
            &[("count", &changed.to_string())],
        )
    } else {
        user_err(locale, Key::ErrorNotionUpToDate)
    })
}

/// Runs Notion sync to completion.
#[tauri::command]
pub async fn sync_notion(app: AppHandle) -> Result<String, String> {
    let locale = locale_of(&app);
    if app.state::<SetupSession>().dry_run {
        return Ok(user_err(locale, Key::ErrorNotionUpToDate));
    }
    let info = secure_store::load_setup().ok_or_else(|| user_err(locale, Key::ErrorSetupNotFinished))?;
    notion_sync(&info.worker_url, &info.auth_token, locale).await
}

/// Opens the dashboard and drops the user straight into the Integrations panel.
/// If the dashboard is already open, just opens the panel there.
#[tauri::command]
pub fn open_dashboard_integrations(
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<(), String> {
    let locale = locale_of(&app);
    let (worker_url, token) = if session.dry_run {
        let outcome = details_from_anywhere(&session)
            .ok_or_else(|| user_err(locale, Key::ErrorSetupNotFinished))?;
        (outcome.worker_url, "demo".to_string())
    } else {
        let info = secure_store::load_setup().ok_or_else(|| user_err(locale, Key::ErrorSetupNotFinished))?;
        (info.worker_url, info.auth_token)
    };
    windows::open_wrapper_window_integrations(&app, &worker_url, &token)
        .map_err(|_| user_err(locale, Key::OpenDashboardFailed))?;
    close_setup_windows(&app);
    Ok(())
}

fn dashboard_credentials(
    session: &SetupSession,
    locale: Locale,
) -> Result<(String, String), String> {
    if session.dry_run {
        // No keychain read, and no connected-yet check.
        //
        // This used to call details_from_anywhere, which falls back to
        // secure_store::load_setup() when the session has no outcome — so opening
        // the settings window in demo mode raised an OS keychain password prompt.
        // That is the same class of bug as #252, and it is why the window never
        // worked in demo mode: the prompt appeared before any request was made.
        //
        // The check itself does not apply here either. In a real run it asks "is
        // this computer connected to a brain yet?"; in demo mode the local demo
        // brain *is* the brain, always present, so there is nothing to refuse.
        // The local demo brain, not `second-brain.demo.workers.dev`: that address
        // does not resolve, so every Worker-backed screen failed with "Couldn't
        // reach your Second Brain". Pointing at a real server on loopback means
        // settings and migration run their actual HTTP paths against real data.
        Ok((crate::demo_brain::base_url(), "demo".to_string()))
    } else {
        let info = secure_store::load_setup()
            .ok_or_else(|| user_err(locale, Key::OpenDashboardNotSetup))?;
        Ok((info.worker_url, info.auth_token))
    }
}

/// Opens the dashboard wrapper, closing setup/details windows on success.
pub fn open_dashboard_impl(app: &AppHandle, session: &SetupSession) -> Result<(), String> {
    let locale = locale_of(app);
    let (worker_url, token) = dashboard_credentials(session, locale)?;
    windows::open_wrapper_window(app, &worker_url, &token)
        .map_err(|_| user_err(locale, Key::OpenDashboardFailed))?;
    close_setup_windows(app);
    Ok(())
}

fn close_setup_windows(app: &AppHandle) {
    for label in ["main", "details"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.close();
        }
    }
}

#[tauri::command]
pub fn open_dashboard(app: AppHandle, session: State<'_, SetupSession>) -> Result<(), String> {
    open_dashboard_impl(&app, &session)
}

#[tauri::command]
pub fn set_locale(locale: String, app: AppHandle) -> Result<(), String> {
    let locale = Locale::parse(&locale).ok_or_else(|| "Invalid locale".to_string())?;
    if let Ok(config) = app.path().app_config_dir() {
        let _ = i18n::write_stored_locale(&config, locale);
    }
    if let Some(state) = app.try_state::<AppLocale>() {
        state.set(locale);
    }
    if let Some(menus) = app.try_state::<AppMenus>() {
        menus.apply_locale(locale);
        menus.rebuild_tray_menu(&app).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_details_window(app: AppHandle) {
    windows::open_details_window(&app);
}

// ── Worker update ────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkerUpdateInfo {
    pub deployed_version: Option<String>,
    pub available_version: String,
}

/// Core check, usable outside a command context (the launch-time offer). None
/// when up to date, unknown, on a custom domain, in dry-run, or not set up.
async fn compute_worker_update(dry_run: bool) -> Option<WorkerUpdateInfo> {
    if dry_run {
        return None;
    }
    let info = secure_store::load_setup()?;
    subdomain_of(&info.worker_url)?;
    let bundled = worker_bundle::manifest().worker_version.clone();
    let deployed = crate::cf::api::worker_version(&info.worker_url, &info.auth_token)
        .await
        .unwrap_or(None);
    crate::version::is_behind(deployed.as_deref(), &bundled).then_some(WorkerUpdateInfo {
        deployed_version: deployed,
        available_version: bundled,
    })
}

/// Checks whether the deployed Worker is behind the version this app bundles.
#[tauri::command]
pub async fn worker_update_available(
    session: State<'_, SetupSession>,
) -> Result<Option<WorkerUpdateInfo>, String> {
    Ok(compute_worker_update(session.dry_run).await)
}

/// Launch-time offer: quietly check, and if the Worker is behind, ask with a
/// native dialog. On accept, drop into the Worker-update flow.
pub fn maybe_offer_worker_update(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let locale = locale_of(&app);
        let dry_run = app.state::<SetupSession>().dry_run;
        let Some(update) = compute_worker_update(dry_run).await else {
            return;
        };
        let message = i18n::t_fmt(
            locale,
            Key::WorkerUpdateMessage,
            &[("version", &update.available_version)],
        );
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.dialog()
            .message(message)
            .title(i18n::t(locale, Key::WorkerUpdateTitle))
            .kind(tauri_plugin_dialog::MessageDialogKind::Info)
            .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                i18n::t(locale, Key::AppUpdateNow).to_string(),
                i18n::t(locale, Key::AppUpdateLater).to_string(),
            ))
            .show(move |accepted| {
                let _ = tx.send(accepted);
            });
        if rx.await.unwrap_or(false) {
            *app.state::<SetupSession>().pending_worker_update.lock().unwrap() = true;
            let _ = windows::open_setup_window(&app);
        }
    });
}

/// Puts the main window into Worker-update mode and shows it. Called from the
/// launch-time prompt and the Connection details button.
#[tauri::command]
pub fn begin_worker_update(app: AppHandle, session: State<'_, SetupSession>) -> Result<(), String> {
    *session.pending_worker_update.lock().unwrap() = true;
    windows::open_setup_window(&app)
        .map_err(|_| user_err(locale_of(&app), Key::ErrorOpenWindowFailed))
}

/// Runs the preserve-everything redeploy. Requires a prior `connect_cloudflare`
/// (so the session holds a Cloudflare token + account list). Resolves the
/// account that hosts the Worker by matching its workers.dev subdomain.
#[tauri::command]
pub async fn start_worker_update(
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<ProvisionOutcome, String> {
    let locale = locale_of(&app);
    let manifest = worker_bundle::manifest();

    let progress_app = app.clone();
    let progress = move |event: provision::StepEvent| {
        let _ = progress_app.emit("setup-progress", &event);
    };

    if session.dry_run {
        let outcome = ProvisionOutcome {
            worker_url: "https://second-brain.demo.workers.dev".into(),
            mcp_url: "https://second-brain.demo.workers.dev/mcp".into(),
        };
        provision::update_worker(
            &DryRunBackend,
            manifest,
            &outcome.worker_url,
            "demo",
            provision::VectorizeTarget::shipped(manifest),
            progress,
        )
            .await
            .map_err(|e| {
                log::warn!("dry-run worker update failed: {e}");
                user_err(locale, Key::ErrorFriendlyRetry)
            })?;
        *session.pending_worker_update.lock().unwrap() = false;
        return Ok(outcome);
    }

    let info = secure_store::load_setup().ok_or_else(|| user_err(locale, Key::ErrorComputerNotSetup))?;
    let expected_sub = subdomain_of(&info.worker_url)
        .ok_or_else(|| user_err(locale, Key::ErrorCustomDomain))?;
    let mut tokens = session
        .tokens
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| user_err(locale, Key::ErrorCfSignInFirst))?;
    if tokens.expires_at <= std::time::Instant::now() {
        tokens = oauth::refresh(&tokens).await.map_err(|e| {
            log::warn!("token refresh failed: {e}");
            user_err(locale, Key::ErrorCfSignInExpired)
        })?;
        *session.tokens.lock().unwrap() = Some(tokens.clone());
    }
    let accounts = session.accounts.lock().unwrap().clone();

    // Find the account whose workers.dev subdomain matches the Worker's URL.
    let mut matched: Option<String> = None;
    for account in &accounts {
        let client = CfClient::new(tokens.access_token.clone(), account.id.clone());
        if let Ok(Some(sub)) = client.get_account_subdomain().await {
            if sub == expected_sub {
                matched = Some(account.id.clone());
                break;
            }
        }
    }
    let account_id = matched.ok_or_else(|| user_err(locale, Key::ErrorWrongCfAccount))?;

    let backend = LiveBackend {
        client: CfClient::new(tokens.access_token.clone(), account_id),
    };
    // A routine update stays on whatever index this build ships with. Only an
    // embedding migration moves it, and that goes through its own command.
    provision::update_worker(
        &backend,
        manifest,
        &info.worker_url,
        &info.auth_token,
        provision::VectorizeTarget::shipped(manifest),
        progress,
    )
        .await
        .map_err(|e| {
            log::warn!("worker update failed: {e}");
            match e {
                // Permanent, so "try again" would be a lie. Reachable only if the
                // subdomain check above is ever removed — the message is right
                // either way.
                ProvisionError::NotAWorkersDevAddress => user_err(locale, Key::ErrorCustomDomain),
                _ => user_err(locale, Key::ErrorFriendlyRetry),
            }
        })?;

    *session.pending_worker_update.lock().unwrap() = false;
    Ok(ProvisionOutcome {
        mcp_url: format!("{}/mcp", info.worker_url.trim_end_matches('/')),
        worker_url: info.worker_url,
    })
}

/// Signs this computer out: forgets the saved address + password and returns
/// to the setup flow. The Second Brain itself (and every other device) is
/// untouched. Confirmation happens in the UI before this is invoked.
#[tauri::command]
pub fn logout(app: AppHandle, session: State<'_, SetupSession>) {
    session.reset();
    perform_logout(&app);
}

/// Shared by the `logout` command and the app-menu item (which confirms via a
/// native dialog and has no `State` handle).
pub fn perform_logout(app: &AppHandle) {
    secure_store::clear_setup();
    if let Some(session) = app.try_state::<SetupSession>() {
        session.reset();
    }
    // The wrapper injected the dashboard session into the webview's
    // localStorage — wipe that store too, then close wrapper windows.
    if let Some(w) = app.get_webview_window("brain") {
        let _ = w.clear_all_browsing_data();
        let _ = w.close();
    }
    if let Some(w) = app.get_webview_window("details") {
        let _ = w.close();
    }
    let _ = windows::open_setup_window(app);
}

// ── Advanced Settings (#246) ───────────────────────────────────────────────────
//
// Every mutating command returns the freshly re-read view rather than echoing
// what was requested. The Worker clamps and invariant-checks at resolve time,
// so what it stored may differ from what was asked for — rendering from the
// request would show the user a state their brain is not actually in.

/// Resolves the brain to talk to, going through the same session-aware helper
/// the dashboard commands use.
///
/// Deliberately NOT `secure_store::load_setup()` directly: that ignores
/// dry-run, so it both breaks demoing the panel on a configured machine and
/// raises a Keychain prompt for a value dry-run would discard — the bug fixed
/// for launch in #252, which is easy to reintroduce one command at a time.
/// Resolves the Cloudflare account that holds this brain, refreshing the sign-in
/// if it aged out.
///
/// Shared by the worker update and the embedding migration: both need to act on
/// the account the brain actually lives in, matched by the subdomain in its
/// stored address rather than assumed.
async fn cloudflare_client_for_brain(
    worker_url: &str,
    session: &SetupSession,
    locale: Locale,
) -> Result<CfClient, String> {
    let expected_sub = crate::worker_url::subdomain_of(worker_url)
        .ok_or_else(|| user_err(locale, Key::ErrorCustomDomain))?;

    let mut tokens = session
        .tokens
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| user_err(locale, Key::ErrorCfSignInFirst))?;
    if tokens.expires_at <= std::time::Instant::now() {
        tokens = oauth::refresh(&tokens).await.map_err(|e| {
            log::warn!("token refresh failed: {e}");
            user_err(locale, Key::ErrorCfSignInExpired)
        })?;
        *session.tokens.lock().unwrap() = Some(tokens.clone());
    }

    let accounts = session.accounts.lock().unwrap().clone();
    for account in &accounts {
        let client = CfClient::new(tokens.access_token.clone(), account.id.clone());
        if let Ok(Some(sub)) = client.get_account_subdomain().await {
            if sub == expected_sub {
                return Ok(client);
            }
        }
    }
    Err(user_err(locale, Key::ErrorWrongCfAccount))
}

/// What a rebuild would involve, and which models can be chosen. Shown before
/// anything is created.
#[tauri::command]
pub async fn migration_estimate(
    app: AppHandle,
) -> Result<crate::migration::MigrationEstimate, String> {
    let (url, token, locale) = settings_target(&app)?;
    crate::migration::fetch_estimate(&url, &token, locale).await
}

/// Where an interrupted rebuild got to, so the app can offer to resume rather
/// than start again.
#[tauri::command]
pub async fn migration_status(app: AppHandle) -> Result<serde_json::Value, String> {
    let (url, token, locale) = settings_target(&app)?;
    crate::migration::fetch_status(&url, &token, locale).await
}

/// Moves the brain onto a new embedding model: create the index it will use,
/// redeploy the binding at it, then record the model.
///
/// Nothing is destroyed here. The previous index is left in place and populated,
/// so every failure before [`finish_embedding_migration`] is recoverable by
/// redeploying against it.
///
/// The order matters. The config write happens *after* the redeploy, because
/// config lives in KV and takes effect on the very next request: writing it first
/// would leave the Worker embedding at the new size against the old index, which
/// fails every capture on upsert. Reversing them narrows that window to the gap
/// between a successful deploy and one KV write. It cannot be closed entirely
/// without the dual-binding scheme #248 defers, and the rebuild that follows
/// leaves recall incomplete anyway — which the UI says plainly.
#[tauri::command]
pub async fn begin_embedding_migration(
    model: String,
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<(), String> {
    let locale = locale_of(&app);
    let manifest = worker_bundle::manifest();

    // Reject an unknown model before touching anything. Dimensions are fixed at
    // index creation, so a model whose size we would have to guess could produce
    // an index that rejects every vector — and an index cannot be altered.
    let dimensions = crate::migration::dimensions_for(&model)
        .ok_or_else(|| user_err(locale, Key::ErrorUnknownEmbeddingModel))?;
    let target_index = crate::migration::index_name_for(
        &manifest.vectorize_name,
        dimensions,
        manifest.vectorize_dimensions,
    );

    let (worker_url, auth_token, _) = settings_target(&app)?;

    let progress_app = app.clone();
    let progress = move |event: provision::StepEvent| {
        let _ = progress_app.emit("setup-progress", &event);
    };

    if session.dry_run {
        // The demo brain runs on a loopback address, which has no script or
        // subdomain to derive — `update_worker` would refuse it before doing
        // anything. DryRunBackend ignores the URL entirely (its health check is
        // stubbed), so a synthetic workers.dev address exercises the same code
        // path while the real loopback address keeps serving the HTTP calls.
        provision::update_worker(
            &DryRunBackend,
            manifest,
            "https://second-brain.demo.workers.dev",
            "demo",
            provision::VectorizeTarget { name: &target_index, dimensions },
            progress,
        )
        .await
        .map_err(|e| {
            log::warn!("dry-run migration redeploy failed: {e}");
            user_err(locale, Key::ErrorFriendlyRetry)
        })?;
        // In the same order as the live path below, so demo mode actually moves
        // the model. Without this the demo rebuild runs at the old model, the
        // old index stays "live", and the final free-up step is unreachable —
        // which would leave the most consequential screen untested.
        crate::migration::patch_embedding_model(&worker_url, &auth_token, &model, locale).await?;
        // In memory, never the keychain — see demo_previous_index.
        if target_index != manifest.vectorize_name {
            *session.demo_previous_index.lock().unwrap() = Some(manifest.vectorize_name.clone());
        }
        return crate::migration::reset(&worker_url, &auth_token, locale).await;
    }

    let client = cloudflare_client_for_brain(&worker_url, &session, locale).await?;

    // What the brain reads right now, taken from the live binding rather than
    // derived from an assumed size. Recorded BEFORE the switch, because
    // afterwards the brain reports the new index as current and this name is the
    // only thing that identifies what may later be freed. Written first so it
    // survives a redeploy that fails half-way.
    if let Some(script) = crate::worker_url::script_of(&worker_url) {
        if let Ok(bindings) = client.get_script_bindings(&script).await {
            if let Some(current) = provision::binding_field(&bindings, "vectorize", "index_name") {
                if current != target_index {
                    if let Err(e) = secure_store::save_previous_index(current) {
                        log::warn!("could not record the outgoing index: {e}");
                    }
                }
            }
        }
    }

    let backend = LiveBackend { client };

    // Creating the index is idempotent and non-destructive, and update_worker
    // creates the target if it is missing — so a retry after a failed deploy
    // costs nothing.
    provision::update_worker(
        &backend,
        manifest,
        &worker_url,
        &auth_token,
        provision::VectorizeTarget { name: &target_index, dimensions },
        progress,
    )
    .await
    .map_err(|e| {
        log::warn!("migration redeploy failed: {e}");
        match e {
            ProvisionError::NotAWorkersDevAddress => user_err(locale, Key::ErrorCustomDomain),
            _ => user_err(locale, Key::ErrorFriendlyRetry),
        }
    })?;

    // Past this point the brain is already reading the new index, so a failure is
    // not "nothing happened". Search stays incomplete until the rebuild runs, and
    // the message has to say so — retrying is safe and idempotent, but walking
    // away is not.
    let half_switched = |_e: String| user_err(locale, Key::ErrorMigrationHalfSwitched);

    crate::migration::patch_embedding_model(&worker_url, &auth_token, &model, locale)
        .await
        .map_err(half_switched)?;

    // Any ledger from a previous target is meaningless against this one.
    crate::migration::reset(&worker_url, &auth_token, locale)
        .await
        .map_err(half_switched)
}

/// Abandons an unfinished rebuild so the next one starts from the beginning.
///
/// The escape hatch for a rebuild that keeps stalling on the same entry: without
/// it, a user whose cursor sits on a permanently failing memory has no way out.
/// Rebuilding is idempotent, so this costs model calls and cannot corrupt
/// anything.
#[tauri::command]
pub async fn migration_reset(app: AppHandle) -> Result<(), String> {
    let (url, token, locale) = settings_target(&app)?;
    crate::migration::reset(&url, &token, locale).await
}

/// One re-embed batch. The window loops on this until `done`, and stops if
/// `stalled` — the day's model allowance is spent and the cursor is kept.
#[tauri::command]
pub async fn migration_step(app: AppHandle) -> Result<crate::migration::BatchProgress, String> {
    let (url, token, locale) = settings_target(&app)?;
    crate::migration::run_batch(&url, &token, locale).await
}

/// Whether an index is left over from a migration, and can be freed.
///
/// The window asks this rather than tracking sizes itself: the name comes from
/// what Cloudflare reported as bound before the switch, so nothing is derived
/// from an assumed dimension count and nothing lives in browser storage that a
/// reset could lose.
#[tauri::command]
pub fn outstanding_old_index(session: State<'_, SetupSession>) -> Option<String> {
    previous_index_for(&session)
}

/// Split out of the command so it can be tested: a Tauri `State` cannot be
/// constructed in a unit test, and the property that matters here — that demo
/// mode performs no keychain read — is only observable by calling it.
fn previous_index_for(session: &SetupSession) -> Option<String> {
    if session.dry_run {
        // Checked before the keychain read, exactly as get_app_state does: a read
        // here raises an OS password prompt on unsigned dev builds, and demo mode
        // must never do that.
        return session.demo_previous_index.lock().unwrap().clone();
    }
    secure_store::load_previous_index()
}

/// Deletes the superseded index. The one irreversible step, so the window
/// confirms it separately and only after a rebuild has finished.
///
/// Takes no argument on purpose. An earlier shape had the window pass the size it
/// thought it was moving from, which put the name of something irreversibly
/// deletable in the hands of browser storage.
#[tauri::command]
pub async fn finish_embedding_migration(
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<(), String> {
    let locale = locale_of(&app);
    let (worker_url, auth_token, _) = settings_target(&app)?;

    let old_index = if session.dry_run {
        session.demo_previous_index.lock().unwrap().clone()
    } else {
        secure_store::load_previous_index()
    }
    .ok_or_else(|| user_err(locale, Key::ErrorNoOldIndexToFree))?;

    // Refuse to delete the index the brain is reading. The recorded name is
    // trustworthy, but a redeploy could have been rolled back since, and the cost
    // of being wrong here is unrecoverable.
    let live_model = crate::migration::fetch_status(&worker_url, &auth_token, locale)
        .await?
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or_default()
        .to_string();
    let manifest = worker_bundle::manifest();
    let live_index = crate::migration::index_name_for(
        &manifest.vectorize_name,
        crate::migration::dimensions_for(&live_model).unwrap_or(manifest.vectorize_dimensions),
        manifest.vectorize_dimensions,
    );
    if old_index == live_index {
        return Err(user_err(locale, Key::ErrorCannotDeleteLiveIndex));
    }

    // Through the Backend trait rather than the client directly, so demo mode
    // exercises the same code path instead of returning early past it.
    use provision::Backend;
    let failed = |e: CfApiError| {
        log::warn!("old index delete failed: {e}");
        user_err(locale, Key::ErrorFriendlyRetry)
    };
    if session.dry_run {
        DryRunBackend
            .delete_vectorize(&old_index)
            .await
            .map_err(failed)?;
    } else {
        let backend = LiveBackend {
            client: cloudflare_client_for_brain(&worker_url, &session, locale).await?,
        };
        backend.delete_vectorize(&old_index).await.map_err(failed)?;
    }

    // Only after the delete succeeded. Clearing it first would silently orphan
    // the index with nothing left pointing at it.
    if session.dry_run {
        *session.demo_previous_index.lock().unwrap() = None;
    } else {
        secure_store::clear_previous_index();
    }
    Ok(())
}

fn settings_target(app: &AppHandle) -> Result<(String, String, Locale), String> {
    let locale = locale_of(app);
    let session = app.state::<SetupSession>();
    let (url, token) = dashboard_credentials(&session, locale)?;
    Ok((url, token, locale))
}

#[tauri::command]
pub async fn get_brain_settings(app: AppHandle) -> Result<crate::settings::SettingsView, String> {
    let (url, token, locale) = settings_target(&app)?;
    crate::settings::fetch_settings(&url, &token, locale).await
}

/// Commits staged changes from the Advanced Settings window.
///
/// Replaces the earlier save-on-change commands: settings that alter how recall
/// behaves should not be written the instant a radio is clicked, because a
/// mis-click silently retunes the user's brain with no way back.
#[tauri::command]
pub async fn save_brain_settings(
    app: AppHandle,
    levels: Vec<(String, String)>,
    resets: Vec<String>,
    model: Option<String>,
) -> Result<crate::settings::SettingsView, String> {
    let (url, token, locale) = settings_target(&app)?;
    crate::settings::apply_settings(&url, &token, &levels, &resets, model, locale).await?;
    crate::settings::fetch_settings(&url, &token, locale).await
}

#[tauri::command]
pub fn open_settings_window(app: AppHandle) {
    crate::windows::open_settings_window(&app);
}

#[cfg(test)]
mod tests {
    use super::{dashboard_credentials, normalize_worker_url, previous_index_for, SetupSession};
    use crate::cf::provision::ProvisionOutcome;
    use crate::i18n::Locale;

    #[test]
    fn normalizes_pasted_addresses() {
        for input in [
            "https://second-brain.demo.workers.dev",
            "second-brain.demo.workers.dev",
            "https://second-brain.demo.workers.dev/",
            "  second-brain.demo.workers.dev/mcp  ",
            "https://second-brain.demo.workers.dev/graph?tab=all",
        ] {
            assert_eq!(
                normalize_worker_url(input, Locale::En).unwrap(),
                "https://second-brain.demo.workers.dev",
                "input: {input:?}"
            );
        }
    }

    #[test]
    fn rejects_garbage_urls() {
        for input in ["", "not a url", "ftp://bad.scheme"] {
            assert!(normalize_worker_url(input, Locale::En).is_err(), "input: {input:?}");
        }
    }

    #[test]
    fn keeps_explicit_http_and_ports_for_dev_setups() {
        assert_eq!(
            normalize_worker_url("http://localhost:8787/mcp", Locale::En).unwrap(),
            "http://localhost:8787"
        );
    }

    #[test]
    fn rejects_junk() {
        for input in ["", "   ", "not a url at all!", "ftp://x.dev", "mailto:a@b.c"] {
            assert!(
                normalize_worker_url(input, Locale::En).is_err(),
                "input: {input:?}"
            );
        }
    }


    /// #252 fixed launch raising a Keychain prompt in dry-run. Every command
    /// that resolves a brain must go through dashboard_credentials for the same
    /// reason — bypassing it reintroduces the bug one command at a time.
    #[test]
    fn settings_commands_resolve_credentials_through_the_session_helper() {
        let src = include_str!("commands.rs");
        let start = src.find("fn settings_target").expect("settings_target");
        let end = src[start..].find("\n}").expect("end of fn") + start;
        let body = &src[start..end];
        assert!(
            body.contains("dashboard_credentials"),
            "settings_target must use dashboard_credentials so dry-run is honoured"
        );
        assert!(
            !body.contains("secure_store::load_setup"),
            "settings_target must not read secure_store directly — it ignores dry-run and prompts the Keychain"
        );
    }

    /// Demo mode is pointed at the local demo brain, not at
    /// `second-brain.demo.workers.dev` — that address does not resolve, so every
    /// Worker-backed screen failed before anything could be demonstrated.
    /// Demo mode performs zero keychain reads.
    ///
    /// Counted rather than grepped. Two separate paths have now reached the
    /// keychain in dry-run: `outstanding_old_index` read the note unconditionally,
    /// and `dashboard_credentials` called `details_from_anywhere`, which falls
    /// back to `secure_store::load_setup()` — so merely opening the settings
    /// window raised an OS password prompt before any request was made. That
    /// second one is why the window never worked in demo mode at all.
    ///
    /// A source scan cannot express the real rule, which is "not inside the
    /// dry-run branch" rather than "the function mentions dry_run" — a guard I
    /// wrote that way passed while the bug was reintroduced. The prompt itself is
    /// an OS dialog no unit test can see, but the read that causes it is
    /// countable, so this counts.
    #[test]
    fn demo_mode_never_reads_the_keychain() {
        let session = SetupSession::new(true);
        *session.outcome.lock().unwrap() = Some(ProvisionOutcome {
            worker_url: "https://second-brain.demo.workers.dev".into(),
            mcp_url: "https://second-brain.demo.workers.dev/mcp".into(),
        });

        crate::secure_store::probe::reset();
        let (url, token) = dashboard_credentials(&session, Locale::En).expect("demo credentials");
        assert_eq!(
            crate::secure_store::probe::reads(),
            0,
            "dashboard_credentials touched the keychain in demo mode — that is the \
             prompt users see when they open the settings window"
        );
        assert!(url.starts_with("http://127.0.0.1:"), "demo must use the local brain: {url}");
        assert_eq!(token, "demo");

        // The outstanding-index note is the other path that reached the keychain.
        crate::secure_store::probe::reset();
        let _ = previous_index_for(&session);
        assert_eq!(
            crate::secure_store::probe::reads(),
            0,
            "the outstanding-index note was read from the keychain in demo mode"
        );

        // And with no session outcome either: the fallback is exactly where the
        // keychain read used to hide.
        let fresh = SetupSession::new(true);
        crate::secure_store::probe::reset();
        let _ = dashboard_credentials(&fresh, Locale::En);
        assert_eq!(
            crate::secure_store::probe::reads(),
            0,
            "an unconnected demo session fell back to the keychain"
        );
    }

    #[test]
    fn dashboard_credentials_dry_run_uses_the_local_demo_brain() {
        let session = SetupSession::new(true);
        *session.outcome.lock().unwrap() = Some(ProvisionOutcome {
            worker_url: "https://second-brain.demo.workers.dev".into(),
            mcp_url: "https://second-brain.demo.workers.dev/mcp".into(),
        });
        let (url, token) = dashboard_credentials(&session, Locale::En).unwrap();
        assert_eq!(url, crate::demo_brain::base_url());
        assert!(url.starts_with("http://127.0.0.1:"), "got {url}");
        assert_eq!(token, "demo");
    }
}
