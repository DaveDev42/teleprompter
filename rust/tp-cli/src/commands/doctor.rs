//! `tp doctor` — environment diagnostic + relay health + E2EE self-test.
//!
//! Byte-exact port of `apps/cli/src/commands/doctor.ts` (287 lines) and
//! `apps/cli/src/lib/e2ee-verify.ts` (84 lines).  The check sequence, icon
//! characters, message strings, and issues-counting rules are reproduced
//! verbatim so the output structure is diff-comparable with the Bun CLI.
//!
//! Architecture invariant enforced here: the relay check goes THROUGH the
//! daemon via the `doctor.probe` IPC — the CLI never opens a relay WebSocket.
//! See `check_relay_via_ipc` for the single-round-trip IPC probe.

use std::io::Write as _;
use std::process::{ExitCode, Stdio};
use std::time::Duration;

use rand::RngCore;

use tp_core::crypto;
use tp_proto::ipc::IpcMessage;

use crate::codec::{encode_frame, read_frame};
use crate::colors::{green, yellow};
use crate::socket::{is_daemon_running, socket_path};
use crate::store::{list_pairings, store_dir};

// ── Public entry point ───────────────────────────────────────────────────────

/// Run `tp doctor`.  Mirrors `doctorCommand` in doctor.ts.  Returns
/// `ExitCode::SUCCESS` regardless of issues found (the summary line is how the
/// user learns about problems — non-zero exit is not the Bun CLI's contract).
pub fn run() -> ExitCode {
    println!("Teleprompter Doctor\n");

    let mut issues: u32 = 0;

    // ── Tool probes ──────────────────────────────────────────────────────────

    // tp binary version (Rust port: replaces the "Bun" line with the tp version).
    let tp_ver = env!("CARGO_PKG_VERSION");
    print_check("tp", tp_ver, true);

    // Claude CLI — `claude_found` gates the `claude doctor` section below.
    // (The Node.js/pnpm probes the Bun CLI carried were legacy dev probes with
    // no runtime consumer — dropped with the Node toolchain in #5 PR7.)
    let claude_found = match probe_version("claude", &["--version"]) {
        Some(v) => {
            print_check("Claude CLI", &v, true);
            true
        }
        None => {
            print_check(
                "Claude CLI",
                "not found \u{2192} install: https://docs.anthropic.com/en/docs/claude-code",
                false,
            );
            issues += 1;
            false
        }
    };

    // Git — strip the "git version " prefix (doctor.ts:100).
    match probe_version("git", &["--version"]) {
        Some(v) => {
            let trimmed = v.strip_prefix("git version ").unwrap_or(&v).to_owned();
            print_check("Git", &trimmed, true);
        }
        None => {
            print_check("Git", "not found", false);
            issues += 1;
        }
    }

    // ── Daemon socket ────────────────────────────────────────────────────────

    let sock = socket_path();
    if sock.exists() {
        print_check("Daemon socket", &sock.display().to_string(), true);
    } else {
        print_check("Daemon socket", "not running", false);
        // Issues NOT incremented — matches doctor.ts:108-116.
    }

    // ── Pairing data ─────────────────────────────────────────────────────────

    let pairings = list_pairings();
    let paired = !pairings.is_empty();
    if paired {
        let msg = format!("{} pairing(s) in store", pairings.len());
        print_check("Pairing data", &msg, true);
    } else {
        print_check(
            "Pairing data",
            "no pairings \u{2192} run: tp pair new",
            false,
        );
        // Issues NOT incremented — matches doctor.ts:119-131.
    }

    // ── Vault directory ──────────────────────────────────────────────────────

    match store_dir() {
        Some(d) if d.exists() => {
            print_check("Vault", &d.display().to_string(), true);
        }
        _ => {
            print_check(
                "Vault",
                "not created yet (starts on first daemon run)",
                false,
            );
            // Issues NOT incremented — matches doctor.ts:134-144.
        }
    }

    // ── Relay connectivity (only when paired) ────────────────────────────────
    // Architecture invariant: we never open a relay WebSocket here.  The probe
    // goes through the daemon IPC (doctor.probe / doctor.probe.ok).

    let first_pairing_has_relay = pairings
        .first()
        .map(|p| !p.relay_url.is_empty())
        .unwrap_or(false);

    if paired && first_pairing_has_relay {
        println!();
        if is_daemon_running() {
            if !check_relay_via_ipc() {
                issues += 1;
            }
        } else {
            print_check(
                "Relay",
                "daemon not running \u{2014} relay connectivity is verified via the daemon; \
                 start it with `tp daemon start` or run any tp command",
                false,
            );
            issues += 1;
        }
    }

    // ── E2EE self-test (only when paired) ───────────────────────────────────

    if paired {
        println!();
        println!("E2EE self-test:");
        let passed = verify_e2ee_crypto();
        if passed {
            print_check("E2EE", "all checks passed", true);
        } else {
            print_check("E2EE", "verification failed", false);
            issues += 1;
        }
    }

    // ── Claude doctor ────────────────────────────────────────────────────────

    println!("\n--- Claude Code Doctor ---\n");
    if claude_found {
        // Spawn with inherited stdio — matches Bun.spawn(..., inherit all).
        let status = std::process::Command::new("claude")
            .arg("doctor")
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status();
        // Ignore errors (e.g. SIGINT); the doctor's own exit code is not
        // propagated — the Bun CLI ignores it too (no exitCode check on proc).
        let _ = status;
    } else {
        println!("  claude not found on PATH \u{2014} skipping `claude doctor`.");
    }

    // ── Summary ──────────────────────────────────────────────────────────────

    println!();
    if issues == 0 {
        println!("{}", green("All checks passed!"));
    } else {
        println!("{}", yellow(&format!("{issues} issue(s) found.")));
    }

    ExitCode::SUCCESS
}

// ── check() helper ───────────────────────────────────────────────────────────

/// `check(name, value, passed)` — mirrors doctor.ts:208-211.
///
/// ```text
///   ✓ Name: value   (green ✓ when passed)
///   ! Name: value   (yellow ! when !passed)
/// ```
fn print_check(name: &str, value: &str, passed: bool) {
    let icon = if passed {
        green("\u{2713}") // ✓
    } else {
        yellow("!")
    };
    println!("  {icon} {name}: {value}");
}

// ── Tool probe ───────────────────────────────────────────────────────────────

/// Run `<tool> <args>` and capture trimmed stdout.  Returns `None` on non-zero
/// exit, spawn failure, or empty output — matching the Bun `spawnSync` + throw
/// pattern (doctor.ts:39-104).
fn probe_version(tool: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(tool).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

// ── Relay IPC probe ──────────────────────────────────────────────────────────

/// Delegate relay health check to the daemon via `doctor.probe` / `doctor.probe.ok`.
///
/// Architecture invariant: this is the ONLY path the doctor uses for relay
/// connectivity.  We send a single framed request and read one framed response
/// (the `ipc_client::request()` pattern), but we override the read timeout to
/// 5 s to match the TS 5000 ms `setTimeout` in `checkRelayConnectivityViaIpc`
/// (doctor.ts:232).
///
/// Returns `true` iff all relays report as connected.
fn check_relay_via_ipc() -> bool {
    // Print a plain status line in place of the TS spinner (tp-cli has no
    // spinner infrastructure — the blocking IPC call is effectively instant or
    // times out in 5 s, so animation adds little value).
    print!("  Checking relay connectivity via daemon IPC...");
    let _ = std::io::stdout().flush();

    match probe_relay_ipc() {
        Ok(relays) => {
            // Clear the "Checking..." line by moving to column 0 and overwriting.
            print!("\r{}\r", " ".repeat(60));
            let _ = std::io::stdout().flush();

            if relays.is_empty() {
                print_check(
                    "Relay",
                    "no active relay connections (daemon has no pairings)",
                    false,
                );
                return false;
            }

            let mut all_ok = true;
            for relay in &relays {
                let status = if relay.connected {
                    let peer_word = if relay.peer_count == 1 {
                        "peer"
                    } else {
                        "peers"
                    };
                    format!("connected ({} {peer_word})", relay.peer_count)
                } else {
                    "disconnected (relay unreachable or auth failed)".to_owned()
                };
                print_check(
                    &format!("Relay {}", relay.relay_url),
                    &status,
                    relay.connected,
                );
                if !relay.connected {
                    all_ok = false;
                }
            }
            all_ok
        }
        Err(msg) => {
            print!("\r{}\r", " ".repeat(60));
            let _ = std::io::stdout().flush();
            print_check("Relay", &msg, false);
            false
        }
    }
}

/// Per-relay health snapshot from the IPC probe.
struct RelayHealth {
    relay_url: String,
    connected: bool,
    peer_count: u64,
}

/// Send `doctor.probe`, read `doctor.probe.ok` with a 5 s timeout.
/// Returns the relay list on success, or an error string on timeout/failure.
fn probe_relay_ipc() -> Result<Vec<RelayHealth>, String> {
    use std::os::unix::net::UnixStream;

    let path = socket_path();
    let mut stream = UnixStream::connect(&path).map_err(|e| format!("IPC connect failed ({e})"))?;

    // 5 s read timeout — matches the TS 5000 ms setTimeout in doctor.ts:232.
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| format!("set_read_timeout: {e}"))?;

    // Serialize and send the probe request.
    let req = IpcMessage::DoctorProbe;
    let json = serde_json::to_vec(&req).map_err(|e| format!("serialize doctor.probe: {e}"))?;
    let frame = encode_frame(&json);
    stream
        .write_all(&frame)
        .map_err(|e| format!("IPC write: {e}"))?;

    // Read one framed response.
    let bytes =
        read_frame(&mut stream).map_err(|_| "daemon did not respond to health probe".to_owned())?;

    let raw: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("IPC JSON: {e}"))?;

    match tp_proto::ipc::parse_ipc_message(&raw) {
        Some(IpcMessage::DoctorProbeOk { relays }) => Ok(relays
            .into_iter()
            .map(|r| RelayHealth {
                relay_url: r.relay_url,
                connected: r.connected,
                peer_count: r.peer_count,
            })
            .collect()),
        Some(_) => Err("daemon did not respond to health probe".to_owned()),
        None => Err("daemon did not respond to health probe".to_owned()),
    }
}

// ── E2EE self-test ───────────────────────────────────────────────────────────

/// Rust-native port of `verifyE2EECrypto` (`apps/cli/src/lib/e2ee-verify.ts`).
///
/// Uses `tp_core::crypto` directly (the same crate the Swift app links as an
/// xcframework) so we exercise the exact same code path in a host-side test.
///
/// Three checks:
/// 1. daemon → frontend round-trip (daemon encrypts, frontend decrypts)
/// 2. frontend → daemon round-trip (frontend encrypts, daemon decrypts)
/// 3. wrong-key rejection (wrong keypair must fail MAC verification)
///
/// Returns `true` iff all three pass.
fn verify_e2ee_crypto() -> bool {
    // Generate two fresh ephemeral keypairs via OsRng-filled seeds.
    // tp-core has `kx_seed_keypair(seed)` — we fill seeds with OsRng to
    // reproduce `generateKeyPair()` (libsodium's random keygen).
    let mut daemon_seed = [0u8; 32];
    let mut frontend_seed = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut daemon_seed);
    rand::rngs::OsRng.fill_bytes(&mut frontend_seed);

    let (daemon_kp, frontend_kp) = match (
        crypto::kx_seed_keypair(&daemon_seed),
        crypto::kx_seed_keypair(&frontend_seed),
    ) {
        (Ok(d), Ok(f)) => (d, f),
        (Err(e), _) | (_, Err(e)) => {
            println!("  E2EE verification: FAILED ({e})");
            return false;
        }
    };

    // Derive session keys: daemon is the server (role = "daemon"),
    // frontend is the client (role = "frontend").
    let daemon_keys = crypto::kx_server_session_keys(
        &daemon_kp.public_key,
        &daemon_kp.secret_key,
        &frontend_kp.public_key,
    );
    let frontend_keys = crypto::kx_client_session_keys(
        &frontend_kp.public_key,
        &frontend_kp.secret_key,
        &daemon_kp.public_key,
    );

    // Test payload: mirrors `new TextEncoder().encode("E2EE verification test ${Date.now()}")`.
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let test_payload = format!("E2EE verification test {now_ms}");
    let test_bytes = test_payload.as_bytes();

    let mut passed = true;

    // ── Check 1: daemon → frontend ──────────────────────────────────────────
    let ciphertext = match seal(test_bytes, &daemon_keys.tx) {
        Ok(c) => c,
        Err(e) => {
            println!("  E2EE verification: FAILED ({e})");
            return false;
        }
    };
    match crypto::open(&ciphertext, &frontend_keys.rx) {
        Ok(dec) if dec == test_bytes => {
            println!("  daemon \u{2192} frontend: OK");
        }
        Ok(_) => {
            println!("  daemon \u{2192} frontend: FAIL (mismatch)");
            passed = false;
        }
        Err(e) => {
            println!("  daemon \u{2192} frontend: FAIL ({e})");
            passed = false;
        }
    }

    // ── Check 2: frontend → daemon ──────────────────────────────────────────
    let ciphertext2 = match seal(test_bytes, &frontend_keys.tx) {
        Ok(c) => c,
        Err(e) => {
            println!("  E2EE verification: FAILED ({e})");
            return false;
        }
    };
    match crypto::open(&ciphertext2, &daemon_keys.rx) {
        Ok(dec) if dec == test_bytes => {
            println!("  frontend \u{2192} daemon: OK");
        }
        Ok(_) => {
            println!("  frontend \u{2192} daemon: FAIL (mismatch)");
            passed = false;
        }
        Err(e) => {
            println!("  frontend \u{2192} daemon: FAIL ({e})");
            passed = false;
        }
    }

    // ── Check 3: wrong-key rejection ────────────────────────────────────────
    // Generate a third keypair; derive server-side session keys from it
    // (wrong keypair + frontend's public key → wrong rx key).  Attempting
    // to decrypt `ciphertext` (encrypted with daemon_keys.tx) with the
    // wrong rx key MUST fail.
    let mut wrong_seed = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut wrong_seed);
    match crypto::kx_seed_keypair(&wrong_seed) {
        Ok(wrong_kp) => {
            let wrong_keys = crypto::kx_server_session_keys(
                &wrong_kp.public_key,
                &wrong_kp.secret_key,
                &frontend_kp.public_key,
            );
            match crypto::open(&ciphertext, &wrong_keys.rx) {
                Err(_) => {
                    println!("  relay isolation:   OK (wrong key rejected)");
                }
                Ok(_) => {
                    println!("  relay isolation:   FAIL (wrong key decrypted!)");
                    passed = false;
                }
            }
        }
        Err(e) => {
            println!("  E2EE verification: FAILED ({e})");
            return false;
        }
    }

    passed
}

/// Convenience wrapper: generate a random 24-byte nonce and call `tp_core::crypto::seal`.
/// Mirrors the TS `encrypt(plaintext, key)` which calls `sodium.randomBytes(24)` internally.
fn seal(plaintext: &[u8], key: &[u8; 32]) -> Result<String, String> {
    let mut nonce = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    crypto::seal(plaintext, key, &nonce).map_err(|e| e.to_string())
}

// ── Unit tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tp_core::crypto;

    // ── check() output format ────────────────────────────────────────────────

    /// The check icon + spacing match doctor.ts exactly.
    #[test]
    fn check_format_passed() {
        // When NO_COLOR is unset the output includes ANSI; just verify structure
        // by stripping ANSI (we test the color module independently).
        // The format is: "  <icon> <name>: <value>\n"
        // We can't capture println! easily, so we test the helper indirectly.
        let icon_pass = green("\u{2713}");
        let icon_fail = yellow("!");
        // Strings must contain the icon character in either mode.
        assert!(icon_pass.contains('\u{2713}'));
        assert!(icon_fail.contains('!'));
    }

    // ── probe_version ────────────────────────────────────────────────────────

    #[test]
    fn probe_version_missing_tool_returns_none() {
        // A tool that definitely does not exist.
        assert!(probe_version("__tp_doctor_nonexistent_tool__", &["--version"]).is_none());
    }

    // ── issues counting ──────────────────────────────────────────────────────

    /// claude/git missing each contribute exactly 1 to issues.
    /// Daemon socket missing, vault missing, and no pairings do NOT contribute.
    ///
    /// We test this via the counting logic (can't run the full `run()` without
    /// spawning real tools), but we can at least confirm the probe_version
    /// contract: a missing tool returns None, which maps to issues += 1 in run().
    #[test]
    fn missing_tool_adds_one_issue() {
        let v = probe_version("__tp_doctor_nonexistent__", &["--version"]);
        assert!(v.is_none(), "missing tool must return None → issues += 1");
    }

    // ── E2EE self-test round-trip ────────────────────────────────────────────

    #[test]
    fn e2ee_bidirectional_round_trip() {
        // Reproduce the two-direction round-trip from verify_e2ee_crypto.
        let mut ds = [0u8; 32];
        let mut fs = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut ds);
        rand::rngs::OsRng.fill_bytes(&mut fs);

        let daemon_kp = crypto::kx_seed_keypair(&ds).unwrap();
        let frontend_kp = crypto::kx_seed_keypair(&fs).unwrap();

        let dk = crypto::kx_server_session_keys(
            &daemon_kp.public_key,
            &daemon_kp.secret_key,
            &frontend_kp.public_key,
        );
        let fk = crypto::kx_client_session_keys(
            &frontend_kp.public_key,
            &frontend_kp.secret_key,
            &daemon_kp.public_key,
        );

        let payload = b"E2EE verification test 1234567890";

        // daemon → frontend
        let ct = seal(payload, &dk.tx).unwrap();
        let dec = crypto::open(&ct, &fk.rx).unwrap();
        assert_eq!(dec, payload);

        // frontend → daemon
        let ct2 = seal(payload, &fk.tx).unwrap();
        let dec2 = crypto::open(&ct2, &dk.rx).unwrap();
        assert_eq!(dec2, payload);
    }

    #[test]
    fn e2ee_wrong_key_rejected() {
        let mut ds = [0u8; 32];
        let mut fs = [0u8; 32];
        let mut ws = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut ds);
        rand::rngs::OsRng.fill_bytes(&mut fs);
        rand::rngs::OsRng.fill_bytes(&mut ws);

        let daemon_kp = crypto::kx_seed_keypair(&ds).unwrap();
        let frontend_kp = crypto::kx_seed_keypair(&fs).unwrap();
        let wrong_kp = crypto::kx_seed_keypair(&ws).unwrap();

        let dk = crypto::kx_server_session_keys(
            &daemon_kp.public_key,
            &daemon_kp.secret_key,
            &frontend_kp.public_key,
        );
        let wrong_keys = crypto::kx_server_session_keys(
            &wrong_kp.public_key,
            &wrong_kp.secret_key,
            &frontend_kp.public_key,
        );

        let payload = b"wrong-key test";
        let ct = seal(payload, &dk.tx).unwrap();

        // Decrypting with the wrong rx key MUST fail (MAC mismatch).
        assert!(
            crypto::open(&ct, &wrong_keys.rx).is_err(),
            "wrong key must be rejected"
        );
    }

    #[test]
    fn e2ee_self_test_passes_in_isolation() {
        // Run the full self-test function — all three checks must pass.
        assert!(verify_e2ee_crypto(), "E2EE self-test must pass");
    }

    #[test]
    fn seal_produces_valid_base64_with_random_nonce() {
        let key = [0xABu8; 32];
        let pt = b"hello world";
        let enc = seal(pt, &key).unwrap();
        // Base64 round-trip.
        let dec = crypto::open(&enc, &key).unwrap();
        assert_eq!(dec, pt);
        // Two seals of the same plaintext must differ (random nonces).
        let enc2 = seal(pt, &key).unwrap();
        assert_ne!(enc, enc2, "each seal must use a fresh random nonce");
    }
}
