//! App self-update, driven entirely from Rust so it works in every window
//! (including the remote wrapper window, which has no IPC). Checks GitHub
//! Releases for a newer signed build, asks the user with a native dialog, then
//! downloads, verifies (minisign), installs, and relaunches.

use crate::i18n::{self, AppLocale, Key};
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

/// Entry point. `silent` = true for the on-launch check (say nothing unless an
/// update exists); false for the menu item (also confirm "up to date" / errors).
pub fn check_for_updates(app: &AppHandle, silent: bool) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let locale = app
            .try_state::<AppLocale>()
            .map(|l| l.get())
            .unwrap_or(i18n::Locale::En);
        match run_check(&app).await {
            Ok(Some(update)) => prompt_and_install(&app, update, locale).await,
            Ok(None) => {
                if !silent {
                    info_dialog(
                        &app,
                        i18n::t(locale, Key::AppUpdateUpToDateTitle),
                        i18n::t(locale, Key::AppUpdateUpToDateMessage),
                    );
                }
            }
            Err(e) => {
                log::warn!("update check failed: {e}");
                if !silent {
                    info_dialog(
                        &app,
                        i18n::t(locale, Key::AppUpdateCheckFailedTitle),
                        i18n::t(locale, Key::AppUpdateCheckFailedMessage),
                    );
                }
            }
        }
    });
}

async fn run_check(app: &AppHandle) -> Result<Option<tauri_plugin_updater::Update>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    updater.check().await.map_err(|e| e.to_string())
}

async fn prompt_and_install(
    app: &AppHandle,
    update: tauri_plugin_updater::Update,
    locale: i18n::Locale,
) {
    let version = update.version.clone();
    let notes = update
        .body
        .clone()
        .filter(|b| !b.trim().is_empty())
        .map(|b| format!("{}{}", i18n::t(locale, Key::AppUpdateWhatsNew), b.trim()))
        .unwrap_or_default();
    let message = format!(
        "{}{notes}",
        i18n::t_fmt(locale, Key::AppUpdateAvailableMessage, &[("version", &version)])
    );

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(message)
        .title(i18n::t(locale, Key::AppUpdateAvailableTitle))
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            i18n::t(locale, Key::AppUpdateNow).to_string(),
            i18n::t(locale, Key::AppUpdateLater).to_string(),
        ))
        .show(move |accepted| {
            let _ = tx.send(accepted);
        });

    if rx.await.unwrap_or(false) {
        match update.download_and_install(|_downloaded, _total| {}, || {}).await {
            Ok(()) => app.restart(),
            Err(e) => {
                log::error!("update install failed: {e}");
                info_dialog(
                    app,
                    i18n::t(locale, Key::AppUpdateFailedTitle),
                    i18n::t(locale, Key::AppUpdateFailedMessage),
                );
            }
        }
    }
}

fn info_dialog(app: &AppHandle, title: &str, message: &str) {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Info)
        .blocking_show();
}
