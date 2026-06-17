//! Cross-implementation message-type parity (ADR-0003 Stage 0 gate).
//!
//! The fixture `tests/fixtures/message-vectors.json` is generated from the LIVE
//! TS guards (`scripts/gen-message-vectors.ts` imports `@teleprompter/protocol`
//! and records, per raw input, the guard's accept/reject verdict and — for
//! accepts — the parsed object re-serialized through `JSON.stringify`).
//!
//! For every case this test:
//!   - runs the corresponding Rust `parse_*` over the SAME `raw`, and
//!   - asserts accept/reject parity, and
//!   - on accept, asserts the Rust parsed value re-serializes to a JSON value
//!     equal to the TS one.
//!
//! Regenerate the fixture (`bun scripts/gen-message-vectors.ts`) whenever a
//! guard's acceptance changes; this test then fails loudly if the port diverges.

use serde_json::Value;
use tp_proto::control::parse_control_message;
use tp_proto::ipc::parse_ipc_message;
use tp_proto::label::{decode_kx_label_or_keep, decode_wire_label};
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
