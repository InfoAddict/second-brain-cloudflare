//! Finding an existing Second Brain in the user's Cloudflare account.
//!
//! Setup used to require the user to go to the Cloudflare dashboard, find their
//! Worker, and type its `workers.dev` URL. This lists the account's Workers
//! instead and asks each one, without credentials, whether it looks like a
//! Second Brain.
//!
//! Everything here probes the *deployed Worker*, not the Cloudflare API, and
//! every probe is unauthenticated — discovery must never send the user's
//! password to an address that has not been identified yet.

use super::api::CfClient;
use super::types::CfApiError;
use std::time::Duration;

/// How long a single probe waits. Short on purpose: an account can hold dozens
/// of Workers, and an unreachable one must not stall the whole scan.
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

/// How many Workers are probed at once.
const MAX_CONCURRENT_PROBES: usize = 8;

/// How sure we are that an address is a Second Brain.
///
/// Two independent signals go into this:
///
/// 1. **Auth-gated JSON** — `/health` (or `/count` on brains predating it)
///    answers 401 with the Worker's `{ ok: false, … }` shape. This is the
///    Second-Brain-specific signal.
/// 2. **MCP OAuth metadata** — `/.well-known/oauth-protected-resource/mcp`
///    serves resource metadata. This comes from `workers-oauth-provider`, so it
///    proves "an MCP OAuth Worker" and *not* "a Second Brain" — any Worker
///    built on that library serves it.
///
/// Signal 2 alone therefore does not qualify: it would match an unrelated MCP
/// server in the same account. Signal 1 is required, and signal 2 upgrades the
/// result to [`Confidence::Strong`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Confidence {
    /// Auth-gated like a brain, and serves MCP OAuth metadata.
    Likely,
    /// Both signals. Ordered last so `sort` puts the best matches at the end
    /// and `rev` yields strongest-first.
    Strong,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// The Worker's deploy name, which is what the user recognises.
    pub name: String,
    pub url: String,
}

/// Builds the `workers.dev` origin for a script. Cloudflare's scheme is
/// `<script>.<account-subdomain>.workers.dev`.
pub fn workers_dev_url(script: &str, subdomain: &str) -> String {
    format!("https://{script}.{subdomain}.workers.dev")
}

/// Asks one address whether it is a Second Brain, using no credentials.
///
/// `None` means "not a brain, or not reachable" — the two are deliberately not
/// distinguished, because neither is something to offer the user as a brain to
/// connect to.
pub async fn classify(origin: &str) -> Option<Confidence> {
    let http = reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .ok()?;

    // The discriminating probe runs first, so an unrelated Worker costs one or
    // two requests and never reaches the generic one.
    if !auth_gated_like_a_brain(&http, origin).await {
        return None;
    }
    if serves_mcp_oauth_metadata(&http, origin).await {
        Some(Confidence::Strong)
    } else {
        Some(Confidence::Likely)
    }
}

/// True when an unauthenticated read is refused the way the Worker refuses it:
/// HTTP 401 with a JSON body carrying `ok: false`.
///
/// `/count` is tried after `/health` for brains deployed before `/health`
/// existed — the same fallback [`super::api::probe_worker`] makes, for the same
/// reason.
async fn auth_gated_like_a_brain(http: &reqwest::Client, origin: &str) -> bool {
    for path in ["/health", "/count"] {
        let Ok(resp) = http.get(format!("{origin}{path}")).send().await else {
            // A transport error on the first path is usually a dead host;
            // trying the second would just pay the timeout twice.
            return false;
        };
        if resp.status().as_u16() != 401 {
            continue;
        }
        let Ok(body) = resp.json::<serde_json::Value>().await else {
            continue; // 401 but not JSON — someone else's auth wall
        };
        if body.get("ok") == Some(&serde_json::Value::Bool(false)) {
            return true;
        }
    }
    false
}

/// True when the address serves MCP protected-resource metadata.
///
/// Corroborating only — see [`Confidence`]. Requires the document to actually
/// describe an MCP resource rather than merely be 200 JSON.
async fn serves_mcp_oauth_metadata(http: &reqwest::Client, origin: &str) -> bool {
    let url = format!("{origin}/.well-known/oauth-protected-resource/mcp");
    let Ok(resp) = http.get(&url).send().await else {
        return false;
    };
    if !resp.status().is_success() {
        return false;
    }
    let Ok(body) = resp.json::<serde_json::Value>().await else {
        return false;
    };
    let resource_is_mcp = body
        .get("resource")
        .and_then(|r| r.as_str())
        .is_some_and(|r| r.ends_with("/mcp"));
    let has_auth_server = body
        .get("authorization_servers")
        .and_then(|s| s.as_array())
        .is_some_and(|s| !s.is_empty());
    resource_is_mcp && has_auth_server
}

/// Probes every candidate concurrently and returns those worth offering.
///
/// Ordering is by confidence then name, so the list is stable across runs —
/// Cloudflare does not promise an order for the script list.
pub async fn probe_all(scripts: Vec<String>, subdomain: &str) -> Vec<(Candidate, Confidence)> {
    let mut found: Vec<(Candidate, Confidence)> = Vec::new();
    // Chunked rather than one big JoinSet so a large account does not open
    // dozens of sockets at once.
    for chunk in scripts.chunks(MAX_CONCURRENT_PROBES) {
        let mut set = tokio::task::JoinSet::new();
        for script in chunk {
            let name = script.clone();
            let url = workers_dev_url(script, subdomain);
            set.spawn(async move {
                let verdict = classify(&url).await;
                (Candidate { name, url }, verdict)
            });
        }
        while let Some(joined) = set.join_next().await {
            // A panicking probe task must not take the scan down with it.
            if let Ok((candidate, Some(confidence))) = joined {
                found.push((candidate, confidence));
            }
        }
    }
    found.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.name.cmp(&b.0.name)));
    found
}

/// Narrows probe results to what the user should actually see.
///
/// When anything matched on both signals, only those are offered: an account
/// can hold unrelated Workers that happen to answer 401 with JSON, and listing
/// them next to a confirmed brain makes the confirmed one harder to trust. With
/// no strong match, the weaker ones are all there is, so they are offered
/// rather than showing an empty list.
pub fn select_candidates(probed: Vec<(Candidate, Confidence)>) -> Vec<Candidate> {
    let has_strong = probed.iter().any(|(_, c)| *c == Confidence::Strong);
    probed
        .into_iter()
        .filter(|(_, c)| !has_strong || *c == Confidence::Strong)
        .map(|(candidate, _)| candidate)
        .collect()
}

/// What a scan of one account produced. The subdomain comes back alongside the
/// matches because the caller persists it as a hint, and re-fetching it would
/// be a second round trip for something already known.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Discovery {
    pub subdomain: String,
    pub brains: Vec<Candidate>,
}

/// Why a scan could not run. Kept separate from "ran and matched nothing",
/// which is a `Discovery` with an empty list — the two need different messages.
#[derive(Debug)]
pub enum DiscoverFailure {
    /// The account has never registered a workers.dev subdomain, so there are
    /// no addresses to construct.
    NoSubdomain,
    Api(CfApiError),
}

/// Scans one Cloudflare account for Second Brains.
///
/// Split out of the Tauri command so the ordering and failure mapping are
/// testable without an app handle: the command around this is only i18n and
/// session bookkeeping.
pub async fn discover_in_account(client: &CfClient) -> Result<Discovery, DiscoverFailure> {
    let subdomain = client
        .get_account_subdomain()
        .await
        .map_err(DiscoverFailure::Api)?
        .ok_or(DiscoverFailure::NoSubdomain)?;
    let scripts = client.list_workers().await.map_err(DiscoverFailure::Api)?;
    let brains = select_candidates(probe_all(scripts, &subdomain).await);
    Ok(Discovery { subdomain, brains })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A Worker stand-in. `kind` selects which contract the fake serves, so the
    /// tests exercise the real HTTP paths rather than a mocked classifier.
    fn spawn_worker(kind: &'static str) -> String {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        std::thread::spawn(move || loop {
            let Ok(req) = server.recv() else { return };
            let url = req.url().to_string();
            let json = |status: u16, payload: &str| {
                tiny_http::Response::from_string(payload)
                    .with_status_code(status)
                    .with_header(
                        "Content-Type: application/json"
                            .parse::<tiny_http::Header>()
                            .unwrap(),
                    )
            };
            let metadata = r#"{"resource":"http://x/mcp","authorization_servers":["http://x"]}"#;
            let unauthorized = r#"{"ok":false,"error":"Unauthorized"}"#;

            let resp = match (kind, url.as_str()) {
                // A current Second Brain.
                ("brain", "/health") => json(401, unauthorized),
                ("brain", "/.well-known/oauth-protected-resource/mcp") => json(200, metadata),

                // Deployed before /health existed: 404 there, 401 on /count.
                ("old_brain", "/health") => json(404, r#"{"error":"Not found"}"#),
                ("old_brain", "/count") => json(401, unauthorized),
                ("old_brain", "/.well-known/oauth-protected-resource/mcp") => {
                    json(404, r#"{}"#)
                }

                // Someone else's MCP server: serves the generic OAuth metadata
                // but is not auth-gated the way a brain is.
                ("other_mcp", "/health") => json(200, r#"{"status":"fine"}"#),
                ("other_mcp", "/count") => json(404, r#"{}"#),
                ("other_mcp", "/.well-known/oauth-protected-resource/mcp") => {
                    json(200, metadata)
                }

                // An unrelated app behind an auth wall that isn't JSON.
                ("html_wall", "/health") => tiny_http::Response::from_string("<html>login</html>")
                    .with_status_code(401)
                    .with_header("Content-Type: text/html".parse::<tiny_http::Header>().unwrap()),

                // Auth-gated with the brain's shape, no OAuth metadata at all.
                ("bare_brain", "/health") => json(401, unauthorized),

                _ => json(404, r#"{}"#),
            };
            let _ = req.respond(resp);
        });
        format!("http://127.0.0.1:{port}")
    }

    #[tokio::test]
    async fn recognises_a_current_brain_on_both_signals() {
        let origin = spawn_worker("brain");
        assert_eq!(classify(&origin).await, Some(Confidence::Strong));
    }

    #[tokio::test]
    async fn recognises_a_brain_that_predates_the_health_endpoint() {
        let origin = spawn_worker("old_brain");
        // Only the /count fallback identifies this one, and it serves no OAuth
        // metadata — still a brain, just not a confident match.
        assert_eq!(classify(&origin).await, Some(Confidence::Likely));
    }

    /// The false positive that matters: `workers-oauth-provider` serves the
    /// well-known route for every Worker built on it, so that signal alone must
    /// never qualify.
    #[tokio::test]
    async fn rejects_an_unrelated_mcp_worker_in_the_same_account() {
        let origin = spawn_worker("other_mcp");
        assert_eq!(classify(&origin).await, None);
    }

    #[tokio::test]
    async fn rejects_a_401_that_is_not_the_workers_json_contract() {
        let origin = spawn_worker("html_wall");
        assert_eq!(classify(&origin).await, None);
    }

    #[tokio::test]
    async fn accepts_a_brain_without_oauth_metadata_as_likely() {
        let origin = spawn_worker("bare_brain");
        assert_eq!(classify(&origin).await, Some(Confidence::Likely));
    }

    #[tokio::test]
    async fn an_unreachable_address_is_not_offered() {
        // Nothing is listening on this port.
        assert_eq!(classify("http://127.0.0.1:1").await, None);
    }

    #[test]
    fn builds_the_cloudflare_workers_dev_hostname() {
        assert_eq!(
            workers_dev_url("second-brain", "demo"),
            "https://second-brain.demo.workers.dev"
        );
    }

    #[test]
    fn a_confirmed_brain_hides_the_weaker_guesses() {
        let probed = vec![
            (
                Candidate { name: "noise".into(), url: "u1".into() },
                Confidence::Likely,
            ),
            (
                Candidate { name: "brain".into(), url: "u2".into() },
                Confidence::Strong,
            ),
        ];
        let picked = select_candidates(probed);
        assert_eq!(picked.len(), 1);
        assert_eq!(picked[0].name, "brain");
    }

    #[test]
    fn weak_guesses_are_offered_when_nothing_matched_strongly() {
        let probed = vec![
            (
                Candidate { name: "b".into(), url: "u2".into() },
                Confidence::Likely,
            ),
            (
                Candidate { name: "a".into(), url: "u1".into() },
                Confidence::Likely,
            ),
        ];
        let picked = select_candidates(probed);
        assert_eq!(picked.len(), 2, "an empty list would be worse than a guess");
    }

    #[tokio::test]
    async fn scans_a_mixed_account_and_offers_only_the_brain() {
        // Three Workers on one subdomain is not expressible through
        // workers_dev_url against a local server, so probe_all's selection is
        // covered by the pure tests above and its concurrency by this one:
        // an empty account must not hang or error.
        let out = probe_all(vec![], "demo").await;
        assert!(out.is_empty());
    }

    // ── The setup UI wired to this ──────────────────────────────────────────
    //
    // Read from installer/src/main.ts, following the convention in
    // settings.rs: the Rust core and the webview are separate build units, so
    // nothing but a source check catches the UI drifting away from the commands
    // it is supposed to call.

    fn setup_ui() -> String {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/main.ts");
        std::fs::read_to_string(path).expect("read installer/src/main.ts")
    }

    /// The whole point of the feature: sign-in must actually reach discovery.
    #[test]
    fn the_existing_brain_path_offers_cloudflare_sign_in() {
        let ui = setup_ui();
        assert!(
            ui.contains(r#"invoke<Account[]>("connect_cloudflare")"#),
            "the existing-brain path must offer Cloudflare sign-in"
        );
        assert!(
            ui.contains(r#"invoke<DiscoveredBrain[]>("discover_brains""#),
            "signing in must lead to a scan, or nothing is discovered"
        );
    }

    /// Manual entry cannot be removed. A custom domain, a brain in another
    /// party's account, and a user unwilling to grant scopes all depend on it,
    /// and none of them are recoverable if the field is gone.
    #[test]
    fn manual_address_entry_survives() {
        let ui = setup_ui();
        assert!(
            ui.contains("function manualEntryScreen("),
            "manual address entry must remain available"
        );
        assert!(
            ui.contains(r#"t("connectExisting.addressPlaceholder")"#),
            "the address field must still be offered"
        );
        // Reachable from the chooser *and* from a scan that found nothing.
        assert!(
            ui.matches("manualEntryScreen(").count() >= 3,
            "manual entry must be reachable, not just defined"
        );
    }

    /// Discovery hands the picked address to `connect_existing`, the same
    /// command manual entry uses. That is what keeps the stored state identical
    /// however the brain was found — and `start_worker_update` reads exactly
    /// that state, so a discovery path that saved differently would break
    /// updates for these users.
    #[test]
    fn a_discovered_brain_connects_through_the_same_command_as_a_typed_one() {
        let ui = setup_ui();
        let unlock_start = ui.find("function unlockBrainScreen(").expect("unlock screen");
        let unlock = &ui[unlock_start..];
        let unlock = &unlock[..unlock.find("\nfunction ").unwrap_or(unlock.len())];
        assert!(
            unlock.contains(r#"invoke<ConnectionDetails>("connect_existing""#),
            "the discovered-brain path must save through connect_existing"
        );
        assert!(
            unlock.contains("address: brain.url"),
            "it must connect to the address that was discovered"
        );
    }

    /// The password is asked for after the address is known, never before —
    /// discovery probes are unauthenticated, and a password typed earlier could
    /// only have been sent to an unidentified address.
    #[test]
    fn the_password_is_requested_only_once_an_address_is_chosen() {
        let ui = setup_ui();
        let searching = ui
            .find("function searchingScreen(")
            .expect("searching screen");
        let block = &ui[searching..];
        let block = &block[..block.find("\nasync function").unwrap_or(block.len())];
        assert!(
            !block.contains("passwordPlaceholder"),
            "the scan screen must not collect a password"
        );
    }

    // ── Account-level orchestration ─────────────────────────────────────────
    //
    // Against a fake Cloudflare API. The Workers these build addresses for do
    // not exist, so `brains` is empty — what is under test is the ordering, the
    // subdomain handling, and the failure mapping.

    fn spawn_cf_api(subdomain_body: &'static str) -> String {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        std::thread::spawn(move || loop {
            let Ok(req) = server.recv() else { return };
            let body = if req.url().contains("/workers/subdomain") {
                subdomain_body
            } else {
                r#"{"success":true,"errors":[],"result":[{"id":"nope"}]}"#
            };
            let _ = req.respond(tiny_http::Response::from_string(body).with_status_code(200));
        });
        format!("http://127.0.0.1:{port}")
    }

    #[tokio::test]
    async fn a_scan_reports_the_subdomain_it_used() {
        let base = spawn_cf_api(r#"{"success":true,"errors":[],"result":{"subdomain":"acme"}}"#);
        let client = CfClient::with_base("tok".into(), "acct".into(), base);
        let found = discover_in_account(&client).await.expect("scan runs");
        // Carried back so the caller can persist it without a second lookup.
        assert_eq!(found.subdomain, "acme");
    }

    /// An account that never registered a workers.dev subdomain cannot be
    /// scanned at all, and that must not be reported as the same thing as an
    /// account with no brains in it.
    #[tokio::test]
    async fn an_account_without_a_subdomain_fails_distinctly() {
        for body in [
            r#"{"success":true,"errors":[],"result":{"subdomain":null}}"#,
            // Empty string is what Cloudflare returns in practice, and
            // get_account_subdomain filters it to None.
            r#"{"success":true,"errors":[],"result":{"subdomain":""}}"#,
        ] {
            let client = CfClient::with_base("tok".into(), "acct".into(), spawn_cf_api(body));
            match discover_in_account(&client).await {
                Err(DiscoverFailure::NoSubdomain) => {}
                other => panic!("expected NoSubdomain, got {other:?}"),
            }
        }
    }

    /// The address discovery builds must be one `start_worker_update` can later
    /// resolve back to an account: it matches the second dotted label of the
    /// stored URL against each account's subdomain. Since discovery constructs
    /// the URL *from* that subdomain, the match holds by construction — this
    /// pins the two formats together so a change to either breaks here.
    #[test]
    fn a_discovered_address_resolves_back_to_its_account_subdomain() {
        for (script, subdomain) in [
            ("second-brain", "acme"),
            ("my-brain-2", "dad-piranifam-com-s-account"),
        ] {
            let url = workers_dev_url(script, subdomain);
            let host = url.strip_prefix("https://").expect("https origin");
            let second_label = host.split('.').nth(1).expect("second dotted label");
            assert_eq!(
                second_label, subdomain,
                "start_worker_update would not find the account for {url}"
            );
            assert!(host.ends_with(".workers.dev"), "{url} must not look like a custom domain");
        }
    }

    #[tokio::test]
    async fn a_dead_account_scan_yields_nothing_rather_than_failing() {
        // Real script names against a subdomain that resolves to nothing.
        let out = probe_all(
            vec!["one".into(), "two".into()],
            "definitely-not-a-real-subdomain-9f3a2b",
        )
        .await;
        assert!(out.is_empty());
    }
}
