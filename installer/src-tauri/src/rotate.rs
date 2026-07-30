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

use crate::cli_config;
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
/// Both `save_secure` and `refresh_dashboard` are injected rather than called
/// directly, for two reasons that turned out to be the same reason.
///
/// Reaching an open webview needs a Tauri `AppHandle`, which cannot be
/// constructed in a unit test — so without the seam the ordering here is only
/// ever exercised by hand, and an ordering nothing asserts is exactly the sort of
/// thing that quietly rots.
///
/// Secure storage has the mirror-image problem. Under `cfg(test)` its backing map
/// is *process-global*, so calling it from here wrote state that `secure_store`'s
/// own end-to-end test was mid-way through asserting on: this module's tests
/// failed that neighbour roughly one run in fifteen at default parallelism, and
/// never at `--test-threads=1`, so CI would have blamed `secure_store` for a fault
/// introduced here. The seam removes the shared state entirely rather than
/// serialising against it, and it buys the thing serialising could not: a
/// `save_setup` that *fails*, which the real test backend cannot do, and which is
/// the difference between the done screen's "this computer is using the new
/// password already" being a fact and being a guess.
///
/// `save_secure` returns `Result<(), String>` rather than `secure_store`'s own
/// error type because that type's inner field is private to its module — a test
/// here could not construct one, which would leave the failure branch as
/// unreachable as it was before.
pub fn persist(
    home: &Path,
    worker_url: &str,
    new_token: &str,
    save_secure: impl FnOnce(&str, &str) -> Result<(), String>,
    refresh_dashboard: impl FnOnce(&str) -> bool,
) -> RotateOutcome {
    // 1. Secure storage.
    let keychain = match save_secure(worker_url, new_token) {
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
    //
    // The check is on the *file*, deliberately, and `is_file` rather than
    // `exists`. Widening it to the parent directory — which `~/.config` users
    // very often have, because anything else may have created
    // `~/.config/second-brain/` — hands a plaintext credential file to exactly
    // the person this branch exists to protect. That widening is a one-token edit
    // and it survived every test in this module until
    // `a_cli_directory_without_a_config_file_is_still_not_an_installed_cli` was
    // written, so the guard against it is behavioural and not a source scan.
    let cli_config = cli_config::config_path(home)
        .is_file()
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

    /// A `save_secure` seam that succeeds and records what it was handed.
    fn ok_store() -> impl FnOnce(&str, &str) -> Result<(), String> {
        |_, _| Ok(())
    }

    /// The store the app itself reads at launch. A rotation that changed the
    /// brain and not this one leaves the computer locked out of its own brain.
    ///
    /// The address and the password are both asserted, because `save_setup` takes
    /// two `&str` in that order and swapping them is a silent, compiling change
    /// that would store the password as the address.
    #[test]
    fn writes_the_new_password_to_secure_storage() {
        let home = temp_home("keychain");
        let seen = std::cell::RefCell::new(None);
        let outcome = persist(
            &home,
            URL,
            NEW,
            |url, token| {
                *seen.borrow_mut() = Some((url.to_string(), token.to_string()));
                Ok(())
            },
            |_| true,
        );
        assert!(
            outcome.keychain,
            "the store the app itself reads at launch. A rotation that changed the \
             brain and not this one leaves the computer locked out of its own brain"
        );
        assert_eq!(
            *seen.borrow(),
            Some((URL.to_string(), NEW.to_string())),
            "secure storage must be handed this brain's address and the NEW password"
        );
    }

    /// `keychain: true` is a claim, and the done screen opens by repeating it to
    /// the user — "this computer is using the new password already". A store that
    /// refused the write must not be reported as one that took it, or the one
    /// screen whose job is to say what is safe now says the opposite of the truth.
    ///
    /// Only reachable because the store is injected. The `cfg(test)` backend
    /// behind `secure_store::save_setup` cannot fail, so before the seam existed
    /// this branch was dead code that any mutation could delete unnoticed.
    #[test]
    fn a_refused_keychain_write_is_reported_as_refused() {
        let home = temp_home("keychain-fail");
        let outcome = persist(
            &home,
            URL,
            NEW,
            |_, _| Err("the login keychain is locked".into()),
            |_| true,
        );
        assert!(
            !outcome.keychain,
            "a store that refused the write must not be reported as holding the new \
             password — the done screen tells the user this computer is already \
             using it, and the next launch would then ask for a password nothing here has"
        );
        assert_eq!(
            outcome.cli_config, None,
            "a failed keychain write does not abandon the rest: each store is \
             independent and the user is told which one did not take"
        );
        assert!(outcome.dashboard, "…including the ones that did work");
    }

    /// The bug #235's own analysis missed. A user who never installed the CLI
    /// must not acquire a plaintext credential file by changing their password.
    #[test]
    fn an_absent_cli_config_is_left_absent_rather_than_created() {
        let home = temp_home("no-cli");
        let path = cli_config::config_path(&home);
        assert!(!path.exists(), "precondition: the CLI was never set up here");

        let outcome = persist(&home, URL, NEW, ok_store(), |_| true);

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

    /// The half-installed case, and the one the previous source-scanning guard
    /// could not see.
    ///
    /// That guard asserted only that the words `config_path` and `exists()`
    /// appeared in `persist`, so widening the test from the file to its parent
    /// directory kept it green — while handing a plaintext copy of the user's new
    /// password to anyone whose `~/.config/second-brain/` exists without a
    /// `config.json` in it. That directory is created by an uninstall that left
    /// the folder behind, by a `brain` command that failed before its first write,
    /// or by hand; the file is the only thing that means "the CLI is set up here".
    #[test]
    fn a_cli_directory_without_a_config_file_is_still_not_an_installed_cli() {
        let home = temp_home("cli-dir-only");
        let path = cli_config::config_path(&home);
        let dir = path.parent().expect("the config file has a parent");
        fs::create_dir_all(dir).unwrap();
        assert!(dir.exists() && !path.exists(), "precondition: directory, no file");

        let outcome = persist(&home, URL, NEW, ok_store(), |_| true);

        assert_eq!(
            outcome.cli_config, None,
            "an empty config directory is not an installed CLI"
        );
        assert!(
            !path.exists(),
            "changing a password created a plaintext credential file for someone \
             who never installed the CLI — the exact harm this branch exists to prevent"
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

        let outcome = persist(&home, URL, NEW, ok_store(), |_| true);

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

    /// The CLI branch's other failure, and the one nothing could reach until
    /// now: the file *is* there, so the write is attempted, and it does not take.
    ///
    /// `Some(true)` and `Some(false)` are different sentences on the done screen.
    /// Reported as a success, the user is told the `brain` command is on the new
    /// password; it then 401s from their next command onwards with nothing on
    /// screen — and nothing in the outcome — to point at the cause. That is the
    /// precise failure this module's own header says #235 would have shipped, so
    /// the branch that reports it has to be pinned rather than merely written.
    ///
    /// The failure used here is a config file that is not JSON, for two reasons.
    /// It is one `write_config` genuinely produces and refuses to clobber — its
    /// own `malformed_config_is_not_clobbered` pins that — and it needs no
    /// permissions: a read-only file or directory proves nothing under a CI
    /// container running as root, where mode bits do not stop a write and this
    /// test would silently invert into asserting that a *successful* write is
    /// reported as a failure. It is also how a user really arrives here, by hand
    /// editing the file or by a half-finished write.
    #[test]
    fn a_cli_config_that_could_not_be_rewritten_is_reported_as_not_rewritten() {
        let home = temp_home("cli-unwritable");
        let path = cli_config::config_path(&home);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{ hand-edited, and no longer json").unwrap();

        let outcome = persist(&home, URL, NEW, ok_store(), |_| true);

        assert_eq!(
            outcome.cli_config,
            Some(false),
            "the CLI is installed and the write did not take, which is a failed \
             write and not an absent CLI. As `Some(true)` the done screen tells \
             the user their `brain` command is on the new password, and the \
             command then refuses them with no explanation available anywhere."
        );
        assert!(
            !fs::read_to_string(&path).unwrap().contains(NEW),
            "the report has to be true in the other direction too: the write \
             failed, so the file must still hold what it held"
        );
        assert!(
            outcome.keychain && outcome.dashboard,
            "each store is independent — a CLI write that failed does not \
             abandon the stores on either side of it"
        );
    }

    /// The dashboard result is reported, not assumed. An open window keeps the
    /// token it was created with, so "we told it" and "we could not" are
    /// different facts and the screen says different things about them.
    #[test]
    fn the_dashboard_result_is_passed_through_both_ways() {
        let home = temp_home("dash-ok");
        let seen = std::cell::RefCell::new(String::new());
        let outcome = persist(&home, URL, NEW, ok_store(), |token| {
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
        let outcome = persist(&home, URL, NEW, ok_store(), |_| false);
        assert!(!outcome.dashboard, "a refused refresh must not be reported as done");
    }

    /// The order of the three writes, asserted rather than described.
    ///
    /// The module doc calls this "exactly the sort of thing that quietly rots",
    /// and it was right: moving the dashboard refresh above the keychain write
    /// changed nothing any test could see. It matters because the stores are not
    /// equal. Secure storage is the one the app itself reads at every launch, so
    /// it goes first and its failure is the one the user must be told about; the
    /// dashboard goes last because it is the only one the user can put right
    /// themselves by closing the window and reopening it. Between them, the CLI
    /// config — after the keychain, so a crash mid-run never leaves a plaintext
    /// copy of a password that secure storage does not have.
    ///
    /// Each seam observes the *file* rather than a call log, so this pins all
    /// three positions from two callbacks.
    #[test]
    fn the_stores_are_written_in_the_order_that_makes_a_half_finished_run_safe() {
        let home = temp_home("order");
        let path = cli_config::config_path(&home);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"workerUrl":"x","authToken":"old"}"#).unwrap();

        let calls = std::cell::RefCell::new(Vec::new());
        let holds_new_password =
            |p: &std::path::Path| fs::read_to_string(p).is_ok_and(|t| t.contains(NEW));

        let outcome = persist(
            &home,
            URL,
            NEW,
            |_, _| {
                calls.borrow_mut().push("keychain");
                assert!(
                    !holds_new_password(&path),
                    "the CLI config was written before secure storage. A run that \
                     stops in between then leaves a plaintext copy of a password \
                     the app itself does not hold."
                );
                Ok(())
            },
            |_| {
                calls.borrow_mut().push("dashboard");
                assert!(
                    holds_new_password(&path),
                    "the dashboard was refreshed before the CLI config was written"
                );
                true
            },
        );

        assert_eq!(
            *calls.borrow(),
            vec!["keychain", "dashboard"],
            "secure storage is written first: it is the store the app reads at every \
             launch, and the only one whose failure locks this computer out"
        );
        assert_eq!(outcome.cli_config, Some(true));
    }

    /// The wire shape the done screen reads, pinned by name.
    ///
    /// `#[serde(rename_all = "camelCase")]` is one line, deleting it compiles, and
    /// every test above reads the Rust field rather than the JSON one — so the UI
    /// would start seeing `cli_config` where it looks for `cliConfig`, silently
    /// render "the CLI was not installed" for a user whose CLI was just rewritten,
    /// and nothing would fail.
    #[test]
    fn the_outcome_reaches_the_screen_under_the_names_it_reads() {
        let outcome = RotateOutcome {
            keychain: true,
            cli_config: Some(false),
            dashboard: false,
        };
        assert_eq!(
            serde_json::to_value(&outcome).expect("RotateOutcome serializes"),
            serde_json::json!({
                "keychain": true,
                "cliConfig": false,
                "dashboard": false,
            })
        );

        // `None` has to arrive as an explicit null rather than a missing key: the
        // screen distinguishes "the CLI was never installed" from "the CLI write
        // failed", and an absent field reads as neither.
        assert_eq!(
            serde_json::to_value(RotateOutcome {
                keychain: false,
                cli_config: None,
                dashboard: true,
            })
            .expect("RotateOutcome serializes"),
            serde_json::json!({
                "keychain": false,
                "cliConfig": serde_json::Value::Null,
                "dashboard": true,
            })
        );
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
