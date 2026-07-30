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
    async fn pause(&self) {
        tokio::time::sleep(Duration::from_millis(450)).await;
    }
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
    async fn deploy_worker(
        &self,
        _script: &str,
        _metadata: &serde_json::Value,
    ) -> Result<(), CfApiError> {
        self.pause().await;
        Ok(())
    }
    async fn set_cron(&self, _script: &str, _crons: &[String]) -> Result<(), CfApiError> {
        Ok(())
    }
    async fn enable_script_subdomain(&self, _script: &str) -> Result<(), CfApiError> {
        self.pause().await;
        Ok(())
    }
    /// Records the write and succeeds. Flipping the password the demo brain
    /// actually accepts is `demo_brain`'s half of the job: it is the thing
    /// serving `/health`, and a rotation is only worth demoing if the old
    /// password starts failing afterwards.
    async fn put_secret(&self, script: &str, name: &str, _text: &str) -> Result<(), CfApiError> {
        self.pause().await;
        DRY_RUN_SECRET_PUTS
            .lock()
            .unwrap()
            .push((script.to_string(), name.to_string()));
        Ok(())
    }
    async fn health_ok(&self, _worker_url: &str, _auth_token: &str) -> Result<bool, CfApiError> {
        self.pause().await;
        Ok(true)
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

    /// A dry run must not quietly skip the password write. Demo mode exists to
    /// walk the real flow, so a rotation that never reached the backend has to
    /// look different from one that did — otherwise the demo proves nothing about
    /// the thing it is demonstrating.
    #[tokio::test]
    async fn dry_run_records_the_secret_write() {
        probe::reset_secret_puts();
        DryRunBackend
            .put_secret("my-brain", "AUTH_TOKEN", "demo-password")
            .await
            .unwrap();
        assert_eq!(
            probe::secret_puts(),
            vec![("my-brain".to_string(), "AUTH_TOKEN".to_string())]
        );
    }
}
