//! Reading a connected brain's own address.
//!
//! A workers.dev host carries two facts the app acts on:
//!
//! ```text
//! second-brain . acme . workers.dev
//! └─ script ──┘  └ subdomain ┘
//! ```
//!
//! The **script name** says which Worker to deploy to. The **subdomain** says
//! which Cloudflare account it lives in.
//!
//! Both must come from the stored address and nowhere else. Taking the script
//! name from the bundled manifest instead is what #257 was: deploys are a `PUT`,
//! so updating a brain connected as `my-brain.acme.workers.dev` wrote the bundle
//! to a script named `second-brain` in that account — creating a Worker the user
//! never asked for, or overwriting an unrelated one that happened to hold the
//! name.
//!
//! A custom domain yields neither fact, so both accessors return `None` rather
//! than guessing; callers surface that as "this brain is on its own address".

/// The four labels of a `<script>.<subdomain>.workers.dev` host.
///
/// Exactly four: `acme.workers.dev` is not a brain address, and the old
/// `split('.').nth(1)` read of it returned `"workers"` as the subdomain — a
/// plausible-looking value that matches no real account.
fn labels(worker_url: &str) -> Option<[String; 4]> {
    let parsed = url::Url::parse(worker_url).ok()?;
    // Match the contract `normalize_worker_url` enforces on the way in: a stored
    // brain address is always http or https. Anything else is not an address this
    // app produced, and the script name derived from it would end up in an API
    // path for a deploy.
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    if !host.ends_with(".workers.dev") {
        return None; // custom domain — neither fact is derivable
    }
    let parts: Vec<&str> = host.split('.').collect();
    let [script, subdomain, "workers", "dev"] = parts.as_slice() else {
        return None;
    };
    if script.is_empty() || subdomain.is_empty() {
        return None;
    }
    Some([
        script.to_string(),
        subdomain.to_string(),
        "workers".into(),
        "dev".into(),
    ])
}

/// The Worker script name to deploy to.
pub fn script_of(worker_url: &str) -> Option<String> {
    labels(worker_url).map(|l| l[0].clone())
}

/// The account's workers.dev subdomain, used to resolve which Cloudflare
/// account holds this brain.
pub fn subdomain_of(worker_url: &str) -> Option<String> {
    labels(worker_url).map(|l| l[1].clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_both_halves_of_a_brain_address() {
        let url = "https://second-brain.acme.workers.dev";
        assert_eq!(script_of(url).as_deref(), Some("second-brain"));
        assert_eq!(subdomain_of(url).as_deref(), Some("acme"));
    }

    /// The case #257 is about: a brain that is not named `second-brain`. The
    /// script name has to follow the address, or the update deploys elsewhere.
    #[test]
    fn reads_a_brain_deployed_under_another_name() {
        let url = "https://my-brain-2.dad-piranifam-com-s-account.workers.dev";
        assert_eq!(script_of(url).as_deref(), Some("my-brain-2"));
        assert_eq!(
            subdomain_of(url).as_deref(),
            Some("dad-piranifam-com-s-account")
        );
    }

    #[test]
    fn a_path_or_trailing_slash_does_not_confuse_it() {
        for url in [
            "https://second-brain.acme.workers.dev/",
            "https://second-brain.acme.workers.dev/mcp",
            "https://second-brain.acme.workers.dev/graph?tab=all",
        ] {
            assert_eq!(script_of(url).as_deref(), Some("second-brain"), "{url}");
            assert_eq!(subdomain_of(url).as_deref(), Some("acme"), "{url}");
        }
    }

    /// A custom domain gives up neither fact. Guessing would mean deploying to
    /// a script name invented from someone's marketing domain.
    #[test]
    fn a_custom_domain_yields_nothing() {
        for url in [
            "https://brain.example.com",
            "https://memory.piranifam.com/mcp",
            "https://workers.dev",
        ] {
            assert_eq!(script_of(url), None, "{url}");
            assert_eq!(subdomain_of(url), None, "{url}");
        }
    }

    /// `acme.workers.dev` has no script label. The previous implementation read
    /// its second label and reported the subdomain as `"workers"`, which matches
    /// no account and surfaced as a confusing "wrong account" error.
    #[test]
    fn an_address_with_no_script_label_is_refused() {
        assert_eq!(script_of("https://acme.workers.dev"), None);
        assert_eq!(subdomain_of("https://acme.workers.dev"), None);
    }

    #[test]
    fn junk_is_refused_rather_than_half_parsed() {
        for url in ["", "not a url", "https://", "ftp://x.y.workers.dev"] {
            assert_eq!(script_of(url), None, "{url}");
            assert_eq!(subdomain_of(url), None, "{url}");
        }
    }

    /// Hosts are case-insensitive, and the script name is used verbatim in an
    /// API path — so it must come back normalised, not as the user typed it.
    #[test]
    fn the_host_is_normalised_to_lowercase() {
        let url = "https://Second-Brain.ACME.workers.dev";
        assert_eq!(script_of(url).as_deref(), Some("second-brain"));
        assert_eq!(subdomain_of(url).as_deref(), Some("acme"));
    }

    /// The property #248 relies on: an address built from an account's own
    /// subdomain round-trips back to it, and to the script that was deployed.
    #[test]
    fn round_trips_an_address_the_app_itself_built() {
        for (script, subdomain) in [
            ("second-brain", "acme"),
            ("second-brain", "dad-piranifam-com-s-account"),
        ] {
            let url = format!("https://{script}.{subdomain}.workers.dev");
            assert_eq!(script_of(&url).as_deref(), Some(script));
            assert_eq!(subdomain_of(&url).as_deref(), Some(subdomain));
        }
    }
}
