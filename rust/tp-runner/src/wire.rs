//! Outbound IPC wire structs the runner sends to the daemon.
//!
//! The runner emits three message types: `hello` (on connect), `rec` (io +
//! event records — see [`crate::collector`]), and `bye` (on stop). Inbound
//! frames (`ack`/`input`/`resize`) are decoded via `tp_proto::parse_ipc_message`
//! and are NOT redefined here.
//!
//! Why not reuse `tp_proto::IpcMessage`? Its `Bye`/`Hello` variants are the
//! Stage-0 golden-vector shapes and omit the runner-specific `pid`/`reason`
//! fields (`IpcBye.pid`, `IpcBye.reason`) that the daemon's generation guard and
//! signal/exit disambiguation depend on. The runner owns the emitting side, so
//! it defines its own outbound structs with **field order matched to the TS
//! object-literal key order** for byte-identical JSON.

use serde::Serialize;

/// `{t:"hello", sid, cwd, worktreePath?, pid}` — the first frame after connect.
/// Field order matches `runner.ts` `this.ipc.send({t,sid,cwd,worktreePath,pid})`.
/// `claudeVersion` is omitted (the Bun runner does not set it on the hello it
/// sends from `start()`; the daemon fills version elsewhere).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Hello {
    pub t: &'static str,
    pub sid: String,
    pub cwd: String,
    #[serde(rename = "worktreePath", skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    pub pid: u32,
}

impl Hello {
    #[must_use]
    pub fn new(sid: String, cwd: String, worktree_path: Option<String>, pid: u32) -> Self {
        Hello {
            t: "hello",
            sid,
            cwd,
            worktree_path,
            pid,
        }
    }
}

/// Why `stop()` was invoked — mirrors `IpcBye.reason`. `Signal` = a
/// daemon/transport-initiated stop (graceful SIGTERM/SIGINT, IPC socket
/// teardown) whose exit code must always resolve to "stopped"; `Exit` = claude's
/// own PTY child exited (the exit code is meaningful).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ByeReason {
    Signal,
    Exit,
}

/// `{t:"bye", sid, exitCode, pid, reason}` — the final frame on stop. Field order
/// matches `runner.ts` `this.ipc.send({t,sid,exitCode,pid,reason})`. `pid` is the
/// daemon's generation guard (a stale bye from an old runner generation must not
/// tear down a restarted session); `reason` disambiguates a signal-kill exit code
/// from a genuine crash.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Bye {
    pub t: &'static str,
    pub sid: String,
    #[serde(rename = "exitCode")]
    pub exit_code: i32,
    pub pid: u32,
    pub reason: ByeReason,
}

impl Bye {
    #[must_use]
    pub fn new(sid: String, exit_code: i32, pid: u32, reason: ByeReason) -> Self {
        Bye {
            t: "bye",
            sid,
            exit_code,
            pid,
            reason,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_json_key_order_and_omits_worktree_when_none() {
        let h = Hello::new("s".into(), "/cwd".into(), None, 4321);
        let s = serde_json::to_string(&h).unwrap();
        assert_eq!(s, r#"{"t":"hello","sid":"s","cwd":"/cwd","pid":4321}"#);
    }

    #[test]
    fn hello_json_includes_worktree_when_some() {
        let h = Hello::new("s".into(), "/cwd".into(), Some("/wt".into()), 1);
        let s = serde_json::to_string(&h).unwrap();
        assert_eq!(
            s,
            r#"{"t":"hello","sid":"s","cwd":"/cwd","worktreePath":"/wt","pid":1}"#
        );
    }

    #[test]
    fn bye_json_key_order_and_reason_lowercase() {
        let b = Bye::new("s".into(), 143, 99, ByeReason::Signal);
        let s = serde_json::to_string(&b).unwrap();
        assert_eq!(
            s,
            r#"{"t":"bye","sid":"s","exitCode":143,"pid":99,"reason":"signal"}"#
        );
        let e = Bye::new("s".into(), 0, 99, ByeReason::Exit);
        assert!(serde_json::to_string(&e)
            .unwrap()
            .contains(r#""reason":"exit""#));
    }
}
