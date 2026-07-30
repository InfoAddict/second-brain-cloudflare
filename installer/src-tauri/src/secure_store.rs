//! OS-secure storage for what setup produces: the Worker URL and the user's
//! AUTH_TOKEN. Backed by the macOS Keychain / Windows Credential Manager via
//! the `keyring` crate. Nothing here ever touches disk in plaintext.
//!
//! The Cloudflare OAuth token is deliberately NOT stored — it's only needed
//! during provisioning and lives in memory for that window.
//!
//! Tests swap the keyring for an in-process map (keyring's mock store scopes
//! credentials to a single Entry instance, so it can't test save→load).

const KEY_WORKER_URL: &str = "worker-url";
const KEY_AUTH_TOKEN: &str = "auth-token";
const KEY_CF_ACCOUNT_ID: &str = "cf-account-id";
const KEY_CF_SUBDOMAIN: &str = "cf-subdomain";

#[derive(Debug, Clone)]
pub struct SetupInfo {
    pub worker_url: String,
    pub auth_token: String,
}

/// Non-secret Cloudflare facts worth remembering so later operations can skip
/// account enumeration.
///
/// These are deliberately the *only* Cloudflare values that persist. The OAuth
/// access token is not among them and must never be: the AUTH_TOKEN unlocks one
/// brain, whereas a Cloudflare token carrying `workers:write` + `d1:write` +
/// `vectorize:write` unlocks the whole account. Storing it would turn a stolen
/// laptop from "someone reads my notes" into "someone controls my Cloudflare".
/// The user signs in per operation instead.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)] // read by tests and by #248; written by discover_brains today
pub struct CfHints {
    pub account_id: String,
    pub subdomain: String,
}

#[derive(Debug, thiserror::Error)]
#[error("secure storage error: {0}")]
pub struct StoreError(String);

#[cfg(not(test))]
mod backend {
    use super::StoreError;
    use keyring::Entry;

    const SERVICE: &str = "com.secondbrain.desktop";

    pub fn set(key: &str, value: &str) -> Result<(), StoreError> {
        Entry::new(SERVICE, key)
            .and_then(|e| e.set_password(value))
            .map_err(|e| StoreError(e.to_string()))
    }

    pub fn get(key: &str) -> Option<String> {
        Entry::new(SERVICE, key).ok()?.get_password().ok()
    }

    pub fn delete(key: &str) {
        if let Ok(e) = Entry::new(SERVICE, key) {
            let _ = e.delete_credential();
        }
    }
}

#[cfg(test)]
mod backend {
    use super::StoreError;
    use std::collections::HashMap;
    use std::sync::Mutex;

    static MAP: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

    pub fn set(key: &str, value: &str) -> Result<(), StoreError> {
        MAP.lock()
            .unwrap()
            .get_or_insert_with(HashMap::new)
            .insert(key.to_string(), value.to_string());
        Ok(())
    }

    pub fn get(key: &str) -> Option<String> {
        MAP.lock().unwrap().as_ref()?.get(key).cloned()
    }

    pub fn delete(key: &str) {
        if let Some(map) = MAP.lock().unwrap().as_mut() {
            map.remove(key);
        }
    }
}

pub fn save_setup(worker_url: &str, auth_token: &str) -> Result<(), StoreError> {
    backend::set(KEY_WORKER_URL, worker_url)?;
    backend::set(KEY_AUTH_TOKEN, auth_token)?;
    Ok(())
}

/// Both values present ⇒ setup completed ⇒ the app boots in wrapper mode.
pub fn load_setup() -> Option<SetupInfo> {
    Some(SetupInfo {
        worker_url: backend::get(KEY_WORKER_URL)?,
        auth_token: backend::get(KEY_AUTH_TOKEN)?,
    })
}

/// Remembers which account and workers.dev subdomain the brain lives under.
///
/// Stored separately from [`save_setup`] and read separately, so a missing or
/// unreadable hint can never make a connected brain look unconfigured — see
/// [`load_setup`], whose two keys remain the only definition of "set up".
pub fn save_cf_hints(account_id: &str, subdomain: &str) -> Result<(), StoreError> {
    backend::set(KEY_CF_ACCOUNT_ID, account_id)?;
    backend::set(KEY_CF_SUBDOMAIN, subdomain)?;
    Ok(())
}

/// The read half of [`save_cf_hints`]. Exercised by the tests here; the
/// operations that will consume it — skipping account enumeration on a repeat
/// Cloudflare action — land with #248.
#[allow(dead_code)]
pub fn load_cf_hints() -> Option<CfHints> {
    Some(CfHints {
        account_id: backend::get(KEY_CF_ACCOUNT_ID)?,
        subdomain: backend::get(KEY_CF_SUBDOMAIN)?,
    })
}

pub fn clear_setup() {
    backend::delete(KEY_WORKER_URL);
    backend::delete(KEY_AUTH_TOKEN);
    backend::delete(KEY_CF_ACCOUNT_ID);
    backend::delete(KEY_CF_SUBDOMAIN);
}

#[cfg(test)]
mod tests {
    use super::*;

    // One test: the backing map is shared process state, so scenarios run
    // sequentially to avoid cross-test races.
    #[test]
    fn roundtrip_clear_and_partial_state() {
        clear_setup();
        assert!(load_setup().is_none());

        save_setup("https://second-brain.demo.workers.dev", "hunter2hunter2").unwrap();
        let info = load_setup().expect("saved setup loads");
        assert_eq!(info.worker_url, "https://second-brain.demo.workers.dev");
        assert_eq!(info.auth_token, "hunter2hunter2");

        clear_setup();
        assert!(load_setup().is_none());

        backend::set(super::KEY_WORKER_URL, "https://x.workers.dev").unwrap();
        assert!(load_setup().is_none(), "URL without token must not count as set up");
        clear_setup();
    }

    #[test]
    fn cf_hints_roundtrip_and_stay_independent_of_setup() {
        clear_setup();
        assert!(load_cf_hints().is_none());

        save_cf_hints("acct-123", "demo").unwrap();
        assert_eq!(
            load_cf_hints(),
            Some(CfHints { account_id: "acct-123".into(), subdomain: "demo".into() })
        );

        // Hints alone must never read as a completed setup, or the app would
        // boot into wrapper mode with no brain to talk to.
        assert!(load_setup().is_none(), "hints are not credentials");

        // And a brain connected without ever signing in to Cloudflare has no
        // hints, which must not stop it being set up.
        clear_setup();
        save_setup("https://b.workers.dev", "hunter2hunter2").unwrap();
        assert!(load_setup().is_some());
        assert!(load_cf_hints().is_none());

        clear_setup();
        assert!(load_cf_hints().is_none(), "disconnect must clear hints too");
    }

    /// The Cloudflare OAuth token is not persisted anywhere. Asserted on the
    /// source because the risk is a future edit adding a key for it, which no
    /// behavioural test would catch.
    #[test]
    fn no_key_here_stores_a_cloudflare_token() {
        let src = include_str!("secure_store.rs");
        let keys: Vec<&str> = src
            .lines()
            .filter(|l| l.trim_start().starts_with("const KEY_"))
            .collect();
        for line in keys {
            let lowered = line.to_lowercase();
            assert!(
                !(lowered.contains("access") || lowered.contains("refresh") || lowered.contains("oauth")),
                "secure_store must not gain a key for a Cloudflare token: {line}"
            );
        }
    }
}
