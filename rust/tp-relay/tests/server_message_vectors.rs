//! Cross-implementation parity gate for `RelayServerMessage` (relay → client).
//!
//! The fixture `rust/tp-proto/tests/fixtures/message-vectors.json` is shared
//! with `tp-proto`. The generator (`scripts/gen-message-vectors.ts`) appended a
//! `"relayServer"` section whose cases were sourced from the live
//! `parseRelayServerMessage` TS guard, before that generator was deleted in the
//! "#5 zero-Bun cascade" PR6 (#933); the Bun/Node toolchain itself was removed
//! in PR7 (#935). This test:
//!
//!   - For every **accept** case: parses the `raw` field with
//!     `parse_relay_server_message`, serializes the result back to `serde_json::Value`,
//!     and asserts JSON equality against the fixture's `json` field (canonical
//!     TS round-trip output).
//!   - For every **reject** case: asserts `parse_relay_server_message` returns
//!     `None` (mirrors the guard's `return null`).
//!
//! The checked-in vectors are now the frozen byte-exact source of truth — this
//! test fails loudly if the Rust port diverges from them. To regenerate (only
//! if a guard's acceptance changes), check out the pre-deletion commit from git
//! history (last verified regeneration: PR5 #929) and rerun the script there.

use serde_json::Value;
use tp_relay::parse_relay_server_message;

fn fixture() -> Value {
    let raw = include_str!("../../tp-proto/tests/fixtures/message-vectors.json");
    serde_json::from_str(raw).expect("fixture parses as JSON")
}

/// Deep JSON equality that treats numbers by VALUE, not by serde_json's
/// internal int-vs-float tag. JS has a single `number` type, so the reference
/// `JSON.stringify` emits `1` for a whole number while serde_json's `f64`
/// serializer emits `1.0`; `Value::Number(1) != Value::Number(1.0)` under the
/// derived `PartialEq`. Comparing via `as_f64()` restores JS semantics while
/// keeping every structural/string/bool check strict.
///
/// Mirrors the identical helper in `tp-proto/tests/message_vectors.rs`.
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

#[test]
fn relay_server_vectors_match_ts() {
    let f = fixture();
    let cases = f["relayServer"].as_array().expect("relayServer array");
    assert!(!cases.is_empty(), "relayServer fixture must not be empty");

    let mut accepts = 0usize;
    let mut rejects = 0usize;

    for case in cases {
        let name = case["name"].as_str().expect("case name");
        let raw = &case["raw"];
        let expect_accept = case["accept"].as_bool().expect("accept flag");

        let parsed = parse_relay_server_message(raw);

        match (expect_accept, parsed) {
            (true, Some(msg)) => {
                // Re-serialize and compare against the TS canonical JSON.
                let got = serde_json::to_value(&msg).unwrap();
                let expected = &case["json"];
                assert!(
                    json_eq(expected, &got),
                    "relayServer/{name}: serialized mismatch\n  TS:   {expected}\n  Rust: {got}",
                );
                accepts += 1;
            }
            (true, None) => {
                panic!("relayServer/{name}: TS accepted but Rust rejected (raw={raw})")
            }
            (false, Some(got)) => {
                let got_val = serde_json::to_value(&got).unwrap();
                panic!("relayServer/{name}: TS rejected but Rust accepted (got={got_val})")
            }
            (false, None) => {
                rejects += 1;
            }
        }
    }

    // Guard against an empty or mis-keyed section silently passing.
    assert!(
        accepts + rejects == cases.len(),
        "relayServer: counted {accepts}+{rejects} of {} cases — mismatch",
        cases.len(),
    );

    eprintln!("relayServer: {accepts} accepts, {rejects} rejects OK");
}
