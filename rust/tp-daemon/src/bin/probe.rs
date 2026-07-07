//! `tp-daemon-probe` — a thin CLI over the `tp_daemon::store::Store` used ONLY
//! by the bidirectional shared-file parity gate
//! (`packages/daemon/src/store/store-rust-parity.test.ts`).
//!
//! It is deliberately NOT the shipping daemon binary (that is increment 5). Its
//! sole job is to let a `bun:test` process drive the Rust store against the same
//! on-disk vault a Bun `Store` uses, then compare on-disk bytes. The CLI is a
//! FIXED line-oriented contract the TS test depends on — see the command match
//! below (kept in lockstep with the test's PROBE CONTRACT doc block).
//!
//! Output is canonical JSON (sorted keys, via `serde_json::to_string` over a
//! `BTreeMap`) so the TS side can `JSON.parse` and compare deterministically.
//! BLOB columns are emitted as lowercase hex strings.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::ExitCode;

use tp_daemon::store::{SavePairingInput, Store};
use tp_proto::label::decode_wire_label;

/// serde_json::Value alias for the canonical, sorted-key object we emit.
type Obj = BTreeMap<String, serde_json::Value>;

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write as _;
        let _ = write!(s, "{b:02x}");
    }
    s
}

fn hex_decode(s: &str) -> Result<Vec<u8>, String> {
    if !s.len().is_multiple_of(2) {
        return Err(format!("odd-length hex string: {s:?}"));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| format!("bad hex: {e}")))
        .collect()
}

/// `-` sentinel → None (matches the TS test's `<x|->` optional-arg encoding).
fn opt(arg: &str) -> Option<&str> {
    if arg == "-" || arg.is_empty() {
        None
    } else {
        Some(arg)
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(out) => {
            if !out.is_empty() {
                println!("{out}");
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("tp-daemon-probe: {e}");
            ExitCode::FAILURE
        }
    }
}

#[allow(clippy::too_many_lines)]
fn run() -> Result<String, String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().ok_or("missing <cmd>")?.as_str();
    let vault = args.get(1).ok_or("missing <vaultDir>")?;
    let vault_path = PathBuf::from(vault);

    let mut store = Store::open(Some(vault_path), None).map_err(|e| format!("Store::open: {e}"))?;

    // Positional args after <cmd> <vaultDir>.
    let a = |i: usize| args.get(i + 2).map(String::as_str);

    match cmd {
        "write-session" => {
            // write-session <sid> <cwd> <worktreeOrEmpty> <verOrEmpty>
            let sid = a(0).ok_or("write-session: missing sid")?;
            let cwd = a(1).ok_or("write-session: missing cwd")?;
            let wt = a(2).and_then(opt);
            let ver = a(3).and_then(opt);
            store
                .create_session(sid, cwd, wt, ver)
                .map_err(|e| format!("create_session: {e}"))?;
            Ok(String::new())
        }
        "update-state" => {
            let sid = a(0).ok_or("update-state: missing sid")?;
            let state = a(1).ok_or("update-state: missing state")?;
            store
                .update_session_state(sid, state)
                .map_err(|e| format!("update_session_state: {e}"))?;
            Ok(String::new())
        }
        "append-rec" => {
            // append-rec <sid> <kind> <ts> <ns|-> <name|-> <hexPayload>
            let sid = a(0).ok_or("append-rec: missing sid")?;
            let kind = a(1).ok_or("append-rec: missing kind")?;
            let ts: i64 = a(2)
                .ok_or("append-rec: missing ts")?
                .parse()
                .map_err(|e| format!("append-rec ts: {e}"))?;
            let ns = a(3).and_then(opt);
            let name = a(4).and_then(opt);
            let payload = hex_decode(a(5).ok_or("append-rec: missing hexPayload")?)?;
            // Opening/creating the session row first mirrors the daemon path
            // (a record only exists for a created session).
            if store.get_session(sid).map_err(|e| e.to_string())?.is_none() {
                return Err(format!("append-rec: no session row for {sid}"));
            }
            let db = store
                .get_session_db(sid)
                .ok_or_else(|| format!("append-rec: cannot open session db for {sid}"))?;
            db.append(kind, ts, &payload, ns, name)
                .map_err(|e| format!("append: {e}"))?;
            Ok(String::new())
        }
        "dump-sessions" => {
            let sessions = store
                .list_sessions()
                .map_err(|e| format!("list_sessions: {e}"))?;
            let arr: Vec<Obj> = sessions
                .iter()
                .map(|m| {
                    let mut o = Obj::new();
                    o.insert("sid".into(), m.sid.clone().into());
                    o.insert("state".into(), m.state.clone().into());
                    o.insert(
                        "worktree_path".into(),
                        m.worktree_path
                            .clone()
                            .map_or(serde_json::Value::Null, Into::into),
                    );
                    o.insert("cwd".into(), m.cwd.clone().into());
                    o.insert(
                        "claude_version".into(),
                        m.claude_version
                            .clone()
                            .map_or(serde_json::Value::Null, Into::into),
                    );
                    o.insert("created_at".into(), m.created_at.into());
                    o.insert("updated_at".into(), m.updated_at.into());
                    o.insert("last_seq".into(), m.last_seq.into());
                    o
                })
                .collect();
            serde_json::to_string(&arr).map_err(|e| e.to_string())
        }
        "dump-recs" => {
            let sid = a(0).ok_or("dump-recs: missing sid")?;
            let db = store
                .get_session_db(sid)
                .ok_or_else(|| format!("dump-recs: cannot open session db for {sid}"))?;
            let recs = db
                .get_records_from(0, 1_000_000)
                .map_err(|e| format!("get_records_from: {e}"))?;
            let arr: Vec<Obj> = recs
                .iter()
                .map(|r| {
                    let mut o = Obj::new();
                    o.insert("seq".into(), r.seq.into());
                    o.insert("kind".into(), r.kind.clone().into());
                    o.insert("ts".into(), r.ts.into());
                    o.insert(
                        "ns".into(),
                        r.ns.clone().map_or(serde_json::Value::Null, Into::into),
                    );
                    o.insert(
                        "name".into(),
                        r.name.clone().map_or(serde_json::Value::Null, Into::into),
                    );
                    o.insert("payload".into(), hex_encode(&r.payload).into());
                    o
                })
                .collect();
            serde_json::to_string(&arr).map_err(|e| e.to_string())
        }
        "write-pairing" => {
            // write-pairing <daemonId> <relayUrl> <relayToken> <regProof>
            //   <pubHex> <secHex> <secretHex> <label|-> <pairingId|-> <hostname|->
            let daemon_id = a(0).ok_or("write-pairing: missing daemonId")?;
            let relay_url = a(1).ok_or("write-pairing: missing relayUrl")?;
            let relay_token = a(2).ok_or("write-pairing: missing relayToken")?;
            let reg_proof = a(3).ok_or("write-pairing: missing regProof")?;
            let public_key = hex_decode(a(4).ok_or("write-pairing: missing pubHex")?)?;
            let secret_key = hex_decode(a(5).ok_or("write-pairing: missing secHex")?)?;
            let pairing_secret = hex_decode(a(6).ok_or("write-pairing: missing secretHex")?)?;
            let label = a(7)
                .and_then(opt)
                .map(|s| decode_wire_label(&serde_json::Value::String(s.to_string())));
            let pairing_id = a(8).and_then(opt).unwrap_or("").to_string();
            let hostname = a(9).and_then(opt).unwrap_or("").to_string();
            store
                .save_pairing(&SavePairingInput {
                    daemon_id: daemon_id.to_string(),
                    relay_url: relay_url.to_string(),
                    relay_token: relay_token.to_string(),
                    registration_proof: reg_proof.to_string(),
                    public_key,
                    secret_key,
                    pairing_secret,
                    label,
                    pairing_id,
                    hostname,
                })
                .map_err(|e| format!("save_pairing: {e}"))?;
            Ok(String::new())
        }
        "dump-pairings" => {
            let pairings = store
                .load_pairings()
                .map_err(|e| format!("load_pairings: {e}"))?;
            let arr: Vec<Obj> = pairings
                .iter()
                .map(|p| {
                    let mut o = Obj::new();
                    o.insert("daemon_id".into(), p.daemon_id.clone().into());
                    o.insert("relay_url".into(), p.relay_url.clone().into());
                    o.insert("relay_token".into(), p.relay_token.clone().into());
                    o.insert(
                        "registration_proof".into(),
                        p.registration_proof.clone().into(),
                    );
                    o.insert("public_key".into(), hex_encode(&p.public_key).into());
                    o.insert("secret_key".into(), hex_encode(&p.secret_key).into());
                    o.insert(
                        "pairing_secret".into(),
                        hex_encode(&p.pairing_secret).into(),
                    );
                    o.insert("pairing_id".into(), p.pairing_id.clone().into());
                    o.insert("hostname".into(), p.hostname.clone().into());
                    o
                })
                .collect();
            serde_json::to_string(&arr).map_err(|e| e.to_string())
        }
        "delete-session" => {
            let sid = a(0).ok_or("delete-session: missing sid")?;
            store
                .delete_session(sid)
                .map_err(|e| format!("delete_session: {e}"))?;
            Ok(String::new())
        }
        other => Err(format!("unknown command: {other}")),
    }
}
