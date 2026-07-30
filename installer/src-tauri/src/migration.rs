//! Driving an embedding-model change from the desktop app (#248).
//!
//! Switching models changes the vector dimensions, and a Vectorize index fixes
//! its dimensions when it is created. The binding resolves an index by name at
//! deploy time. So a model change is not a setting — it is: create a second
//! index, point the binding at it, rebuild every vector, check the result, and
//! only then drop the first one.
//!
//! The app owns this because only the app holds Cloudflare credentials. The
//! Worker owns the rebuilding, behind `/migration/*`.
//!
//! # The order is the safety property
//!
//! Nothing is destroyed until the last step, and every step before it is
//! reversible by redeploying against the old index, which is still there and
//! still full. That is why deletion is a separate, explicitly confirmed act
//! rather than the tail of a successful run.
//!
//! The model is written to the Worker's config *as part of* the redeploy rather
//! than beforehand. Config lives in KV and takes effect on the next request, so
//! writing it early would leave a window where the Worker embeds at the new
//! dimensions against the old index — every capture in that window fails on
//! upsert, and recall returns quiet nonsense. This is also why the model must
//! never join the Advanced Settings save patch, where a click would apply it
//! instantly.

use crate::i18n::{self, Key, Locale};
use serde::Deserialize;
use std::time::Duration;

/// Longer than the settings calls: a re-embed batch does real model work.
const TIMEOUT: Duration = Duration::from_secs(120);

/// Embedding models offered, with the dimensions each produces.
///
/// A curated list rather than a live catalogue fetch, for the same reason
/// `LLM_MODELS` is curated: the panel has to render offline. Unlike `LLM_MODEL`
/// though, a wrong value here is not survivable — the dimensions must match the
/// index that gets created, so every entry carries its own rather than being
/// looked up later.
///
/// Only models whose dimensions are documented are listed. A model whose
/// dimension count we would have to guess cannot be offered: guessing wrong
/// creates an index that rejects every vector.
pub const EMBEDDING_MODELS: &[EmbeddingChoice] = &[
    EmbeddingChoice { model: "@cf/baai/bge-small-en-v1.5", dimensions: 384, level: "standard" },
    EmbeddingChoice { model: "@cf/baai/bge-base-en-v1.5", dimensions: 768, level: "finer" },
    EmbeddingChoice { model: "@cf/baai/bge-large-en-v1.5", dimensions: 1024, level: "finest" },
];

/// One offerable way of reading memories.
///
/// `level` is a copy key, not a label: the window looks it up in its own catalogue
/// so the choice reads as "Standard / Finer / Finest" rather than as a model id.
/// That matches the named-level pattern every other control in the same window
/// uses, and it matters more here — this is the last thing read before a one-way
/// operation, and asking someone to reason about the position of an opaque string
/// in a list is not a choice they can make well.
///
/// `dimensions` deliberately never reaches the screen. It exists to size the
/// index and to order the list.
#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingChoice {
    pub model: &'static str,
    #[serde(skip)]
    pub dimensions: u32,
    pub level: &'static str,
}

pub fn dimensions_for(model: &str) -> Option<u32> {
    EMBEDDING_MODELS
        .iter()
        .find(|c| c.model == model)
        .map(|c| c.dimensions)
}

/// The index a given dimension count lives in.
///
/// The shipped index keeps its historical name so an existing brain is untouched
/// by this feature; every other size gets a suffixed name. Deriving the name from
/// the dimensions rather than the model means two models of the same size share
/// an index, which is correct — the vectors are compatible.
pub fn index_name_for(base: &str, dimensions: u32, shipped_dimensions: u32) -> String {
    if dimensions == shipped_dimensions {
        base.to_string()
    } else {
        format!("{base}-{dimensions}")
    }
}

fn base(worker_url: &str) -> &str {
    worker_url.trim_end_matches('/')
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationEstimate {
    pub entries: u64,
    /// A lower bound. The chunker's sentence snapping can only produce more, so
    /// the UI says "at least" rather than implying precision it does not have.
    pub chunks_at_least: u64,
    pub current_model: String,
    /// The choices the picker offers, ordered coarsest first.
    pub models: Vec<EmbeddingChoice>,
}

#[derive(Debug, Deserialize)]
struct EstimateBody {
    entries: u64,
    #[serde(rename = "chunksAtLeast")]
    chunks_at_least: u64,
    model: String,
}

#[derive(Debug, Clone, serde::Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BatchProgress {
    pub processed: u64,
    pub failed: u64,
    pub remaining: u64,
    pub total: u64,
    pub done: bool,
    /// The Worker stopped because a batch achieved nothing. The cursor is kept,
    /// so resuming later costs nothing already paid for.
    pub stalled: bool,
    /// Why it stopped: `"budget"` when the day's allowance looks spent, or
    /// `"failing"` when an entry keeps failing for some other reason.
    ///
    /// The distinction is the difference between "come back tomorrow" and "come
    /// back tomorrow forever": a persistently failing entry sits at the cursor and
    /// makes every future batch achieve nothing, so telling that user to wait for
    /// an allowance reset would be advice that can never work.
    #[serde(default)]
    pub stalled_reason: Option<String>,
}

async fn get_json<T: serde::de::DeserializeOwned>(
    worker_url: &str,
    auth_token: &str,
    path: &str,
    locale: Locale,
) -> Result<T, String> {
    send_json(reqwest::Client::new().get(format!("{}{path}", base(worker_url))), auth_token, locale)
        .await
}

async fn post_json<T: serde::de::DeserializeOwned>(
    worker_url: &str,
    auth_token: &str,
    path: &str,
    locale: Locale,
) -> Result<T, String> {
    send_json(reqwest::Client::new().post(format!("{}{path}", base(worker_url))), auth_token, locale)
        .await
}

async fn send_json<T: serde::de::DeserializeOwned>(
    builder: reqwest::RequestBuilder,
    auth_token: &str,
    locale: Locale,
) -> Result<T, String> {
    let resp = builder
        .bearer_auth(auth_token)
        .timeout(TIMEOUT)
        .send()
        .await
        .map_err(|e| {
            log::warn!("migration request failed: {e}");
            i18n::t(locale, Key::ErrorReachBrain).to_string()
        })?;

    // The app and the Worker update independently, so a brain that predates
    // these routes is the ordinary state for anyone who updated the app first.
    // Say what to do, not what happened.
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(i18n::t(locale, Key::ErrorBrainNeedsUpdateForMigration).to_string());
    }
    if !resp.status().is_success() {
        return Err(i18n::t_fmt(
            locale,
            Key::ErrorBrainHttpStatus,
            &[("status", &resp.status().as_u16().to_string())],
        ));
    }
    resp.json::<T>().await.map_err(|e| {
        log::warn!("migration response was not the expected shape: {e}");
        i18n::t(locale, Key::ErrorBrainUnexpected).to_string()
    })
}

/// What a rebuild would cost, before anything is created.
pub async fn fetch_estimate(
    worker_url: &str,
    auth_token: &str,
    locale: Locale,
) -> Result<MigrationEstimate, String> {
    let body: EstimateBody =
        get_json(worker_url, auth_token, "/migration/estimate", locale).await?;
    Ok(MigrationEstimate {
        entries: body.entries,
        chunks_at_least: body.chunks_at_least,
        current_model: body.model,
        models: EMBEDDING_MODELS.to_vec(),
    })
}

/// One re-embed batch. The caller loops while `remaining > 0`, stopping on
/// `stalled`.
pub async fn run_batch(
    worker_url: &str,
    auth_token: &str,
    locale: Locale,
) -> Result<BatchProgress, String> {
    post_json(worker_url, auth_token, "/migration/reembed", locale).await
}

/// Where an interrupted rebuild got to, or `None` if this brain has never
/// migrated.
pub async fn fetch_status(
    worker_url: &str,
    auth_token: &str,
    locale: Locale,
) -> Result<serde_json::Value, String> {
    get_json(worker_url, auth_token, "/migration/status", locale).await
}

/// Records the new model on the brain.
///
/// Lives here rather than in `settings.rs` on purpose. `apply_settings` sends one
/// merged PATCH when the user clicks Save, and an embedding model in that patch
/// would take effect the instant it is clicked — before any index exists to hold
/// vectors of that size. Keeping the write in the migration module means the only
/// path to it is the sequenced one.
pub async fn patch_embedding_model(
    worker_url: &str,
    auth_token: &str,
    model: &str,
    locale: Locale,
) -> Result<(), String> {
    let body = serde_json::json!({ "EMBEDDING_MODEL": model });
    let _: serde_json::Value = send_json(
        reqwest::Client::new()
            .patch(format!("{}/config", base(worker_url)))
            .json(&body),
        auth_token,
        locale,
    )
    .await?;
    Ok(())
}

/// Forget the ledger so the next batch starts from the beginning. Rebuilding is
/// idempotent, so this costs model calls but cannot corrupt anything.
pub async fn reset(worker_url: &str, auth_token: &str, locale: Locale) -> Result<(), String> {
    let _: serde_json::Value =
        post_json(worker_url, auth_token, "/migration/reset", locale).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_offered_model_declares_its_dimensions() {
        // A model whose dimension count we had to guess cannot be offered:
        // guessing wrong creates an index that rejects every vector written to
        // it, and the index cannot be altered afterwards.
        for choice in EMBEDDING_MODELS {
            let EmbeddingChoice { model, dimensions, level } = choice;
            assert!(model.starts_with("@cf/"), "{model} is not a Workers AI id");
            assert!(*dimensions > 0, "{model} has no dimensions");
            assert_eq!(dimensions_for(model), Some(*dimensions));
            // Every choice needs a named level, or the window falls back to
            // showing the raw model id at the moment of commitment.
            assert!(!level.is_empty(), "{model} has no named level");
        }

        // Coarsest first, so "further down the list reads in finer detail" is
        // true rather than aspirational.
        let sizes: Vec<u32> = EMBEDDING_MODELS.iter().map(|c| c.dimensions).collect();
        let mut sorted = sizes.clone();
        sorted.sort();
        assert_eq!(sizes, sorted, "the picker's order must ascend by detail");

        // Distinct levels, or two choices render identically.
        let mut levels: Vec<&str> = EMBEDDING_MODELS.iter().map(|c| c.level).collect();
        levels.sort();
        let before = levels.len();
        levels.dedup();
        assert_eq!(levels.len(), before, "two choices share a level name");
    }

    #[test]
    fn the_shipped_model_is_offered_so_a_user_can_return_to_it() {
        // Migration has to be reversible in both directions, or a user who tries
        // a larger model is stuck with it.
        assert_eq!(dimensions_for("@cf/baai/bge-small-en-v1.5"), Some(384));
    }

    #[test]
    fn an_unknown_model_has_no_dimensions_rather_than_a_guess() {
        assert_eq!(dimensions_for("@cf/google/embeddinggemma-300m"), None);
        assert_eq!(dimensions_for(""), None);
    }

    /// The shipped size keeps the historical index name, so enabling this feature
    /// does not rename anything under an existing brain.
    #[test]
    fn the_shipped_dimension_count_keeps_the_original_index_name() {
        assert_eq!(
            index_name_for("second-brain-vectors", 384, 384),
            "second-brain-vectors"
        );
    }

    #[test]
    fn other_dimension_counts_get_their_own_index() {
        assert_eq!(
            index_name_for("second-brain-vectors", 768, 384),
            "second-brain-vectors-768"
        );
        assert_eq!(
            index_name_for("second-brain-vectors", 1024, 384),
            "second-brain-vectors-1024"
        );
    }

    /// Two models of the same size share an index, which is correct — their
    /// vectors are compatible, and creating a second index of the same shape
    /// would double storage for nothing.
    #[test]
    fn models_of_the_same_size_share_an_index() {
        let a = index_name_for("second-brain-vectors", 768, 384);
        let b = index_name_for("second-brain-vectors", 768, 384);
        assert_eq!(a, b);
    }

    /// The webview reads these keys by name. Nothing else can catch a rename
    /// across that boundary: Rust renames the field, `serde` happily emits the new
    /// key, `tsc` type-checks the TypeScript against its own interface, and the
    /// mismatch only appears as a blank screen at runtime.
    ///
    /// Asserted against the literal strings `installer/src/settings.ts` reads.
    #[test]
    fn the_estimate_serialises_the_keys_the_window_reads() {
        let est = MigrationEstimate {
            entries: 1620,
            chunks_at_least: 2100,
            current_model: "@cf/baai/bge-small-en-v1.5".into(),
            models: EMBEDDING_MODELS.to_vec(),
        };
        let json = serde_json::to_value(&est).expect("serialises");

        for key in ["entries", "chunksAtLeast", "currentModel", "models"] {
            assert!(json.get(key).is_some(), "the window reads {key}, which is absent");
        }
        // The picker reads a named level per choice. Dimensions must NOT be in
        // the payload: they are an implementation detail, and putting a number
        // like 768 on the decision screen is what the named level replaces.
        let first = &json["models"][0];
        assert!(first["model"].is_string(), "model id must be present for auditing");
        assert!(first["level"].is_string(), "each choice needs a named level");
        assert!(
            first.get("dimensions").is_none(),
            "dimensions must not reach the window: {first}"
        );
    }

    #[test]
    fn a_batch_serialises_the_keys_the_progress_bar_reads() {
        let json = serde_json::to_value(BatchProgress::default()).expect("serialises");
        // `remaining` and `total` are the two the bar is computed from; `stalled`
        // is what stops the loop. A missing `stalled` would loop forever against
        // a Worker that has given up.
        for key in ["processed", "failed", "remaining", "total", "done", "stalled"] {
            assert!(json.get(key).is_some(), "the window reads {key}, which is absent");
        }
    }

    /// Every key above, checked against the file that reads them, so adding a
    /// field to the struct without the window knowing is visible here too.
    #[test]
    fn the_window_really_reads_those_keys() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/settings.ts");
        let ui = std::fs::read_to_string(path).expect("read settings.ts");
        for key in ["chunksAtLeast", "currentModel", "level", "stalledReason"] {
            assert!(ui.contains(key), "settings.ts no longer reads {key}");
        }
        // The window must NOT deal in dimensions. They size the index and order
        // the picker; putting a number like 768 on a decision screen is what the
        // named levels replaced, and a browser-stored dimension count was how the
        // target of an irreversible delete used to be identified.
        assert!(
            !ui.contains("oldDimensions"),
            "settings.ts is tracking dimensions again — that belongs on the Rust side"
        );
        for command in [
            "migration_estimate",
            "migration_status",
            "migration_step",
            "begin_embedding_migration",
            "finish_embedding_migration",
            // The abandon path, which existed with no command exposing it until
            // a review noticed, and the outstanding-index question the window
            // asks instead of tracking sizes itself.
            "migration_reset",
            "outstanding_old_index",
        ] {
            assert!(
                ui.contains(&format!("\"{command}\"")),
                "settings.ts no longer calls {command}"
            );
        }
    }

    // ── HTTP ────────────────────────────────────────────────────────────────
    //
    // Against a real tiny_http server, matching the convention in settings.rs
    // and cf/api.rs: the request path and method select the scenario, so the
    // assertions cover what the Worker actually receives.

    fn spawn_worker(
        estimate_status: u16,
    ) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let log = seen.clone();
        std::thread::spawn(move || loop {
            let Ok(req) = server.recv() else { return };
            let method = req.method().as_str().to_string();
            let url = req.url().to_string();
            let auth = req
                .headers()
                .iter()
                .find(|h| h.field.equiv("authorization"))
                .map(|h| h.value.to_string())
                .unwrap_or_default();
            log.lock().unwrap().push(format!("{method} {url} auth={auth}"));

            let (status, body) = match (method.as_str(), url.as_str()) {
                ("GET", "/migration/estimate") => (
                    estimate_status,
                    r#"{"ok":true,"entries":1620,"chunksAtLeast":2100,"model":"@cf/baai/bge-small-en-v1.5"}"#,
                ),
                ("POST", "/migration/reembed") => (
                    200,
                    r#"{"ok":true,"processed":5,"failed":0,"remaining":95,"total":100,"done":false,"stalled":false}"#,
                ),
                ("POST", "/migration/reset") => (200, r#"{"ok":true}"#),
                ("GET", "/migration/status") => (200, r#"{"ok":true,"state":null,"model":"m"}"#),
                _ => (404, r#"{"ok":false}"#),
            };
            let resp = tiny_http::Response::from_string(body)
                .with_status_code(status)
                .with_header(
                    "Content-Type: application/json"
                        .parse::<tiny_http::Header>()
                        .unwrap(),
                );
            let _ = req.respond(resp);
        });
        (format!("http://127.0.0.1:{port}"), seen)
    }

    #[tokio::test]
    async fn the_estimate_carries_the_models_the_picker_needs() {
        let (url, seen) = spawn_worker(200);
        let est = fetch_estimate(&url, "tok", Locale::En).await.expect("estimate");

        assert_eq!(est.entries, 1620);
        assert_eq!(est.chunks_at_least, 2100);
        assert_eq!(est.current_model, "@cf/baai/bge-small-en-v1.5");
        // Shipped to the UI so the dropdown never hardcodes model ids.
        assert_eq!(est.models.len(), EMBEDDING_MODELS.len());

        let log = seen.lock().unwrap();
        assert!(log[0].starts_with("GET /migration/estimate"));
        assert!(log[0].contains("auth=Bearer tok"));
    }

    #[tokio::test]
    async fn a_batch_reports_the_fields_the_loop_needs() {
        let (url, _) = spawn_worker(200);
        let p = run_batch(&url, "tok", Locale::En).await.expect("batch");
        assert_eq!(p.processed, 5);
        assert_eq!(p.remaining, 95);
        assert!(!p.done);
        assert!(!p.stalled);
    }

    /// A brain that predates these routes 404s. That is the ordinary state for
    /// someone who updated the app first, so it must say "update your brain"
    /// rather than surfacing a status code.
    #[tokio::test]
    async fn an_older_brain_is_told_to_update_rather_than_shown_a_404() {
        let (url, _) = spawn_worker(404);
        let err = fetch_estimate(&url, "tok", Locale::En).await.unwrap_err();
        assert_eq!(
            err,
            i18n::t(Locale::En, Key::ErrorBrainNeedsUpdateForMigration)
        );
        assert!(!err.contains("404"), "leaked a status code to the user: {err}");
    }

    #[tokio::test]
    async fn a_server_error_does_not_leak_a_raw_body() {
        let (url, _) = spawn_worker(500);
        let err = fetch_estimate(&url, "tok", Locale::En).await.unwrap_err();
        assert!(err.contains("500"), "the status is useful here: {err}");
        assert!(!err.contains("{"), "leaked a response body: {err}");
    }

    #[tokio::test]
    async fn an_unreachable_brain_says_so() {
        // Nothing is listening on this port.
        let err = fetch_estimate("http://127.0.0.1:1", "tok", Locale::En)
            .await
            .unwrap_err();
        assert_eq!(err, i18n::t(Locale::En, Key::ErrorReachBrain));
    }

    #[tokio::test]
    async fn a_trailing_slash_in_the_stored_address_does_not_double_up() {
        let (url, seen) = spawn_worker(200);
        fetch_estimate(&format!("{url}/"), "tok", Locale::En)
            .await
            .expect("estimate");
        let log = seen.lock().unwrap();
        assert!(
            log[0].starts_with("GET /migration/estimate"),
            "path was mangled: {}",
            log[0]
        );
    }
}
