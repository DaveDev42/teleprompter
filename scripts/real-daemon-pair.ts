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

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";

import { connectIpcAsClient } from "../apps/cli/src/lib/ipc-client";
import { getSocketPath } from "../packages/protocol/src/socket-path";
import type {
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
  const runtime = process.env.XDG_RUNTIME_DIR;
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

async function main(): Promise<void> {
  ensureIsolationDirs();

  // 1. Real relay on a free port (OS-assigned). The daemon's proof-carrying
  //    relay.register is accepted by a fresh relay with no pre-seeded token.
  const relay = new RelayServer();
  const relayPort = relay.start(0);
  const relayUrl = `ws://localhost:${relayPort}`;
  log(`relay up on ${relayUrl}`);

  // 2. Real daemon subprocess, isolated via the inherited XDG_* env.
  const daemon = spawn({
    cmd: [...CLI, "daemon", "start"],
    env: { ...process.env, LOG_LEVEL: "error", TP_NO_AUTO_INSTALL: "1" },
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  log(`daemon spawned (pid ${daemon.pid})`);

  const shutdown = (): never => {
    try {
      daemon.kill();
    } catch {
      /* already gone */
    }
    relay.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 3. Wait for the daemon IPC socket, then connect as the CLI would.
  const socketPath = getSocketPath();
  await waitForSocket(socketPath);
  const ipc = await connectIpcAsClient(socketPath);
  log(`IPC connected at ${socketPath}`);

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

  // 5. Stay alive — the relay + daemon must keep serving the app until the harness
  //    kills us. (The smoke run injects REAL_PAIR_URL and polls the app's markers.)
  log("paired; holding relay + daemon open until SIGTERM");
  await new Promise<never>(() => {
    /* never resolves; exits via the SIGINT/SIGTERM handlers */
  });
}

void main();
