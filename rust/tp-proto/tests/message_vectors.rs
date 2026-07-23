//! Cross-implementation message-type parity (ADR-0003 Stage 0 gate).
//!
//! The fixture `tests/fixtures/message-vectors.json` was generated from the live
//! TS guards (`scripts/gen-message-vectors.ts` imported `@teleprompter/protocol`
//! and recorded, per raw input, the guard's accept/reject verdict and — for
//! accepts — the parsed object re-serialized through `JSON.stringify`) before
//! that generator was deleted in the "#5 zero-Bun cascade" PR6 (#933); the
//! Bun/Node toolchain itself was removed in PR7 (#935).
//!
//! For every case this test:
//!   - runs the corresponding Rust `parse_*` over the SAME `raw`, and
//!   - asserts accept/reject parity, and
//!   - on accept, asserts the Rust parsed value re-serializes to a JSON value
//!     equal to the TS one.
//!
//! The checked-in vectors are now the frozen byte-exact source of truth — this
//! test fails loudly if the port diverges from them. To regenerate (only if a
//! guard's acceptance changes), check out the pre-deletion commit from git
//! history (last verified regeneration: PR5 #929) and rerun the script there.

use serde_json::Value;
use tp_proto::control::parse_control_message;
use tp_proto::ipc::parse_ipc_message;
use tp_proto::label::{decode_kx_label_or_keep, decode_label_opt_field, decode_wire_label};
use tp_proto::relay_client::parse_relay_client_message;

fn fixture() -> Value {
    let raw = include_str!("fixtures/message-vectors.json");
    serde_json::from_str(raw).expect("fixture parses")
}

/// Deep JSON equality that treats numbers by VALUE, not by serde_json's
/// internal int-vs-float tag. JS has a single `number` type, so the reference
/// `JSON.stringify` emits `1` for a whole number while serde_json's `f64`
/// serializer emits `1.0`; `Value::Number(1) != Value::Number(1.0)` under the
/// derived `PartialEq`. Comparing via `as_f64()` restores JS semantics while
/// keeping every structural/string/bool check strict.
fn json_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => match (x.as_f64(), y.as_f64()) {
            (Some(fx), Some(fy)) => fx == fy,
            _ => x == y,
        },
        (Value::Array(xs), Value::Array(ys)) => {
            xs.len() == ys.len() && xs.iter().zip(ys).all(|(x, y)| json_eq(x, y))
        }
        (Value::Object(xs), Value::Object(ys)) => {
            xs.len() == ys.len()
                && xs
                    .iter()
                    .all(|(k, x)| ys.get(k).is_some_and(|y| json_eq(x, y)))
        }
        _ => a == b,
    }
}

/// Drive a fallible Rust parser over the fixture's accept/reject cases.
fn check_parse_section(section: &str, cases: &[Value], parser: impl Fn(&Value) -> Option<Value>) {
    let mut accepts = 0usize;
    let mut rejects = 0usize;
    for case in cases {
        let name = case["name"].as_str().expect("case name");
        let raw = &case["raw"];
        let expect_accept = case["accept"].as_bool().expect("accept flag");
        let parsed = parser(raw);

        match (expect_accept, &parsed) {
            (true, Some(got)) => {
                let expected = &case["json"];
                assert!(
                    json_eq(expected, got),
                    "{section}/{name}: serialized mismatch\n  TS:   {expected}\n  Rust: {got}",
                );
                accepts += 1;
            }
            (true, None) => panic!("{section}/{name}: TS accepted but Rust rejected (raw={raw})"),
            (false, Some(got)) => {
                panic!("{section}/{name}: TS rejected but Rust accepted (got={got})")
            }
            (false, None) => rejects += 1,
        }
    }
    // Guard against an empty / mis-keyed section silently passing.
    assert!(
        accepts + rejects == cases.len() && !cases.is_empty(),
        "{section}: counted {accepts}+{rejects} of {} cases",
        cases.len(),
    );
    eprintln!("{section}: {accepts} accepts, {rejects} rejects OK");
}

#[test]
fn relay_client_vectors_match_ts() {
    let f = fixture();
    let cases = f["relayClient"].as_array().expect("relayClient array");
    check_parse_section("relayClient", cases, |raw| {
        parse_relay_client_message(raw).map(|m| serde_json::to_value(m).unwrap())
    });
}

#[test]
fn ipc_vectors_match_ts() {
    let f = fixture();
    let cases = f["ipc"].as_array().expect("ipc array");
    check_parse_section("ipc", cases, |raw| {
        parse_ipc_message(raw).map(|m| serde_json::to_value(m).unwrap())
    });
}

#[test]
fn control_vectors_match_ts() {
    let f = fixture();
    let cases = f["control"].as_array().expect("control array");
    check_parse_section("control", cases, |raw| {
        parse_control_message(raw).map(|m| serde_json::to_value(m).unwrap())
    });
}

#[test]
fn label_decoders_match_ts() {
    let f = fixture();
    let cases = f["label"].as_array().expect("label array");
    assert!(!cases.is_empty());
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let raw = &case["raw"];

        // decodeWireLabel is total — always an object.
        let wire = serde_json::to_value(decode_wire_label(raw)).unwrap();
        assert!(
            json_eq(&case["wire"], &wire),
            "label/{name}: wire mismatch\n  TS:   {}\n  Rust: {wire}",
            case["wire"],
        );

        // decodeKxLabelOrKeep — None (null) is keep-current, else Some(Set).
        let kx = decode_kx_label_or_keep(raw).map(|l| serde_json::to_value(l).unwrap());
        let expected_kx = &case["kxOrKeep"];
        match (expected_kx.is_null(), &kx) {
            (true, None) => {}
            (false, Some(got)) => assert!(
                json_eq(expected_kx, got),
                "label/{name}: kxOrKeep mismatch\n  TS:   {expected_kx}\n  Rust: {got}",
            ),
            (true, Some(got)) => panic!("label/{name}: TS kxOrKeep=null but Rust returned {got}"),
            (false, None) => {
                panic!("label/{name}: TS kxOrKeep={expected_kx} but Rust returned null")
            }
        }
    }
    eprintln!("label: {} cases OK", cases.len());
}

/// `labelUpdate` golden vectors (ADR-0003 Amendment 1 A1.3#1).
///
/// These vectors cover the unified new contract:
///   - `{set:true,value}` → Set / Unset (trimmed / empty)
///   - `{set:false}`      → Unset (authoritative Clear)
///   - absent field       → `None` (keep-current) via `decode_label_opt_field(None)`
///   - legacy shapes      → lenient back-compat read
///
/// The `absent-keep` case has no `raw` key in the fixture (JSON key is absent,
/// not `null`) — detected by `case.get("raw").is_none()`. For that case we drive
/// `decode_label_opt_field(None)` and assert the result is `None`.
///
/// For all other cases we run both `decode_wire_label` (compare `wire`) and
/// `decode_label_opt_field(Some(raw))` (compare `kxOrKeep` as Some/None).
#[test]
fn label_update_vectors_match_contract() {
    let f = fixture();
    let cases = f["labelUpdate"].as_array().expect("labelUpdate array");
    assert!(!cases.is_empty(), "labelUpdate fixture must not be empty");

    for case in cases {
        let name = case["name"].as_str().expect("name");
        let is_absent = case.get("raw").is_none();

        if is_absent {
            // absent-keep: field was not present in the JSON object at all.
            // decode_label_opt_field(None) MUST return None (keep-current).
            let result = decode_label_opt_field(None);
            assert_eq!(
                result, None,
                "labelUpdate/{name}: expected None (keep-current) for absent field",
            );
            // kxOrKeep fixture entry must also be null.
            assert!(
                case["kxOrKeep"].is_null(),
                "labelUpdate/{name}: fixture kxOrKeep should be null for absent case",
            );
        } else {
            let raw = &case["raw"];

            // decode_wire_label: total function, check against "wire".
            let wire = serde_json::to_value(decode_wire_label(raw)).unwrap();
            assert!(
                json_eq(&case["wire"], &wire),
                "labelUpdate/{name}: wire mismatch\n  fixture: {}\n  Rust:    {wire}",
                case["wire"],
            );

            // Also verify decode_label_opt_field(Some(raw)) agrees with wire.
            // Some(Unset) when wire is {set:false}, Some(Set) when wire is {set:true,value}.
            let opt_result = decode_label_opt_field(Some(raw));
            let opt_as_wire = opt_result.map(|l| serde_json::to_value(l).unwrap());
            assert!(
                opt_as_wire.as_ref().map(|v| json_eq(&case["wire"], v)).unwrap_or(false),
                "labelUpdate/{name}: decode_label_opt_field wire mismatch\n  expected: {}\n  Rust: {:?}",
                case["wire"],
                opt_as_wire,
            );

            // kxOrKeep column maps to decode_kx_label_or_keep (same as label group).
            // Unset collapses to None; Set maps to Some.
            let kx = decode_kx_label_or_keep(raw).map(|l| serde_json::to_value(l).unwrap());
            let expected_kx = &case["kxOrKeep"];
            match (expected_kx.is_null(), &kx) {
                (true, None) => {}
                (false, Some(got)) => assert!(
                    json_eq(expected_kx, got),
                    "labelUpdate/{name}: kxOrKeep mismatch\n  fixture: {expected_kx}\n  Rust:    {got}",
                ),
                (true, Some(got)) => {
                    panic!("labelUpdate/{name}: fixture kxOrKeep=null but Rust returned {got}")
                }
                (false, None) => {
                    panic!("labelUpdate/{name}: fixture kxOrKeep={expected_kx} but Rust returned null")
                }
            }
        }
    }
    eprintln!("labelUpdate: {} cases OK", cases.len());
}
