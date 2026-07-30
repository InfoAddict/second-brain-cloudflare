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
use crate::rotate::{self, RotateOutcome};
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
    /// Set when the main window should boot into the change-your-password flow
    /// (#235, Door A). Mirrors `pending_worker_update` exactly, including being
    /// read before any keychain access — see [`get_app_state`].
    pending_rotation: Mutex<bool>,
    /// Set at launch when the brain refused the password this computer has
    /// stored, which means it was changed somewhere else. The window then asks
    /// for the new one instead of opening a dashboard that only 401s.
    stale_password: Mutex<bool>,
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
            pending_rotation: Mutex::new(false),
            stale_password: Mutex::new(false),
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
        *self.pending_rotation.lock().unwrap() = false;
        *self.stale_password.lock().unwrap() = false;
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
    //
    // Every in-memory flag has to be tested before that read for the same
    // reason, which is why the two #235 modes sit up here with the Worker
    // update rather than beside the branch they most resemble. A demo run
    // reaching `load_setup()` at all is the bug — see #252.
    let mode = if *session.pending_rotation.lock().unwrap() {
        "change-password"
    } else if *session.stale_password.lock().unwrap() {
        "stale-password"
    } else if *session.pending_worker_update.lock().unwrap() {
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
        //
        // The password is asked of the brain rather than written here as a
        // literal. A real run re-reads it from the keychain, which a rotation has
        // just updated; demo mode has no keychain, so the equivalent is to ask
        // the demo brain what it currently answers to. With the literal in place
        // every settings and dashboard window 401s for the rest of the run the
        // moment a demo rotation happens — which is the whole flow this is meant
        // to make demonstrable.
        Ok((crate::demo_brain::base_url(), crate::demo_brain::auth_token()))
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

/// What the one authenticated request the app makes at launch found out.
enum LaunchCheck {
    /// Nothing worth interrupting the user for: up to date, unknown, offline,
    /// on a custom domain, in dry-run, or not set up.
    Nothing,
    Update(WorkerUpdateInfo),
    /// The brain refused the password this computer has stored, which means it
    /// was changed somewhere else (#235 §5). Until now this was discarded, and
    /// the user got a dashboard that silently 401ed with no route back except
    /// Disconnect.
    StalePassword,
}

/// The launch-time probe. One authenticated `GET /health`, and both facts come
/// out of it — the deployed version, and whether this computer's password still
/// opens the brain at all.
async fn launch_check(dry_run: bool) -> LaunchCheck {
    if dry_run {
        return LaunchCheck::Nothing;
    }
    let Some(info) = secure_store::load_setup() else {
        return LaunchCheck::Nothing;
    };

    // The request is made before the workers.dev check, not after.
    //
    // The custom-domain early-out exists because such a brain cannot be updated
    // from here — but it can certainly have had its password changed on another
    // computer, and its owner deserves the same screen. The cost is one GET at
    // launch for custom-domain users, who previously skipped it.
    let deployed = match crate::cf::api::worker_version(&info.worker_url, &info.auth_token).await {
        Ok(version) => version,
        Err(CfApiError::Unauthorized) => return LaunchCheck::StalePassword,
        // Offline, or a brain having a moment. Neither is a password problem, and
        // telling someone their password changed because their wifi dropped is
        // worse than saying nothing at all.
        Err(e) => {
            log::debug!("launch health check could not reach the brain: {e}");
            return LaunchCheck::Nothing;
        }
    };

    if subdomain_of(&info.worker_url).is_none() {
        return LaunchCheck::Nothing;
    }
    let bundled = worker_bundle::manifest().worker_version.clone();
    if crate::version::is_behind(deployed.as_deref(), &bundled) {
        LaunchCheck::Update(WorkerUpdateInfo {
            deployed_version: deployed,
            available_version: bundled,
        })
    } else {
        LaunchCheck::Nothing
    }
}

/// Core check, usable outside a command context (the launch-time offer). None
/// when up to date, unknown, on a custom domain, in dry-run, or not set up.
async fn compute_worker_update(dry_run: bool) -> Option<WorkerUpdateInfo> {
    match launch_check(dry_run).await {
        LaunchCheck::Update(info) => Some(info),
        LaunchCheck::Nothing | LaunchCheck::StalePassword => None,
    }
}

/// Checks whether the deployed Worker is behind the version this app bundles.
#[tauri::command]
pub async fn worker_update_available(
    session: State<'_, SetupSession>,
) -> Result<Option<WorkerUpdateInfo>, String> {
    Ok(compute_worker_update(session.dry_run).await)
}

/// Launch-time check on the brain this computer is connected to.
///
/// Two outcomes are worth interrupting for: the Worker is behind the bundled
/// version (ask, with a native dialog), or the stored password no longer opens
/// the brain (#235 §5 — show the screen that asks for the new one).
pub fn check_brain_at_launch(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let locale = locale_of(&app);
        let dry_run = app.state::<SetupSession>().dry_run;
        let update = match launch_check(dry_run).await {
            LaunchCheck::Nothing => return,
            LaunchCheck::StalePassword => {
                show_stale_password(&app);
                return;
            }
            LaunchCheck::Update(update) => update,
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

/// Routes a launch that found a dead password to the screen that asks for the
/// new one.
///
/// In place of the wrapper window, not beside it. The dashboard behind it can
/// only 401, and leaving it up would mean explaining the problem through a broken
/// page — which until now was the entire experience of having your password
/// changed on another computer: a silently failing window and no route back
/// except Disconnect.
fn show_stale_password(app: &AppHandle) {
    *app.state::<SetupSession>().stale_password.lock().unwrap() = true;
    if let Some(window) = app.get_webview_window("brain") {
        let _ = window.close();
    }
    let _ = windows::open_setup_window(app);
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
            // Not the literal "demo": an update's health poll is made with the
            // password the app already holds, and after a demo rotation that is
            // no longer the default. A 401 there is terminal (it means a redeploy
            // dropped the secret), so a hard-coded token turns every demo update
            // after a demo rotation into a reported failure.
            &crate::demo_brain::auth_token(),
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

    // Resolving which Cloudflare account holds this brain used to be written out
    // here as well as in `cloudflare_client_for_brain`. It now has a third caller
    // (`rotate_password`), and three copies of "match the address's subdomain
    // against every signed-in account" is three places for #257 to come back.
    let backend = LiveBackend {
        client: cloudflare_client_for_brain(&info.worker_url, &session, locale).await?,
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

// ── Changing the password (#235) ─────────────────────────────────────────────

/// Why a password change did not finish, in the only three shapes that differ in
/// what may honestly be said afterwards.
///
/// `Result<(), String>` is not sufficient here, and that is load-bearing rather
/// than fastidious. A string cannot separate "the change never reached
/// Cloudflare, so your old password still works" from "the change was accepted
/// and never confirmed, so your new password may already be the only one that
/// opens your brain". Those are opposite instructions. With one string every
/// failure has to hedge — so a user whose Cloudflare sign-in merely expired is
/// told their password may already have changed, which teaches people to
/// disbelieve that warning on the one occasion it is real.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RotateError {
    /// Selects the screen, and with it what may be claimed:
    ///   `"notSent"`     — nothing reached Cloudflare; the old password still works.
    ///   `"unconfirmed"` — the secret was accepted; health never went green. Never
    ///                     tell the user the old password still works.
    ///   `"local"`       — the brain has the new password; a local write failed.
    pub stage: &'static str,
    /// Already localised; rendered into the failure screen's detail slot rather
    /// than being the screen. Bare text — the "What went wrong: …" framing is the
    /// front end's.
    pub detail: String,
}

impl RotateError {
    fn not_sent(detail: String) -> Self {
        Self { stage: "notSent", detail }
    }
    fn unconfirmed(detail: String) -> Self {
        Self { stage: "unconfirmed", detail }
    }
    fn local(detail: String) -> Self {
        Self { stage: "local", detail }
    }
}

/// Maps a `rotate_secret` failure onto what the user may be told.
///
/// `HealthCheckFailed` is the only variant that means the secret was accepted.
/// `rotate_secret` PUTs once and then polls, so it is the only error raised
/// *after* the write; everything else is raised before it or by it.
///
/// One honest caveat, and it is why `notSent` claims no more than "nothing
/// reached Cloudflare": a PUT that dies on the wire may still have been applied
/// at the far end. That is rare, indistinguishable from here, and the retry the
/// screen offers settles it either way — `PUT …/secrets` on one name is
/// idempotent.
fn rotation_failure(error: ProvisionError, locale: Locale) -> RotateError {
    match error {
        ProvisionError::HealthCheckFailed => {
            RotateError::unconfirmed(user_err(locale, Key::ErrorRotateNotConfirmed))
        }
        // Refused before the PUT, by the same #257 guard the update path uses.
        ProvisionError::NotAWorkersDevAddress => {
            RotateError::not_sent(user_err(locale, Key::ErrorCustomDomain))
        }
        // The case the three-way split exists for: an expired Cloudflare sign-in
        // must read as "nothing happened", not as a hedge.
        ProvisionError::Api(CfApiError::Unauthorized) => {
            RotateError::not_sent(user_err(locale, Key::ErrorCfSignInExpired))
        }
        _ => RotateError::not_sent(user_err(locale, Key::ErrorFriendlyRetry)),
    }
}

/// The address a rotation should act on, and the password this computer already
/// holds for it — `None` when it holds none.
///
/// `address` is Door B: the user has lost their password, so there may be nothing
/// in secure storage to resolve and the address comes from Cloudflare discovery
/// instead. There is then no current password, which is precisely why every check
/// that needs one is skipped for that door rather than failed.
///
/// Absent, this is Door A on a computer that is already connected, and the
/// address is resolved the way every other settings command resolves it: through
/// `dashboard_credentials`, never `secure_store::load_setup()` directly, because
/// that ignores dry-run and raises a Keychain prompt (#252).
fn rotation_target(
    app: &AppHandle,
    address: Option<String>,
) -> Result<(String, Option<String>, Locale), String> {
    let locale = locale_of(app);
    match address {
        Some(address) => Ok((normalize_worker_url(&address, locale)?, None, locale)),
        None => {
            let (url, token, locale) = settings_target(app)?;
            Ok((url, Some(token), locale))
        }
    }
}

/// Every Vectorize index name a brain built by this app could legitimately be
/// bound to.
///
/// The shipped name, plus the one an embedding migration would have moved it to
/// for each reading this build knows about (#248 names indexes by dimension
/// count). Without the migrated names a user who has changed how their brain
/// reads would be told their own brain is not a brain.
fn brain_index_names() -> Vec<String> {
    let manifest = worker_bundle::manifest();
    let mut names = vec![manifest.vectorize_name.clone()];
    for choice in crate::migration::EMBEDDING_MODELS {
        let name = crate::migration::index_name_for(
            &manifest.vectorize_name,
            choice.dimensions,
            manifest.vectorize_dimensions,
        );
        if !names.contains(&name) {
            names.push(name);
        }
    }
    names
}

/// Confirms the Worker at `worker_url` really is a Second Brain, from its
/// Cloudflare bindings rather than from anything it says over HTTP.
///
/// This is the #247 rule, and rotation needs it more sharply than discovery did.
/// In lost mode the user types an address, and the Cloudflare account match
/// cannot catch a typo that lands on a *different Worker of their own* — that
/// script is in the right account, so the only thing left to check is what it is.
/// Getting it wrong would overwrite an unrelated Worker's `AUTH_TOKEN` secret
/// while telling the user their brain's password had changed: the brain stays on
/// the old password, and something they did not name has been altered.
///
/// Bindings and not a probe, for the reason `cf/discover.rs` sets out at length:
/// a Worker authors every byte of its own HTTP responses and can forge whatever
/// a probe looks for, but it cannot forge account state.
async fn confirm_target_is_a_brain(
    worker_url: &str,
    session: &SetupSession,
    locale: Locale,
) -> Result<(), String> {
    use provision::Backend;

    let script = crate::worker_url::script_of(worker_url)
        .ok_or_else(|| user_err(locale, Key::ErrorCustomDomain))?;

    let bindings = if session.dry_run {
        DryRunBackend.get_script_bindings(&script).await
    } else {
        cloudflare_client_for_brain(worker_url, session, locale)
            .await?
            .get_script_bindings(&script)
            .await
    }
    .map_err(|e| {
        // A script that does not exist answers the same way as one that cannot
        // be read. Both mean "there is no brain of yours at that address", which
        // is what the user needs to know and can act on.
        log::warn!("could not read the bindings for {script}: {e}");
        user_err(locale, Key::ErrorNotABrain)
    })?;

    brain_index_names()
        .iter()
        .any(|name| discover::bindings_look_like_a_brain(&bindings, name))
        .then_some(())
        .ok_or_else(|| user_err(locale, Key::ErrorNotABrain))
}

/// Checks an address typed in lost mode before anything is done to it.
///
/// Exists so §2.4's screen can report a bad address where it was entered instead
/// of failing several screens later, and it is the same check `rotate_password`
/// runs on an explicit address — one implementation, two callers, so the screen
/// cannot pass something the command would then refuse.
#[tauri::command]
pub async fn validate_brain_address(
    address: String,
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<(), String> {
    let locale = locale_of(&app);
    let worker_url = normalize_worker_url(&address, locale)?;
    confirm_target_is_a_brain(&worker_url, &session, locale).await
}

/// Revokes every access an AI tool was granted through `/oauth/authorize`.
///
/// Deliberately separate from rotation rather than part of it. Those tools hold
/// provider-issued tokens validated against KV, not the brain's password, so a
/// rotation genuinely does not reach them — which is right for a hygiene change
/// and wrong for a leak. Making it explicit is what lets the done screen tell the
/// truth about what a rotation did and did not close.
///
/// The Worker's `{ ok, revoked, failed }` is passed straight through: `failed` is
/// the case this control exists for, and summarising it away would hide a tool
/// that kept its access.
#[tauri::command]
pub async fn disconnect_ai_tools(app: AppHandle) -> Result<serde_json::Value, String> {
    let (worker_url, token, locale) = settings_target(&app)?;
    let resp = reqwest::Client::new()
        .post(format!("{}/oauth/revoke-all", worker_url.trim_end_matches('/')))
        .bearer_auth(&token)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| {
            log::warn!("revoke-all failed: {e}");
            user_err(locale, Key::ErrorReachBrain)
        })?;
    if !resp.status().is_success() {
        return Err(i18n::t_fmt(
            locale,
            Key::ErrorBrainHttpStatus,
            &[("status", &resp.status().as_u16().to_string())],
        ));
    }
    resp.json()
        .await
        .map_err(|_| user_err(locale, Key::ErrorBrainUnexpected))
}

/// Applies the ledger rule to a `GET /migration/status` body.
///
/// Three states, because the ledger is rewritten with `finishedAt` when a
/// rebuild completes rather than deleted:
///
/// | `state`            | meaning                       | rotation |
/// |--------------------|-------------------------------|----------|
/// | `null`             | never migrated                | allowed  |
/// | `finishedAt` set   | rebuild complete              | allowed  |
/// | `finishedAt` absent| in progress **or abandoned**  | blocked  |
///
/// The block is not about session contention — every batch re-reads the token,
/// so a rotation would technically survive one. It is about the failure mode: a
/// rotation caught half-way leaves the next batch 401ing and the ledger stalling
/// with `failed` climbing, so a recoverable password problem presents as a failed
/// rebuild. That is the more frightening of the two and the one that invites a
/// destructive "fix".
///
/// An outstanding old index is deliberately not consulted. That is the ordinary
/// post-rebuild state, users sit in it for weeks, and rotation touches no
/// Vectorize binding.
fn blocked_by_migration(status: &serde_json::Value) -> bool {
    match status.get("state") {
        None | Some(serde_json::Value::Null) => false,
        Some(state) => !state
            .get("finishedAt")
            .is_some_and(|finished| !finished.is_null()),
    }
}

/// Whether a rebuild is in flight (or was abandoned) and rotation must wait.
///
/// Door A only. Door B cannot ask — checking needs a working password, which is
/// by definition what that user does not have — and gating their only way back
/// in on a check they cannot perform would be backwards. Someone who has lost
/// their password is not driving a rebuild from that machine anyway.
#[tauri::command]
pub async fn rotation_blocked(app: AppHandle) -> Result<bool, String> {
    let (url, token, locale) = settings_target(&app)?;
    let status = crate::migration::fetch_status(&url, &token, locale).await?;
    Ok(blocked_by_migration(&status))
}

/// Read-only re-probe of `/health` with a password, for the "it may already be
/// live" screen.
///
/// Writes nothing, which is what makes it safe to offer as a button on the one
/// screen where the user does not know what happened. A wrong password is a
/// `false`, not an error: on that screen "no" is an answer, not a fault.
#[tauri::command]
pub async fn recheck_password(
    password: String,
    address: Option<String>,
    app: AppHandle,
) -> Result<bool, String> {
    let (worker_url, _, locale) = rotation_target(&app, address)?;
    match crate::cf::api::worker_health_ok(&worker_url, password.trim()).await {
        Ok(ok) => Ok(ok),
        Err(CfApiError::Unauthorized) => Ok(false),
        Err(e) => {
            log::warn!("password re-check could not reach the brain: {e}");
            Err(user_err(locale, Key::ErrorReachBrain))
        }
    }
}

/// Puts the main window into change-your-password mode and shows it. Door A,
/// from the Connection pane — the same shape as `begin_worker_update`.
#[tauri::command]
pub fn begin_password_change(
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<(), String> {
    *session.pending_rotation.lock().unwrap() = true;
    windows::open_setup_window(&app)
        .map_err(|_| user_err(locale_of(&app), Key::ErrorOpenWindowFailed))
}

/// Replaces the brain's password, then writes the new one everywhere this
/// computer keeps it.
///
/// The order is not negotiable. The remote change goes first and is confirmed
/// against the *new* password before anything local is touched, so a failure
/// before that point leaves this computer able to open its own brain. Reversing
/// it would produce the one outcome with no recovery inside the app: local
/// stores holding a password the brain never accepted.
#[tauri::command]
pub async fn rotate_password(
    new_password: String,
    address: Option<String>,
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<RotateOutcome, RotateError> {
    let locale = locale_of(&app);
    let new_password = new_password.trim().to_string();
    if new_password.len() < MIN_PASSWORD_LEN {
        return Err(RotateError::not_sent(i18n::t_fmt(
            locale,
            Key::ErrorPasswordTooShort,
            &[("min", &MIN_PASSWORD_LEN.to_string())],
        )));
    }

    let progress_app = app.clone();
    let progress = move |event: provision::StepEvent| {
        let _ = progress_app.emit("setup-progress", &event);
    };

    if session.dry_run {
        return rotate_demo_password(&new_password, &session, locale, progress).await;
    }

    // 1. Which brain. Through the session-aware helper, never the keychain
    //    directly — see `rotation_target`.
    let door_b = address.is_some();
    let (worker_url, current_password, locale) =
        rotation_target(&app, address).map_err(RotateError::not_sent)?;

    // 1a. On Door B the address was typed or picked rather than read back from
    //     this computer's own store, so confirm it is a brain before writing a
    //     secret to it. Door A's address came from secure storage, which this app
    //     wrote itself after a successful connection.
    if door_b {
        confirm_target_is_a_brain(&worker_url, &session, locale)
            .await
            .map_err(RotateError::not_sent)?;
    }

    // 2. Refuse defensively if a rebuild is under way. The Connection pane
    //    already hides the door, but the flow can be open across the moment a
    //    rebuild starts on another machine.
    //
    //    Only a check that *succeeds* and says "blocked" refuses. Door B has no
    //    password to ask with, and a check that cannot be made is not a block: a
    //    user who has lost their password must not be turned away by a question
    //    they are unable to answer. A network blip must not either.
    if let Some(password) = &current_password {
        if let Ok(status) = crate::migration::fetch_status(&worker_url, password, locale).await {
            if blocked_by_migration(&status) {
                return Err(RotateError::not_sent(user_err(
                    locale,
                    Key::ErrorRotateBlocked,
                )));
            }
        }
    }

    // 3. The Cloudflare account that holds this brain, matched by the subdomain
    //    in its address rather than assumed.
    let client = cloudflare_client_for_brain(&worker_url, &session, locale)
        .await
        .map_err(RotateError::not_sent)?;

    // 4. The remote change, health-gated against the new password.
    provision::rotate_secret(
        &LiveBackend { client },
        &worker_url,
        &new_password,
        progress,
    )
    .await
    .map_err(|e| {
        log::warn!("password rotation failed: {e}");
        rotation_failure(e, locale)
    })?;

    // 5. Only now is it safe to write anything locally.
    //
    // Without a home directory there is nowhere for `persist` to look, so it
    // cannot run at all and there is no outcome to report — which is what the
    // `"local"` stage is for. `ErrorRotateSecureStore` reads correctly here: the
    // password was changed and nothing on this computer was told, which is what
    // the user needs to act on. Deliberately not `ErrorSecureStoreConnect`, which
    // opens "Connected, but…" — nothing was connected, a working password was
    // replaced.
    let home = dirs::home_dir()
        .ok_or_else(|| RotateError::local(user_err(locale, Key::ErrorRotateSecureStore)))?;
    let refresh_app = app.clone();
    let refresh_url = worker_url.clone();
    let outcome = rotate::persist(&home, &worker_url, &new_password, move |token| {
        windows::refresh_wrapper_token(&refresh_app, &refresh_url, token)
    });

    *session.pending_rotation.lock().unwrap() = false;
    // A rotation is also the answer to "your password was changed elsewhere".
    *session.stale_password.lock().unwrap() = false;

    // Reported, not raised. The rotation itself succeeded — the brain is on the
    // new password — so turning a failed local write into an `Err` would throw
    // away the outcome that tells the screen *which* store to name, and would
    // describe a change that did happen as one that did not. The `"local"` stage
    // is for a local step that produced no outcome at all (above), and the front
    // end renders the same screen from either arrival.
    Ok(outcome)
}

/// The demo half of [`rotate_password`], split out so it can be driven by a test.
///
/// A Tauri `State`/`AppHandle` cannot be constructed in a unit test, and the
/// property that matters most here — that a demo rotation reaches the keychain
/// exactly zero times — is only observable by calling the thing that does the
/// work. `previous_index_for` is split for the same reason.
///
/// This runs the real pipeline: `rotate_secret` against `DryRunBackend`, whose
/// `put_secret` moves the demo brain onto the new password and whose `health_ok`
/// then has to get a real 200 back from it. What it must never do is write to
/// secure storage — demo state lives in the session and in the demo brain, per
/// the `demo_previous_index` precedent.
async fn rotate_demo_password(
    new_password: &str,
    session: &SetupSession,
    locale: Locale,
    progress: impl Fn(provision::StepEvent),
) -> Result<RotateOutcome, RotateError> {
    // Resolved the same way every other demo screen resolves it, so this path
    // shares the no-keychain guarantee rather than restating it.
    let (_demo_url, _demo_token) =
        dashboard_credentials(session, locale).map_err(RotateError::not_sent)?;

    // The address handed to `rotate_secret` is the `.demo.workers.dev` stand-in,
    // not the loopback address above. `rotate_secret` derives the Worker's script
    // name from the address it is given (#257) and loopback has no script label,
    // so it would refuse a demo rotation before doing anything.
    // `DryRunBackend::health_ok` resolves the stand-in back to the brain on
    // loopback, so the gate is still a real request against a real server.
    let worker_url = "https://second-brain.demo.workers.dev";

    provision::rotate_secret(&DryRunBackend, worker_url, new_password, progress)
        .await
        .map_err(|e| {
            log::warn!("demo password rotation failed: {e}");
            rotation_failure(e, locale)
        })?;

    *session.pending_rotation.lock().unwrap() = false;
    *session.stale_password.lock().unwrap() = false;

    // No `rotate::persist`. Its first act is `secure_store::save_setup`, and a
    // demo run must not write a demo password into the user's real keychain —
    // nor a plaintext demo credential into their real CLI config. The demo brain
    // is now answering to the new password, and `dashboard_credentials` asks it
    // rather than remembering, so demo mode is genuinely on the new password
    // from here without anything having been stored.
    Ok(RotateOutcome {
        keychain: true,
        cli_config: None,
        dashboard: true,
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
    // The shipped dimension count is the fallback for a brain running a reading
    // this build does not list.
    let manifest = worker_bundle::manifest();
    crate::migration::fetch_estimate(&url, &token, manifest.vectorize_dimensions, locale).await
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
        // anything. The `.demo.workers.dev` stand-in exercises the same code path,
        // and `DryRunBackend::health_ok` resolves it back to the brain on
        // loopback, so the health poll is a real request against a real server
        // while the deploy stays a no-op.
        provision::update_worker(
            &DryRunBackend,
            manifest,
            "https://second-brain.demo.workers.dev",
            // The live password, for the same reason as `start_worker_update`'s
            // dry-run branch: the health poll is authenticated, and a demo
            // rotation has already moved this.
            &auth_token,
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
    use super::{
        blocked_by_migration, cloudflare_client_for_brain, dashboard_credentials,
        normalize_worker_url, previous_index_for, rotate_demo_password, rotation_failure,
        RotateError, SetupSession,
    };
    use crate::cf::oauth::Tokens;
    use crate::cf::provision::{ProvisionError, ProvisionOutcome};
    use crate::cf::types::{Account, CfApiError};
    use crate::i18n::{self, Key, Locale};

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

    // ── Changing the password (#235) ─────────────────────────────────────────

    /// The three failure shapes are three different things to tell the user, and
    /// the copy on each screen is only true for one of them.
    ///
    /// "notSent" says the old password still works. "unconfirmed" must never say
    /// that: the secret was accepted and only the confirmation timed out, so the
    /// new password may already be the only one that opens the brain. Collapsing
    /// them means every failure has to hedge — and a user whose Cloudflare
    /// sign-in merely expired is told their password may have changed, which
    /// teaches people to ignore that warning on the one occasion it is real.
    #[test]
    fn each_failure_shape_selects_the_screen_that_can_tell_the_truth() {
        assert_eq!(
            rotation_failure(ProvisionError::HealthCheckFailed, Locale::En).stage,
            "unconfirmed",
            "the only error raised after the secret was accepted"
        );
        assert_eq!(
            rotation_failure(
                ProvisionError::Api(CfApiError::Unauthorized),
                Locale::En
            )
            .stage,
            "notSent",
            "an expired Cloudflare sign-in never reached the brain"
        );
        assert_eq!(
            rotation_failure(ProvisionError::NotAWorkersDevAddress, Locale::En).stage,
            "notSent",
            "refused by the #257 guard before the write"
        );
        assert_eq!(
            rotation_failure(ProvisionError::CaptureFailed, Locale::En).stage,
            "notSent",
        );
        assert_eq!(RotateError::local(String::new()).stage, "local");

        // Distinct strings, checked as a set: two stages that happen to be spelled
        // the same select the same screen no matter how carefully the match arms
        // above are written.
        let stages = [
            RotateError::not_sent(String::new()).stage,
            RotateError::unconfirmed(String::new()).stage,
            RotateError::local(String::new()).stage,
        ];
        let mut unique = stages.to_vec();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), 3, "two stages collapsed into one: {stages:?}");
    }

    /// The detail is what the front end drops into "What went wrong: …", so it
    /// has to be localised rather than a Rust error's `Display`.
    #[test]
    fn the_failure_detail_is_localised_and_not_a_rust_error_string() {
        let english = rotation_failure(
            ProvisionError::Api(CfApiError::Unauthorized),
            Locale::En,
        );
        assert_eq!(english.detail, i18n::t(Locale::En, Key::ErrorCfSignInExpired));

        let italian = rotation_failure(
            ProvisionError::Api(CfApiError::Unauthorized),
            Locale::It,
        );
        assert_ne!(
            italian.detail, english.detail,
            "the detail must follow the app's locale"
        );
        assert!(
            !rotation_failure(ProvisionError::HealthCheckFailed, Locale::En)
                .detail
                .is_empty(),
            "an empty detail renders as an empty sentence on the screen"
        );
    }

    /// The ledger has three states, not two: a finished rebuild leaves its record
    /// behind with `finishedAt` set rather than deleting it.
    #[test]
    fn rotation_waits_only_while_a_rebuild_is_actually_outstanding() {
        let never = serde_json::json!({ "ok": true, "state": null });
        let finished = serde_json::json!({
            "ok": true,
            "state": { "model": "m", "processed": 10, "finishedAt": 1_753_000_000_000i64 }
        });
        let running = serde_json::json!({
            "ok": true,
            "state": { "model": "m", "processed": 3, "totalAtStart": 100 }
        });

        assert!(!blocked_by_migration(&never), "a brain that never migrated");
        assert!(!blocked_by_migration(&finished), "a rebuild that completed");
        assert!(
            blocked_by_migration(&running),
            "in progress, or abandoned — both block, and Advanced Settings is the \
             escape the message points at"
        );

        // A ledger with the key present but null is not a finished one. Reading
        // `is_some()` alone would let a half-written record unblock rotation.
        let null_finish = serde_json::json!({ "state": { "finishedAt": null } });
        assert!(blocked_by_migration(&null_finish));

        // And a body with no `state` key at all — an older Worker — is not a
        // reason to refuse.
        assert!(!blocked_by_migration(&serde_json::json!({ "ok": true })));
    }

    /// An outstanding old index is the ordinary post-rebuild state. Users sit in
    /// it for weeks, rotation touches no Vectorize binding, and treating it as a
    /// block would make the password unchangeable until they freed an index they
    /// were told they could keep.
    ///
    /// Asserted on the source rather than by planting a note: the note lives in
    /// process-global test state that other tests clear, so a behavioural version
    /// of this would be racing them. What is checkable is that neither function
    /// can consult it. Scans only the function bodies, so this test's own text
    /// cannot satisfy it.
    #[test]
    fn an_outstanding_old_index_is_not_a_reason_to_block_rotation() {
        let src = include_str!("commands.rs");
        for name in ["fn blocked_by_migration", "pub async fn rotation_blocked"] {
            let start = src.find(name).unwrap_or_else(|| panic!("{name} exists"));
            let body = &src[start..];
            let body = &body[..body.find("\n}").expect("end of fn")];
            assert!(
                !body.contains("previous_index"),
                "{name} consults the outstanding-index note. That note means a \
                 rebuild finished and the old index has not been freed — which is \
                 a state users stay in deliberately, and rotation does not care."
            );
        }
    }

    /// Every in-memory mode is decided before secure storage is consulted.
    ///
    /// `get_app_state` takes a Tauri `State`, which cannot be built in a unit
    /// test, so this reads the source — but the rule it protects is not a style
    /// preference. `&&`/`else if` are short-circuiting, and each of these
    /// branches returns without falling through, so a mode moved below the
    /// `load_setup()` branch performs a keychain read on the way past. That read
    /// raises an OS password prompt on an unsigned dev build, before the setup
    /// UI's first paint, which is #252 — and demo mode, which must never see one,
    /// reaches this function on every launch.
    ///
    /// Scans only the function body, so the names written in this test cannot
    /// satisfy it.
    #[test]
    fn every_in_memory_mode_is_decided_before_the_keychain_is_touched() {
        let src = include_str!("commands.rs");
        let start = src.find("pub fn get_app_state").expect("the command");
        let body = &src[start..];
        let body = &body[..body.find("\n}").expect("end of fn")];

        let keychain = body
            .find("secure_store::load_setup")
            .expect("get_app_state still reads the keychain somewhere");
        for flag in ["pending_rotation", "stale_password", "pending_worker_update"] {
            let at = body
                .find(flag)
                .unwrap_or_else(|| panic!("{flag} is not consulted at all"));
            assert!(
                at < keychain,
                "{flag} is checked after the keychain read, so reaching that mode \
                 costs an OS password prompt — and in demo mode there is nothing \
                 in the keychain to have prompted for"
            );
        }
    }

    /// A demo rotation runs the real pipeline and reaches the keychain zero times.
    ///
    /// Counted rather than grepped, for the reason `demo_mode_never_reads_the_keychain`
    /// sets out: every read can raise an OS password prompt on an unsigned dev
    /// build, a source scan cannot express "not inside the dry-run branch", and a
    /// guard written that way passed while the bug was reintroduced.
    ///
    /// The password is [`DEFAULT_TOKEN`] on purpose. The demo brain is
    /// process-wide and outlives this test, so rotating it to anything else would
    /// start 401ing whatever else in the suite is mid-request against it — the
    /// reasoning `demo_brain`'s own rotation test sets out. Rotating it to the
    /// token every other caller already sends changes nothing for them while
    /// still driving the whole path: the secret write is recorded, the demo brain
    /// takes the password, and `rotate_secret`'s health gate has to get a real
    /// 200 back from it before this returns.
    #[tokio::test]
    async fn a_demo_rotation_runs_the_real_path_and_never_reads_the_keychain() {
        let session = SetupSession::new(true);
        *session.pending_rotation.lock().unwrap() = true;

        // Sampled rather than counted once. The read probe is a process-global
        // counter and the suite runs in parallel, so a single sample can pick up
        // another test's keychain access and report it against this path. A
        // sample that caught someone else proves nothing either way — but a path
        // that reads the keychain contaminates *every* sample, so one clean
        // sample is the proof and repeated dirty ones are the failure.
        let mut outcome = None;
        let mut dirty = Vec::new();
        for _ in 0..8 {
            let before = crate::secure_store::probe::reads();
            let attempt = rotate_demo_password(
                crate::demo_brain::DEFAULT_TOKEN,
                &session,
                Locale::En,
                |_| {},
            )
            .await
            .expect("the demo brain must accept the password the demo just set");
            let reads = crate::secure_store::probe::reads() - before;
            if reads == 0 {
                outcome = Some(attempt);
                break;
            }
            dirty.push(reads);
        }
        let outcome = outcome.unwrap_or_else(|| {
            panic!(
                "every sample of a demo rotation touched the keychain ({dirty:?}) — \
                 that is the OS password prompt users see, and a demo password has \
                 no business in a real keychain"
            )
        });

        assert!(
            crate::cf::backend::probe::secret_puts()
                .contains(&("second-brain".to_string(), "AUTH_TOKEN".to_string())),
            "the rotation never reached the backend, so the demo proves nothing \
             about the thing it is demonstrating"
        );
        assert_eq!(
            crate::demo_brain::auth_token(),
            crate::demo_brain::DEFAULT_TOKEN,
            "the demo brain must be holding the password the rotation set"
        );
        assert!(outcome.keychain);
        assert_eq!(
            outcome.cli_config, None,
            "a demo run must not write a plaintext credential file"
        );
        assert!(
            !*session.pending_rotation.lock().unwrap(),
            "a finished rotation must leave the flow"
        );
    }

    /// Resolving which Cloudflare account holds a brain was written out twice —
    /// once in `start_worker_update` and once in `cloudflare_client_for_brain`.
    /// Rotation is the third caller, so the copy went. This pins the errors the
    /// shared helper raises and the order it raises them in, which is what
    /// `start_worker_update` used to do inline.
    ///
    /// Every case here returns before any network call: a custom domain and a
    /// missing sign-in are refused up front, and an empty account list never
    /// enters the loop.
    #[tokio::test]
    async fn the_shared_account_lookup_refuses_in_the_same_order_the_inline_copy_did() {
        let session = SetupSession::new(false);

        assert_eq!(
            cloudflare_client_for_brain("https://brain.example.com", &session, Locale::En)
                .await
                .map(|_| ())
                .unwrap_err(),
            i18n::t(Locale::En, Key::ErrorCustomDomain),
            "a custom domain yields no subdomain to match, and retrying cannot help"
        );

        assert_eq!(
            cloudflare_client_for_brain(
                "https://second-brain.acme.workers.dev",
                &session,
                Locale::En
            )
            .await
            .map(|_| ())
            .unwrap_err(),
            i18n::t(Locale::En, Key::ErrorCfSignInFirst),
            "no Cloudflare session yet"
        );

        *session.tokens.lock().unwrap() = Some(Tokens {
            access_token: "cf-access-token".into(),
            refresh_token: None,
            expires_at: std::time::Instant::now() + std::time::Duration::from_secs(3600),
        });
        session.accounts.lock().unwrap().push(Account {
            id: "acct-1".into(),
            name: "Some other space".into(),
        });
        // The account list is scanned, nothing matches `acme`, and the message
        // names the real problem rather than a generic failure.
        //
        // Left un-run against the network deliberately: with one account this
        // would make a live request, so the assertion below is the empty-list
        // case, which is the same branch.
        session.accounts.lock().unwrap().clear();
        assert_eq!(
            cloudflare_client_for_brain(
                "https://second-brain.acme.workers.dev",
                &session,
                Locale::En
            )
            .await
            .map(|_| ())
            .unwrap_err(),
            i18n::t(Locale::En, Key::ErrorWrongCfAccount),
        );
    }

    /// …and that `start_worker_update` actually calls it. The behavioural test
    /// above pins the helper; this pins that the inline copy is gone, because a
    /// second copy left behind would keep passing every test while quietly
    /// drifting.
    #[test]
    fn the_worker_update_resolves_its_account_through_the_shared_helper() {
        let src = include_str!("commands.rs");
        let start = src.find("pub async fn start_worker_update").expect("the command");
        let body = &src[start..];
        let body = &body[..body.find("\n}\n").expect("end of fn")];

        assert!(
            body.contains("cloudflare_client_for_brain"),
            "start_worker_update must resolve its account through the shared helper"
        );
        assert!(
            !body.contains("get_account_subdomain"),
            "start_worker_update still enumerates accounts itself — that is the \
             copy rotation was meant to remove"
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
