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
  // claude advances past the trust dialog to the idle REPL. A single `\r` selects the
  // default highlighted option 1 ("Yes, I trust this folder").
  const sendEnter = (label: string): void => {
    const msg: IpcInput = {
      t: "input",
      sid,
      data: Buffer.from("\r").toString("base64"),
    };
    try {
      ipc.send(msg);
      log(`sent trust-accept Enter to interactive claude (${label})`);
    } catch (err) {
      log(`WARN — failed to send trust-accept (${label}): ${String(err)}`);
    }
  };
  // Send Enter REPEATEDLY (every 2s, ~25s window) rather than at two fixed offsets.
  // The trust prompt's render time varies with cold-start (warm vs cold caches, the
  // isolated HOME, daemon connect latency), and claude's raw-mode stdin handler must
  // be attached when the `\r` lands or it is swallowed as pre-prompt noise. A single
  // mistimed Enter leaves claude stuck at the trust dialog, so the app's later probe
  // is consumed as a trust-menu keystroke (no UserPromptSubmit → no Stop → M5 fails).
  // Sending Enter on an interval guarantees one lands once the prompt is interactive;
  // any extra Enter at the already-idle REPL just submits an empty line (no prompt →
  // claude ignores it), and stops well before the app pairs+probes (~30s+), so there
  // is no risk of an empty Enter racing the probe text. 13 sends × 2s ≈ 26s.
  let trustTicks = 0;
  const trustTimer = setInterval(() => {
    trustTicks += 1;
    sendEnter(`tick ${trustTicks}`);
    if (trustTicks >= 13) clearInterval(trustTimer);
  }, 2_000);
  // Don't let the interval keep the event loop alive past the holder's lifetime.
  if (typeof trustTimer === "object" && "unref" in trustTimer) {
    (trustTimer as { unref: () => void }).unref();
  }

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
  if (process.argv.includes("--spawn-claude-interactive")) {
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

  // 6. Stay alive — the relay + daemon must keep serving the app until the harness
  //    kills us. (The smoke run injects REAL_PAIR_URL and polls the app's markers.)
  log("paired; holding relay + daemon open until SIGTERM");
  await new Promise<never>(() => {
    /* never resolves; exits via the SIGINT/SIGTERM handlers */
  });
}

void main();
