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

    #[test]
    fn ships_seven_controls_counting_the_model_dropdown() {
        // Six level controls here; the seventh (LLM_MODEL) is a dropdown and is
        // deliberately not modelled as levels.
        assert_eq!(CONTROLS.len(), 6);
    }
}
