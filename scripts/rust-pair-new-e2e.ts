// scripts/rust-pair-new-e2e.ts — headless synthetic-kx E2E for the NATIVE Rust
// `tp pair new` (ADR-0003 Amendment 2, tranche 3b).
//
// Proves the Rust `tp pair new` drives the genuine CLI → daemon (IPC) → relay
// pairing path end-to-end: it stands up a real in-process TS RelayServer + a
// real (Bun) `tp` daemon under an ISOLATED XDG tree, runs the compiled Rust
// `$TP_RUST_BIN pair new --relay <url>`, parses the `tp://p?d=…` URL the Rust
// CLI prints, drives a SYNTHETIC frontend (the same ECDH kx a real phone does,
// lifted from apps/cli/src/multi-frontend.test.ts:72-103), and asserts the Rust
// process exits 0 with a `Paired …` line.
//
// Architecture invariants preserved: the Rust CLI talks ONLY to the daemon over
// IPC (it NEVER opens a relay WS) — the daemon self-registers and does the relay
// work. The synthetic frontend's WS connection simulates the PHONE, not the CLI.
//
// Result lines (greppable, on stdout):
//   RUST_PAIR_E2E_OK            — pass (process.exit 0)
//   RUST_PAIR_E2E_FAIL: <why>   — fail (process.exit 1)
//
// Usage: TP_RUST_BIN=rust/target/debug/tp bun run scripts/rust-pair-new-e2e.ts

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodePairingData,
  deriveKxKey,
  encrypt,
  generateKeyPair,
  parsePairingForFrontend,
  toBase64,
} from "@teleprompter/protocol";
import { spawn } from "bun";
import { getSocketPath } from "../packages/protocol/src/socket-path";
import { RelayServer } from "../packages/relay/src/relay-server";

const REPO_ROOT = join(import.meta.dir, "..");
const BUN_CLI = ["bun", "run", join(REPO_ROOT, "apps/cli/src/index.ts")];
// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-harness env var, not a turbo task dep
const RUST_BIN = process.env["TP_RUST_BIN"];

function log(msg: string): void {
  process.stderr.write(`[rust-pair-new-e2e] ${msg}\n`);
}

function pass(): never {
  process.stdout.write("RUST_PAIR_E2E_OK\n");
  process.exit(0);
}

function fail(why: string): never {
  process.stdout.write(`RUST_PAIR_E2E_FAIL: ${why}\n`);
  process.exit(1);
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
  fail(`daemon socket never appeared at ${socketPath} within ${timeoutMs}ms`);
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("ws error")), {
      once: true,
    });
  });
}

function waitMsg(
  ws: WebSocket,
  pred: (m: { t?: string }) => boolean,
  timeoutMs = 5_000,
): Promise<{ t?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for ws message")),
      timeoutMs,
    );
    const onMsg = (ev: MessageEvent): void => {
      let parsed: { t?: string };
      try {
        parsed = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (pred(parsed)) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMsg);
        resolve(parsed);
      }
    };
    ws.addEventListener("message", onMsg);
  });
}

async function main(): Promise<void> {
  if (!RUST_BIN) {
    fail("TP_RUST_BIN env var must point at the compiled Rust `tp` binary");
  }

  // 1. Isolated XDG tree — never collide with the dogfood daemon.
  const home = await mkdtemp(join(tmpdir(), "tp-rust-pair-e2e-"));
  const runtimeDir = join(home, "runtime");
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    XDG_RUNTIME_DIR: runtimeDir,
    XDG_DATA_HOME: join(home, "data"),
    XDG_CONFIG_HOME: join(home, "config"),
    LOG_LEVEL: "error",
    TP_NO_AUTO_INSTALL: "1",
    TP_NO_UPDATE_CHECK: "1",
  };
  // The daemon mkdir's its store; the runtime dir for the socket must exist 0700.
  const { mkdirSync } = await import("node:fs");
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const dataHome = env["XDG_DATA_HOME"];
  const configHome = env["XDG_CONFIG_HOME"];
  if (dataHome === undefined) throw new Error("XDG_DATA_HOME missing from env");
  if (configHome === undefined)
    throw new Error("XDG_CONFIG_HOME missing from env");
  mkdirSync(dataHome, { recursive: true });
  mkdirSync(configHome, { recursive: true });

  // 2. Real in-process relay on a free port.
  const relay = new RelayServer();
  const relayPort = relay.start(0);
  const relayUrl = `ws://localhost:${relayPort}`;
  log(`relay up on ${relayUrl}`);

  // 3. Real (Bun) `tp` daemon subprocess, isolated.
  const daemon = spawn({
    cmd: [...BUN_CLI, "daemon", "start"],
    env,
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  log(`daemon spawned (pid ${daemon.pid})`);

  let rustProc: ReturnType<typeof spawn> | undefined;
  let synthWs: WebSocket | undefined;
  const cleanup = async (): Promise<void> => {
    try {
      rustProc?.kill();
    } catch {
      /* gone */
    }
    try {
      synthWs?.close();
    } catch {
      /* gone */
    }
    try {
      daemon.kill();
    } catch {
      /* gone */
    }
    relay.stop();
    await rm(home, { recursive: true, force: true }).catch(() => {});
  };

  try {
    // Resolve the daemon socket UNDER the isolated env (same derivation the
    // Rust binary uses since it inherits XDG_RUNTIME_DIR).
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: temporarily overriding XDG_RUNTIME_DIR for socket path resolution
    const prevRuntime = process.env["XDG_RUNTIME_DIR"];
    process.env["XDG_RUNTIME_DIR"] = runtimeDir;
    const socketPath = getSocketPath();
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: restoring XDG_RUNTIME_DIR to prior value after socket-path probe
    if (prevRuntime === undefined) delete process.env["XDG_RUNTIME_DIR"];
    else process.env["XDG_RUNTIME_DIR"] = prevRuntime;
    await waitForSocket(socketPath);
    log(`daemon socket ready at ${socketPath}`);

    // 4. Run the RUST `tp pair new --relay <url>` against the isolated daemon.
    //    stdin is ignored (non-TTY → the canCopy path is false, deterministic).
    rustProc = spawn({
      cmd: [RUST_BIN, "pair", "new", "--relay", relayUrl],
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    log(`rust pair new spawned (pid ${rustProc.pid})`);

    // 5. Stream the Rust stdout; capture the first `tp://p?d=…` line.
    let stdoutBuf = "";
    let urlResolve: (url: string) => void;
    let urlReject: (e: Error) => void;
    const urlPromise = new Promise<string>((res, rej) => {
      urlResolve = res;
      urlReject = rej;
    });
    const urlTimer = setTimeout(
      () => urlReject(new Error("never saw a tp:// URL within 5s")),
      5_000,
    );

    const reader = rustProc.stdout.getReader();
    const decoder = new TextDecoder();
    let urlSeen = false;
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        stdoutBuf += decoder.decode(value, { stream: true });
        if (!urlSeen) {
          for (const line of stdoutBuf.split("\n")) {
            if (line.startsWith("tp://p?d=")) {
              urlSeen = true;
              clearTimeout(urlTimer);
              urlResolve(line.trim());
              break;
            }
          }
        }
      }
    })();

    const url = await urlPromise;
    log(`rust printed pairing URL: ${url.slice(0, 32)}…`);

    // 6. Drive the synthetic frontend (genuine ECDH kx — phone simulation).
    const data = decodePairingData(url);
    const parsed = await parsePairingForFrontend(data);
    const { relayUrl: bundleRelayUrl, daemonId, relayToken } = parsed;
    const frontendKp = await generateKeyPair();
    const kxKey = await deriveKxKey(parsed.pairingSecret);
    const frontendId = "rust-e2e-frontend";

    synthWs = new WebSocket(bundleRelayUrl);
    await waitOpen(synthWs);
    synthWs.send(
      JSON.stringify({
        t: "relay.auth",
        v: 2,
        role: "frontend",
        daemonId,
        token: relayToken,
        frontendId,
      }),
    );
    await waitMsg(synthWs, (m) => m.t === "relay.auth.ok");
    log("synthetic frontend authed");

    const kxPayload = JSON.stringify({
      pk: await toBase64(frontendKp.publicKey),
      frontendId,
      role: "frontend",
    });
    synthWs.send(
      JSON.stringify({
        t: "relay.kx",
        ct: await encrypt(new TextEncoder().encode(kxPayload), kxKey),
        role: "frontend",
      }),
    );
    log("synthetic frontend sent kx → daemon should emit pair.completed");

    // 7. Await the Rust process exit (it blocks until pair.completed).
    const exitCode = await Promise.race([
      rustProc.exited,
      new Promise<number>((_, rej) =>
        setTimeout(
          () => rej(new Error("rust pair new did not exit within 10s")),
          10_000,
        ),
      ),
    ]);

    // Drain any remaining stdout.
    await Bun.sleep(50);

    if (exitCode !== 0) {
      const stderr = await new Response(rustProc.stderr).text().catch(() => "");
      fail(
        `rust pair new exited ${exitCode} (expected 0)\nstdout:\n${stdoutBuf}\nstderr:\n${stderr}`,
      );
    }
    if (!/^✓?.*Paired /m.test(stdoutBuf) && !stdoutBuf.includes("Paired ")) {
      fail(`rust stdout missing "Paired " line\nstdout:\n${stdoutBuf}`);
    }
    // Contract lines the iOS scanner / users rely on.
    for (const needle of ["Daemon ID:", "Relay:", "tp://p?d="]) {
      if (!stdoutBuf.includes(needle)) {
        fail(
          `rust stdout missing contract line "${needle}"\nstdout:\n${stdoutBuf}`,
        );
      }
    }

    log("rust pair new exited 0 with Paired line + contract lines present");
    await cleanup();
    pass();
  } catch (err) {
    await cleanup();
    fail(err instanceof Error ? err.message : String(err));
  }
}

void main();
