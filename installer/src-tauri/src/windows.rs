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
use tauri::{AppHandle, Manager, Theme, WebviewUrl, WebviewWindowBuilder};

/// Clicking the injected Connections button navigates here. The navigation is
/// cancelled in `on_navigation` and turned into a native window instead, so the
/// remote page still needs no IPC to reach it. The path is one the dashboard
/// does not route, so nothing is lost if the interception ever fails.
const CONNECTIONS_PATH: &str = "/__sb-connections";

/// Same navigation-sentinel trick for the settings panel. The dashboard has no
/// settings UI by design (#244) — the desktop app is the only writer of config —
/// so this button is injected here rather than shipped in the dashboard.
const SETTINGS_PATH: &str = "/__sb-settings";

fn dark_window_chrome(builder: WebviewWindowBuilder<'_, tauri::Wry, AppHandle>) -> WebviewWindowBuilder<'_, tauri::Wry, AppHandle> {
    builder.theme(Some(Theme::Dark))
}

fn pin_dark_theme(window: &tauri::WebviewWindow) {
    let _ = window.set_theme(Some(Theme::Dark));
}

/// Adds a "Connections" entry to the dashboard's own sidebar footer, next to
/// Settings, reusing the dashboard's `sb-footer-btn` class so it inherits the
/// real styling rather than floating over the page. Injected rather than shipped
/// in the dashboard so it appears regardless of which Worker version the user
/// has deployed. Polls because the init script runs at document-start, and is
/// idempotent so a re-render cannot produce two buttons.
const CONNECTIONS_BUTTON_JS: &str = r#"(function () {
  var ID = 'sb-desktop-connections';
  var LABELS = { en: __LABEL_EN__, it: __LABEL_IT__ };
  var TITLES = { en: __TITLE_EN__, it: __TITLE_IT__ };
  function pick(map) {
    try {
      var loc = localStorage.getItem('sb-locale');
      if (loc === 'it' || loc === 'en') return map[loc] || map.en;
    } catch (_) {}
    return map.en;
  }
  var tries = 0;
  var iv = setInterval(function () {
    var existing = document.getElementById(ID);
    if (existing) {
      existing.title = pick(TITLES);
      var span = existing.querySelector('span');
      if (span) span.textContent = pick(LABELS);
      clearInterval(iv);
      return;
    }
    var footer = document.querySelector('.sb-footer');
    if (footer) {
      var b = document.createElement('button');
      b.id = ID;
      b.className = 'sb-footer-btn';
      b.title = pick(TITLES);
      b.innerHTML = '<i class="ti ti-plug"></i><span>' + pick(LABELS) + '</span>';
      b.addEventListener('click', function () { location.assign('__CONNECTIONS_PATH__'); });
      footer.appendChild(b);
      clearInterval(iv);
    } else if (++tries > 60) {
      clearInterval(iv);
    }
  }, 100);
})();"#;

/// Second injected footer button, for the settings panel. Uses ti-adjustments
/// (sliders) beside the dashboard's own ti-settings gear — ti-sliders is not a
/// Tabler icon and rendered as nothing at all.
///
/// Kept as its own
/// script rather than parameterising the Connections one: the ids, labels and
/// target paths differ, and one script doing both would need every value
/// twice anyway.
const SETTINGS_BUTTON_JS: &str = r#"(function () {
  var ID = 'sb-desktop-settings';
  var LABELS = { en: __LABEL_EN__, it: __LABEL_IT__ };
  var TITLES = { en: __TITLE_EN__, it: __TITLE_IT__ };
  function pick(map) {
    try {
      var loc = localStorage.getItem('sb-locale');
      if (loc === 'it' || loc === 'en') return map[loc] || map.en;
    } catch (_) {}
    return map.en;
  }
  var tries = 0;
  var iv = setInterval(function () {
    var existing = document.getElementById(ID);
    if (existing) {
      existing.title = pick(TITLES);
      var span = existing.querySelector('span');
      if (span) span.textContent = pick(LABELS);
      clearInterval(iv);
      return;
    }
    var footer = document.querySelector('.sb-footer');
    if (footer) {
      var b = document.createElement('button');
      b.id = ID;
      b.className = 'sb-footer-btn';
      b.title = pick(TITLES);
      b.innerHTML = '<i class="ti ti-adjustments"></i><span>' + pick(LABELS) + '</span>';
      b.addEventListener('click', function () { location.assign('__SETTINGS_PATH__'); });
      footer.appendChild(b);
      clearInterval(iv);
    } else if (++tries > 60) {
      clearInterval(iv);
    }
  }, 100);
})();"#;

fn settings_button_js() -> String {
    let label_en =
        serde_json::to_string(i18n::t(Locale::En, Key::SettingsButtonLabel)).expect("string");
    let label_it =
        serde_json::to_string(i18n::t(Locale::It, Key::SettingsButtonLabel)).expect("string");
    let title_en =
        serde_json::to_string(i18n::t(Locale::En, Key::SettingsButtonTooltip)).expect("string");
    let title_it =
        serde_json::to_string(i18n::t(Locale::It, Key::SettingsButtonTooltip)).expect("string");
    SETTINGS_BUTTON_JS
        .replace("__LABEL_EN__", &label_en)
        .replace("__LABEL_IT__", &label_it)
        .replace("__TITLE_EN__", &title_en)
        .replace("__TITLE_IT__", &title_it)
        .replace("__SETTINGS_PATH__", SETTINGS_PATH)
}

fn connections_button_js() -> String {
    let label_en =
        serde_json::to_string(i18n::t(Locale::En, Key::ConnectionsButtonLabel)).expect("string");
    let label_it =
        serde_json::to_string(i18n::t(Locale::It, Key::ConnectionsButtonLabel)).expect("string");
    let title_en =
        serde_json::to_string(i18n::t(Locale::En, Key::ConnectionsButtonTooltip)).expect("string");
    let title_it =
        serde_json::to_string(i18n::t(Locale::It, Key::ConnectionsButtonTooltip)).expect("string");
    CONNECTIONS_BUTTON_JS
        .replace("__LABEL_EN__", &label_en)
        .replace("__LABEL_IT__", &label_it)
        .replace("__TITLE_EN__", &title_en)
        .replace("__TITLE_IT__", &title_it)
        .replace("__CONNECTIONS_PATH__", CONNECTIONS_PATH)
}

pub fn open_setup_window(app: &AppHandle) -> tauri::Result<()> {
    let locale = app
        .try_state::<crate::i18n::AppLocale>()
        .map(|l| l.get())
        .unwrap_or(Locale::En);
    if let Some(w) = app.get_webview_window("main") {
        pin_dark_theme(&w);
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }
    let window = dark_window_chrome(
        WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into())),
    )
        .title(i18n::t(locale, Key::WindowSecondBrain))
        .inner_size(940.0, 700.0)
        .min_inner_size(760.0, 560.0)
        .build()?;
    pin_dark_theme(&window);
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
        pin_dark_theme(&w);
        // Align dashboard locale with the app without reloading when it already
        // matches — reopening the brain otherwise would flash a full reload.
        sync_brain_locale(app, worker_url, locale, false);
        if open_integrations {
            let _ = w.eval("try { openIntegrations() } catch (_) {}");
        }
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }
    // Through `brain_origin`, the same definition the refresh below uses. Two
    // spellings of "origin" in one file is how they drift, and the guard in both
    // injected scripts compares against `location.origin`, which carries no path
    // and no trailing slash.
    let origin = brain_origin(worker_url).ok_or(tauri::Error::WindowNotFound)?;
    // serde_json turns the values into safely-escaped JS string literals.
    let origin_js = serde_json::to_string(&origin).expect("string serializes");
    let token_js = serde_json::to_string(auth_token).expect("string serializes");
    let locale_js = serde_json::to_string(locale.as_str()).expect("string serializes");
    let mut init = format!(
        r#"(function () {{
  // Tells the dashboard it is running inside the desktop app, so it can hide
  // the "download the app" button. Set unconditionally: unlike the auth keys
  // below it carries nothing sensitive, and it must be true even when the
  // origin check fails.
  try {{ window.SB_DESKTOP = true; }} catch (_) {{}}
  try {{
    if (location.origin === {origin_js}) {{
      if (!sessionStorage.getItem('sb-native-locale-stamped')) {{
        localStorage.setItem('sb-locale', {locale_js});
        sessionStorage.setItem('sb-native-locale-stamped', '1');
      }}
    }}
  }} catch (_) {{}}
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
    init.push_str(&connections_button_js());
    init.push('\n');
    init.push_str(&settings_button_js());

    let url: tauri::Url = format!("{origin}/")
        .parse()
        .map_err(|_| tauri::Error::WindowNotFound)?;
    let nav_handle = app.clone();
    let window = dark_window_chrome(
        WebviewWindowBuilder::new(app, "brain", WebviewUrl::External(url)),
    )
        .title(i18n::t(locale, Key::WindowSecondBrain))
        .inner_size(1180.0, 820.0)
        .min_inner_size(720.0, 480.0)
        .initialization_script(&init)
        // The injected Connections button asks for a path the dashboard does not
        // route; turn that request into the native window and let the page stay
        // where it is.
        // Runs inside the webview's navigation handler. On Windows that is a
        // WebView2 NavigationStarting callback on the UI thread, and building a
        // window from there has to pump the message loop, which re-enters and
        // deadlocks — the app goes Not Responding with an unpainted window.
        // macOS survives it because WKWebView dispatches its navigation
        // delegate differently, which is why this only ever showed up on
        // Windows.
        //
        // So cancel the navigation here and queue the window for the event
        // loop, after this callback has returned.
        .on_navigation(move |target| {
            let path = target.path().to_string();
            let settings = match path.as_str() {
                CONNECTIONS_PATH => false,
                SETTINGS_PATH => true,
                _ => return true,
            };
            let handle = nav_handle.clone();
            let _ = nav_handle.run_on_main_thread(move || {
                if settings {
                    open_settings_window(&handle);
                } else {
                    open_details_window(&handle);
                }
            });
            false
        })
        .build()?;
    pin_dark_theme(&window);
    Ok(())
}

/// Writes `sb-locale` into an open brain window (origin-guarded) and reloads
/// when the stored value differs — or always when `force_reload` is set (language
/// change from Settings). Same pattern as token refresh: never write off-origin.
pub fn sync_brain_locale(
    app: &AppHandle,
    worker_url: &str,
    locale: Locale,
    force_reload: bool,
) {
    let Some(window) = app.get_webview_window("brain") else {
        return;
    };
    let Some(origin) = brain_origin(worker_url) else {
        return;
    };
    match window.url() {
        Ok(showing) if showing_the_brain(showing.as_str(), &origin) => {}
        Ok(_) => return,
        Err(e) => {
            log::warn!("could not read the dashboard window's address: {e}");
            return;
        }
    }
    let locale_js = serde_json::to_string(locale.as_str()).expect("string serializes");
    let origin_js = serde_json::to_string(&origin).expect("string serializes");
    let force = if force_reload { "true" } else { "false" };
    let script = format!(
        r#"(function () {{
  try {{
    if (location.origin !== {origin_js}) return;
    var next = {locale_js};
    var prev = localStorage.getItem('sb-locale');
    if (prev === next && !{force}) return;
    localStorage.setItem('sb-locale', next);
    location.reload();
  }} catch (_) {{}}
}})();"#
    );
    if let Err(e) = window.eval(&script) {
        log::warn!("could not sync the dashboard window's locale: {e}");
    }
}

/// Re-points an already-open dashboard window at a new password, then reloads it.
///
/// The origin check is not ceremony, and it is the reason this is a separate
/// script rather than a re-run of the creation-time one. The `brain` window
/// navigates to third-party sites during an integration's OAuth handshake
/// (Notion, Google, Microsoft), and `eval` runs against whatever document is
/// loaded at the time — so an unguarded write would hand the user's brain
/// password to someone else's origin. The reload sits inside the same guard for
/// a milder version of the same reason: reloading a half-finished sign-in throws
/// it away.
const REFRESH_TOKEN_JS: &str = r#"(function () {
  try {
    if (location.origin !== __ORIGIN__) { return; }
    localStorage.setItem('sb_url', __ORIGIN__);
    localStorage.setItem('sb_token', __TOKEN__);
    location.reload();
  } catch (_) {}
})();"#;

/// A stored brain address as a browser origin: scheme, host, and port only.
///
/// `location.origin` never carries a path or a trailing slash, and a stored
/// address very often does — `connect_existing` accepts one, and
/// `details_from_anywhere` trims it back off for exactly this reason. Compared
/// raw, `https://brain.workers.dev/` never equals `https://brain.workers.dev`, so
/// the injected guard below would decline to write on every rotation for those
/// users while this function went on reporting success. Parsing rather than
/// trimming means that difference cannot be reintroduced by deleting one call.
///
/// `None` for anything that is not a real `scheme://host` — an opaque origin can
/// never legitimately equal a brain's, and treating "unparseable" as "matches"
/// is how a password reaches a page it does not belong on.
fn brain_origin(worker_url: &str) -> Option<String> {
    let origin = url::Url::parse(worker_url.trim()).ok()?.origin();
    origin.is_tuple().then(|| origin.ascii_serialization())
}

/// Whether the page a window is currently showing is the user's own brain.
///
/// The `brain` window is not always on the brain: an integration's OAuth
/// handshake navigates it to Notion, Google or Microsoft, and it stays there
/// until the user finishes. Asked in Rust as well as in the injected script
/// because the two answer different questions — the script decides whether to
/// *write*, and this decides what the caller may be *told*, and until now the
/// caller was told "done" whenever the script had been handed over successfully,
/// whether or not it had written anything.
fn showing_the_brain(window_url: &str, worker_url: &str) -> bool {
    match (brain_origin(window_url), brain_origin(worker_url)) {
        (Some(showing), Some(brain)) => showing == brain,
        _ => false,
    }
}

/// Hands the open dashboard window the new password and reloads it.
///
/// The token reaches that window through an `initialization_script`, which runs
/// once per page load. A window that was already open when the password changed
/// therefore goes on presenting the old one indefinitely: nothing about it looks
/// broken, it simply starts 401ing, and the only route back is Disconnect.
///
/// Returns whether the dashboard is now on the new password — not whether a
/// script was handed over. Those came apart in the two cases that matter: a
/// window sitting on a third-party OAuth page, where the injected guard correctly
/// declines to write, and a stored address with a trailing slash, where the
/// comparison could never succeed. `eval` is fire-and-forget and cannot report
/// either back, so the origin is settled here, from what the window says it is
/// showing, before the script is sent at all.
///
/// The guard inside the script stays regardless. This check and that one race —
/// the window can navigate in between — and the one that runs in the same tick as
/// the write is the one that keeps the password off someone else's origin.
///
/// `true` when there is no wrapper window at all: the caller is asking whether a
/// stale copy is left anywhere, and with no window there is none.
pub fn refresh_wrapper_token(app: &AppHandle, worker_url: &str, auth_token: &str) -> bool {
    let Some(window) = app.get_webview_window("brain") else {
        return true;
    };
    let Some(origin) = brain_origin(worker_url) else {
        log::warn!("cannot refresh the dashboard window: {worker_url} has no origin");
        return false;
    };
    match window.url() {
        Ok(showing) if showing_the_brain(showing.as_str(), &origin) => {}
        Ok(showing) => {
            // Not an error and not worth a scary message: the user is part-way
            // through connecting an integration. The window will pick the new
            // password up from the creation-time script on its next load, and the
            // done screen says so rather than claiming it is already there.
            log::info!(
                "the dashboard window is on {} rather than the brain, so it keeps the \
                 old password until it navigates back",
                showing.origin().ascii_serialization()
            );
            return false;
        }
        Err(e) => {
            log::warn!("could not read the dashboard window's address: {e}");
            return false;
        }
    }
    // serde_json turns both values into safely-escaped JS string literals, the
    // same way the creation-time injection does.
    let script = REFRESH_TOKEN_JS
        .replace("__ORIGIN__", &serde_json::to_string(&origin).expect("string serializes"))
        .replace("__TOKEN__", &serde_json::to_string(auth_token).expect("string serializes"));
    match window.eval(&script) {
        Ok(()) => true,
        Err(e) => {
            log::warn!("could not refresh the dashboard window's password: {e}");
            false
        }
    }
}

pub fn open_details_window(app: &AppHandle) {
    let locale = app
        .try_state::<crate::i18n::AppLocale>()
        .map(|l| l.get())
        .unwrap_or(Locale::En);
    if let Some(w) = app.get_webview_window("details") {
        pin_dark_theme(&w);
        let _ = w.center();
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    if let Ok(w) = dark_window_chrome(
        WebviewWindowBuilder::new(app, "details", WebviewUrl::App("details.html".into())),
    )
        .title(i18n::t(locale, Key::WindowConnections))
        .inner_size(960.0, 680.0)
        .min_inner_size(820.0, 560.0)
        .center()
        .build()
    {
        pin_dark_theme(&w);
    }
}

/// Sized to its content: seven controls with three radio levels each is taller
/// than Connections (960x680) but no wider.
pub fn open_settings_window(app: &AppHandle) {
    let locale = app
        .try_state::<crate::i18n::AppLocale>()
        .map(|l| l.get())
        .unwrap_or(Locale::En);
    if let Some(w) = app.get_webview_window("settings") {
        pin_dark_theme(&w);
        let _ = w.center();
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    if let Ok(w) = dark_window_chrome(
        WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into())),
    )
        .title(i18n::t(locale, Key::WindowSettings))
        .inner_size(760.0, 820.0)
        .min_inner_size(640.0, 560.0)
        .center()
        .build()
    {
        pin_dark_theme(&w);
    }
}

#[cfg(test)]
mod tests {
    use super::{brain_origin, showing_the_brain};

    /// This file's source, stopping at the test module.
    ///
    /// Every guard below reads the code and nothing but the code. A scan that
    /// runs on past the last item finds the assertion strings written to describe
    /// it and passes with the thing it guards deleted — which is not a
    /// hypothetical here. `both_sentinel_paths_are_deferred` passed with
    /// `SETTINGS_PATH` removed from the handler outright, because its end anchor
    /// (`"\n        .build()"`) was neither unique nor tied to this window and its
    /// `unwrap_or(rest.len())` fallback sent `end` to the end of the file, where
    /// the literal `"SETTINGS_PATH"` in its own assertion satisfied it. That
    /// pattern has now misfired four times in this repository, so: bounded source,
    /// unique anchors, and `expect` everywhere. A guard that cannot find what it
    /// is anchored to must fail, never widen.
    fn code() -> &'static str {
        let src = include_str!("windows.rs");
        &src[..src
            .find("\n#[cfg(test)]\nmod tests {")
            .expect("the test module is the boundary of the scannable source")]
    }

    /// The `brain` window's navigation handler, and only that.
    ///
    /// Anchored inside `open_wrapper_window_impl` first, so it is tied to the
    /// window whose handler this is rather than to whichever `.on_navigation(`
    /// happens to come first in the file.
    fn navigation_handler() -> &'static str {
        let code = code();
        let builder = code
            .find("fn open_wrapper_window_impl(")
            .expect("the brain window's builder");
        let scope = &code[builder..];
        let scope = &scope[..scope
            .find("\n}\n")
            .expect("open_wrapper_window_impl ends at a closing brace in column zero")];
        let start = scope
            .find(".on_navigation(")
            .expect("the brain window still installs a navigation handler");
        let rest = &scope[start..];
        let end = rest
            .find("\n        })\n")
            .expect("the navigation closure closes at eight spaces, before .build()");
        &rest[..end]
    }

    /// Windows 11 report: the Connections button in the injected sidebar hung the
    /// app ("Not Responding", unpainted window) while the same window opened fine
    /// from the menu bar.
    ///
    /// The difference is dispatch context. on_navigation runs inside a WebView2
    /// NavigationStarting callback on the UI thread, and building a window from
    /// there pumps the message loop, re-enters, and deadlocks. The menu path is
    /// dispatched from the event loop and is unaffected.
    ///
    /// Asserted on the source because the failure is a deadlock on a platform
    /// this suite does not run a GUI on — there is no value to observe, only the
    /// absence of a hang. What is checkable is that the callback queues the work
    /// rather than doing it inline.
    #[test]
    fn navigation_handler_never_builds_a_window_inline() {
        let body = navigation_handler();

        assert!(
            body.contains("run_on_main_thread"),
            "on_navigation must queue window creation on the event loop; building inline deadlocks WebView2 on Windows"
        );
        for direct in ["open_details_window(&nav_handle)", "open_settings_window(&nav_handle)"] {
            assert!(
                !body.contains(direct),
                "on_navigation still calls {direct} inline, which is the deadlock"
            );
        }
    }

    /// Both injected sidebar buttons route through the same handler, so a fix
    /// covering only Connections would leave Advanced Settings hanging.
    #[test]
    fn both_sentinel_paths_are_deferred() {
        let body = navigation_handler();
        for path in ["CONNECTIONS_PATH", "SETTINGS_PATH"] {
            assert!(
                body.contains(path),
                "{path} is no longer intercepted, so clicking that button navigates \
                 the dashboard to a route it does not serve — and on Windows the \
                 window it was meant to open never appears at all"
            );
        }
    }

    /// A stored address becomes the origin a browser would report, by parsing
    /// rather than by trimming.
    ///
    /// The trailing slash is the whole point. `location.origin` never has one, and
    /// stored addresses sometimes do, so `https://brain.workers.dev/` compared raw
    /// against `location.origin` is never equal: the injected guard declines to
    /// write on every rotation, the dashboard keeps the old password, and — before
    /// this — the function reported `true` anyway. Deleting a `trim_end_matches`
    /// used to be that bug and left every test green; there is now nothing to
    /// delete, because the comparison is between parsed origins.
    #[test]
    fn a_stored_address_becomes_the_origin_the_page_will_report() {
        for input in [
            "https://second-brain.acme.workers.dev",
            "https://second-brain.acme.workers.dev/",
            "https://second-brain.acme.workers.dev/graph?tab=all",
            "  https://second-brain.acme.workers.dev/  ",
        ] {
            assert_eq!(
                brain_origin(input).as_deref(),
                Some("https://second-brain.acme.workers.dev"),
                "input: {input:?}"
            );
        }

        // The port is part of the origin, and the demo brain lives on one.
        assert_eq!(
            brain_origin("http://127.0.0.1:8787/").as_deref(),
            Some("http://127.0.0.1:8787")
        );

        // Nothing that is not a real scheme://host may produce an origin. An
        // opaque one can never legitimately equal a brain's, and answering
        // "matches" for an address nobody could parse is how a password reaches a
        // page it does not belong on.
        for input in ["", "not a url", "data:text/html,x", "https://"] {
            assert_eq!(brain_origin(input), None, "input: {input:?}");
        }
    }

    /// `dashboard: true` means "that window now has the new password", not "a
    /// script was handed over".
    ///
    /// The two came apart wherever it mattered. `eval` is fire-and-forget: it
    /// returns `Ok` as soon as the script has been posted to the webview, and
    /// says nothing about whether the origin guard inside it decided to write. So
    /// a `brain` window part-way through an integration's OAuth handshake — on
    /// Notion, Google or Microsoft, which is where that window spends real time —
    /// correctly refused the write and was reported to the user as done, leaving a
    /// dashboard that 401s under a screen saying it had been updated.
    #[test]
    fn only_the_brains_own_page_counts_as_holding_the_new_password() {
        let brain = "https://second-brain.acme.workers.dev";

        for showing in [
            brain,
            "https://second-brain.acme.workers.dev/",
            "https://second-brain.acme.workers.dev/graph?tab=all",
        ] {
            assert!(showing_the_brain(showing, brain), "showing: {showing:?}");
        }

        for showing in [
            // Where the window actually goes during an integration handshake.
            "https://api.notion.com/v1/oauth/authorize?client_id=x",
            "https://accounts.google.com/o/oauth2/v2/auth",
            "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
            // A different brain, and a look-alike host.
            "https://second-brain.other.workers.dev/",
            "https://second-brain.acme.workers.dev.evil.example/",
            // Same host, different scheme and different port: neither is the same
            // origin, and `localStorage` is partitioned by all three.
            "http://second-brain.acme.workers.dev/",
            "https://second-brain.acme.workers.dev:8443/",
            "about:blank",
            "",
        ] {
            assert!(
                !showing_the_brain(showing, brain),
                "a window on {showing:?} was treated as the user's own dashboard — \
                 which is both a false 'done' on the screen and, if the script's own \
                 guard ever went, the user's brain password written to that origin"
            );
        }
    }

    /// A rotation re-injects the password into an already-open dashboard window.
    /// That window is not always on the user's own origin: an integration's
    /// OAuth handshake navigates it to Notion or Google, and `eval` targets
    /// whatever document is loaded. Writing the password there would hand the key
    /// to the user's whole brain to a third party.
    ///
    /// Asserted on the source because the failure needs a live webview sitting on
    /// a foreign origin, which this suite has no way to produce — but the guard
    /// that prevents it is a single line, and its absence is checkable.
    ///
    /// Reads only the literal's own body, so the strings in this test cannot
    /// satisfy it.
    #[test]
    fn the_token_refresh_writes_nothing_outside_the_brains_own_origin() {
        let code = code();
        let start = code.find("const REFRESH_TOKEN_JS").expect("REFRESH_TOKEN_JS");
        let body = &code[start..];
        let body = &body[..body.find("\"#;").expect("end of the literal")];

        let guard = body
            .find("location.origin !== __ORIGIN__")
            .expect("the refresh script must compare origins before writing");
        let write = body.find("sb_token").expect("the token write");
        let reload = body.find("location.reload").expect("the reload");

        assert!(
            guard < write,
            "the password is written before the origin is checked, which leaks it \
             to whatever site the dashboard window happens to be showing"
        );
        assert!(
            guard < reload,
            "an unguarded reload discards a third-party sign-in that is mid-flight"
        );

        // The Rust half of the same rule. The script's guard decides whether to
        // write; this one decides what the user is told, and it has to be settled
        // before `eval` because `eval` cannot answer. Both stay: they race, and
        // the one that runs in the same tick as the write is the one that keeps
        // the password off someone else's origin.
        let refresh = {
            let start = code
                .find("pub fn refresh_wrapper_token(")
                .expect("the refresh function");
            let rest = &code[start..];
            &rest[..rest
                .find("\n}\n")
                .expect("refresh_wrapper_token ends at a closing brace in column zero")]
        };
        let asked = refresh
            .find("window.url()")
            .expect("the window is no longer asked where it is, so a refresh that \
                     wrote nothing is reported as done");
        let evaluated = refresh.find("window.eval").expect("the script is still sent");
        assert!(
            asked < evaluated,
            "the origin has to be settled before the script is handed over — after \
             it there is nothing left to decide, because `eval` returns `Ok` as soon \
             as the script is posted and never says what it did"
        );

        // …and the answer has to be acted on. The comparison is unit-tested
        // above; what only the source can show is that a window on someone else's
        // page leaves this function as a `false`. Turning that into a `true` is a
        // one-word edit that restores the original bug exactly: a screen telling
        // the user their dashboard is on the new password when nothing wrote it.
        let decision = &refresh[asked..evaluated];
        assert!(
            decision.contains("showing_the_brain"),
            "the window's address is read and then ignored"
        );
        assert!(
            decision.contains("return false"),
            "a window that is not showing the brain must leave this function as a \
             `false`: nothing was written, and the done screen repeats this flag to \
             the user as \"your dashboard is already using the new password\""
        );
        assert!(
            !decision.contains("return true"),
            "something short-circuits to success before the script has been sent"
        );
    }
}
