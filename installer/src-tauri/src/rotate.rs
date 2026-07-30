//! The local half of a password change: every place on *this* computer that
//! holds the brain's password, rewritten in one pass.
//!
//! Split out of `commands.rs` on the `migration.rs` precedent — `provision.rs`
//! grows by one call (`rotate_secret`), not by a flow — and kept as one function
//! for the reason #235 itself demonstrates. The issue named two stores. There are
//! three, and the third is the one that would have shipped broken: the `brain`
//! CLI reads a plaintext config file that nothing else touches, so a rotation
//! that skipped it would leave the command silently 401ing with no clue why.
//! [`RotateOutcome`] is the enumeration that was missing, and the guard test at
//! the bottom of this file pins it.
//!
//! Called **only** after `provision::rotate_secret` reports success. Until the
//! Worker has authenticated the new token there is no guarantee the brain has
//! moved, and writing the new password here first would lock this computer out
//! of a brain that is still working perfectly on the old one.

use crate::{cli_config, secure_store};
use std::path::Path;

/// What happened at each of the places this computer keeps the password.
///
/// Returned to the webview on success as well as consulted on failure: the done
/// screen opens by claiming "this computer is using the new password already",
/// which it may only say if it knows the local writes landed.
///
/// One field per store, and the set of fields is the specification — see
/// `the_places_a_rotation_writes_are_exactly_these_three`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RotateOutcome {
    /// OS secure storage (Keychain / Credential Manager). The one the app itself
    /// reads at every launch, so a `false` here means this computer will ask for
    /// the password the next time it opens.
    pub keychain: bool,
    /// `~/.config/second-brain/config.json`, which the `brain` CLI reads.
    ///
    /// `None` means the file is not there, i.e. the CLI was never set up on this
    /// computer. That is not a failure and gets no sentence on any screen.
    pub cli_config: Option<bool>,
    /// The dashboard window that is already open, if there is one. The token is
    /// injected when that window is *created*, so an open one keeps serving the
    /// old value until it is told otherwise.
    pub dashboard: bool,
}

/// Writes `new_token` everywhere this computer keeps the brain's password.
///
/// Never fails as a whole: each store is independent, and a caller has to be
/// able to tell the user precisely which one did not take. Ordered as the design
/// specifies — secure storage first, because it is the store the app itself
/// depends on and the one whose failure the user must be told about.
///
/// `refresh_dashboard` is injected rather than called directly so this stays
/// testable: reaching an open webview needs a Tauri `AppHandle`, which cannot be
/// constructed in a unit test, and the ordering above is exactly the sort of
/// thing that quietly rots when it is only exercised by hand.
pub fn persist(
    home: &Path,
    worker_url: &str,
    new_token: &str,
    refresh_dashboard: impl FnOnce(&str) -> bool,
) -> RotateOutcome {
    // 1. Secure storage.
    let keychain = match secure_store::save_setup(worker_url, new_token) {
        Ok(()) => true,
        Err(e) => {
            log::error!("could not save the new password to secure storage: {e}");
            false
        }
    };

    // 2. The CLI's config file — but only if it is already there.
    //
    // `cli_config::write_config` creates the file and its parent directory when
    // they are missing. That is right at setup, where the user has just asked for
    // the CLI, and wrong here: someone who never installed it would end up with a
    // plaintext copy of their password sitting in their home directory as a side
    // effect of *changing* that password. A change made for hygiene would leave
    // them measurably worse off than before they made it.
    //
    // So `None` means "not installed", which is not a failure, and the existence
    // check is the whole point of this branch. Collapsing it to an unconditional
    // write is the mutation this module's tests exist to catch.
    let cli_config = cli_config::config_path(home)
        .exists()
        .then(|| match cli_config::write_config(home, worker_url, new_token) {
            Ok(_) => true,
            Err(e) => {
                log::warn!("could not update the CLI config with the new password: {e}");
                false
            }
        });

    // 3. The open dashboard window, last, because it is the only one the user
    // can put right themselves by closing and reopening it.
    let dashboard = refresh_dashboard(new_token);

    RotateOutcome {
        keychain,
        cli_config,
        dashboard,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sb-rotate-test-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    const URL: &str = "https://second-brain.demo.workers.dev";
    const NEW: &str = "k7hpq-3mrxd-9wfty-2njca";

    /// The store the app itself reads at launch. A rotation that changed the
    /// brain and not this one leaves the computer locked out of its own brain.
    ///
    /// Reads back through `secure_store` rather than trusting the returned flag:
    /// the flag is what `persist` claims, and the claim is what the done screen
    /// repeats to the user.
    ///
    /// Reading the store back is deliberately not attempted, and the reason is
    /// worth writing down rather than rediscovering. `secure_store`'s backing map
    /// is process-global, and its own test clears and rewrites it from end to
    /// end; a save-then-load here is measuring that test as much as this one, in
    /// both directions. A guard that fails one run in thirty gets deleted rather
    /// than fixed, so this asserts the two things that are actually stable: that
    /// the write is reported, and — below — that it goes through `secure_store`
    /// at all.
    #[test]
    fn writes_the_new_password_to_secure_storage() {
        let home = temp_home("keychain");
        let outcome = persist(&home, URL, NEW, |_| true);
        assert!(
            outcome.keychain,
            "the store the app itself reads at launch. A rotation that changed the \
             brain and not this one leaves the computer locked out of its own brain"
        );
    }

    /// …and the write is a real one, not a reported one.
    ///
    /// The other half of the test above: `keychain: true` is a claim, and the done
    /// screen repeats that claim to the user, so something has to hold the call
    /// that makes it true in place.
    #[test]
    fn the_keychain_write_goes_through_secure_store() {
        let src = include_str!("rotate.rs");
        let code = &src[..src.find("#[cfg(test)]").expect("test module")];
        let start = code.find("pub fn persist(").expect("persist");
        let body = &code[start..];
        let body = &body[..body.find("\n}").expect("end of fn")];

        assert!(
            body.contains("secure_store::save_setup"),
            "persist no longer writes secure storage, so `keychain: true` would be \
             telling the user their computer holds a password it does not have"
        );
        assert!(
            body.contains("cli_config::config_path") && body.contains("exists()"),
            "persist no longer checks whether the CLI config is there before \
             writing it, so changing a password would create a plaintext \
             credential file for someone who never installed the CLI"
        );
    }

    /// The bug #235's own analysis missed. A user who never installed the CLI
    /// must not acquire a plaintext credential file by changing their password.
    #[test]
    fn an_absent_cli_config_is_left_absent_rather_than_created() {
        let home = temp_home("no-cli");
        let path = cli_config::config_path(&home);
        assert!(!path.exists(), "precondition: the CLI was never set up here");

        let outcome = persist(&home, URL, NEW, |_| true);

        assert_eq!(
            outcome.cli_config, None,
            "a CLI that was never installed is not a failed write"
        );
        assert!(
            !path.exists(),
            "changing a password must never create a plaintext credential file"
        );
        assert!(
            !home.join(".config").join("second-brain").exists(),
            "nor the directory that would hold one"
        );
    }

    /// The other half: when the CLI *is* set up, leaving it on the old password
    /// means `brain` 401s from the next command onwards with nothing on screen
    /// to explain it.
    #[test]
    fn an_existing_cli_config_is_rewritten_and_its_other_keys_survive() {
        let home = temp_home("with-cli");
        let path = cli_config::config_path(&home);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"workerUrl":"https://second-brain.demo.workers.dev","authToken":"old","defaultTags":["work"]}"#,
        )
        .unwrap();

        let outcome = persist(&home, URL, NEW, |_| true);

        assert_eq!(outcome.cli_config, Some(true));
        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed["authToken"], NEW);
        assert_eq!(parsed["workerUrl"], URL);
        assert_eq!(
            parsed["defaultTags"][0], "work",
            "the CLI's own settings are not ours to discard"
        );
    }

    /// The dashboard result is reported, not assumed. An open window keeps the
    /// token it was created with, so "we told it" and "we could not" are
    /// different facts and the screen says different things about them.
    #[test]
    fn the_dashboard_result_is_passed_through_both_ways() {
        let home = temp_home("dash-ok");
        let seen = std::cell::RefCell::new(String::new());
        let outcome = persist(&home, URL, NEW, |token| {
            *seen.borrow_mut() = token.to_string();
            true
        });
        assert!(outcome.dashboard);
        assert_eq!(
            *seen.borrow(),
            NEW,
            "the window must be handed the new password, not the old one"
        );

        let home = temp_home("dash-fail");
        let outcome = persist(&home, URL, NEW, |_| false);
        assert!(!outcome.dashboard, "a refused refresh must not be reported as done");
    }

    /// The test that would have caught the CLI config.
    ///
    /// Pins the complete list of places a rotation writes, in the shape of
    /// `secure_store`'s `the_stored_key_set_is_exactly_these_five`. #235 was
    /// filed naming two stores; nothing in the codebase enumerated them, so the
    /// third was found by reading `cli_config.rs` rather than by anything
    /// failing. Adding a fourth is then a deliberate act that forces someone to
    /// decide what a rotation owes it.
    ///
    /// Scans only the source *above* the test module, and only the struct's own
    /// body. A source-scanning guard that reads the whole file matches its own
    /// expectation string and passes no matter what the code says — that has
    /// quietly disabled three guards in this repo already.
    #[test]
    fn the_places_a_rotation_writes_are_exactly_these_three() {
        let src = include_str!("rotate.rs");
        let code = &src[..src.find("#[cfg(test)]").expect("test module")];

        let start = code
            .find("pub struct RotateOutcome {")
            .expect("RotateOutcome is declared above the tests");
        let body = &code[start..];
        let body = &body[..body.find("\n}").expect("end of the struct")];

        let fields: Vec<&str> = body
            .lines()
            .skip(1) // the `pub struct …` line itself
            .filter_map(|line| line.trim().strip_prefix("pub "))
            .filter_map(|field| field.split(':').next())
            .collect();

        assert_eq!(
            fields,
            vec!["keychain", "cli_config", "dashboard"],
            "a rotation gained or lost somewhere it writes. Every store here has \
             to be rewritten together, because the ones that are missed do not \
             announce themselves — they just start refusing the user's password."
        );
    }
}
