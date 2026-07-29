//! Window construction for the app's three windows:
//!   main    — the bundled setup flow (first run only)
//!   brain   — the user's remote dashboard, wrapped (every run after setup)
//!   details — the local "Connection details" panel
//!
//! The `brain` window is remote content: it gets NO Tauri IPC (it isn't listed
//! in any capability). The only things injected are the dashboard's own
//! localStorage auth keys, guarded so they're set solely on the user's own
//! Worker origin, and the Connections sidebar button below.

use crate::i18n::{self, Key, Locale};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Clicking the injected Connections button navigates here. The navigation is
/// cancelled in `on_navigation` and turned into a native window instead, so the
/// remote page still needs no IPC to reach it. The path is one the dashboard
/// does not route, so nothing is lost if the interception ever fails.
const CONNECTIONS_PATH: &str = "/__sb-connections";

/// Same navigation-sentinel trick for the settings panel. The dashboard has no
/// settings UI by design (#244) — the desktop app is the only writer of config —
/// so this button is injected here rather than shipped in the dashboard.
const SETTINGS_PATH: &str = "/__sb-settings";

/// Adds a "Connections" entry to the dashboard's own sidebar footer, next to
/// Settings, reusing the dashboard's `sb-footer-btn` class so it inherits the
/// real styling rather than floating over the page. Injected rather than shipped
/// in the dashboard so it appears regardless of which Worker version the user
/// has deployed. Polls because the init script runs at document-start, and is
/// idempotent so a re-render cannot produce two buttons.
const CONNECTIONS_BUTTON_JS: &str = r#"(function () {
  var ID = 'sb-desktop-connections';
  var LABEL = __LABEL__;
  var TITLE = __TITLE__;
  var tries = 0;
  var iv = setInterval(function () {
    if (document.getElementById(ID)) { clearInterval(iv); return; }
    var footer = document.querySelector('.sb-footer');
    if (footer) {
      var b = document.createElement('button');
      b.id = ID;
      b.className = 'sb-footer-btn';
      b.title = TITLE;
      b.innerHTML = '<i class="ti ti-plug"></i><span>' + LABEL + '</span>';
      b.addEventListener('click', function () { location.assign('__CONNECTIONS_PATH__'); });
      footer.appendChild(b);
      clearInterval(iv);
    } else if (++tries > 60) {
      clearInterval(iv);
    }
  }, 100);
})();"#;

/// Second injected footer button, for the settings panel. Kept as its own
/// script rather than parameterising the Connections one: the ids, labels and
/// target paths differ, and one script doing both would need every value
/// twice anyway.
const SETTINGS_BUTTON_JS: &str = r#"(function () {
  var ID = 'sb-desktop-settings';
  var LABEL = __LABEL__;
  var TITLE = __TITLE__;
  var tries = 0;
  var iv = setInterval(function () {
    if (document.getElementById(ID)) { clearInterval(iv); return; }
    var footer = document.querySelector('.sb-footer');
    if (footer) {
      var b = document.createElement('button');
      b.id = ID;
      b.className = 'sb-footer-btn';
      b.title = TITLE;
      b.innerHTML = '<i class="ti ti-sliders"></i><span>' + LABEL + '</span>';
      b.addEventListener('click', function () { location.assign('__SETTINGS_PATH__'); });
      footer.appendChild(b);
      clearInterval(iv);
    } else if (++tries > 60) {
      clearInterval(iv);
    }
  }, 100);
})();"#;

fn settings_button_js(locale: Locale) -> String {
    let label = serde_json::to_string(i18n::t(locale, Key::SettingsButtonLabel)).expect("string");
    let title = serde_json::to_string(i18n::t(locale, Key::SettingsButtonTooltip)).expect("string");
    SETTINGS_BUTTON_JS
        .replace("__LABEL__", &label)
        .replace("__TITLE__", &title)
        .replace("__SETTINGS_PATH__", SETTINGS_PATH)
}

fn connections_button_js(locale: Locale) -> String {
    let label = serde_json::to_string(i18n::t(locale, Key::ConnectionsButtonLabel)).expect("string");
    let title = serde_json::to_string(i18n::t(locale, Key::ConnectionsButtonTooltip)).expect("string");
    CONNECTIONS_BUTTON_JS
        .replace("__LABEL__", &label)
        .replace("__TITLE__", &title)
        .replace("__CONNECTIONS_PATH__", CONNECTIONS_PATH)
}

pub fn open_setup_window(app: &AppHandle) -> tauri::Result<()> {
    let locale = app
        .try_state::<crate::i18n::AppLocale>()
        .map(|l| l.get())
        .unwrap_or(Locale::En);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title(i18n::t(locale, Key::WindowSecondBrain))
        .inner_size(940.0, 700.0)
        .min_inner_size(760.0, 560.0)
        .build()?;
    Ok(())
}

pub fn open_wrapper_window(
    app: &AppHandle,
    worker_url: &str,
    auth_token: &str,
) -> tauri::Result<()> {
    open_wrapper_window_impl(app, worker_url, auth_token, false)
}

/// Same wrapper, but once the dashboard has loaded it opens the Integrations
/// panel — used by the "Set up Notion" / "Manage" deep-links.
pub fn open_wrapper_window_integrations(
    app: &AppHandle,
    worker_url: &str,
    auth_token: &str,
) -> tauri::Result<()> {
    open_wrapper_window_impl(app, worker_url, auth_token, true)
}

/// Calls the dashboard's own `openIntegrations()` once it exists. The wrapper's
/// init script runs at document-start, so it polls until the page defines the
/// function rather than assuming it's ready.
const OPEN_INTEGRATIONS_JS: &str = r#"(function () {
  var tries = 0;
  var iv = setInterval(function () {
    if (typeof openIntegrations === 'function') {
      try { openIntegrations(); } catch (_) {}
      clearInterval(iv);
    } else if (++tries > 60) {
      clearInterval(iv);
    }
  }, 100);
})();"#;

fn open_wrapper_window_impl(
    app: &AppHandle,
    worker_url: &str,
    auth_token: &str,
    open_integrations: bool,
) -> tauri::Result<()> {
    let locale = app
        .try_state::<crate::i18n::AppLocale>()
        .map(|l| l.get())
        .unwrap_or(Locale::En);
    if let Some(w) = app.get_webview_window("brain") {
        if open_integrations {
            let _ = w.eval("try { openIntegrations() } catch (_) {}");
        }
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }
    let origin = worker_url.trim_end_matches('/');
    // serde_json turns the values into safely-escaped JS string literals.
    let origin_js = serde_json::to_string(origin).expect("string serializes");
    let token_js = serde_json::to_string(auth_token).expect("string serializes");
    let mut init = format!(
        r#"(function () {{
  try {{
    if (location.origin === {origin_js}) {{
      localStorage.setItem('sb_url', {origin_js});
      localStorage.setItem('sb_token', {token_js});
    }}
  }} catch (_) {{}}
}})();"#
    );
    if open_integrations {
        init.push('\n');
        init.push_str(OPEN_INTEGRATIONS_JS);
    }
    init.push('\n');
    init.push_str(&connections_button_js(locale));
    init.push('\n');
    init.push_str(&settings_button_js(locale));

    let url: tauri::Url = format!("{origin}/")
        .parse()
        .map_err(|_| tauri::Error::WindowNotFound)?;
    let nav_handle = app.clone();
    WebviewWindowBuilder::new(app, "brain", WebviewUrl::External(url))
        .title(i18n::t(locale, Key::WindowSecondBrain))
        .inner_size(1180.0, 820.0)
        .min_inner_size(720.0, 480.0)
        .initialization_script(&init)
        // The injected Connections button asks for a path the dashboard does not
        // route; turn that request into the native window and let the page stay
        // where it is.
        .on_navigation(move |target| {
            match target.path() {
                CONNECTIONS_PATH => {
                    open_details_window(&nav_handle);
                    false
                }
                SETTINGS_PATH => {
                    open_settings_window(&nav_handle);
                    false
                }
                _ => true,
            }
        })
        .build()?;
    Ok(())
}

pub fn open_details_window(app: &AppHandle) {
    let locale = app
        .try_state::<crate::i18n::AppLocale>()
        .map(|l| l.get())
        .unwrap_or(Locale::En);
    if let Some(w) = app.get_webview_window("details") {
        let _ = w.center();
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "details", WebviewUrl::App("details.html".into()))
        .title(i18n::t(locale, Key::WindowConnections))
        .inner_size(960.0, 680.0)
        .min_inner_size(820.0, 560.0)
        .center()
        .build();
}

/// Sized to its content: seven controls with three radio levels each is taller
/// than Connections (960x680) but no wider.
pub fn open_settings_window(app: &AppHandle) {
    let locale = app
        .try_state::<crate::i18n::AppLocale>()
        .map(|l| l.get())
        .unwrap_or(Locale::En);
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.center();
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title(i18n::t(locale, Key::WindowSettings))
        .inner_size(760.0, 820.0)
        .min_inner_size(640.0, 560.0)
        .center()
        .build();
}
