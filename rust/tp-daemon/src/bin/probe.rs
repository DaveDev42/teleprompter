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
use tp_daemon::worktree::{WorktreeInfo, WorktreeManager};
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

    // Worktree verbs take a <repoRoot> (NOT a vault) as arg[1] and never touch
    // the store — dispatch them BEFORE Store::open so no spurious vault dir is
    // created. They drive the differential worktree parity gate
    // (packages/daemon/src/worktree/worktree-parity.test.ts), the same fixed
    // line-oriented contract the store gate uses.
    if let Some(out) = run_worktree(cmd, &args)? {
        return Ok(out);
    }

    // Reconnect-plan verb takes two numeric args (NOT a vault) and calls the
    // pure `compute_reconnect_plan` / `next_peerless_reconnects` — dispatch
    // before Store::open so no vault dir is created. Drives the reconnect-plan
    // differential parity gate (packages/daemon/.../relay-client-rust-parity.test.ts).
    if let Some(out) = run_reconnect(cmd, &args)? {
        return Ok(out);
    }

    // Push-gate verb takes an event name + tokenCount + an optional payload JSON
    // (NOT a vault) and calls the pure push-notifier decision — dispatch before
    // Store::open. Drives the push-gate differential parity gate
    // (packages/daemon/src/push/push-notifier-rust-parity.test.ts).
    if let Some(out) = run_push_gate(cmd, &args)? {
        return Ok(out);
    }

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

/// Serialize `WorktreeInfo[]` to canonical (sorted-key) JSON so the TS gate can
/// compare byte-for-byte. `head` (a commit SHA) and absolute `path` are
/// nondeterministic across machines/runs — the TS test normalizes them out
/// before comparing (same discipline as the store gate's created_at/updated_at
/// strip), so we emit them verbatim here.
fn worktree_json(list: &[WorktreeInfo]) -> Result<String, String> {
    let arr: Vec<Obj> = list
        .iter()
        .map(|w| {
            let mut o = Obj::new();
            o.insert("path".into(), w.path.clone().into());
            o.insert(
                "branch".into(),
                w.branch.clone().map_or(serde_json::Value::Null, Into::into),
            );
            o.insert("head".into(), w.head.clone().into());
            o.insert("is_main".into(), w.is_main.into());
            o
        })
        .collect();
    serde_json::to_string(&arr).map_err(|e| e.to_string())
}

/// Worktree-verb dispatch for the differential worktree parity gate. Returns
/// `Ok(Some(output))` when `cmd` is a reconnect verb, `Ok(None)` otherwise.
/// Drives the pure reconnect-delay policy (`tp_daemon::transport`) for the
/// differential parity gate — no vault/store, just numeric args.
///
/// Contract (kept in lockstep with `relay-client-rust-parity.test.ts`):
///   reconnect-plan  <attempt> <peerlessReconnects> → JSON {delayMs, nextAttempt}
///   peerless-next   <current> <hadPeer:0|1>        → JSON {value}
fn run_reconnect(cmd: &str, args: &[String]) -> Result<Option<String>, String> {
    let num = |i: usize| -> Result<u32, String> {
        args.get(i)
            .ok_or_else(|| format!("{cmd}: missing arg {i}"))?
            .parse::<u32>()
            .map_err(|e| format!("{cmd} arg {i}: {e}"))
    };
    match cmd {
        "reconnect-plan" => {
            let plan = tp_daemon::transport::compute_reconnect_plan(num(1)?, num(2)?);
            let mut obj: Obj = BTreeMap::new();
            obj.insert("delayMs".into(), plan.delay_ms.into());
            obj.insert("nextAttempt".into(), plan.next_attempt.into());
            Ok(Some(
                serde_json::to_string(&obj).map_err(|e| e.to_string())?,
            ))
        }
        "peerless-next" => {
            let value = tp_daemon::transport::next_peerless_reconnects(num(1)?, num(2)? != 0);
            let mut obj: Obj = BTreeMap::new();
            obj.insert("value".into(), value.into());
            Ok(Some(
                serde_json::to_string(&obj).map_err(|e| e.to_string())?,
            ))
        }
        _ => Ok(None),
    }
}

/// `push-gate <eventName> <tokenCount> [payloadJson]` — drives the pure
/// push-notifier decision. Emits `{shouldNotify, level, title, body}`:
///
/// - `shouldNotify` = `is_notify_event(name) && tokenCount > 0` (the two-part
///   `on_record` gate, push-notifier.ts:224-230).
/// - `level` = wire string of `interruption_level_for(name)`.
/// - `title`/`body` = `build_push_message(name, payload)` output.
///
/// Drives the push-gate differential parity gate
/// (`packages/daemon/src/push/push-notifier-rust-parity.test.ts`).
fn run_push_gate(cmd: &str, args: &[String]) -> Result<Option<String>, String> {
    if cmd != "push-gate" {
        return Ok(None);
    }
    let name = args
        .get(1)
        .ok_or("push-gate: missing <eventName>")?
        .as_str();
    let token_count: usize = args
        .get(2)
        .ok_or("push-gate: missing <tokenCount>")?
        .parse()
        .map_err(|e| format!("push-gate <tokenCount>: {e}"))?;
    // Optional payload JSON — default to null (no payload) when absent.
    let payload: serde_json::Value = match args.get(3) {
        Some(raw) => serde_json::from_str(raw).map_err(|e| format!("push-gate <payload>: {e}"))?,
        None => serde_json::Value::Null,
    };

    let should_notify = tp_daemon::push::is_notify_event(name) && token_count > 0;
    let level = tp_daemon::push::interruption_level_for(name);
    // `build_push_message` takes an object payload (or None). A null / non-object
    // payload maps to None, matching the TS `payload?: Record<…>` optionality.
    let payload_opt = if payload.is_object() {
        Some(&payload)
    } else {
        None
    };
    let msg = tp_daemon::push::build_push_message(name, payload_opt);

    let level_str = serde_json::to_value(level)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .ok_or("push-gate: interruption-level serialization")?;

    let mut obj: Obj = BTreeMap::new();
    obj.insert("shouldNotify".into(), should_notify.into());
    obj.insert("level".into(), level_str.into());
    obj.insert("title".into(), msg.title.into());
    obj.insert("body".into(), msg.body.into());
    Ok(Some(
        serde_json::to_string(&obj).map_err(|e| e.to_string())?,
    ))
}

/// `Ok(Some(output))` when `cmd` is a worktree verb, `Ok(None)` otherwise (so
/// the caller falls through to the store-based commands). Uses `args[1]` as a
/// `<repoRoot>`, never opening the store.
///
/// Contract (kept in lockstep with `worktree-parity.test.ts`):
///   worktree-list   <repoRoot>                              → JSON WorktreeInfo[]
///   worktree-add    <repoRoot> <path> <branch> <baseBranch|-> → JSON [WorktreeInfo]
///   worktree-remove <repoRoot> <path> <force:0|1>            → "" (or error text)
fn run_worktree(cmd: &str, args: &[String]) -> Result<Option<String>, String> {
    // args[0] = cmd, args[1] = repoRoot, args[2..] = verb positionals.
    let a = |i: usize| args.get(i + 2).map(String::as_str);
    let repo_root = || -> Result<WorktreeManager, String> {
        let root = args.get(1).ok_or("worktree: missing <repoRoot>")?;
        WorktreeManager::new(std::path::Path::new(root))
            .map_err(|e| format!("WorktreeManager::new: {e}"))
    };
    match cmd {
        "worktree-list" => {
            let wm = repo_root()?;
            Ok(Some(worktree_json(&wm.list())?))
        }
        "worktree-add" => {
            // worktree-add <repoRoot> <path> <branch> <baseBranch|->
            let wm = repo_root()?;
            let path = a(0).ok_or("worktree-add: missing path")?;
            let branch = a(1).ok_or("worktree-add: missing branch")?;
            let base = a(2).and_then(opt);
            let info = wm.add(path, branch, base)?;
            Ok(Some(worktree_json(std::slice::from_ref(&info))?))
        }
        "worktree-remove" => {
            // worktree-remove <repoRoot> <path> <force:0|1>
            let wm = repo_root()?;
            let path = a(0).ok_or("worktree-remove: missing path")?;
            let force = a(1).is_some_and(|f| f == "1");
            wm.remove(path, force)?;
            Ok(Some(String::new()))
        }
        _ => Ok(None),
    }
}
