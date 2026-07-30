//! Named levels for the settings window (#246).
//!
//! Six of the seven controls are multi-value: one user-facing level moves two
//! or three config keys together. They are levels rather than sliders because
//! the underlying values must stay coherent — two pairs carry invariants the
//! Worker enforces at resolve time, and a user must not be able to cross them
//! from the UI at all.
//!
//! The seventh control (which AI model) is a plain dropdown over LLM_MODEL and
//! is not modelled here.

use crate::i18n::{self, Key, Locale};
use serde::Serialize;
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, Serialize)]
pub struct Level {
    pub id: &'static str,
    /// Config keys this level writes, with the values it writes.
    #[serde(skip)]
    pub values: &'static [(&'static str, fn() -> Value)],
}

#[derive(Debug, Clone, Serialize)]
pub struct Control {
    pub id: &'static str,
    /// Every config key this control owns. Used to decide which level is
    /// currently selected, and to reset the control as a unit.
    pub keys: &'static [&'static str],
    #[serde(skip)]
    pub levels: &'static [Level],
    /// Cannot affect data already stored. Surfaced in the UI because it
    /// otherwise generates support questions.
    pub forward_only: bool,
}

macro_rules! lvl {
    ($id:literal, $($k:literal => $v:expr),+ $(,)?) => {
        Level { id: $id, values: &[ $( ($k, || json!($v)) ),+ ] }
    };
}

pub static CONTROLS: &[Control] = &[
    Control {
        id: "recency",
        keys: &["RECENCY_FLOOR", "RECENCY_FLOOR_DURABLE", "RECENCY_FLOOR_VOLATILE"],
        forward_only: false,
        levels: &[
            // Higher floors mean decay bottoms out sooner, so age matters less.
            lvl!("timeless", "RECENCY_FLOOR" => 0.85, "RECENCY_FLOOR_DURABLE" => 0.95, "RECENCY_FLOOR_VOLATILE" => 0.6),
            lvl!("balanced", "RECENCY_FLOOR" => 0.6, "RECENCY_FLOOR_DURABLE" => 0.9, "RECENCY_FLOOR_VOLATILE" => 0.15),
            lvl!("recent_first", "RECENCY_FLOOR" => 0.3, "RECENCY_FLOOR_DURABLE" => 0.7, "RECENCY_FLOOR_VOLATILE" => 0.05),
        ],
    },
    Control {
        id: "variety",
        keys: &["MMR_LAMBDA"],
        forward_only: false,
        levels: &[
            // Higher lambda favours relevance; lower spreads results out.
            lvl!("focused", "MMR_LAMBDA" => 0.9),
            lvl!("balanced", "MMR_LAMBDA" => 0.7),
            lvl!("varied", "MMR_LAMBDA" => 0.45),
        ],
    },
    Control {
        id: "connections",
        keys: &["DEFAULT_HOPS", "GRAPH_HOP_DECAY"],
        forward_only: false,
        levels: &[
            lvl!("off", "DEFAULT_HOPS" => 0, "GRAPH_HOP_DECAY" => 0.6),
            lvl!("nearby", "DEFAULT_HOPS" => 1, "GRAPH_HOP_DECAY" => 0.6),
            // Two hops decays less steeply, or the second ring contributes
            // almost nothing and the setting looks broken.
            lvl!("extended", "DEFAULT_HOPS" => 2, "GRAPH_HOP_DECAY" => 0.7),
        ],
    },
    Control {
        id: "detail",
        keys: &["RECALL_OUTPUT_BUDGET", "SNIPPET_MAX_CHARS", "RECALL_FULL_MATCHES"],
        forward_only: false,
        levels: &[
            lvl!("compact", "RECALL_OUTPUT_BUDGET" => 6000, "SNIPPET_MAX_CHARS" => 240, "RECALL_FULL_MATCHES" => 1),
            lvl!("standard", "RECALL_OUTPUT_BUDGET" => 12000, "SNIPPET_MAX_CHARS" => 400, "RECALL_FULL_MATCHES" => 2),
            lvl!("full", "RECALL_OUTPUT_BUDGET" => 24000, "SNIPPET_MAX_CHARS" => 800, "RECALL_FULL_MATCHES" => 4),
        ],
    },
    Control {
        id: "duplicates",
        keys: &["DUPLICATE_BLOCK_THRESHOLD", "DUPLICATE_FLAG_THRESHOLD"],
        forward_only: true,
        levels: &[
            lvl!("permissive", "DUPLICATE_BLOCK_THRESHOLD" => 0.99, "DUPLICATE_FLAG_THRESHOLD" => 0.95),
            lvl!("standard", "DUPLICATE_BLOCK_THRESHOLD" => 0.95, "DUPLICATE_FLAG_THRESHOLD" => 0.85),
            lvl!("strict", "DUPLICATE_BLOCK_THRESHOLD" => 0.9, "DUPLICATE_FLAG_THRESHOLD" => 0.75),
        ],
    },
    Control {
        id: "compression",
        keys: &["COMPRESSION_IMPORTANCE_THRESHOLD", "COMPRESSION_MIN_RECALL", "COMPRESSION_MIN_AGE_MS"],
        forward_only: true,
        levels: &[
            // Eligibility is `importance < THRESHOLD AND recall < MIN_RECALL AND
            // older than MIN_AGE`, so protecting more means LOWER thresholds and
            // a LONGER age requirement.
            lvl!("conservative", "COMPRESSION_IMPORTANCE_THRESHOLD" => 3, "COMPRESSION_MIN_RECALL" => 1, "COMPRESSION_MIN_AGE_MS" => 120i64 * 86_400_000),
            lvl!("standard", "COMPRESSION_IMPORTANCE_THRESHOLD" => 4, "COMPRESSION_MIN_RECALL" => 2, "COMPRESSION_MIN_AGE_MS" => 60i64 * 86_400_000),
            lvl!("aggressive", "COMPRESSION_IMPORTANCE_THRESHOLD" => 5, "COMPRESSION_MIN_RECALL" => 4, "COMPRESSION_MIN_AGE_MS" => 30i64 * 86_400_000),
        ],
    },
];

/// The level each control shows for a fresh install. Must equal the Worker's
/// shipped DEFAULTS — asserted in tests against `src/config.ts` itself.
pub const DEFAULT_LEVELS: &[(&str, &str)] = &[
    ("recency", "balanced"),
    ("variety", "balanced"),
    ("connections", "off"),
    ("detail", "standard"),
    ("duplicates", "standard"),
    ("compression", "standard"),
];

pub fn control(id: &str) -> Option<&'static Control> {
    CONTROLS.iter().find(|c| c.id == id)
}

/// The config patch a level writes. `None` for an unknown control or level.
pub fn patch_for(control_id: &str, level_id: &str) -> Option<Map<String, Value>> {
    let c = control(control_id)?;
    let l = c.levels.iter().find(|l| l.id == level_id)?;
    Some(l.values.iter().map(|(k, v)| ((*k).to_string(), v())).collect())
}

/// Which level the given effective config corresponds to, or `None` when it
/// matches no level — a config hand-edited in KV, or written by a newer
/// version. The UI shows that as "Custom" rather than silently snapping the
/// user to a level they did not choose.
pub fn level_of(control_id: &str, config: &Map<String, Value>) -> Option<&'static str> {
    let c = control(control_id)?;
    c.levels
        .iter()
        .find(|l| l.values.iter().all(|(k, v)| config.get(*k).map(|got| values_eq(got, &v())).unwrap_or(false)))
        .map(|l| l.id)
}

/// JSON numbers compare by value, not representation: 0.6 arriving as 0.6 and
/// 60 arriving as 60.0 must both match.
fn values_eq(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => (x - y).abs() < f64::EPSILON * 8.0,
        _ => a == b,
    }
}

/// Models offered in the dropdown. A curated list rather than a live catalogue
/// fetch: the panel must render offline, and an unrecognised model string still
/// resolves fine on the Worker (LLM_MODEL is validated only as a non-empty
/// string), so a stale entry degrades to "works" rather than "breaks".
pub const LLM_MODELS: &[&str] = &[
    "@cf/meta/llama-4-scout-17b-16e-instruct",
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "@cf/meta/llama-3.1-8b-instruct-fast",
    "@cf/mistralai/mistral-small-3.1-24b-instruct",
    "@cf/qwen/qwen2.5-coder-32b-instruct",
];

// ── Worker API ──────────────────────────────────────────────────────────────
//
// The desktop app is the only writer of config (#244): it holds AUTH_TOKEN in
// secure_store, and the dashboard deliberately has no settings UI. These call
// the routes #245 added.

const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlView {
    pub id: &'static str,
    /// Level ids in display order, so the UI never hardcodes them.
    pub levels: Vec<&'static str>,
    /// `None` when the stored config matches no level — shown as "Custom"
    /// rather than snapping the user to a level they did not pick.
    pub level: Option<String>,
    /// What "Reset to default" returns to, so the UI can name it instead of
    /// saying "default" and leaving the user to guess.
    pub default_level: &'static str,
    pub forward_only: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub controls: Vec<ControlView>,
    pub llm_model: String,
    /// Sent to the UI so the dropdown never hardcodes model ids.
    pub llm_models: Vec<&'static str>,
}

fn base(worker_url: &str) -> &str {
    worker_url.trim_end_matches('/')
}

/// Maps the Worker's effective config onto the level each control is showing.
fn view_from_config(config: &Map<String, Value>) -> SettingsView {
    SettingsView {
        controls: CONTROLS
            .iter()
            .map(|c| ControlView {
                id: c.id,
                levels: c.levels.iter().map(|l| l.id).collect(),
                level: level_of(c.id, config).map(|s| s.to_string()),
                default_level: DEFAULT_LEVELS
                    .iter()
                    .find(|(id, _)| *id == c.id)
                    .map(|(_, lvl)| *lvl)
                    .unwrap_or(""),
                forward_only: c.forward_only,
            })
            .collect(),
        llm_model: config
            .get("LLM_MODEL")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        llm_models: LLM_MODELS.to_vec(),
    }
}

pub async fn fetch_settings(
    worker_url: &str,
    auth_token: &str,
    locale: Locale,
) -> Result<SettingsView, String> {
    let resp = reqwest::Client::new()
        .get(format!("{}/config", base(worker_url)))
        .bearer_auth(auth_token)
        .timeout(TIMEOUT)
        .send()
        .await
        .map_err(|e| {
            log::warn!("config fetch failed: {e}");
            i18n::t(locale, Key::ErrorReachBrain).to_string()
        })?;

    // 404 means the deployed Worker predates the config routes (#245). The app
    // and the Worker update independently, so this is the ordinary state for
    // anyone who updated the app first — say what to do, not what happened.
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(i18n::t(locale, Key::ErrorBrainNeedsUpdateForSettings).to_string());
    }
    if !resp.status().is_success() {
        return Err(i18n::t_fmt(
            locale,
            Key::ErrorBrainHttpStatus,
            &[("status", &resp.status().as_u16().to_string())],
        ));
    }

    #[derive(serde::Deserialize)]
    struct Wrapper {
        config: Map<String, Value>,
    }
    let body: Wrapper = resp
        .json()
        .await
        .map_err(|e| {
            log::warn!("config parse failed: {e}");
            i18n::t(locale, Key::ErrorBrainUnexpected).to_string()
        })?;

    Ok(view_from_config(&body.config))
}

/// Sends a sparse patch. The Worker rejects the whole patch if any key is
/// invalid or would cross an invariant, and its message names the offending key
/// — surfaced verbatim, because it is the only thing that tells the user what
/// actually went wrong.
pub async fn patch_config(
    worker_url: &str,
    auth_token: &str,
    patch: &Value,
    locale: Locale,
) -> Result<(), String> {
    let resp = reqwest::Client::new()
        .patch(format!("{}/config", base(worker_url)))
        .bearer_auth(auth_token)
        .json(patch)
        .timeout(TIMEOUT)
        .send()
        .await
        .map_err(|e| {
            log::warn!("config patch failed: {e}");
            i18n::t(locale, Key::ErrorReachBrain).to_string()
        })?;

    if resp.status().is_success() {
        return Ok(());
    }

    #[derive(serde::Deserialize)]
    struct Err_ {
        error: Option<String>,
    }
    let status = resp.status().as_u16().to_string();
    match resp.json::<Err_>().await.ok().and_then(|b| b.error) {
        Some(message) => Err(message),
        None => Err(i18n::t_fmt(locale, Key::ErrorBrainHttpStatus, &[("status", &status)])),
    }
}

/// Per-setting reset: deletes every key the control owns, leaving all other
/// controls untouched. A delete rather than a write-back of the default, so the
/// user rejoins the shipped value and picks up any later retune of it.
pub async fn reset_control(
    worker_url: &str,
    auth_token: &str,
    control_id: &str,
    locale: Locale,
) -> Result<(), String> {
    let c = control(control_id)
        .ok_or_else(|| i18n::t(locale, Key::ErrorUnknownTool).to_string())?;
    let client = reqwest::Client::new();
    for key in c.keys {
        let resp = client
            .delete(format!("{}/config/{key}", base(worker_url)))
            .bearer_auth(auth_token)
            .timeout(TIMEOUT)
            .send()
            .await
            .map_err(|e| {
                log::warn!("config reset failed for {key}: {e}");
                i18n::t(locale, Key::ErrorReachBrain).to_string()
            })?;
        if !resp.status().is_success() {
            return Err(i18n::t_fmt(
                locale,
                Key::ErrorBrainHttpStatus,
                &[("status", &resp.status().as_u16().to_string())],
            ));
        }
    }
    Ok(())
}

/// Commits a batch of staged changes: one merged PATCH for every changed level
/// plus the model, then a DELETE per key of each control being reset.
///
/// Merged rather than one request per control on purpose. The Worker validates
/// invariants against the whole resulting config, so splitting a batch could
/// reject a combination that is valid as a whole, and would leave earlier
/// controls written when a later one failed.
///
/// Every level is validated locally first, so an invalid batch writes nothing.
pub async fn apply_settings(
    worker_url: &str,
    auth_token: &str,
    levels: &[(String, String)],
    resets: &[String],
    model: Option<String>,
    locale: Locale,
) -> Result<(), String> {
    let mut patch = Map::new();
    for (control_id, level_id) in levels {
        let keys = patch_for(control_id, level_id)
            .ok_or_else(|| i18n::t(locale, Key::ErrorUnknownTool).to_string())?;
        patch.extend(keys);
    }
    // Validate reset targets before writing anything, for the same reason.
    for control_id in resets {
        control(control_id).ok_or_else(|| i18n::t(locale, Key::ErrorUnknownTool).to_string())?;
    }
    if let Some(m) = model {
        patch.insert("LLM_MODEL".into(), json!(m));
    }

    if !patch.is_empty() {
        patch_config(worker_url, auth_token, &Value::Object(patch), locale).await?;
    }
    for control_id in resets {
        reset_control(worker_url, auth_token, control_id, locale).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Parses `DEFAULTS` out of the Worker's src/config.ts.
    ///
    /// The alternative is duplicating those numbers here, which is exactly the
    /// drift this guards against: if a shipped default is retuned and the
    /// middle level is not, a fresh install opens the panel already showing a
    /// non-default level.
    fn worker_defaults() -> HashMap<String, f64> {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../src/config.ts");
        let src = std::fs::read_to_string(path).expect("read src/config.ts");
        let start = src.find("export const DEFAULTS").expect("DEFAULTS block");
        let end = src[start..].find("} as const;").expect("end of DEFAULTS") + start;
        let mut out = HashMap::new();
        for line in src[start..end].lines() {
            let line = line.trim();
            if line.starts_with("//") { continue; }
            let Some((k, v)) = line.split_once(':') else { continue };
            let key = k.trim();
            if key.is_empty() || !key.chars().all(|c| c.is_ascii_uppercase() || c == '_' || c.is_ascii_digit()) { continue; }
            let raw = v.trim().trim_end_matches(',').trim();
            // handles plain numbers and simple products like `60 * 86400000`
            let val = if let Some((a, b)) = raw.split_once('*') {
                match (a.trim().parse::<f64>(), b.trim().parse::<f64>()) { (Ok(x), Ok(y)) => x * y, _ => continue }
            } else {
                match raw.parse::<f64>() { Ok(x) => x, Err(_) => continue }
            };
            out.insert(key.to_string(), val);
        }
        out
    }

    #[test]
    fn every_control_has_a_default_level_and_vice_versa() {
        for c in CONTROLS {
            assert!(DEFAULT_LEVELS.iter().any(|(id, _)| *id == c.id), "{} has no default level", c.id);
        }
        for (id, lvl) in DEFAULT_LEVELS {
            let c = control(id).unwrap_or_else(|| panic!("unknown control {id}"));
            assert!(c.levels.iter().any(|l| l.id == *lvl), "{id} has no level {lvl}");
        }
    }

    #[test]
    fn every_level_writes_exactly_the_controls_keys() {
        for c in CONTROLS {
            for l in c.levels {
                let mut wrote: Vec<&str> = l.values.iter().map(|(k, _)| *k).collect();
                wrote.sort_unstable();
                let mut owns = c.keys.to_vec();
                owns.sort_unstable();
                assert_eq!(wrote, owns, "control {} level {} writes the wrong keys", c.id, l.id);
            }
        }
    }

    #[test]
    fn default_level_matches_the_workers_shipped_defaults() {
        let defaults = worker_defaults();
        assert!(defaults.len() > 10, "parsed too few defaults — parser drifted");
        for (control_id, level_id) in DEFAULT_LEVELS {
            let patch = patch_for(control_id, level_id).expect("patch");
            for (key, value) in patch {
                let shipped = defaults
                    .get(&key)
                    .unwrap_or_else(|| panic!("{key} is not a Worker default — settings writes a key the config layer does not define"));
                let ours = value.as_f64().expect("numeric level value");
                assert!(
                    (ours - shipped).abs() < 1e-9,
                    "{control_id}/{level_id} sets {key}={ours} but the Worker ships {shipped}",
                );
            }
        }
    }

    #[test]
    fn no_level_can_invert_the_duplicate_invariant() {
        for l in control("duplicates").unwrap().levels {
            let p = patch_for("duplicates", l.id).unwrap();
            let block = p["DUPLICATE_BLOCK_THRESHOLD"].as_f64().unwrap();
            let flag = p["DUPLICATE_FLAG_THRESHOLD"].as_f64().unwrap();
            assert!(block > flag, "level {} makes flagging unreachable ({block} <= {flag})", l.id);
        }
    }

    #[test]
    fn no_level_can_invert_the_recency_tiering() {
        for l in control("recency").unwrap().levels {
            let p = patch_for("recency", l.id).unwrap();
            let (vol, base, dur) = (
                p["RECENCY_FLOOR_VOLATILE"].as_f64().unwrap(),
                p["RECENCY_FLOOR"].as_f64().unwrap(),
                p["RECENCY_FLOOR_DURABLE"].as_f64().unwrap(),
            );
            assert!(vol <= base && base <= dur, "level {} inverts tiering ({vol}, {base}, {dur})", l.id);
        }
    }

    #[test]
    fn levels_round_trip_through_level_of() {
        for c in CONTROLS {
            for l in c.levels {
                let patch = patch_for(c.id, l.id).unwrap();
                assert_eq!(level_of(c.id, &patch), Some(l.id), "{}/{} did not round-trip", c.id, l.id);
            }
        }
    }

    #[test]
    fn a_hand_edited_config_reads_as_custom_rather_than_snapping_to_a_level() {
        let mut cfg = patch_for("variety", "balanced").unwrap();
        cfg.insert("MMR_LAMBDA".into(), json!(0.53));
        assert_eq!(level_of("variety", &cfg), None);
    }

    #[test]
    fn a_partially_present_config_reads_as_custom() {
        // Only one of recency's three keys present — must not match a level.
        let mut cfg = Map::new();
        cfg.insert("RECENCY_FLOOR".into(), json!(0.6));
        assert_eq!(level_of("recency", &cfg), None);
    }

    #[test]
    fn forward_only_controls_are_exactly_the_two_that_cannot_rewrite_history() {
        let forward: Vec<&str> = CONTROLS.iter().filter(|c| c.forward_only).map(|c| c.id).collect();
        assert_eq!(forward, vec!["duplicates", "compression"]);
    }

    #[test]
    fn unknown_control_or_level_is_none_rather_than_a_panic() {
        assert!(patch_for("nope", "standard").is_none());
        assert!(patch_for("variety", "nope").is_none());
        assert!(level_of("nope", &Map::new()).is_none());
    }

    #[test]
    fn there_is_no_match_strictness_control() {
        // Dropped deliberately (#246): CANDIDATE_SCORE_THRESHOLD is write-path
        // only and recall applies no minimum-score cutoff, so a control for it
        // would imply retrieval behaviour that does not exist.
        assert!(control("match_strictness").is_none());
        for c in CONTROLS {
            assert!(!c.keys.contains(&"CANDIDATE_SCORE_THRESHOLD"), "{} exposes a write-path-only constant", c.id);
        }
    }


    // ── HTTP layer ──────────────────────────────────────────────────────────
    //
    // Driven against a real tiny_http server, matching the convention in
    // cf/api.rs: the request path and method select the scenario, so the
    // assertions cover what the Worker actually receives, not a mock's idea of
    // it.

    fn spawn_worker() -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            loop {
                let Ok(mut req) = server.recv() else { return };
                let method = req.method().as_str().to_string();
                let url = req.url().to_string();
                let auth = req
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("authorization"))
                    .map(|h| h.value.to_string())
                    .unwrap_or_default();
                let mut body = String::new();
                let _ = std::io::Read::read_to_string(req.as_reader(), &mut body);
                log.lock().unwrap().push(format!("{method} {url} auth={auth} body={body}"));

                let (status, payload) = match (method.as_str(), url.as_str()) {
                    ("GET", "/config") => (
                        200,
                        r#"{"ok":true,"config":{"MMR_LAMBDA":0.7,"RECENCY_FLOOR":0.6,"RECENCY_FLOOR_DURABLE":0.9,"RECENCY_FLOOR_VOLATILE":0.15,"DEFAULT_HOPS":0,"GRAPH_HOP_DECAY":0.6,"RECALL_OUTPUT_BUDGET":12000,"SNIPPET_MAX_CHARS":400,"RECALL_FULL_MATCHES":2,"DUPLICATE_BLOCK_THRESHOLD":0.95,"DUPLICATE_FLAG_THRESHOLD":0.85,"COMPRESSION_IMPORTANCE_THRESHOLD":4,"COMPRESSION_MIN_RECALL":2,"COMPRESSION_MIN_AGE_MS":5184000000,"LLM_MODEL":"@cf/meta/llama-4-scout-17b-16e-instruct"},"overrides":{},"defaults":{}}"#.to_string(),
                    ),
                    ("PATCH", "/config") if body.contains("\"BAD\"") => (
                        400,
                        r#"{"ok":false,"error":"MMR_LAMBDA must be between 0 and 1 (got 99)"}"#.to_string(),
                    ),
                    ("PATCH", "/config") => (200, r#"{"ok":true}"#.to_string()),
                    ("DELETE", u) if u.starts_with("/config/") => (200, r#"{"ok":true}"#.to_string()),
                    _ => (404, r#"{"ok":false}"#.to_string()),
                };
                let resp = tiny_http::Response::from_string(payload)
                    .with_status_code(status)
                    .with_header("Content-Type: application/json".parse::<tiny_http::Header>().unwrap());
                let _ = req.respond(resp);
            }
        });
        (format!("http://127.0.0.1:{port}"), seen)
    }

    #[tokio::test]
    async fn fetch_settings_maps_the_workers_config_to_selected_levels() {
        let (url, _) = spawn_worker();
        let view = fetch_settings(&url, "tok", Locale::En).await.expect("view");

        // The Worker returned its shipped defaults, so every control must read
        // as its default level.
        for (control_id, level_id) in DEFAULT_LEVELS {
            let c = view.controls.iter().find(|c| c.id == *control_id).expect("control present");
            assert_eq!(c.level.as_deref(), Some(*level_id), "{control_id} read as the wrong level");
        }
        assert_eq!(view.llm_model, "@cf/meta/llama-4-scout-17b-16e-instruct");
    }

    #[tokio::test]
    async fn fetch_settings_marks_the_two_forward_only_controls() {
        let (url, _) = spawn_worker();
        let view = fetch_settings(&url, "tok", Locale::En).await.unwrap();
        let forward: Vec<&str> = view.controls.iter().filter(|c| c.forward_only).map(|c| c.id).collect();
        assert_eq!(forward, vec!["duplicates", "compression"]);
    }

    #[tokio::test]
    async fn fetch_settings_sends_the_bearer_token() {
        let (url, seen) = spawn_worker();
        fetch_settings(&url, "secret-token", Locale::En).await.unwrap();
        let log = seen.lock().unwrap();
        assert!(log[0].contains("auth=Bearer secret-token"), "got: {}", log[0]);
    }

    #[tokio::test]
    async fn apply_level_patches_only_that_controls_keys() {
        let (url, seen) = spawn_worker();
        apply_settings(&url, "tok", &[("variety".into(), "varied".into())], &[], None, Locale::En)
            .await
            .unwrap();
        let log = seen.lock().unwrap();
        assert!(log[0].starts_with("PATCH /config"), "got: {}", log[0]);
        assert!(log[0].contains("MMR_LAMBDA"));
        // A control must never write a key it does not own.
        assert!(!log[0].contains("RECENCY_FLOOR"), "leaked another control's key: {}", log[0]);
    }

    #[tokio::test]
    async fn apply_level_rejects_an_unknown_level_without_calling_the_worker() {
        let (url, seen) = spawn_worker();
        let err = apply_settings(&url, "tok", &[("variety".into(), "nonsense".into())], &[], None, Locale::En).await;
        assert!(err.is_err());
        assert!(seen.lock().unwrap().is_empty(), "must not hit the Worker for an invalid level");
    }

    #[tokio::test]
    async fn apply_level_surfaces_the_workers_validation_message() {
        let (url, _) = spawn_worker();
        // The fake Worker 400s on a body containing "BAD".
        let err = patch_config(&url, "tok", &serde_json::json!({"BAD": 99}), Locale::En)
            .await
            .expect_err("should fail");
        assert!(err.contains("must be between 0 and 1"), "lost the Worker's message: {err}");
    }

    #[tokio::test]
    async fn reset_control_deletes_every_key_the_control_owns() {
        let (url, seen) = spawn_worker();
        reset_control(&url, "tok", "recency", Locale::En).await.unwrap();
        let log = seen.lock().unwrap();
        assert_eq!(log.len(), 3, "recency owns three keys, got {} calls", log.len());
        for key in control("recency").unwrap().keys {
            assert!(
                log.iter().any(|l| l.contains(&format!("DELETE /config/{key}"))),
                "never reset {key}: {log:?}"
            );
        }
    }

    #[tokio::test]
    async fn reset_control_rejects_an_unknown_control_without_calling_the_worker() {
        let (url, seen) = spawn_worker();
        assert!(reset_control(&url, "tok", "nope", Locale::En).await.is_err());
        assert!(seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_unreachable_worker_is_a_readable_error_not_a_panic() {
        // Port 1 is reserved and will refuse instantly.
        let err = fetch_settings("http://127.0.0.1:1", "tok", Locale::En).await;
        assert!(err.is_err());
    }


    /// Every control and level id must have copy in both locales.
    ///
    /// The ids live in Rust and the copy lives in TypeScript, so no compiler
    /// spans the two. Adding a level here without copy would render a blank
    /// radio button; the TS `Messages` type enforces en/it parity, but it
    /// cannot know what Rust defines.
    #[test]
    fn every_control_and_level_has_copy_in_both_locales() {
        for locale_file in ["en.ts", "it.ts"] {
            let path = format!("{}/../src/i18n/{}", env!("CARGO_MANIFEST_DIR"), locale_file);
            let src = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
            let start = src.find("settingsPanel:").unwrap_or_else(|| panic!("{locale_file} has no settingsPanel"));
            let panel = &src[start..];

            for c in CONTROLS {
                assert!(
                    panel.contains(&format!("{}: {{", c.id)),
                    "{locale_file} has no copy for control {}",
                    c.id
                );
                for l in c.levels {
                    assert!(
                        panel.contains(&format!("{}: {{", l.id)),
                        "{locale_file} has no copy for {}/{}",
                        c.id,
                        l.id
                    );
                }
            }
            // The forward-only pair each need their explanatory note.
            for c in CONTROLS.iter().filter(|c| c.forward_only) {
                let seg_start = panel.find(&format!("{}: {{", c.id)).unwrap();
                let seg = &panel[seg_start..(seg_start + 1200).min(panel.len())];
                assert!(seg.contains("note:"), "{locale_file}: {} is forward-only but has no note", c.id);
            }
        }
    }


    #[tokio::test]
    async fn every_control_in_the_view_names_its_default_level() {
        let (url, _) = spawn_worker();
        let view = fetch_settings(&url, "tok", Locale::En).await.unwrap();
        for c in &view.controls {
            assert!(!c.default_level.is_empty(), "{} has no default level in the view", c.id);
        }
    }


    /// The settings window groups controls into sections with a hardcoded list.
    /// A control missing from it would simply never render — no error, no blank
    /// space, just a setting the user cannot reach.
    #[test]
    fn the_settings_window_renders_every_control() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/settings.ts");
        let src = std::fs::read_to_string(path).expect("read settings.ts");
        let start = src.find("const SECTIONS").expect("SECTIONS list");
        // Anchored to a `];` at the start of a line. A bare `find("];")` matched
        // inside the declaration's own type annotation (`controls: string[];`)
        // once that was written across several lines, silently truncating the
        // slice to nothing and failing on a file that was perfectly correct.
        let end = src[start..].find("\n];").expect("end of SECTIONS") + start;
        let sections = &src[start..end];
        for c in CONTROLS {
            assert!(
                sections.contains(&format!("\"{}\"", c.id)),
                "settings.ts SECTIONS omits {} — it would never render",
                c.id
            );
        }
    }


    /// A Worker deployed before #245 has no /config route and answers 404.
    ///
    /// Found by running the real app against a real brain: the generic handler
    /// reported "Your Second Brain returned 404.", which is accurate and
    /// useless. The app and the Worker update independently, so this is the
    /// normal state for anyone who updates the app first — it needs to say what
    /// to do, not what happened.
    #[tokio::test]
    async fn a_worker_without_the_config_route_says_to_update_it() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        std::thread::spawn(move || {
            while let Ok(req) = server.recv() {
                let _ = req.respond(tiny_http::Response::from_string("Not found").with_status_code(404));
            }
        });

        let err = fetch_settings(&format!("http://127.0.0.1:{port}"), "tok", Locale::En)
            .await
            .expect_err("404 must be an error");

        assert!(
            err.to_lowercase().contains("update"),
            "404 must point at the Worker update, got: {err}"
        );
        assert!(!err.contains("404"), "a bare status code is not actionable: {err}");
    }


    #[tokio::test]
    async fn saving_several_controls_sends_one_merged_patch() {
        let (url, seen) = spawn_worker();
        apply_settings(
            &url, "tok",
            &[("variety".into(), "varied".into()), ("detail".into(), "compact".into())],
            &[],
            None,
            Locale::En,
        ).await.unwrap();

        let log = seen.lock().unwrap();
        let patches: Vec<&String> = log.iter().filter(|l| l.starts_with("PATCH")).collect();
        // One request, not one per control: the Worker validates invariants
        // against the merged result, so splitting them could reject a change
        // that is valid as a whole.
        assert_eq!(patches.len(), 1, "expected a single merged PATCH, got {patches:?}");
        assert!(patches[0].contains("MMR_LAMBDA"));
        assert!(patches[0].contains("SNIPPET_MAX_CHARS"));
    }

    #[tokio::test]
    async fn saving_includes_the_model_when_it_changed() {
        let (url, seen) = spawn_worker();
        apply_settings(&url, "tok", &[], &[], Some("@cf/some/model".into()), Locale::En)
            .await
            .unwrap();
        let log = seen.lock().unwrap();
        assert!(log[0].contains("LLM_MODEL"), "got: {}", log[0]);
    }

    #[tokio::test]
    async fn saving_a_reset_deletes_that_controls_keys() {
        let (url, seen) = spawn_worker();
        apply_settings(&url, "tok", &[], &["recency".into()], None, Locale::En)
            .await
            .unwrap();
        let log = seen.lock().unwrap();
        let deletes = log.iter().filter(|l| l.starts_with("DELETE")).count();
        assert_eq!(deletes, 3, "recency owns three keys, got {deletes} deletes");
    }

    #[tokio::test]
    async fn saving_nothing_makes_no_requests() {
        let (url, seen) = spawn_worker();
        apply_settings(&url, "tok", &[], &[], None, Locale::En).await.unwrap();
        assert!(seen.lock().unwrap().is_empty(), "an empty save must not call the Worker");
    }

    #[tokio::test]
    async fn saving_an_unknown_level_fails_before_any_request() {
        let (url, seen) = spawn_worker();
        let r = apply_settings(&url, "tok", &[("variety".into(), "nope".into())], &[], None, Locale::En).await;
        assert!(r.is_err());
        assert!(seen.lock().unwrap().is_empty(), "must validate before writing anything");
    }

    #[test]
    fn ships_seven_controls_counting_the_model_dropdown() {
        // Six level controls here; the seventh (LLM_MODEL) is a dropdown and is
        // deliberately not modelled as levels.
        assert_eq!(CONTROLS.len(), 6);
    }
}
