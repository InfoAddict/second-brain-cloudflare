//! The two `provision::Backend` implementations: the real Cloudflare client
//! and a dry-run stand-in (SECOND_BRAIN_DRY_RUN=1) that exercises the whole
//! UI without an account, network, or side effects.

use super::api::{self, CfClient};
use super::provision::Backend;
use super::types::CfApiError;
use crate::worker_bundle;
use std::sync::Mutex;
use std::time::Duration;

pub struct LiveBackend {
    pub client: CfClient,
}

impl Backend for LiveBackend {
    async fn get_account_subdomain(&self) -> Result<Option<String>, CfApiError> {
        self.client.get_account_subdomain().await
    }
    async fn register_account_subdomain(&self, name: &str) -> Result<String, CfApiError> {
        self.client.register_account_subdomain(name).await
    }
    async fn find_d1(&self, name: &str) -> Result<Option<String>, CfApiError> {
        self.client.find_d1(name).await
    }
    async fn create_d1(&self, name: &str) -> Result<String, CfApiError> {
        self.client.create_d1(name).await
    }
    async fn find_kv(&self, title: &str) -> Result<Option<String>, CfApiError> {
        self.client.find_kv(title).await
    }
    async fn create_kv(&self, title: &str) -> Result<String, CfApiError> {
        self.client.create_kv(title).await
    }
    async fn vectorize_exists(&self, name: &str) -> Result<bool, CfApiError> {
        self.client.vectorize_exists(name).await
    }
    async fn delete_vectorize(&self, name: &str) -> Result<(), CfApiError> {
        self.client.delete_vectorize(name).await
    }
    async fn create_vectorize(
        &self,
        name: &str,
        dimensions: u32,
        metric: &str,
    ) -> Result<(), CfApiError> {
        self.client.create_vectorize(name, dimensions, metric).await
    }
    async fn upload_assets(&self, script: &str) -> Result<String, CfApiError> {
        let files = worker_bundle::asset_files();
        self.client.upload_assets(script, &files).await
    }
    async fn deploy_worker(
        &self,
        script: &str,
        metadata: &serde_json::Value,
    ) -> Result<(), CfApiError> {
        self.client
            .deploy_worker(script, metadata, worker_bundle::worker_script())
            .await
    }
    async fn set_cron(&self, script: &str, crons: &[String]) -> Result<(), CfApiError> {
        self.client.set_cron(script, crons).await
    }
    async fn enable_script_subdomain(&self, script: &str) -> Result<(), CfApiError> {
        self.client.enable_script_subdomain(script).await
    }
    async fn put_secret(&self, script: &str, name: &str, text: &str) -> Result<(), CfApiError> {
        self.client.put_secret(script, name, text).await
    }
    async fn health_ok(&self, worker_url: &str, auth_token: &str) -> Result<bool, CfApiError> {
        api::worker_health_ok(worker_url, auth_token).await
    }
    async fn auth_ok(&self, worker_url: &str, auth_token: &str) -> Result<bool, CfApiError> {
        api::worker_auth_ok(worker_url, auth_token).await
    }
    async fn capture_ok(&self, worker_url: &str, auth_token: &str) -> Result<bool, CfApiError> {
        api::worker_capture_ok(worker_url, auth_token).await
    }
    async fn get_script_bindings(
        &self,
        script: &str,
    ) -> Result<Vec<serde_json::Value>, CfApiError> {
        self.client.get_script_bindings(script).await
    }
    async fn sleep(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }
}

/// Answers everything successfully after a short pause, so the setup flow can
/// be demoed end-to-end. Never touches the network or the keychain.
pub struct DryRunBackend;

/// Every secret write a dry run has made, as `(script, name)` pairs.
///
/// [`DryRunBackend`] is a unit struct constructed inline at every call site
/// (`&DryRunBackend`), so there is nowhere on the value to hang a record, and
/// giving it state would mean editing every caller to make one test possible. A
/// module static is the cheap way to make "the rotation really did reach the
/// backend" observable — the same shape as `secure_store`'s read counter.
///
/// The secret's text is deliberately not kept. Nothing here has a reason to hold
/// the user's new password after the call returns, and a demo password is still
/// a password.
static DRY_RUN_SECRET_PUTS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

/// Test-only view of the secret writes a dry run has made.
#[cfg(test)]
pub mod probe {
    pub fn secret_puts() -> Vec<(String, String)> {
        super::DRY_RUN_SECRET_PUTS.lock().unwrap().clone()
    }
    pub fn reset_secret_puts() {
        super::DRY_RUN_SECRET_PUTS.lock().unwrap().clear();
    }
}

impl DryRunBackend {
    /// The pacing that makes a demo look like work being done.
    ///
    /// Zero under test. It is a UI affordance and nothing asserts on it, while a
    /// suite that sleeps through it holds every dry-run path open for a second
    /// at a time — long enough for a process-global counter (`secure_store`'s
    /// read probe) to pick up whatever else the suite is doing and report it
    /// against the path being measured.
    async fn pause(&self) {
        let delay = if cfg!(test) {
            Duration::ZERO
        } else {
            Duration::from_millis(450)
        };
        tokio::time::sleep(delay).await;
    }
}

/// The address of the demo brain a dry run's health check should actually talk
/// to, or `None` when nothing is listening at `worker_url` and the check has to
/// be waved through.
///
/// Two addresses reach the same server, and both have to be recognised:
///
/// * **Loopback.** `dashboard_credentials` hands every Worker-backed screen
///   `http://127.0.0.1:PORT` in dry-run, because that is where the demo brain is
///   and a screen pointed anywhere else has nothing to read.
/// * **`*.demo.workers.dev`.** The stand-in address, used wherever a real
///   workers.dev *shape* is required. `rotate_secret` (and `update_worker`)
///   derive the Worker's script name from the address it is given — #257, and
///   non-negotiable — and loopback has no script label at all, so a dry-run
///   rotation has no choice but to pass the stand-in. `DryRunBackend::get_account_subdomain`
///   answers `"demo"`, so this is exactly the set of addresses a dry run invents.
///
/// Anything else has no server behind it and gets the unconditional pass below.
///
/// Do not simplify this back to `Ok(true)`. A rotation's entire safety property
/// is that nothing local is written until the Worker authenticates the *new*
/// password; against a backend that reports health without asking anyone, that
/// gate passes trivially and demo mode proves the opposite of what it is run to
/// prove — which is how the last arc shipped five bugs past 170 unit tests.
fn demo_health_target(worker_url: &str) -> Option<String> {
    let parsed = url::Url::parse(worker_url).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    if host == "127.0.0.1" || host == "localhost" || host == "[::1]" || host == "::1" {
        return Some(worker_url.to_string());
    }
    if host.ends_with(".demo.workers.dev") {
        return Some(crate::demo_brain::base_url());
    }
    None
}

impl Backend for DryRunBackend {
    async fn get_account_subdomain(&self) -> Result<Option<String>, CfApiError> {
        self.pause().await;
        Ok(Some("demo".into()))
    }
    async fn register_account_subdomain(&self, name: &str) -> Result<String, CfApiError> {
        self.pause().await;
        Ok(name.to_string())
    }
    async fn find_d1(&self, _name: &str) -> Result<Option<String>, CfApiError> {
        self.pause().await;
        Ok(None)
    }
    async fn create_d1(&self, _name: &str) -> Result<String, CfApiError> {
        self.pause().await;
        Ok("00000000-0000-0000-0000-000000000000".into())
    }
    async fn find_kv(&self, _title: &str) -> Result<Option<String>, CfApiError> {
        Ok(None)
    }
    async fn create_kv(&self, _title: &str) -> Result<String, CfApiError> {
        self.pause().await;
        Ok("dryrun-kv".into())
    }
    async fn vectorize_exists(&self, _name: &str) -> Result<bool, CfApiError> {
        Ok(false)
    }
    async fn create_vectorize(
        &self,
        _name: &str,
        _dimensions: u32,
        _metric: &str,
    ) -> Result<(), CfApiError> {
        self.pause().await;
        Ok(())
    }
    async fn delete_vectorize(&self, _name: &str) -> Result<(), CfApiError> {
        self.pause().await;
        Ok(())
    }
    async fn upload_assets(&self, _script: &str) -> Result<String, CfApiError> {
        self.pause().await;
        Ok("dryrun-jwt".into())
    }
    /// A fresh deploy carries the password as a `secret_text` binding, so the
    /// demo brain has to take it the same way a real Worker would.
    ///
    /// Without this, running setup again after a demo rotation fails: the health
    /// poll now genuinely asks the demo brain, the brain is still enforcing the
    /// rotated password, and `provision`'s poll treats a 401 as terminal. An
    /// *update* is unaffected and must be — its metadata carries `keep_bindings`
    /// and no secret, exactly because the app does not know the password then.
    async fn deploy_worker(
        &self,
        _script: &str,
        metadata: &serde_json::Value,
    ) -> Result<(), CfApiError> {
        self.pause().await;
        if let Some(token) = metadata
            .get("bindings")
            .and_then(|b| b.as_array())
            .and_then(|bindings| {
                bindings.iter().find(|b| {
                    b.get("type").and_then(|t| t.as_str()) == Some("secret_text")
                        && b.get("name").and_then(|n| n.as_str()) == Some("AUTH_TOKEN")
                })
            })
            .and_then(|b| b.get("text"))
            .and_then(|t| t.as_str())
        {
            // `deployed_with`, not `rotate_to`: the secret rides along with this
            // upload, so the Worker comes up already holding it and there is no
            // propagation window to model. Routing a deploy through the rotation
            // path instead pointed `SECOND_BRAIN_DEMO_ROTATE_AFTER` at
            // `provision`'s health poll — where a 401 is terminal — and killed
            // demo setup outright whenever the variable was exported.
            crate::demo_brain::deployed_with(token);
        }
        Ok(())
    }
    async fn set_cron(&self, _script: &str, _crons: &[String]) -> Result<(), CfApiError> {
        Ok(())
    }
    async fn enable_script_subdomain(&self, _script: &str) -> Result<(), CfApiError> {
        self.pause().await;
        Ok(())
    }
    /// Records the write, then makes it true.
    ///
    /// This backend stands in for Cloudflare's control plane and the demo brain
    /// stands in for the Worker, so when the fake control plane sets `AUTH_TOKEN`
    /// the fake Worker has to start honouring it — otherwise `rotate_secret`'s
    /// health gate polls a server that accepts anything, passes on the first
    /// attempt, and a demo rotation flips nothing while reporting success. The
    /// old password would go on working for the rest of the run.
    ///
    /// Only `AUTH_TOKEN`. A future secret under another name is not the brain's
    /// password and must not retire it.
    async fn put_secret(&self, script: &str, name: &str, text: &str) -> Result<(), CfApiError> {
        self.pause().await;
        DRY_RUN_SECRET_PUTS
            .lock()
            .unwrap()
            .push((script.to_string(), name.to_string()));
        if name == "AUTH_TOKEN" {
            crate::demo_brain::rotate_to(text);
        }
        Ok(())
    }
    /// Probes the demo brain for real when there is one behind this address; see
    /// [`demo_health_target`] for which addresses those are and why an
    /// unconditional pass is wrong.
    async fn health_ok(&self, worker_url: &str, auth_token: &str) -> Result<bool, CfApiError> {
        self.pause().await;
        match demo_health_target(worker_url) {
            // `worker_health_ok` already maps a 401 to `Unauthorized`, which
            // `rotate_secret`'s loop reads as "the new secret has not propagated
            // yet" and retries — the same shape the live path has.
            Some(url) => api::worker_health_ok(&url, auth_token).await,
            None => Ok(true),
        }
    }
    /// The rotation gate's probe, resolved through exactly the same addresses as
    /// [`Self::health_ok`] — see [`demo_health_target`]. A dry run that waved
    /// this one through unconditionally would put the demo back to proving the
    /// opposite of what it is run to prove, and this is the check a rotation
    /// actually turns on.
    async fn auth_ok(&self, worker_url: &str, auth_token: &str) -> Result<bool, CfApiError> {
        self.pause().await;
        match demo_health_target(worker_url) {
            // `worker_auth_ok` maps a 401 — and only a 401 — to `Unauthorized`,
            // which `rotate_secret`'s loop reads as "the new secret has not
            // propagated yet" and retries.
            Some(url) => api::worker_auth_ok(&url, auth_token).await,
            None => Ok(true),
        }
    }
    async fn capture_ok(&self, _worker_url: &str, _auth_token: &str) -> Result<bool, CfApiError> {
        Ok(true)
    }
    async fn get_script_bindings(
        &self,
        _script: &str,
    ) -> Result<Vec<serde_json::Value>, CfApiError> {
        self.pause().await;
        Ok(vec![
            serde_json::json!({ "type": "d1", "name": "DB", "database_id": "dryrun-d1" }),
            serde_json::json!({ "type": "kv_namespace", "name": "OAUTH_KV", "namespace_id": "dryrun-kv" }),
            // The vectorize binding matters in demo mode too: the embedding
            // migration reads it to show which index is bound, and without it the
            // demo silently falls through to "none".
            serde_json::json!({ "type": "vectorize", "name": "VECTORIZE", "index_name": "second-brain-vectors" }),
        ])
    }
    async fn sleep(&self, _duration: Duration) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::demo_brain;

    /// A dry run must not quietly skip the password write. Demo mode exists to
    /// walk the real flow, so a rotation that never reached the backend has to
    /// look different from one that did — otherwise the demo proves nothing about
    /// the thing it is demonstrating.
    ///
    /// The second half is the wiring that makes the demo real: setting the secret
    /// has to retire the old password on the brain that serves `/health`, or the
    /// gate `rotate_secret` exists for passes against a server that accepts
    /// anything.
    ///
    /// **The brain is bound for this test alone.** It used to rotate the
    /// process-wide one and hand the password straight back, on the grounds that
    /// the window was "two statements with no request in between" — true read
    /// down the page, false under a parallel harness, where three other tests are
    /// reading that same global. At `RUST_TEST_THREADS=64` it failed 10 runs out
    /// of 15, and CI's thread count follows the runner's cores. A scoped brain
    /// removes the shared state instead of narrowing the window, which also frees
    /// the test to settle on a password nothing else uses — the only value that
    /// can *only* have come from this call.
    #[tokio::test]
    async fn dry_run_records_the_secret_write_and_the_demo_brain_starts_enforcing_it() {
        let brain = demo_brain::scoped_brain();
        probe::reset_secret_puts();

        DryRunBackend
            .put_secret("my-brain", "AUTH_TOKEN", "a-password-only-this-test-sets")
            .await
            .unwrap();
        assert_eq!(
            demo_brain::auth_token(),
            "a-password-only-this-test-sets",
            "setting AUTH_TOKEN must move the demo brain onto it. Without that, \
             `rotate_secret`'s gate polls a server that accepts anything, passes \
             on the first attempt, and a demo rotation flips nothing while \
             reporting success"
        );
        // `contains`, not equality. The record is a process-global static and the
        // suite runs in parallel, so pinning the whole vector makes this test
        // fail whenever another one happens to rotate at the same moment — which
        // says nothing about either.
        assert!(
            probe::secret_puts().contains(&("my-brain".to_string(), "AUTH_TOKEN".to_string())),
            "the write must be recorded against the script it targeted: {:?}",
            probe::secret_puts()
        );

        // A secret that is not the brain's password must not retire the one that
        // is.
        DryRunBackend
            .put_secret("my-brain", "SOME_OTHER_SECRET", "not-a-password")
            .await
            .unwrap();
        assert_eq!(
            demo_brain::auth_token(),
            "a-password-only-this-test-sets",
            "a secret under another name is not the brain's password"
        );

        // Both probes: `auth_ok` is what a rotation is gated on, `health_ok` is
        // what every other flow asks, and a dry run has to route them both at the
        // demo brain rather than answer either from a constant.
        let set = "a-password-only-this-test-sets";
        let url = brain.base_url();
        for (name, accepted, refused) in [
            (
                "auth_ok",
                DryRunBackend.auth_ok(url, set).await,
                DryRunBackend.auth_ok(url, "not-the-demo-password").await,
            ),
            (
                "health_ok",
                DryRunBackend.health_ok(url, set).await,
                DryRunBackend.health_ok(url, "not-the-demo-password").await,
            ),
        ] {
            assert!(
                matches!(accepted, Ok(true)),
                "{name}: the password that was set must open the demo brain, got {accepted:?}"
            );
            assert!(
                matches!(refused, Err(CfApiError::Unauthorized)),
                "{name}: setting the secret must retire every other password, or \
                 a demo rotation flips nothing and the gate proves nothing. Got \
                 {refused:?}"
            );
        }
    }

    /// Demo setup, end to end against the demo brain, with the rotation delay
    /// exported.
    ///
    /// The knob is for rotation's retry loop. It used to reach the deploy as
    /// well, and `provision`'s health poll treats a 401 as terminal — so with
    /// `SECOND_BRAIN_DEMO_ROTATE_AFTER` set, the very first thing a demo user
    /// does died on "Something went wrong", with no way to reach the screen the
    /// variable was exported to see.
    ///
    /// A scoped brain, so the fresh password this provisions with cannot 401 the
    /// rest of the suite.
    #[tokio::test]
    async fn a_dry_run_setup_completes_even_with_the_rotation_delay_exported() {
        let _brain = demo_brain::scoped_brain_with(demo_brain::Options {
            rotate_after: Some(3),
            ..demo_brain::test_options()
        });

        crate::cf::provision::provision(
            &DryRunBackend,
            &crate::worker_bundle::manifest(),
            "Demo Account",
            "a-password-only-this-test-sets",
            |_| {},
        )
        .await
        .expect("a demo setup must not be broken by a knob meant for rotation");
    }

    /// The dry-run health check has to be capable of saying no.
    ///
    /// Port 1 has nothing listening, and it is loopback, so this is the shortest
    /// proof that the check makes a real request instead of answering from a
    /// constant. If this ever reports `Ok(true)`, `rotate_secret`'s gate is
    /// vacuous in demo mode and a demo rotation "succeeds" against a brain that
    /// never received it.
    #[tokio::test]
    async fn the_dry_run_health_check_fails_when_nothing_is_listening() {
        let result = DryRunBackend.health_ok("http://127.0.0.1:1", "demo").await;
        assert!(
            !matches!(result, Ok(true)),
            "a dry-run health check answered yes for an address with no server \
             behind it: {result:?}"
        );
    }

    /// …and still waves through the addresses no demo server stands behind, so
    /// the flows that invent a plausible remote address keep working offline.
    #[tokio::test]
    async fn an_address_with_no_demo_server_behind_it_still_passes() {
        assert!(matches!(
            DryRunBackend
                .health_ok("https://second-brain.acme.workers.dev", "demo")
                .await,
            Ok(true)
        ));
        assert!(demo_health_target("https://second-brain.acme.workers.dev").is_none());
        assert!(demo_health_target("https://second-brain.demo.workers.dev").is_some());
        assert!(demo_health_target("http://127.0.0.1:8787").is_some());
    }
}
