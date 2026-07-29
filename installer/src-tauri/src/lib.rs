//! Second Brain desktop app.
//!
//! Two modes of one app:
//!   * first run  → the setup flow (webview UI in src/, provisioning in Rust)
//!   * afterwards → a native shell around the user's own Worker dashboard
//! Mode is decided by whether OS-secure storage holds a completed setup.

mod app_menus;
mod app_update;
mod cf;
mod cli_config;
mod commands;
mod credits;
mod i18n;
mod mcp_config;
mod password_check;
mod secure_store;
mod version;
mod windows;
mod worker_bundle;

use app_menus::{build_menu_items, build_tray_items, install_app_menu, install_tray, AppMenus};
use commands::SetupSession;
use i18n::{AppLocale, Key};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// Opens the user's dashboard from a menu action (no `State` handle). Falls
/// back to setup when this computer isn't connected yet.
fn open_dashboard_from_menu(app: &AppHandle) {
    let session = app.state::<SetupSession>();
    match commands::open_dashboard_impl(app, &session) {
        Ok(()) => {}
        Err(message) => {
            let locale = app
                .try_state::<AppLocale>()
                .map(|l| l.get())
                .unwrap_or(i18n::Locale::En);
            if secure_store::load_setup().is_none() && !session.dry_run {
                let _ = windows::open_setup_window(app);
            } else {
                app.dialog()
                    .message(message)
                    .title(i18n::t(locale, Key::OpenDashboardFailed))
                    .kind(MessageDialogKind::Warning)
                    .show(|_| {});
            }
        }
    }
}

/// Menu-bar "Sync Notion now": runs the sync in the background and reports the
/// outcome with a native dialog. Silent no-op target when not set up.
fn sync_notion_from_menu(app: &AppHandle) {
    let Some(info) = secure_store::load_setup() else {
        let _ = windows::open_setup_window(app);
        return;
    };
    let locale = app
        .try_state::<AppLocale>()
        .map(|l| l.get())
        .unwrap_or(i18n::Locale::En);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let message = match commands::notion_sync(&info.worker_url, &info.auth_token, locale).await
        {
            Ok(msg) => msg,
            Err(e) => e,
        };
        app.dialog()
            .message(message)
            .title(i18n::t(locale, Key::NotionSyncTitle))
            .kind(MessageDialogKind::Info)
            .show(|_| {});
    });
}

/// Menu-bar Logout: confirm natively, then clear this computer's connection.
/// (The details window has its own inline confirm and calls the command.)
fn confirm_logout(app: &AppHandle) {
    if secure_store::load_setup().is_none() {
        // Nothing to log out of — just make sure setup is visible.
        let _ = windows::open_setup_window(app);
        return;
    }
    let locale = app
        .try_state::<AppLocale>()
        .map(|l| l.get())
        .unwrap_or(i18n::Locale::En);
    let handle = app.clone();
    app.dialog()
        .message(i18n::t(locale, Key::LogoutMessage))
        .title(i18n::t(locale, Key::LogoutTitle))
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            i18n::t(locale, Key::LogoutConfirm).to_string(),
            i18n::t(locale, Key::Cancel).to_string(),
        ))
        .show(move |confirmed| {
            if confirmed {
                commands::perform_logout(&handle);
            }
        });
}

pub fn run() {
    // Errors from provisioning etc. print to stderr (visible under `tauri dev`
    // or when launched from a terminal). Override with RUST_LOG.
    let _ = env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info,second_brain_desktop_lib=debug"),
    )
    .try_init();

    let dry_run = std::env::var("SECOND_BRAIN_DRY_RUN").is_ok();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            for label in ["brain", "main", "details"] {
                if let Some(w) = app.get_webview_window(label) {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                    return;
                }
            }
        }))
        // The details panel always opens at its designed size. Restoring a saved
        // geometry meant a window sized before a layout change stayed wrong forever.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .skip_initial_state("details")
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(SetupSession::new(dry_run))
        .invoke_handler(tauri::generate_handler![
            commands::get_app_state,
            commands::check_password,
            commands::generate_password,
            commands::submit_password,
            commands::connect_cloudflare,
            commands::connect_existing,
            commands::start_provisioning,
            commands::get_connection_details,
            commands::detect_tools,
            commands::connect_tool,
            commands::detect_cli,
            commands::connect_cli,
            commands::install_cli,
            commands::detect_obsidian,
            commands::integration_status,
            commands::sync_notion,
            commands::open_dashboard_integrations,
            commands::copy_text,
            commands::open_external,
            commands::open_dashboard,
            commands::open_details_window,
            commands::logout,
            commands::set_locale,
            commands::worker_update_available,
            commands::begin_worker_update,
            commands::start_worker_update,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let config_dir = app.path().app_config_dir().ok();
            let locale = i18n::resolve_initial_locale(config_dir.as_deref());
            app.manage(AppLocale::new(locale));

            let (
                menu_open,
                menu_hub,
                menu_sync,
                menu_update,
                menu_logout,
                connections,
            ) = build_menu_items(&handle, locale)?;
            install_app_menu(&handle, &connections)?;
            app.on_menu_event(|app, event| match event.id().as_ref() {
                "menu-open" => open_dashboard_from_menu(app),
                "menu-hub" => windows::open_details_window(app),
                "menu-sync-notion" => sync_notion_from_menu(app),
                "menu-update" => app_update::check_for_updates(app, false),
                "menu-logout" => confirm_logout(app),
                _ => {}
            });

            let (
                tray_open,
                tray_hub,
                tray_sync,
                tray_update,
                tray_logout,
                tray_quit,
                tray_menu,
            ) = build_tray_items(&handle, locale)?;
            install_tray(&handle, &tray_menu, |app, event| match event.id().as_ref() {
                "tray-open" => open_dashboard_from_menu(app),
                "tray-hub" => windows::open_details_window(app),
                "tray-sync-notion" => sync_notion_from_menu(app),
                "tray-update" => app_update::check_for_updates(app, false),
                "tray-logout" => confirm_logout(app),
                "tray-quit" => app.exit(0),
                _ => {}
            })?;

            app.manage(AppMenus {
                menu_open,
                menu_hub,
                menu_sync,
                menu_update,
                menu_logout,
                connections_submenu: connections,
                tray_open,
                tray_hub,
                tray_sync,
                tray_update,
                tray_logout,
                tray_quit,
            });

            // Mode selection. Dry-run always shows setup so the flow can be
            // demoed even on a machine that already has a Second Brain.
            match secure_store::load_setup() {
                Some(info) if !dry_run => {
                    windows::open_wrapper_window(&handle, &info.worker_url, &info.auth_token)?;
                    // In wrapper mode, quietly check whether the deployed Worker
                    // is behind what this app bundles and offer to update it.
                    commands::maybe_offer_worker_update(&handle);
                }
                _ => windows::open_setup_window(&handle)?,
            }

            // Quiet check for an app update on launch (says nothing unless one
            // exists). Skipped in dry-run so demos don't hit the network.
            if !dry_run {
                app_update::check_for_updates(&handle, true);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
