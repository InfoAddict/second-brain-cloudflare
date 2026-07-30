//! A local stand-in for a real Second Brain, so demo mode has data to operate on.
//!
//! `SECOND_BRAIN_DRY_RUN=1` used to point the app at
//! `https://second-brain.demo.workers.dev`, which does not resolve. Every
//! Worker-backed screen therefore failed with "Couldn't reach your Second
//! Brain" — the Advanced Settings window would not open at all, and the
//! embedding-migration pane could not be exercised even once.
//!
//! # Why a real server rather than a `dry_run` branch
//!
//! The obvious fix is an `if session.dry_run` early return inside
//! [`crate::settings::fetch_settings`] and friends. That would prove nothing: the
//! request, the JSON parsing, the status mapping and the error copy would all be
//! skipped, so a clean demo run would say only that the short-circuit works.
//!
//! Instead this binds a real `tiny_http` listener on `127.0.0.1:0` and demo mode
//! is handed its address. `fetch_settings`, `apply_settings`, `reset_control`,
//! `fetch_estimate`, `run_batch` and `fetch_status` then execute completely
//! unchanged — real HTTP, real bearer auth, real deserialisation, real error
//! mapping. A demo run is evidence about the shipping code path.
//!
//! `tiny_http` is already a production dependency: [`crate::cf::oauth`] uses it
//! for the Cloudflare loopback callback. Nothing new is pulled in.
//!
//! # The config is derived, never typed out
//!
//! [`shipped_config`] is built from [`crate::settings::DEFAULT_LEVELS`] and the
//! levels in [`crate::settings::CONTROLS`], so the demo brain reports exactly the
//! keys and values the controls write. A hardcoded blob would drift the moment a
//! level was retuned, and the window would open showing "Custom" for a brain that
//! is in fact untouched — the single most misleading thing this could do.

use serde_json::{json, Map, Value};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The owner's own brain size, so the numbers on screen are plausible rather
/// than obviously synthetic.
pub const ENTRIES: u64 = 1620;
/// A lower bound, the way the Worker reports it.
pub const CHUNKS_AT_LEAST: u64 = 2100;

/// Entries per re-embed batch. Close to what the Worker actually manages —
/// `MIGRATION_CHUNK_BUDGET` is 20 chunks and most entries are one chunk — which
/// is what makes a demo rebuild take ~80 batches instead of finishing in one and
/// leaving the progress bar untested.
const BATCH_ENTRIES: u64 = 20;

/// Enough that progress is visible on screen, small enough that a full rebuild
/// of 1,620 entries takes about 20 seconds.
const BATCH_PAUSE: Duration = Duration::from_millis(250);

/// Set to a batch count to make the rebuild pause once, as it does when the
/// day's embedding allowance runs out. The "Paused for today" screen is
/// otherwise unreachable in a demo.
const STALL_ENV: &str = "SECOND_BRAIN_DEMO_STALL_AFTER";

/// Shipped in `src/config.ts` DEFAULTS. Both must be values the pickers offer,
/// or the settings window shows a model that is not in its own dropdown and the
/// migration pane cannot read the current dimensions — asserted in tests.
const DEMO_LLM_MODEL: &str = "@cf/meta/llama-4-scout-17b-16e-instruct";
const DEMO_EMBEDDING_MODEL: &str = "@cf/baai/bge-small-en-v1.5";

/// Returned when loopback cannot be bound at all. Port 1 refuses instantly, so
/// the app reports "Couldn't reach your Second Brain" — the truth — rather than
/// hanging.
const UNREACHABLE: &str = "http://127.0.0.1:1";

const THREADS: usize = 3;

// ── Options ─────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct Options {
    pub entries: u64,
    pub chunks_at_least: u64,
    pub batch_entries: u64,
    /// Deliberate delay per batch, so a demo rebuild is watchable. Zero in tests.
    pub batch_pause: Duration,
    /// Pause the rebuild once, after this many batches.
    pub stall_after: Option<u64>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            entries: ENTRIES,
            chunks_at_least: CHUNKS_AT_LEAST,
            batch_entries: BATCH_ENTRIES,
            batch_pause: BATCH_PAUSE,
            stall_after: parse_stall_after(std::env::var(STALL_ENV).ok().as_deref()),
        }
    }
}

/// Split out from the env read so it can be tested without `set_var`, which
/// races every other test in the process.
fn parse_stall_after(raw: Option<&str>) -> Option<u64> {
    let n = raw?.trim().parse::<u64>().ok()?;
    // 0 would stall before the first batch, leaving no progress to resume from —
    // which is not the state the paused screen is for.
    (n > 0).then_some(n)
}

// ── Config ──────────────────────────────────────────────────────────────────

/// The effective config a fresh brain reports, built from the controls
/// themselves.
///
/// Every key each control owns is present at its default level, so the settings
/// window renders every control at a named level. A control reading "Custom" on
/// an untouched demo brain would be a lie about what the user is looking at.
pub fn shipped_config() -> Map<String, Value> {
    let mut out = Map::new();
    for (control_id, level_id) in crate::settings::DEFAULT_LEVELS {
        // `settings.rs` asserts every entry here names a real control and a real
        // level of it, and that a level writes exactly that control's keys.
        let patch = crate::settings::patch_for(control_id, level_id)
            .expect("DEFAULT_LEVELS names a control and a level it has");
        out.extend(patch);
    }
    out.insert("LLM_MODEL".into(), json!(DEMO_LLM_MODEL));
    out.insert("EMBEDDING_MODEL".into(), json!(DEMO_EMBEDDING_MODEL));
    out
}

fn effective(overrides: &Map<String, Value>) -> Map<String, Value> {
    let mut cfg = shipped_config();
    for (key, value) in overrides {
        cfg.insert(key.clone(), value.clone());
    }
    cfg
}

fn embedding_model(overrides: &Map<String, Value>) -> String {
    effective(overrides)
        .get("EMBEDDING_MODEL")
        .and_then(|v| v.as_str())
        .unwrap_or(DEMO_EMBEDDING_MODEL)
        .to_string()
}

// ── State ───────────────────────────────────────────────────────────────────

/// The KV ledger `src/migration/embedding.ts` keeps, minus the parts only D1
/// needs. Held in memory so a PATCH is visible to the next GET and a rebuild
/// survives across the many requests it takes — the point of the exercise is
/// that saving a setting and reopening the window shows the saved value.
struct Ledger {
    model: String,
    started_at: u64,
    cursor_created_at: Option<u64>,
    cursor_id: Option<String>,
    processed: u64,
    failed: u64,
    total_at_start: u64,
    finished_at: Option<u64>,
    /// Batches completed, for the stall gate.
    batches: u64,
    /// The allowance is only exhausted once per demo, so Resume finishes the
    /// rebuild instead of pausing again on every click.
    stalled_once: bool,
}

impl Ledger {
    fn new(model: String, total: u64) -> Self {
        Self {
            model,
            started_at: now_ms(),
            cursor_created_at: None,
            cursor_id: None,
            processed: 0,
            failed: 0,
            total_at_start: total,
            finished_at: None,
            batches: 0,
            stalled_once: false,
        }
    }

    fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("model".into(), json!(self.model));
        out.insert("startedAt".into(), json!(self.started_at));
        out.insert("cursorCreatedAt".into(), json!(self.cursor_created_at));
        out.insert("cursorId".into(), json!(self.cursor_id));
        out.insert("processed".into(), json!(self.processed));
        out.insert("failed".into(), json!(self.failed));
        out.insert("totalAtStart".into(), json!(self.total_at_start));
        // Absent rather than null until the rebuild finishes, matching
        // `MigrationState.finishedAt?`.
        if let Some(at) = self.finished_at {
            out.insert("finishedAt".into(), json!(at));
        }
        Value::Object(out)
    }
}

#[derive(Default)]
struct State {
    /// Sparse, exactly like `config:overrides` in KV.
    overrides: Map<String, Value>,
    ledger: Option<Ledger>,
}

struct Demo {
    options: Options,
    state: Mutex<State>,
}

// ── Routes ──────────────────────────────────────────────────────────────────

impl Demo {
    fn new(options: Options) -> Self {
        Self { options, state: Mutex::new(State::default()) }
    }

    fn handle(&self, method: &str, path: &str, body: &str) -> (u16, Value) {
        match (method, path) {
            ("GET", "/health") => (200, self.health()),
            ("GET", "/config") => (200, self.config_body()),
            ("PATCH", "/config") => self.patch_config(body),
            ("DELETE", p) if p.starts_with("/config/") => {
                self.reset_key(&p["/config/".len()..])
            }
            ("GET", "/migration/estimate") => (200, self.estimate()),
            ("GET", "/migration/status") => (200, self.status()),
            ("POST", "/migration/reembed") => (200, self.reembed()),
            ("POST", "/migration/reset") => {
                self.state.lock().unwrap().ledger = None;
                (200, json!({ "ok": true }))
            }
            _ => (404, json!({ "ok": false, "error": "Not found" })),
        }
    }

    /// `{ ok, version, vectorize }`, as `src/routes/admin.ts` returns it. The
    /// index it names follows the model in force, so a demo migration changes
    /// what health reports the way a real one does.
    fn health(&self) -> Value {
        let manifest = crate::worker_bundle::manifest();
        let model = embedding_model(&self.state.lock().unwrap().overrides);
        let dimensions =
            crate::migration::dimensions_for(&model).unwrap_or(manifest.vectorize_dimensions);
        json!({
            "ok": true,
            "version": manifest.worker_version,
            "vectorize": {
                "ok": true,
                "indexName": crate::migration::index_name_for(
                    &manifest.vectorize_name,
                    dimensions,
                    manifest.vectorize_dimensions,
                ),
                "dimensions": dimensions,
                "vectorCount": self.options.chunks_at_least,
            }
        })
    }

    /// Three things, not one: a settings UI needs the effective values, the
    /// sparse overrides and the shipped defaults to say "changed from 0.7 to
    /// 0.45" and to know whether a reset control should be live at all.
    fn config_body(&self) -> Value {
        let state = self.state.lock().unwrap();
        json!({
            "ok": true,
            "config": effective(&state.overrides),
            "overrides": state.overrides,
            "defaults": shipped_config(),
        })
    }

    /// Sparse merge. The whole patch is rejected if any key is unknown, so a
    /// batch that names one bad setting writes nothing.
    fn patch_config(&self, body: &str) -> (u16, Value) {
        let Ok(Value::Object(patch)) = serde_json::from_str::<Value>(body) else {
            return (
                400,
                json!({ "ok": false, "error": "Body must be an object of setting → value" }),
            );
        };
        let known = shipped_config();
        for key in patch.keys() {
            if !known.contains_key(key) {
                return (400, json!({ "ok": false, "error": format!("{key} is not a known setting") }));
            }
        }
        let mut state = self.state.lock().unwrap();
        for (key, value) in patch {
            state.overrides.insert(key, value);
        }
        (200, json!({ "ok": true, "config": effective(&state.overrides) }))
    }

    /// Per-setting reset: drop the override so the value rejoins the shipped
    /// default, rather than writing that default back.
    fn reset_key(&self, key: &str) -> (u16, Value) {
        if !shipped_config().contains_key(key) {
            return (404, json!({ "ok": false, "error": format!("{key} is not a known setting") }));
        }
        let mut state = self.state.lock().unwrap();
        state.overrides.remove(key);
        (200, json!({ "ok": true, "config": effective(&state.overrides) }))
    }

    fn estimate(&self) -> Value {
        let model = embedding_model(&self.state.lock().unwrap().overrides);
        json!({
            "ok": true,
            "entries": self.options.entries,
            "chunksAtLeast": self.options.chunks_at_least,
            "model": model,
        })
    }

    /// `state` is null until a rebuild has ever been started for this brain.
    fn status(&self) -> Value {
        let state = self.state.lock().unwrap();
        json!({
            "ok": true,
            "state": state.ledger.as_ref().map(Ledger::to_json).unwrap_or(Value::Null),
            "model": embedding_model(&state.overrides),
        })
    }

    /// One bounded batch, the shape the app loops on.
    ///
    /// Mirrors `runBatch`: a target change mid-run restarts from the beginning,
    /// because entries before the cursor hold vectors from the previous target;
    /// `remaining` is recomputed every call; and `done` is only ever true once
    /// `remaining` has reached 0.
    fn reembed(&self) -> Value {
        // Outside the lock: holding it across the sleep would serialise an
        // unrelated /config read behind a batch.
        if !self.options.batch_pause.is_zero() {
            std::thread::sleep(self.options.batch_pause);
        }

        let total = self.options.entries;
        let mut state = self.state.lock().unwrap();
        let target = embedding_model(&state.overrides);

        let restart = state.ledger.as_ref().map(|l| l.model != target).unwrap_or(true);
        if restart {
            state.ledger = Some(Ledger::new(target, total));
        }
        let pause_after = self.options.stall_after;
        let batch = self.options.batch_entries;
        let ledger = state.ledger.as_mut().expect("just ensured");

        // The day's allowance running out. The cursor is kept, so resuming costs
        // nothing already paid for.
        if let Some(after) = pause_after {
            if ledger.batches >= after && !ledger.stalled_once && ledger.processed < total {
                ledger.stalled_once = true;
                ledger.failed += 1;
                return json!({
                    "ok": true,
                    "processed": 0,
                    "failed": 1,
                    "remaining": total - ledger.processed,
                    "total": ledger.total_at_start.max(ledger.processed + (total - ledger.processed)),
                    "done": false,
                    "stalled": true,
                    "stalledReason": "budget",
                });
            }
        }

        let processed = batch.min(total.saturating_sub(ledger.processed));
        ledger.processed += processed;
        ledger.batches += 1;
        let remaining = total.saturating_sub(ledger.processed);
        if processed > 0 {
            ledger.cursor_created_at = Some(cursor_time(ledger.processed, total, now_ms()));
            ledger.cursor_id = Some(format!("demo-entry-{:05}", ledger.processed));
        }
        let done = remaining == 0;
        if done && ledger.finished_at.is_none() {
            ledger.finished_at = Some(now_ms());
        }

        json!({
            "ok": true,
            "processed": processed,
            // Per batch, not cumulative — the ledger carries the running total.
            "failed": 0,
            "remaining": remaining,
            "total": ledger.total_at_start.max(ledger.processed + remaining),
            "done": done,
            "stalled": false,
        })
    }
}

/// Entries are spread over the last three years, so the keyset cursor advances
/// through time the way a real one does.
fn cursor_time(processed: u64, entries: u64, now: u64) -> u64 {
    const SPAN_MS: u64 = 3 * 365 * 86_400_000;
    now.saturating_sub(SPAN_MS) + SPAN_MS * processed / entries.max(1)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

// ── Server ──────────────────────────────────────────────────────────────────

/// Shown when demo mode opens the dashboard. The wrapper window would otherwise
/// load a blank page from an address that has no dashboard behind it.
const PLACEHOLDER: &str = "<!doctype html><meta charset=\"utf-8\">\
<title>Second Brain — demo</title>\
<style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;margin:12vh auto;max-width:34rem;padding:0 1.5rem;color:#1d1d1f}\
h1{font-size:1.35rem;margin:0 0 .6rem}p{color:#6e6e73}@media(prefers-color-scheme:dark){body{background:#1c1c1e;color:#f5f5f7}p{color:#98989d}}</style>\
<h1>Demo brain</h1>\
<p>This is a stand-in Second Brain running on this computer. It answers the app's \
settings and rebuild requests with plausible data so the flow can be tried end to \
end; it holds no memories of its own.</p>";

fn json_response(status: u16, payload: &Value) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    tiny_http::Response::from_string(payload.to_string())
        .with_status_code(status)
        .with_header(
            "Content-Type: application/json"
                .parse::<tiny_http::Header>()
                .expect("static header"),
        )
}

/// Every route the real Worker guards with `requireAuth` is guarded here, so a
/// demo run is also evidence the app sends its token.
///
/// Any non-empty bearer token is accepted rather than one literal string: what
/// is worth proving is that the app authenticates at all, and pinning the value
/// would turn an unrelated change of the demo token into a window full of 401s.
fn is_authenticated(req: &tiny_http::Request) -> bool {
    req.headers()
        .iter()
        .filter(|h| h.field.equiv("authorization"))
        .any(|h| {
            let value = h.value.to_string();
            value
                .strip_prefix("Bearer ")
                .is_some_and(|token| !token.trim().is_empty())
        })
}

fn serve(server: &tiny_http::Server, demo: &Demo) {
    loop {
        let Ok(mut req) = server.recv() else { return };
        let method = req.method().as_str().to_string();
        let raw = req.url().to_string();
        let path = raw.split('?').next().unwrap_or_default().to_string();
        let authed = is_authenticated(&req);
        let mut body = String::new();
        let _ = std::io::Read::read_to_string(req.as_reader(), &mut body);

        if method == "GET" && (path == "/" || path == "/index.html") {
            let response = tiny_http::Response::from_string(PLACEHOLDER).with_header(
                "Content-Type: text/html; charset=utf-8"
                    .parse::<tiny_http::Header>()
                    .expect("static header"),
            );
            let _ = req.respond(response);
            continue;
        }

        let (status, payload) = if authed {
            demo.handle(&method, &path, &body)
        } else {
            (401, json!({ "ok": false, "error": "Unauthorized" }))
        };
        let _ = req.respond(json_response(status, &payload));
    }
}

/// Binds a demo brain on an ephemeral loopback port and returns its base URL.
///
/// A small pool rather than one thread: a re-embed batch sleeps, and a single
/// handler would hold an unrelated /config read behind it.
pub fn spawn(options: Options) -> Option<String> {
    let server = tiny_http::Server::http("127.0.0.1:0").ok()?;
    let port = server.server_addr().to_ip()?.port();
    let server = Arc::new(server);
    let demo = Arc::new(Demo::new(options));
    for _ in 0..THREADS {
        let server = server.clone();
        let demo = demo.clone();
        std::thread::spawn(move || serve(&server, &demo));
    }
    Some(format!("http://127.0.0.1:{port}"))
}

static RUNNING: OnceLock<String> = OnceLock::new();

/// The demo brain's address, starting it if it is not already up.
///
/// Lazy as well as started at launch so no caller can be handed a dead address:
/// the port is chosen by the OS, so it cannot be a constant.
pub fn base_url() -> String {
    RUNNING
        .get_or_init(|| match spawn(Options::default()) {
            Some(url) => {
                log::info!("demo brain listening on {url}");
                url
            }
            None => {
                log::warn!("could not bind the demo brain to loopback");
                UNREACHABLE.to_string()
            }
        })
        .clone()
}

/// Brings the demo brain up at launch, before any window can ask for it.
pub fn start() {
    let _ = base_url();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::Locale;
    use crate::settings::{self, CONTROLS, DEFAULT_LEVELS};

    /// A demo brain with the delay removed. Everything else is what a real demo
    /// run uses, so the tests exercise the shipped numbers.
    fn brain() -> String {
        spawn(Options { batch_pause: Duration::ZERO, stall_after: None, ..Options::default() })
            .expect("bind loopback")
    }

    fn brain_with(options: Options) -> String {
        spawn(options).expect("bind loopback")
    }

    async fn get(url: &str, path: &str) -> (u16, Value) {
        let resp = reqwest::Client::new()
            .get(format!("{url}{path}"))
            .bearer_auth("demo")
            .send()
            .await
            .expect("request");
        let status = resp.status().as_u16();
        (status, resp.json().await.unwrap_or(Value::Null))
    }

    async fn post(url: &str, path: &str) -> (u16, Value) {
        let resp = reqwest::Client::new()
            .post(format!("{url}{path}"))
            .bearer_auth("demo")
            .send()
            .await
            .expect("request");
        let status = resp.status().as_u16();
        (status, resp.json().await.unwrap_or(Value::Null))
    }

    // ── The config the window renders ───────────────────────────────────────

    /// The whole point of deriving the payload from `CONTROLS`: every control
    /// must find all of its keys, or the window renders it as "Custom" — a lie
    /// about a brain nobody has touched.
    #[tokio::test]
    async fn the_demo_config_carries_every_key_every_control_owns() {
        let url = brain();
        let (status, body) = get(&url, "/config").await;
        assert_eq!(status, 200);
        let config = body["config"].as_object().expect("config object");
        for c in CONTROLS {
            for key in c.keys {
                assert!(
                    config.contains_key(*key),
                    "control {} owns {key}, which the demo config omits",
                    c.id
                );
            }
        }
    }

    /// Stronger than key presence: each control must resolve to a *named* level,
    /// and specifically to its default one.
    #[tokio::test]
    async fn every_control_reads_as_its_default_level_not_custom() {
        let url = brain();
        let view = settings::fetch_settings(&url, "demo", Locale::En).await.expect("view");
        for (control_id, level_id) in DEFAULT_LEVELS {
            let c = view.controls.iter().find(|c| c.id == *control_id).expect("control present");
            assert_eq!(
                c.level.as_deref(),
                Some(*level_id),
                "{control_id} read as {:?} rather than its default",
                c.level
            );
        }
        assert_eq!(view.llm_model, DEMO_LLM_MODEL);
    }

    /// The two models must be ones the pickers offer. An LLM_MODEL outside
    /// `LLM_MODELS` renders an empty dropdown selection; an EMBEDDING_MODEL
    /// outside `EMBEDDING_MODELS` leaves `oldDimensions` null, which makes the
    /// last migration step unreachable.
    #[test]
    fn both_demo_models_are_offered_by_the_pickers() {
        assert!(
            settings::LLM_MODELS.contains(&DEMO_LLM_MODEL),
            "{DEMO_LLM_MODEL} is not in the dropdown"
        );
        assert!(
            crate::migration::dimensions_for(DEMO_EMBEDDING_MODEL).is_some(),
            "{DEMO_EMBEDDING_MODEL} has no known dimensions"
        );
    }

    /// The demo must not report a setting the Worker's config layer does not
    /// define, or a PATCH the window sends would 400 against a real brain while
    /// passing here.
    #[test]
    fn the_demo_config_only_names_settings_the_worker_ships() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../src/config.ts");
        let src = std::fs::read_to_string(path).expect("read src/config.ts");
        let start = src.find("export const DEFAULTS").expect("DEFAULTS block");
        let end = src[start..].find("} as const;").expect("end of DEFAULTS") + start;
        let defaults = &src[start..end];
        for key in shipped_config().keys() {
            assert!(
                defaults.contains(&format!("{key}:")),
                "{key} is not a Worker default — the demo reports a setting that does not exist"
            );
        }
        // And the two model strings must be the shipped ones, not a guess.
        assert!(
            defaults.contains(&format!("LLM_MODEL: \"{DEMO_LLM_MODEL}\"")),
            "LLM_MODEL drifted from src/config.ts"
        );
        assert!(
            defaults.contains(&format!("EMBEDDING_MODEL: \"{DEMO_EMBEDDING_MODEL}\"")),
            "EMBEDDING_MODEL drifted from src/config.ts"
        );
    }

    #[tokio::test]
    async fn config_reports_effective_values_overrides_and_defaults_separately() {
        let url = brain();
        let (_, body) = get(&url, "/config").await;
        for key in ["config", "overrides", "defaults"] {
            assert!(body.get(key).is_some(), "/config omits {key}");
        }
        assert!(
            body["overrides"].as_object().expect("object").is_empty(),
            "a fresh brain has overridden nothing"
        );
        assert_eq!(body["config"]["MMR_LAMBDA"], json!(0.7));
    }

    // ── State survives across calls ─────────────────────────────────────────

    /// The reason this holds state at all: save a setting, reopen the window,
    /// see the saved value.
    #[tokio::test]
    async fn a_saved_level_is_what_the_next_read_reports() {
        let url = brain();
        settings::apply_settings(
            &url,
            "demo",
            &[("variety".into(), "varied".into())],
            &[],
            None,
            Locale::En,
        )
        .await
        .expect("save");

        let view = settings::fetch_settings(&url, "demo", Locale::En).await.expect("view");
        let variety = view.controls.iter().find(|c| c.id == "variety").expect("variety");
        assert_eq!(variety.level.as_deref(), Some("varied"));

        // ...and only that control moved.
        let detail = view.controls.iter().find(|c| c.id == "detail").expect("detail");
        assert_eq!(detail.level.as_deref(), Some("standard"));
    }

    #[tokio::test]
    async fn a_patch_records_a_sparse_override_and_leaves_the_defaults_alone() {
        let url = brain();
        settings::patch_config(&url, "demo", &json!({ "MMR_LAMBDA": 0.45 }), Locale::En)
            .await
            .expect("patch");
        let (_, body) = get(&url, "/config").await;
        let overrides = body["overrides"].as_object().expect("object");
        assert_eq!(overrides.len(), 1, "only the changed key belongs in overrides: {overrides:?}");
        assert_eq!(overrides["MMR_LAMBDA"], json!(0.45));
        assert_eq!(body["config"]["MMR_LAMBDA"], json!(0.45));
        assert_eq!(body["defaults"]["MMR_LAMBDA"], json!(0.7), "the shipped default must not move");
    }

    #[tokio::test]
    async fn resetting_a_control_drops_its_overrides_and_returns_the_default_level() {
        let url = brain();
        settings::apply_settings(
            &url,
            "demo",
            &[("recency".into(), "recent_first".into())],
            &[],
            None,
            Locale::En,
        )
        .await
        .expect("save");
        settings::reset_control(&url, "demo", "recency", Locale::En).await.expect("reset");

        let (_, body) = get(&url, "/config").await;
        assert!(
            body["overrides"].as_object().expect("object").is_empty(),
            "a reset must delete the overrides, not write the default back"
        );
        let view = settings::fetch_settings(&url, "demo", Locale::En).await.expect("view");
        let recency = view.controls.iter().find(|c| c.id == "recency").expect("recency");
        assert_eq!(recency.level.as_deref(), Some("balanced"));
    }

    #[tokio::test]
    async fn a_patch_naming_an_unknown_setting_is_refused_and_writes_nothing() {
        let url = brain();
        let err = settings::patch_config(
            &url,
            "demo",
            &json!({ "MMR_LAMBDA": 0.45, "NOT_A_SETTING": 1 }),
            Locale::En,
        )
        .await
        .expect_err("must be refused");
        assert!(err.contains("NOT_A_SETTING"), "the error must name the key: {err}");

        let (_, body) = get(&url, "/config").await;
        assert!(
            body["overrides"].as_object().expect("object").is_empty(),
            "a rejected patch must not write its valid half"
        );
    }

    #[tokio::test]
    async fn deleting_an_unknown_setting_is_a_404() {
        let url = brain();
        let resp = reqwest::Client::new()
            .delete(format!("{url}/config/NOT_A_SETTING"))
            .bearer_auth("demo")
            .send()
            .await
            .expect("request");
        assert_eq!(resp.status().as_u16(), 404);
    }

    #[tokio::test]
    async fn requests_without_a_bearer_token_are_refused() {
        let url = brain();
        let resp = reqwest::Client::new()
            .get(format!("{url}/config"))
            .send()
            .await
            .expect("request");
        assert_eq!(resp.status().as_u16(), 401, "the real Worker requires auth on /config");
    }

    // ── Migration ───────────────────────────────────────────────────────────

    #[tokio::test]
    async fn the_estimate_reports_a_plausible_brain_through_the_apps_own_parser() {
        let url = brain();
        let est = crate::migration::fetch_estimate(&url, "demo", 384, Locale::En)
            .await
            .expect("estimate");
        // Pinned as literals, not against the constants: comparing a constant to
        // itself would pass whatever the demo brain claimed to hold, and the
        // whole point of these numbers is that they look like a real brain.
        assert_eq!(est.entries, 1620);
        assert_eq!(est.chunks_at_least, 2100);
        assert_eq!(est.current_model, DEMO_EMBEDDING_MODEL);
    }

    #[tokio::test]
    async fn status_is_null_until_a_rebuild_starts_then_carries_what_the_window_reads() {
        let url = brain();
        let before = crate::migration::fetch_status(&url, "demo", Locale::En).await.expect("status");
        assert!(before["state"].is_null(), "no rebuild has ever been started");
        assert_eq!(before["model"], json!(DEMO_EMBEDDING_MODEL));

        crate::migration::run_batch(&url, "demo", Locale::En).await.expect("batch");

        let after = crate::migration::fetch_status(&url, "demo", Locale::En).await.expect("status");
        let state = &after["state"];
        assert!(!state.is_null(), "a started rebuild must be on record");
        // The keys installer/src/settings.ts reads off MigrationRun.
        for key in ["model", "processed", "failed", "totalAtStart", "cursorId"] {
            assert!(state.get(key).is_some(), "the window reads state.{key}, which is absent");
        }
        assert!(
            state.get("finishedAt").is_none(),
            "an unfinished rebuild must not look finished"
        );
    }

    /// The rebuild has to take many batches, or the progress bar and the k-of-n
    /// counter are never exercised by a demo.
    #[tokio::test]
    async fn a_rebuild_takes_many_batches_and_only_finishes_once_nothing_is_left() {
        let url = brain();
        let mut batches = 0;
        let mut last_remaining = u64::MAX;
        let mut processed_total = 0;
        loop {
            let p = crate::migration::run_batch(&url, "demo", Locale::En).await.expect("batch");
            batches += 1;
            assert!(!p.stalled, "the default demo must run to completion");
            assert_eq!(p.total, 1620, "the bar counts up to the owner's brain size");
            assert!(
                p.remaining < last_remaining,
                "progress must advance: {} then {}",
                last_remaining,
                p.remaining
            );
            last_remaining = p.remaining;
            processed_total += p.processed;
            if p.done {
                assert_eq!(p.remaining, 0, "done must never be true with work left");
                break;
            }
            assert!(p.remaining > 0, "remaining reached 0 without done being set");
            assert!(batches < 500, "runaway loop");
        }
        assert!(batches > 10, "a one-batch rebuild proves nothing, got {batches}");
        assert_eq!(processed_total, 1620, "every entry must be accounted for");

        let status = crate::migration::fetch_status(&url, "demo", Locale::En).await.expect("status");
        assert!(
            status["state"]["finishedAt"].is_u64(),
            "a completed rebuild must be recorded as finished"
        );
    }

    /// The "Paused for today" screen, which is otherwise untestable. Progress is
    /// kept, and resuming carries on rather than pausing again.
    #[tokio::test]
    async fn the_stall_gate_pauses_once_with_progress_kept_then_resumes_to_completion() {
        let url = brain_with(Options {
            batch_pause: Duration::ZERO,
            stall_after: Some(3),
            ..Options::default()
        });

        let mut before = 0;
        for _ in 0..3 {
            let p = crate::migration::run_batch(&url, "demo", Locale::En).await.expect("batch");
            assert!(!p.stalled);
            before = ENTRIES - p.remaining;
        }
        assert!(before > 0, "there must be progress to keep");

        let paused = crate::migration::run_batch(&url, "demo", Locale::En).await.expect("batch");
        assert!(paused.stalled, "the fourth batch must pause");
        assert!(!paused.done);
        assert_eq!(paused.processed, 0, "a paused batch achieves nothing");
        assert_eq!(
            ENTRIES - paused.remaining,
            before,
            "pausing must keep the cursor, not lose it"
        );

        // Resume: one pause per demo, so the rest of the rebuild completes.
        let mut batches = 0;
        loop {
            let p = crate::migration::run_batch(&url, "demo", Locale::En).await.expect("batch");
            batches += 1;
            assert!(!p.stalled, "resuming must not pause again");
            if p.done {
                break;
            }
            assert!(batches < 500, "runaway loop");
        }
    }

    #[tokio::test]
    async fn reset_clears_the_ledger_so_status_reads_null_again() {
        let url = brain();
        crate::migration::run_batch(&url, "demo", Locale::En).await.expect("batch");
        crate::migration::reset(&url, "demo", Locale::En).await.expect("reset");
        let status = crate::migration::fetch_status(&url, "demo", Locale::En).await.expect("status");
        assert!(status["state"].is_null(), "the ledger must be gone");
    }

    /// A target change mid-run invalidates the cursor: the entries behind it hold
    /// vectors from the previous model. `runBatch` restarts, and so must this.
    #[tokio::test]
    async fn changing_the_target_model_restarts_the_rebuild() {
        let url = brain();
        for _ in 0..3 {
            crate::migration::run_batch(&url, "demo", Locale::En).await.expect("batch");
        }
        let partway = crate::migration::run_batch(&url, "demo", Locale::En).await.expect("batch");
        assert!(partway.remaining < ENTRIES);

        crate::migration::patch_embedding_model(&url, "demo", "@cf/baai/bge-base-en-v1.5", Locale::En)
            .await
            .expect("model write");

        let restarted = crate::migration::run_batch(&url, "demo", Locale::En).await.expect("batch");
        assert_eq!(
            restarted.remaining,
            ENTRIES - restarted.processed,
            "a new target must rebuild from the beginning"
        );

        let status = crate::migration::fetch_status(&url, "demo", Locale::En).await.expect("status");
        assert_eq!(status["state"]["model"], json!("@cf/baai/bge-base-en-v1.5"));
        assert_eq!(status["model"], json!("@cf/baai/bge-base-en-v1.5"));
    }

    /// The estimate follows the config, so the migration pane reflects a model
    /// change instead of showing the old one forever.
    #[tokio::test]
    async fn the_estimate_follows_the_model_in_force() {
        let url = brain();
        crate::migration::patch_embedding_model(&url, "demo", "@cf/baai/bge-large-en-v1.5", Locale::En)
            .await
            .expect("model write");
        let est = crate::migration::fetch_estimate(&url, "demo", 384, Locale::En).await.expect("estimate");
        assert_eq!(est.current_model, "@cf/baai/bge-large-en-v1.5");
    }

    // ── Everything else that must not break ─────────────────────────────────

    #[tokio::test]
    async fn health_answers_the_shape_the_version_check_reads() {
        let url = brain();
        let (status, body) = get(&url, "/health").await;
        assert_eq!(status, 200);
        assert_eq!(body["ok"], json!(true));
        assert!(body["version"].is_string(), "the update check reads version");
        assert_eq!(body["vectorize"]["ok"], json!(true));
        assert_eq!(
            body["vectorize"]["indexName"],
            json!(crate::worker_bundle::manifest().vectorize_name)
        );
    }

    /// Health names the index the brain is actually reading, so a demo migration
    /// changes it the way a real one does.
    #[tokio::test]
    async fn health_names_the_index_the_current_model_implies() {
        let url = brain();
        crate::migration::patch_embedding_model(&url, "demo", "@cf/baai/bge-base-en-v1.5", Locale::En)
            .await
            .expect("model write");
        let (_, body) = get(&url, "/health").await;
        assert_eq!(body["vectorize"]["dimensions"], json!(768));
        assert!(
            body["vectorize"]["indexName"].as_str().expect("string").ends_with("-768"),
            "got {}",
            body["vectorize"]["indexName"]
        );
    }

    #[tokio::test]
    async fn an_unknown_route_is_a_404_the_way_the_worker_answers_one() {
        let url = brain();
        let (status, _) = post(&url, "/nope").await;
        assert_eq!(status, 404);
    }

    #[tokio::test]
    async fn a_query_string_does_not_stop_a_route_matching() {
        let url = brain();
        let (status, body) = get(&url, "/config?t=1").await;
        assert_eq!(status, 200);
        assert!(body["config"].is_object());
    }

    /// `dashboard_credentials` hands this address to the wrapper window too, so
    /// opening the dashboard in demo mode must land on something, not a blank
    /// page.
    #[tokio::test]
    async fn the_root_serves_a_page_for_the_dashboard_window() {
        let url = brain();
        let resp = reqwest::Client::new().get(&url).send().await.expect("request");
        assert_eq!(resp.status().as_u16(), 200);
        let body = resp.text().await.expect("body");
        assert!(body.contains("Demo brain"), "got: {body}");
    }

    #[test]
    fn the_stall_gate_is_off_unless_the_env_var_names_a_batch_count() {
        assert_eq!(parse_stall_after(None), None);
        assert_eq!(parse_stall_after(Some("")), None);
        assert_eq!(parse_stall_after(Some("nonsense")), None);
        // 0 would pause before any progress exists to resume from.
        assert_eq!(parse_stall_after(Some("0")), None);
        assert_eq!(parse_stall_after(Some("3")), Some(3));
        assert_eq!(parse_stall_after(Some(" 3 ")), Some(3));
    }

    #[test]
    fn the_cursor_advances_forwards_through_time() {
        let now = 1_700_000_000_000;
        let first = cursor_time(20, ENTRIES, now);
        let later = cursor_time(1600, ENTRIES, now);
        assert!(first < later, "{first} !< {later}");
        assert!(later <= now, "the cursor cannot reach into the future");
        // Must not divide by zero on an empty brain.
        assert!(cursor_time(0, 0, now) <= now);
    }

    /// Demo mode asks for this address before any window opens, and must never
    /// be handed one with nothing behind it.
    #[tokio::test]
    async fn base_url_hands_out_a_running_server() {
        let url = base_url();
        assert!(url.starts_with("http://127.0.0.1:"), "got {url}");
        assert_eq!(url, base_url(), "the address must be stable across calls");
        let (status, body) = get(&url, "/config").await;
        assert_eq!(status, 200, "base_url returned an address nothing is serving");
        assert!(body["config"].is_object());
    }
}
