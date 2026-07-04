// SCOPE: This is a LOCAL integration-test harness for a single-operator, self-hosted
// dev tool. It runs entirely on the operator's own machine, against a throwaway isolated
// daemon, using the operator's own already-logged-in Claude token. Where it answers
// Claude's own first-run "trust this folder?" prompt or reuses that token, this is
// ordinary unattended-CI plumbing for the operator's own sandbox — not credential theft,
// not a safety bypass, and there is no remote target. (Never runs in CI; see ios.sh.)
//
// scripts/real-daemon-pair.ts — headless REAL-daemon pairing for the native E2E
// harness (T5, #66). Stands up a real relay + a real `tp` daemon (isolated store/
// socket under a temp dir, so it never collides with the user's dogfood daemon),
// pairs a frontend over the daemon IPC socket, and prints the resulting
// `tp://p?d=…` deep link for `scripts/ios.sh` to inject as `--tp-smoke-url`.
//
// Unlike scripts/local-relay-loopback.ts (a FAKE scripted daemon peer), this drives
// the genuine daemon→relay path: the daemon self-registers via proof-based
// `relay.register`, exchanges kx in-band, and serves the frontend's real ECDH
// pairing. Architecture invariants hold: the app reaches the daemon ONLY through
// the relay, the daemon opens no WS server (only an outbound relay client), and the
// relay forwards ciphertext only.
//
// Lifecycle: this process stays alive after pairing (the relay + daemon must keep
// serving while the Swift app connects). It prints two greppable lines —
//   REAL_PAIR_URL=tp://p?d=…     (emit FIRST, before pair.completed)
//   REAL_PAIR_READY              (after the frontend completes ECDH kx)
// — then runs until SIGINT/SIGTERM, at which point it tears the daemon down.
//
// Isolation env (set by the harness before invoking us; we also default them):
//   XDG_RUNTIME_DIR  → daemon.sock dir         (socket-path.ts)
//   XDG_DATA_HOME    → sessions/vault store     (store/config.ts)
//   XDG_CONFIG_HOME  → pair.lock / hint file    (cli/lib/paths.ts)
//
// --spawn-claude (TP_E2E_CLAUDE=1): after pairing completes, spawn a REAL claude
// session against the SAME isolated daemon via `tp run --socket-path <isolated>`
// (NOT session.create — that relay control message carries no claudeArgs/env). The
// runner connects to the isolated daemon's IPC socket, sends hello → the daemon
// registers the session and broadcasts `state` over the relay → the app auto-
// attaches and renders the Stop hook's last_assistant_message. Drives M3/M3'/M4.
// Auth rides in via CLAUDE_CODE_OAUTH_TOKEN, inherited from the harness env.
//
// --spawn-claude-interactive (TP_E2E_CLAUDE_M5=1): interactive claude (live PTY) so
// the app's relayed input probe can round-trip → M5/TP_INPUT_OK.
//
// --spawn-claude-coding (TP_E2E_CLAUDE_CODING=1): the most thorough mode — drives real
// interactive claude through MULTIPLE coding turns (Write + Bash tools) over the
// genuine app→relay→daemon→PTY pipeline, then the harness asserts the file claude
// wrote + the 2-turn session-DB shape. Proves the pipeline carries real coding turns
// end-to-end, not a canned PONG. See spawnClaudeSessionCoding for the full sequence.
//
// --emit-push-notification (TP_E2E_PUSH=1): after a session DB exists (paired with
// --spawn-claude print mode so `real-smoke-sess` exists) AND the app has registered
// its synthetic push token (--tp-push-smoke), inject a synthetic `Notification` hook
// event over the IPC socket (`rec` frame). The daemon's PushNotifier sees a
// notify-eligible event with tokenCount>0 → sends `relay.push` → the relay delivers
// it in-band as `relay.notification` to the live app → `RelayClient.onNotification`
// emits TP_PUSH_NOTIFY_RECEIVED. Proves the production in-band push RECEIVE path
// without any real APNs (device entitlement / .p8 creds stay Dave-gated). See
// emitPushNotification.

import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Subprocess, spawn } from "bun";

import type { IpcClient } from "../apps/cli/src/lib/ipc-client";
import { connectIpcAsClient } from "../apps/cli/src/lib/ipc-client";
import { getSocketPath } from "../packages/protocol/src/socket-path";
import type {
  IpcInput,
  IpcMessage,
  IpcPairBegin,
  IpcRec,
} from "../packages/protocol/src/types/ipc";
import { RelayServer } from "../packages/relay/src/relay-server";

const REPO_ROOT = join(import.meta.dir, "..");
const CLI = ["bun", "run", join(REPO_ROOT, "apps/cli/src/index.ts")];

function log(msg: string): void {
  // Diagnostics on stderr so stdout carries only the greppable REAL_PAIR_* lines.
  process.stderr.write(`[real-daemon-pair] ${msg}\n`);
}

function die(msg: string): never {
  log(`FATAL: ${msg}`);
  process.exit(1);
}

// Ensure the isolated XDG dirs exist (the daemon mkdir's the store itself, but the
// runtime dir for the socket must be present + 0700 before the daemon binds).
function ensureIsolationDirs(): void {
  const runtime = process.env["XDG_RUNTIME_DIR"];
  if (!runtime) die("XDG_RUNTIME_DIR must be set (isolated socket dir)");
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  for (const v of ["XDG_DATA_HOME", "XDG_CONFIG_HOME"]) {
    const d = process.env[v];
    if (d) mkdirSync(d, { recursive: true });
  }
}

async function waitForSocket(
  socketPath: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const probe = await Bun.connect({
        unix: socketPath,
        socket: { data() {}, open() {}, close() {}, error() {} },
      });
      probe.end();
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  die(`daemon socket never appeared at ${socketPath} within ${timeoutMs}ms`);
}

// Optional `--relay-url <ws://…>`: when supplied we pair against an EXTERNAL,
// already-running relay (e.g. the Rust `tp-relay` binary in the Step 8a E2E)
// instead of starting our own in-process TS RelayServer. All isolation, the real
// daemon subprocess, and the genuine daemon→relay register + frontend pairing are
// otherwise identical — only the relay endpoint changes.
function parseRelayUrlArg(): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--relay-url") return argv[i + 1];
    const eq = argv[i]?.startsWith("--relay-url=");
    if (eq) return argv[i]?.slice("--relay-url=".length);
  }
  return undefined;
}

// Spawn a real claude session against the ALREADY-PAIRED isolated daemon by
// running `tp run --socket-path <isolated>`. The Runner connects to that exact
// socket (the isolated daemon, never the user's dogfood daemon), sends `hello`,
// and the daemon spawns claude in a PTY. We use print mode (`-p <prompt>`) so the
// Stop hook fires deterministically with a populated last_assistant_message → M4.
//   sid    fixed via TP_E2E_CLAUDE_SID so the harness can assert TP_SESSION_OK
//          sid=<that> without knowing a dynamically generated id.
//   cwd    a writable scratch dir under the isolated HOME.
//   auth   CLAUDE_CODE_OAUTH_TOKEN is inherited from our env (the harness extracts
//          it from the macOS keychain and exports it before invoking us). The
//          isolated HOME has no credentials of its own, so this env is the only
//          auth vector. Never set CLAUDE_CODE_SIMPLE=1 — simple mode skips hooks,
//          so the Stop event never fires and M4 is impossible.
function spawnClaudeSession(socketPath: string): Subprocess {
  const sid = process.env["TP_E2E_CLAUDE_SID"] ?? "real-smoke-sess";
  const cwd =
    process.env["TP_E2E_CLAUDE_CWD"] ?? process.env["HOME"] ?? REPO_ROOT;
  const prompt =
    process.env["TP_E2E_CLAUDE_PROMPT"] ?? "Reply with exactly: PONG";
  mkdirSync(cwd, { recursive: true });
  log(`spawning real claude session sid=${sid} cwd=${cwd} (print mode)`);
  const runner = spawn({
    cmd: [
      ...CLI,
      "run",
      "--sid",
      sid,
      "--cwd",
      cwd,
      "--socket-path",
      socketPath,
      "--",
      "-p",
      prompt,
      "--dangerously-skip-permissions",
    ],
    // Inherit the full env (XDG_*, HOME, CLAUDE_CODE_OAUTH_TOKEN). The Runner's
    // PtyBun.spawn passes no `env:` of its own, so claude sees exactly this env.
    env: { ...process.env },
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  // Emit the sid so the harness can override SMOKE_SESSION_ID for the M4 assertion.
  process.stdout.write(`REAL_SESSION_SID=${sid}\n`);
  log(`real claude runner spawned (pid ${runner.pid})`);
  return runner;
}

// --spawn-claude-interactive (TP_E2E_CLAUDE_M5=1): spawn a REAL *interactive* claude
// session (no `-p` — a live REPL with a persistent PTY) so the input round-trip (M5)
// can be exercised. Print mode (`-p`) ends after one Stop, before any input arrives;
// only an interactive session keeps the PTY open for the app's relayed probe.
//
// Two things differ from the print-mode spawn, both empirically required:
//   1. `--permission-mode bypassPermissions` — the dogfood permission mode (the app
//      sends only one prompt; we don't want per-tool approval prompts to stall it).
//   2. The trust-folder prompt. Interactive claude renders "Do you trust this folder?
//      1. Yes / 2. No" at startup over the PTY (print mode skips it). Pre-seeding
//      `~/.claude.json` `hasTrustDialogAccepted: true` is NOT sufficient at the current
//      claude version, so the holder sends a single Enter (`\r`) over IPC a few seconds
//      after spawn to accept option 1 ("Yes, I trust"), leaving claude idle at the REPL.
//      We also seed `hasCompletedOnboarding` so claude doesn't run first-run onboarding.
//
// After this returns claude is at the REPL: the APP then drives the genuine M5 input
// (its auto-probe `in.chat` over the relay → daemon appends `\n` → PTY → claude submits
// → responds → a NEW assistant Stop chat item → the app emits TP_INPUT_OK proof=response).
function spawnClaudeSessionInteractive(
  socketPath: string,
  ipc: IpcClient,
): Subprocess {
  const sid = process.env["TP_E2E_CLAUDE_SID"] ?? "real-smoke-sess";
  const cwd =
    process.env["TP_E2E_CLAUDE_CWD"] ?? process.env["HOME"] ?? REPO_ROOT;
  mkdirSync(cwd, { recursive: true });

  // Pre-seed trust + onboarding in the isolated HOME's ~/.claude.json so claude skips
  // onboarding (the trust dialog is still answered live via the `\r` below).
  const home = process.env["HOME"];
  if (home) {
    try {
      const seed = {
        hasCompletedOnboarding: true,
        // Best-effort onboarding pre-seed. NOTE: neither key reliably SUPPRESSES the
        // first-run dialogs when bypass is requested via the --permission-mode CLI flag —
        // empirically (claude 2.1.198, through the real `tp run` PTY) the trust dialog AND
        // the Bypass-mode disclaimer ("1. No, exit / 2. Yes, I accept", default = exit)
        // still render. They are therefore dismissed LIVE by acceptTrustDialogs, which
        // reads the PTY and sends the correct key per dialog. These keys stay only as
        // harmless belt-and-suspenders should a future claude honour them from this file.
        bypassPermissionsModeAccepted: true,
        projects: { [cwd]: { hasTrustDialogAccepted: true } },
      };
      writeFileSync(join(home, ".claude.json"), JSON.stringify(seed));
    } catch (err) {
      log(`WARN — could not seed ~/.claude.json: ${String(err)}`);
    }
  }

  log(`spawning real claude session sid=${sid} cwd=${cwd} (INTERACTIVE)`);
  const runner = spawn({
    cmd: [
      ...CLI,
      "run",
      "--sid",
      sid,
      "--cwd",
      cwd,
      "--socket-path",
      socketPath,
      "--",
      "--permission-mode",
      "bypassPermissions",
    ],
    env: { ...process.env },
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  process.stdout.write(`REAL_SESSION_SID=${sid}\n`);
  log(`real interactive claude runner spawned (pid ${runner.pid})`);

  // Accept the trust-folder prompt: wait for the TUI to render it, then send Enter
  // (`\r`) over IPC. The daemon routes `input` to the runner by sid → PtyBun.write →
  // claude advances past its first-run dialogs to the idle REPL. Send raw bytes over IPC
  // (daemon routes by sid → PtyBun.write); acceptTrustDialogs picks the right key per
  // prompt (a context-free Enter quits on the Bypass-mode "No, exit" default — see its comment).
  const sendRaw = (bytes: string, label: string): void => {
    const msg: IpcInput = {
      t: "input",
      sid,
      data: Buffer.from(bytes).toString("base64"),
    };
    try {
      ipc.send(msg);
      log(`sent ${label} to interactive claude`);
    } catch (err) {
      log(`WARN — failed to send ${label}: ${String(err)}`);
    }
  };
  // Content-aware trust accept, detached so the holder returns the runner immediately
  // (the app pairs + probes concurrently). Reads live PTY io to send the correct key for
  // whichever of the trust / bypass / settings-error dialogs is on screen, then resolves
  // once claude reaches the REPL. This must finish before the app's probe so the probe
  // text is never consumed as a dialog keystroke.
  void acceptTrustDialogs(sid, sendRaw).catch((err: unknown) => {
    log(`WARN — interactive trust-accept failed: ${String(err)}`);
  });

  return runner;
}

// Count records of a given (kind, name) in the daemon's per-session DB. The daemon
// writes records in WAL mode (schema.ts PRAGMAS), so a short-lived read-only opener
// from THIS process sees committed writes without colliding with the writer. The
// path layout is fixed by store/config.ts (`<XDG_DATA_HOME>/teleprompter/vault`) +
// store.ts (`sessions/<sid>.sqlite`) — the same SoT the harness asserts on later.
//
// Returns 0 if the DB does not exist yet (session not registered) or any read error
// (transient WAL race) — the caller polls, so a 0 just means "keep waiting".
function countRecords(sid: string, kind: string, name: string): number {
  const dataHome =
    process.env["XDG_DATA_HOME"] ??
    join(process.env["HOME"] ?? REPO_ROOT, ".local", "share");
  const dbPath = join(
    dataHome,
    "teleprompter",
    "vault",
    "sessions",
    `${sid}.sqlite`,
  );
  let db: Database | undefined;
  try {
    // readonly avoids creating the file if the session hasn't registered yet, and
    // never takes a write lock against the daemon. WAL readers don't block.
    db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM records WHERE kind = ? AND name = ?")
      .get(kind, name) as { c: number } | null;
    return row?.c ?? 0;
  } catch {
    return 0;
  } finally {
    db?.close();
  }
}

async function waitForStopCount(
  sid: string,
  target: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (countRecords(sid, "event", "Stop") >= target) return true;
    await Bun.sleep(1_000);
  }
  return false;
}

// True once the per-session DB exists with its `records` table — i.e. the spawned
// claude session has registered with the daemon. `handleRec` rejects a `rec` for an
// unknown sid (`store.getSessionDb(sid)` is null), so the push injection must wait
// for this before firing.
function sessionDbReady(sid: string): boolean {
  const dataHome =
    process.env["XDG_DATA_HOME"] ??
    join(process.env["HOME"] ?? REPO_ROOT, ".local", "share");
  const dbPath = join(
    dataHome,
    "teleprompter",
    "vault",
    "sessions",
    `${sid}.sqlite`,
  );
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    // Touch the table so a half-created DB (file present, schema not yet applied)
    // doesn't read as ready.
    db.prepare("SELECT 1 FROM records LIMIT 1").get();
    return true;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

// Concatenate the most recent `limit` io-record payloads (ANSI left intact — we only
// substring-match on the human-readable option labels, which survive the escapes) so
// the trust-accept driver can see WHICH first-run dialog claude is currently rendering.
function readRecentIo(sid: string, limit = 6): string {
  const dataHome =
    process.env["XDG_DATA_HOME"] ??
    join(process.env["HOME"] ?? REPO_ROOT, ".local", "share");
  const dbPath = join(
    dataHome,
    "teleprompter",
    "vault",
    "sessions",
    `${sid}.sqlite`,
  );
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare(
        "SELECT payload FROM records WHERE kind = 'io' ORDER BY seq DESC LIMIT ?",
      )
      .all(limit) as Array<{ payload: Uint8Array }>;
    // Rows come newest-first; join oldest-first so multi-record dialogs read in order.
    return rows
      .reverse()
      .map((r) => Buffer.from(r.payload).toString("latin1"))
      .join("");
  } catch {
    return "";
  } finally {
    db?.close();
  }
}

// Answer claude's TWO first-run prompts for the harness's OWN throwaway sandbox HOME
// (the operator would click these for their own scratch dir; the test does it unattended)
// by reading the live PTY io and sending the CORRECT key for whichever prompt is on
// screen — NOT a context-free Enter. The two prompts have OPPOSITE safe options, which is
// exactly why the old context-free `\r`×13 loop quit the session:
//   • Dialog 1 "Is this a project you trust?": ❯ default = "1. Yes, I trust this folder".
//     A bare Enter accepts. (option 2 = "No, exit")
//   • Dialog 2 "Bypass Permissions mode" disclaimer: ❯ default = "1. No, exit".
//     A bare Enter QUITS claude. The accept is option "2. Yes, I accept", reached by
//     one Down-arrow then Enter (\x1b[B\r). Selecting by digit is avoided because "2"
//     on dialog 1 means "No, exit".
// Config seeds (hasTrustDialogAccepted / bypassPermissionsModeAccepted in ~/.claude.json)
// do NOT suppress these dialogs when bypass is requested via the --permission-mode CLI
// flag (empirically confirmed against claude 2.1.198 through the real `tp run` PTY), so
// the accept must be driven live. Resolves once claude submits a real prompt
// (UserPromptSubmit >= 1) or ~40s elapses.
async function acceptTrustDialogs(
  sid: string,
  sendRaw: (bytes: string, label: string) => void,
): Promise<void> {
  const upsBaseline = countRecords(sid, "event", "UserPromptSubmit");
  const deadline = Date.now() + 40_000;
  let ticks = 0;
  while (Date.now() < deadline) {
    // Past the gates once claude accepts and processes a prompt.
    if (countRecords(sid, "event", "UserPromptSubmit") > upsBaseline) return;
    ticks += 1;
    const io = readRecentIo(sid);
    const onBypassDialog =
      io.includes("Bypass Permissions mode") || io.includes("Yes, I accept");
    const onTrustDialog = io.includes("Yes, I trust this folder");
    // A third gate can appear when a settings.json claude reads (e.g. a personal/global
    // one outside the isolated HOME) fails schema validation: "1. Fix with Claude /
    // 2. Exit and fix manually / 3. Continue without these settings". Neither of the
    // first two lets the session proceed unattended, so pick "3" to continue.
    const onSettingsError =
      io.includes("Continue without these settings") ||
      (io.includes("Files with errors are skipped") &&
        io.includes("Fix with Claude"));
    if (onSettingsError) {
      sendRaw("3", `settings-error continue (tick ${ticks})`);
      await Bun.sleep(250);
      sendRaw("\r", `settings-error confirm (tick ${ticks})`);
    } else if (onBypassDialog) {
      // Down-arrow to "Yes, I accept", then Enter to confirm. Never a bare Enter here.
      sendRaw("\x1b[B", `bypass-dialog select (tick ${ticks})`);
      await Bun.sleep(250);
      sendRaw("\r", `bypass-dialog confirm (tick ${ticks})`);
    } else if (onTrustDialog) {
      // Default is already "Yes, I trust" — Enter accepts.
      sendRaw("\r", `trust-dialog accept (tick ${ticks})`);
    } else {
      // Not on a recognizable dialog yet (cold start) or already at the REPL — a stray
      // Enter is harmless (empty submit). Nudge in case the dialog render lagged the DB.
      sendRaw("\r", `trust nudge (tick ${ticks})`);
    }
    await Bun.sleep(1_500);
  }
}

// --emit-push-notification (TP_E2E_PUSH=1): inject a synthetic `Notification` hook
// event over IPC so the daemon's PushNotifier dispatches a push to the live app.
// Drives the production in-band receive path (RelayClient.onNotification →
// TP_PUSH_NOTIFY_RECEIVED) with no real APNs.
//
// Preconditions handled here:
//   - the session DB must exist (handleRec rejects an unknown sid) → poll sessionDbReady.
//   - the app must have registered its synthetic push token (--tp-push-smoke) so the
//     daemon's `tokenCount > 0` gate is open. There is no holder-visible signal for
//     that (the token lives in the daemon's vault, not the session DB), so we RE-SEND
//     the event on a bounded loop: an injection that lands before the token registers
//     simply finds tokenCount==0 and no-ops (push-notifier.ts:227), and the next
//     re-send (after the app has authed + registered) succeeds. Each re-send is cheap
//     and idempotent (a fresh notify-eligible event); the harness's assert_push_e2e
//     polls the marker independently. The app stays connected through the smoke run,
//     so once a push fires the relay delivers it in-band (DeliveryResult "ws").
async function emitPushNotification(
  sid: string,
  ipc: IpcClient,
): Promise<void> {
  // Wait for the session DB so the daemon will accept the rec.
  const dbDeadline = Date.now() + 60_000;
  while (Date.now() < dbDeadline && !sessionDbReady(sid)) {
    await Bun.sleep(500);
  }
  if (!sessionDbReady(sid)) {
    log(`push: session DB ${sid} never appeared — skipping push injection`);
    return;
  }

  const message =
    process.env["TP_E2E_PUSH_MESSAGE"] ?? "QA push smoke — Claude needs you";
  const payload = Buffer.from(JSON.stringify({ message })).toString("base64");

  // Re-send a few times to absorb the token-registration race (above). 8 sends @ 3s
  // covers the worst-case app auth+register latency without dragging the run out.
  for (let attempt = 1; attempt <= 8; attempt++) {
    const rec: IpcRec = {
      t: "rec",
      sid,
      kind: "event",
      name: "Notification",
      payload,
      ts: Date.now(),
    };
    ipc.send(rec);
    log(
      `push: injected synthetic Notification event (sid=${sid}, attempt ${attempt})`,
    );
    await Bun.sleep(3_000);
  }
  log("push: finished injecting Notification events");
}

// --spawn-claude-coding (TP_E2E_CLAUDE_CODING=1): the strongest real-claude E2E. It
// drives a REAL interactive claude through ACTUAL CODING across MULTIPLE turns over
// the genuine app→relay→daemon→PTY pipeline — not a canned "reply PONG". This proves
// the controller can make Claude Code use the Write and Bash tools and observe the
// results, which is the whole point of the product.
//
// Sequence (each turn = an `in.chat`-equivalent `input` frame the daemon appends `\r`
// to → PTY → claude submits → UserPromptSubmit → … → Stop):
//   trust  accept the trust-folder dialog (reuses the interactive `\r` ticks).
//   turn 1 "Create a file tp_qa_marker.txt containing exactly QA-CODING-OK" → claude
//          uses the Write tool (bypassPermissions = no approval dialog) → Stop #1.
//   turn 2 (gated on Stop>=1) "run: cat tp_qa_marker.txt && echo BUILD-STEP-DONE" →
//          claude uses the Bash tool, the file content + BUILD-STEP-DONE land in the
//          PTY io records → Stop #2.
//
// The harness then asserts the deterministic structural facts (not exact model text):
//   - the file exists on disk under the isolated cwd with body QA-CODING-OK
//   - the session DB has UserPromptSubmit >= 2 and Stop >= 2 (two real turns landed)
//   - the DB has a PostToolUse(Write) and a PostToolUse(Bash) hook event, both naming
//     the marker file (claude used those tools on the controller's instructions — a
//     structured event check, not a substring scan of the ANSI-laden io stream)
// Turn-gating reads the SAME per-session DB the harness asserts on (countRecords).
//
// The app's M5 auto-probe is SUPPRESSED in this mode (harness launches the app with
// --tp-no-input-probe): the holder owns input, and an interleaved probe on the same
// REPL corrupts the coding turns (observed: the probe submitted a Skill(run) mid-turn,
// so turn 1's Write never completed).
//
// Like the M5 interactive mode, daemon+relay+claude all run on the HOST; only the app
// runs in the sim/native target. So this is the deepest proof the app pipeline can
// give without a human at the keyboard. It is LOCAL-ONLY (real claude auth + credits)
// and never runs in CI.
function spawnClaudeSessionCoding(
  socketPath: string,
  ipc: IpcClient,
): Subprocess {
  const sid = process.env["TP_E2E_CLAUDE_SID"] ?? "real-smoke-sess";
  const cwd =
    process.env["TP_E2E_CLAUDE_CWD"] ?? process.env["HOME"] ?? REPO_ROOT;
  mkdirSync(cwd, { recursive: true });

  // Same trust + onboarding pre-seed as the interactive mode.
  const home = process.env["HOME"];
  if (home) {
    try {
      const seed = {
        hasCompletedOnboarding: true,
        // Best-effort onboarding pre-seed. NOTE: neither key reliably SUPPRESSES the
        // first-run dialogs when bypass is requested via the --permission-mode CLI flag —
        // empirically (claude 2.1.198, through the real `tp run` PTY) the trust dialog AND
        // the Bypass-mode disclaimer ("1. No, exit / 2. Yes, I accept", default = exit)
        // still render. They are therefore dismissed LIVE by acceptTrustDialogs, which
        // reads the PTY and sends the correct key per dialog. These keys stay only as
        // harmless belt-and-suspenders should a future claude honour them from this file.
        bypassPermissionsModeAccepted: true,
        projects: { [cwd]: { hasTrustDialogAccepted: true } },
      };
      writeFileSync(join(home, ".claude.json"), JSON.stringify(seed));
    } catch (err) {
      log(`WARN — could not seed ~/.claude.json: ${String(err)}`);
    }
  }

  log(`spawning real claude session sid=${sid} cwd=${cwd} (CODING multi-turn)`);
  const runner = spawn({
    cmd: [
      ...CLI,
      "run",
      "--sid",
      sid,
      "--cwd",
      cwd,
      "--socket-path",
      socketPath,
      "--",
      "--permission-mode",
      "bypassPermissions",
    ],
    env: { ...process.env },
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  process.stdout.write(`REAL_SESSION_SID=${sid}\n`);
  log(`real coding claude runner spawned (pid ${runner.pid})`);

  // Send raw bytes to the session over IPC (daemon routes by sid → PtyBun.write).
  const sendRaw = (bytes: string, label: string): void => {
    const msg: IpcInput = {
      t: "input",
      sid,
      data: Buffer.from(bytes).toString("base64"),
    };
    try {
      ipc.send(msg);
      log(`sent ${label}`);
    } catch (err) {
      log(`WARN — failed to send ${label}: ${String(err)}`);
    }
  };
  // A standalone carriage return — submits whatever is in claude's composer (and
  // accepts the trust dialog's highlighted option). Claude's TUI treats a CR glued to
  // the prompt text as part of the multi-line paste buffer, NOT a submit — so the text
  // and the submit MUST be separate writes (empirically: a `text\r` single frame
  // leaves the prompt sitting unsubmitted in the composer).
  const sendSubmit = (label: string): void =>
    sendRaw("\r", `submit (${label})`);

  const marker = process.env["TP_E2E_CODING_MARKER"] ?? "QA-CODING-OK";
  const fileName = process.env["TP_E2E_CODING_FILE"] ?? "tp_qa_marker.txt";
  const turn1 = `Create a file named ${fileName} in the current directory containing exactly this text and nothing else: ${marker}`;
  const turn2 = `Now run this shell command: cat ${fileName} && echo BUILD-STEP-DONE`;

  // Drive one coding turn robustly: type the prompt text, then submit, then confirm the
  // prompt actually registered (UserPromptSubmit count incremented) — resending the
  // submit a few times if not, because claude's REPL drops keystrokes during its warmup
  // window (the same fragility the M5 probe handles with retries). Resolves true once
  // the turn's UserPromptSubmit AND its Stop are both observed.
  const driveTurn = async (
    text: string,
    turnIndex: number,
  ): Promise<boolean> => {
    const upsBefore = countRecords(sid, "event", "UserPromptSubmit");
    const stopsBefore = countRecords(sid, "event", "Stop");
    // Type the text (no CR), let the composer settle, then submit.
    sendRaw(text, `coding turn ${turnIndex} text (${text.length} chars)`);
    await Bun.sleep(1_500);
    sendSubmit(`turn ${turnIndex}`);
    // Confirm the prompt registered; resend submit on warmup drops (up to ~5 tries).
    let registered = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        if (countRecords(sid, "event", "UserPromptSubmit") > upsBefore) {
          registered = true;
          break;
        }
        await Bun.sleep(500);
      }
      if (registered) break;
      log(
        `turn ${turnIndex}: UserPromptSubmit not yet incremented (attempt ${attempt}) — resending submit`,
      );
      sendSubmit(`turn ${turnIndex} retry ${attempt}`);
    }
    if (!registered) {
      log(
        `WARN — turn ${turnIndex}: prompt never registered (UserPromptSubmit)`,
      );
      return false;
    }
    log(`turn ${turnIndex}: prompt registered; waiting for its Stop`);
    const ok = await waitForStopCount(sid, stopsBefore + 1, 180_000);
    log(
      ok
        ? `turn ${turnIndex}: Stop observed (turn complete)`
        : `WARN — turn ${turnIndex}: Stop never observed within 180s`,
    );
    return ok;
  };

  // Drive the whole sequence on a detached async chain so the spawn returns immediately
  // (the holder's pairing handshake runs concurrently, like the interactive mode). Any
  // failure here is logged but never throws into the holder — the harness's marker/DB/
  // file assertions are the real pass/fail signal.
  void (async () => {
    // 1. First-run answer window: content-aware (sends the correct key per first-run prompt).
    //    A context-free Enter loop quits on the Bypass-mode prompt's "No, exit" default and
    //    stalls on a settings-error dialog; acceptTrustDialogs handles all three. Turn 1
    //    is sent only AFTER the gates clear so a coding prompt is never interleaved with
    //    a dialog keystroke.
    await acceptTrustDialogs(sid, sendRaw);

    // 2. Turn 1 (create the file via Write) → its Stop.
    await driveTurn(turn1, 1);
    // 3. Turn 2 (cat + echo via Bash) — gated on turn 1's Stop inside driveTurn, so the
    //    two turns are strictly ordered for a clean 2-turn session DB.
    await driveTurn(turn2, 2);
    log("coding turn driver finished (both turns attempted)");
  })().catch((err: unknown) => {
    log(`WARN — coding turn driver failed: ${String(err)}`);
  });

  return runner;
}

// spawnClaudeSessionWebpage — TP_E2E_WEBPAGE sibling of spawnClaudeSessionCoding.
//
// Drives TWO turns building a real static HTML5 webpage in the isolated cwd:
//   turn 1: instruct claude to CREATE an index.html (or $TP_E2E_WEBPAGE_FILE) that is a
//            complete valid HTML5 document with DOCTYPE, <html>, <head>/<title>, <body>/<h1>
//            containing a recognizable marker ($TP_E2E_WEBPAGE_MARKER, default TP-WEBPAGE-OK),
//            and an inline <style> block with at least one CSS rule. Tells it to use Write.
//   turn 2: instruct claude to run a shell command that validates the file —
//            `grep -c "<!DOCTYPE html>" <file> && grep -c "<marker>" <file> && echo WEBPAGE-STEP-DONE`.
//            Uses the Bash tool.
//
// Reuses driveTurn verbatim; only the turn prompts differ from the coding variant.
// Local-only (real claude auth + credits); never CI.
function spawnClaudeSessionWebpage(
  socketPath: string,
  ipc: IpcClient,
): Subprocess {
  const sid = process.env["TP_E2E_CLAUDE_SID"] ?? "real-smoke-sess";
  const cwd =
    process.env["TP_E2E_CLAUDE_CWD"] ?? process.env["HOME"] ?? REPO_ROOT;
  mkdirSync(cwd, { recursive: true });

  // Same trust + onboarding pre-seed as the coding mode.
  const home = process.env["HOME"];
  if (home) {
    try {
      const seed = {
        hasCompletedOnboarding: true,
        // Best-effort onboarding pre-seed. NOTE: neither key reliably SUPPRESSES the
        // first-run dialogs when bypass is requested via the --permission-mode CLI flag —
        // empirically (claude 2.1.198, through the real `tp run` PTY) the trust dialog AND
        // the Bypass-mode disclaimer ("1. No, exit / 2. Yes, I accept", default = exit)
        // still render. They are therefore dismissed LIVE by acceptTrustDialogs, which
        // reads the PTY and sends the correct key per dialog. These keys stay only as
        // harmless belt-and-suspenders should a future claude honour them from this file.
        bypassPermissionsModeAccepted: true,
        projects: { [cwd]: { hasTrustDialogAccepted: true } },
      };
      writeFileSync(join(home, ".claude.json"), JSON.stringify(seed));
    } catch (err) {
      log(`WARN — could not seed ~/.claude.json: ${String(err)}`);
    }
  }

  log(
    `spawning real claude session sid=${sid} cwd=${cwd} (WEBPAGE multi-turn)`,
  );
  const runner = spawn({
    cmd: [
      ...CLI,
      "run",
      "--sid",
      sid,
      "--cwd",
      cwd,
      "--socket-path",
      socketPath,
      "--",
      "--permission-mode",
      "bypassPermissions",
    ],
    env: { ...process.env },
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  process.stdout.write(`REAL_SESSION_SID=${sid}\n`);
  log(`real webpage claude runner spawned (pid ${runner.pid})`);

  // Send raw bytes to the session over IPC (daemon routes by sid → PtyBun.write).
  const sendRaw = (bytes: string, label: string): void => {
    const msg: IpcInput = {
      t: "input",
      sid,
      data: Buffer.from(bytes).toString("base64"),
    };
    try {
      ipc.send(msg);
      log(`sent ${label}`);
    } catch (err) {
      log(`WARN — failed to send ${label}: ${String(err)}`);
    }
  };
  const sendSubmit = (label: string): void =>
    sendRaw("\r", `submit (${label})`);

  const marker = process.env["TP_E2E_WEBPAGE_MARKER"] ?? "TP-WEBPAGE-OK";
  const fileName = process.env["TP_E2E_WEBPAGE_FILE"] ?? "index.html";
  const turn1 =
    `Create a file named ${fileName} in the current directory using the Write tool. ` +
    `The file must be a complete valid HTML5 document with: ` +
    `a <!DOCTYPE html> declaration, an <html> element, a <head> element containing a <title>, ` +
    `a <body> element containing an <h1> that includes the text "${marker}", ` +
    `and an inline <style> block inside <head> with at least one CSS rule (e.g. body { font-family: sans-serif; }). ` +
    `Do not truncate the file — write the complete document in one Write tool call.`;
  const turn2 =
    `Now run this shell command to validate the file you just created: ` +
    `grep -c "<!DOCTYPE html>" ${fileName} && grep -c "${marker}" ${fileName} && echo WEBPAGE-STEP-DONE`;

  // driveTurn — reused verbatim from the coding mode: type prompt text (no CR),
  // wait 1.5s for composer, send separate \r submit, confirm UserPromptSubmit
  // incremented (resend up to 5× on warmup keystroke-drops), wait for Stop.
  const driveTurn = async (
    text: string,
    turnIndex: number,
  ): Promise<boolean> => {
    const upsBefore = countRecords(sid, "event", "UserPromptSubmit");
    const stopsBefore = countRecords(sid, "event", "Stop");
    sendRaw(text, `webpage turn ${turnIndex} text (${text.length} chars)`);
    await Bun.sleep(1_500);
    sendSubmit(`turn ${turnIndex}`);
    let registered = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        if (countRecords(sid, "event", "UserPromptSubmit") > upsBefore) {
          registered = true;
          break;
        }
        await Bun.sleep(500);
      }
      if (registered) break;
      log(
        `turn ${turnIndex}: UserPromptSubmit not yet incremented (attempt ${attempt}) — resending submit`,
      );
      sendSubmit(`turn ${turnIndex} retry ${attempt}`);
    }
    if (!registered) {
      log(
        `WARN — turn ${turnIndex}: prompt never registered (UserPromptSubmit)`,
      );
      return false;
    }
    log(`turn ${turnIndex}: prompt registered; waiting for its Stop`);
    const ok = await waitForStopCount(sid, stopsBefore + 1, 180_000);
    log(
      ok
        ? `turn ${turnIndex}: Stop observed (turn complete)`
        : `WARN — turn ${turnIndex}: Stop never observed within 180s`,
    );
    return ok;
  };

  // Detached async chain — returns immediately so the pairing handshake runs
  // concurrently (same pattern as spawnClaudeSessionCoding).
  void (async () => {
    // Trust-accept window: content-aware, sends the correct key per dialog (a blind
    // Enter loop quits on the Bypass-mode dialog's "No, exit" default).
    await acceptTrustDialogs(sid, sendRaw);

    // Turn 1: create the HTML5 file via the Write tool.
    await driveTurn(turn1, 1);
    // Turn 2: validate the file via Bash (gated on turn 1's Stop via driveTurn).
    await driveTurn(turn2, 2);
    log("webpage turn driver finished (both turns attempted)");
  })().catch((err: unknown) => {
    log(`WARN — webpage turn driver failed: ${String(err)}`);
  });

  return runner;
}

async function main(): Promise<void> {
  ensureIsolationDirs();

  // 1. Relay endpoint. By default, a real in-process TS relay on a free port
  //    (OS-assigned). With `--relay-url`, point at an external relay (the Rust
  //    binary) instead — the daemon's proof-carrying relay.register is accepted
  //    by either, since neither pre-seeds the token.
  const externalRelayUrl = parseRelayUrlArg();
  let relay: RelayServer | undefined;
  let relayUrl: string;
  if (externalRelayUrl) {
    relayUrl = externalRelayUrl;
    log(`using EXTERNAL relay at ${relayUrl} (no in-process relay started)`);
  } else {
    relay = new RelayServer();
    const relayPort = relay.start(0);
    relayUrl = `ws://localhost:${relayPort}`;
    log(`relay up on ${relayUrl}`);
  }

  // 2. Real daemon subprocess, isolated via the inherited XDG_* env.
  const daemon = spawn({
    cmd: [...CLI, "daemon", "start"],
    env: { ...process.env, LOG_LEVEL: "error", TP_NO_AUTO_INSTALL: "1" },
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  log(`daemon spawned (pid ${daemon.pid})`);

  // Holds the optional real-claude runner (--spawn-claude). Declared before
  // shutdown() so the signal handlers can tear it down too — otherwise the runner
  // (and its claude PTY) would outlive the daemon+relay on SIGTERM.
  let claudeRunner: Subprocess | undefined;
  const shutdown = (): never => {
    try {
      claudeRunner?.kill();
    } catch {
      /* already gone */
    }
    try {
      daemon.kill();
    } catch {
      /* already gone */
    }
    relay?.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 3. Wait for the daemon IPC socket, then connect as the CLI would.
  const socketPath = getSocketPath();
  await waitForSocket(socketPath);
  const ipc = await connectIpcAsClient(socketPath);
  log(`IPC connected at ${socketPath}`);

  // 3b. Spawn the real claude session NOW — before pairing — so the daemon has
  //     registered (and stored) the session by the time the app sends its `hello`.
  //     A `claude -p` print session ends within a few seconds, but a stopped
  //     session still appears in `store.listSessions()` (no state filter), so the
  //     app's hello returns sessions>=1 (drives TP_FRAME_OK) and auto-attach →
  //     resume → batch replays the persisted Stop record (drives TP_SESSION_OK).
  //     Spawning post-`pair.completed` (the old order) raced the app's hello: the
  //     store was still empty at pairing time, so the first hello carried
  //     sessions=0 and the print session had already ended before any live `state`
  //     broadcast could backfill it. Pairing does NOT depend on the session, and
  //     `tp run` connects to the daemon IPC directly (no relay), so the two are
  //     independent — we kick claude off here and let it run concurrently with the
  //     pairing handshake below.
  if (process.argv.includes("--spawn-claude-webpage")) {
    // Webpage mode: real interactive claude driven through TWO webpage-building turns
    // (Write an HTML5 file, then Bash-validate it) over the genuine pipeline.
    // Takes highest precedence (over coding + interactive + print) — webpage and coding
    // are mutually exclusive siblings; when both flags appear, webpage wins.
    claudeRunner = spawnClaudeSessionWebpage(socketPath, ipc);
  } else if (process.argv.includes("--spawn-claude-coding")) {
    // Strongest mode: real interactive claude driven through MULTIPLE coding turns
    // (Write + Bash tools) over the genuine pipeline. Reuses `ipc` to send the
    // trust-accept Enter and each coding turn's input frame.
    claudeRunner = spawnClaudeSessionCoding(socketPath, ipc);
  } else if (process.argv.includes("--spawn-claude-interactive")) {
    // M5: interactive claude (live PTY) + trust-accept over IPC. Reuses `ipc` (the
    // same daemon IPC connection used for pairing) to send the trust-accept Enter.
    claudeRunner = spawnClaudeSessionInteractive(socketPath, ipc);
  } else if (process.argv.includes("--spawn-claude")) {
    claudeRunner = spawnClaudeSession(socketPath);
  }

  // 4. pair.begin → print URL on pair.begin.ok → resolve on pair.completed.
  await new Promise<void>((resolve, reject) => {
    ipc.onMessage((msg: IpcMessage) => {
      switch (msg.t) {
        case "pair.begin.ok":
          // Emit the deep link FIRST so the harness can inject it immediately —
          // it does not need to wait for the frontend to finish kx.
          process.stdout.write(`REAL_PAIR_URL=${msg.qrString}\n`);
          log(`pairing begun (id ${msg.pairingId}, daemon ${msg.daemonId})`);
          break;
        case "pair.completed":
          process.stdout.write(`REAL_PAIR_READY\n`);
          log(`pairing completed (daemon ${msg.daemonId})`);
          resolve();
          break;
        case "pair.begin.err":
          reject(
            new Error(`pair.begin.err: ${msg.reason} ${msg.message ?? ""}`),
          );
          break;
        case "pair.error":
          reject(new Error(`pair.error: ${msg.reason} ${msg.message ?? ""}`));
          break;
        case "pair.cancelled":
          reject(new Error("pair.cancelled"));
          break;
        default:
          break;
      }
    });
    ipc.onClose(() =>
      reject(new Error("daemon IPC closed before pairing completed")),
    );

    const begin: IpcPairBegin = { t: "pair.begin", relayUrl };
    ipc.send(begin);
  }).catch((err: unknown) => {
    die(err instanceof Error ? err.message : String(err));
  });

  // 5. (claude session already spawned at step 3b — before pairing — so the app's
  //    hello already lists it. Nothing to do here.)

  // 5b. PUSH E2E: inject a synthetic Notification event so the daemon pushes it to
  //     the live app (in-band relay.notification → TP_PUSH_NOTIFY_RECEIVED). Detached
  //     so it does not block the hold-open loop; the session DB it targets is created
  //     by the --spawn-claude print session above.
  if (process.argv.includes("--emit-push-notification")) {
    const pushSid = process.env["TP_E2E_CLAUDE_SID"] ?? "real-smoke-sess";
    void emitPushNotification(pushSid, ipc).catch((err: unknown) => {
      log(
        `push: emitPushNotification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  // 6. Stay alive — the relay + daemon must keep serving the app until the harness
  //    kills us. (The smoke run injects REAL_PAIR_URL and polls the app's markers.)
  log("paired; holding relay + daemon open until SIGTERM");
  await new Promise<never>(() => {
    /* never resolves; exits via the SIGINT/SIGTERM handlers */
  });
}

void main();
