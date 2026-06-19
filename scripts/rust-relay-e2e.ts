// scripts/rust-relay-e2e.ts — ADR-0003 Stage 1 Step 8a LOCAL GATE.
//
// Proves a REAL `tp` daemon can pair to a LOCALLY-RUN RUST relay binary and that
// the genuine daemon→relay→app auth pipeline completes against it. This is the
// safe, fully-local prerequisite to the production cutover (8b deploy + 8c live
// flip come AFTER this). It touches NOTHING in production: no relay.tpmt.dev, no
// deploy pipeline, no real secret, and NOT the user's dogfood daemon.
//
// What it does:
//   1. cargo build --release --bin tp-relay (rustup-shim-safe PATH).
//   2. Run the Rust relay binary on a FREE loopback port with an EPHEMERAL
//      TP_RELAY_RESUME_SECRET (test-only; never a real secret).
//   3. Poll the relay's /health until it reports {"status":"ok"}.
//   4. Spawn scripts/real-daemon-pair.ts --relay-url ws://127.0.0.1:PORT, which
//      stands up a FULLY ISOLATED tp daemon (own mktemp XDG/HOME) and pairs it to
//      the Rust relay. Capture the emitted REAL_PAIR_URL deep link.
//   5. Assert the daemon REGISTERED with the Rust relay: GET /health shows
//      daemons>=1 AND /metrics shows relay_daemons_online>=1.
//   6. Run a frontend-role auth probe: derive the relayToken from the pairing
//      deep link (parsePairingForFrontend), open a raw WS, send relay.auth with
//      role=frontend, and assert relay.auth.ok comes back — the genuine
//      daemon→relay→app auth pipeline against the RUST relay.
//   7. Tear everything down (SIGTERM the pair holder, SIGTERM the relay), leaving
//      no orphan processes. The isolated daemon's store lives under /tmp and is
//      removed by real-daemon-pair.ts's harness env.
//
// HONEST SCOPE: daemon→relay REGISTER + frontend relay.auth → relay.auth.ok.
// (These map to the smoke harness's TP_*_OK relay-auth path, but this gate does
// NOT reuse the M0–M5 marker numbering — it asserts only register + frontend
// auth.) Full kx / session frames / input need a spawned claude session and are
// OUT of 8a scope — covered by the 8-marker loopback smoke elsewhere.
//
// Architecture invariants hold: app→relay only, daemon outbound-WS only (the real
// daemon self-registers via relay.register), relay ciphertext-only.

import { dirname, join } from "node:path";
import { spawn } from "bun";

import {
  decodePairingData,
  parsePairingForFrontend,
} from "../packages/protocol/src/pairing";

const REPO_ROOT = join(import.meta.dir, "..");
const RUST_DIR = join(REPO_ROOT, "rust");
const PAIR_SCRIPT = join(REPO_ROOT, "scripts/real-daemon-pair.ts");

function log(msg: string): void {
  process.stderr.write(`[rust-relay-e2e] ${msg}\n`);
}

function die(msg: string): never {
  log(`FAIL: ${msg}`);
  process.exit(1);
}

// rustup ships a `cargo` shim that mis-parses `--workspace`; prepend the real
// toolchain bin dir so `cargo` resolves to the toolchain binary.
async function cargoBinDir(): Promise<string> {
  const which = spawn(["rustup", "which", "cargo"], { stdout: "pipe" });
  const out = (await new Response(which.stdout).text()).trim();
  await which.exited;
  if (!out) die("`rustup which cargo` produced no path");
  return dirname(out);
}

async function buildRelay(cargoBin: string): Promise<string> {
  log("building tp-relay binary (cargo build --release --bin tp-relay)…");
  const build = spawn(["cargo", "build", "--release", "--bin", "tp-relay"], {
    cwd: RUST_DIR,
    env: { ...process.env, PATH: `${cargoBin}:${process.env["PATH"] ?? ""}` },
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await build.exited;
  if (code !== 0) die(`cargo build exited ${code}`);
  const bin = join(RUST_DIR, "target/release/tp-relay");
  return bin;
}

// Ask the OS for a free TCP port by binding :0, then immediately closing.
async function freePort(): Promise<number> {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open() {}, close() {}, error() {} },
  });
  const port = server.port;
  server.stop();
  return port;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

// Poll /health until status=ok (returns true) or the relay process exits / the
// timeout elapses (returns false so the caller can retry on a fresh port).
async function healthReady(
  base: string,
  proc: ReturnType<typeof spawn>,
  timeoutMs = 8_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return false; // relay died (e.g. EADDRINUSE)
    try {
      const body = (await getJson(`${base}/health`)) as { status?: string };
      if (body.status === "ok") return true;
    } catch {
      /* relay not listening yet */
    }
    await Bun.sleep(150);
  }
  return false;
}

// Poll /health until daemons>=1 (the real daemon's relay.register landed).
async function waitForDaemonRegistered(
  base: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    try {
      const body = (await getJson(`${base}/health`)) as { daemons?: number };
      last = body.daemons ?? -1;
      if (last >= 1) return;
    } catch {
      /* transient */
    }
    await Bun.sleep(150);
  }
  die(
    `relay /health never showed daemons>=1 (last=${last}) within ${timeoutMs}ms`,
  );
}

function assertMetricsDaemonOnline(metrics: string): void {
  const m = metrics.match(/^relay_daemons_online (\d+)$/m);
  if (!m || Number(m[1]) < 1) {
    die(`relay /metrics relay_daemons_online not >=1:\n${metrics}`);
  }
  log(`/metrics relay_daemons_online=${m[1]} OK`);
}

// Run a real frontend-role auth probe against the Rust relay. Returns when
// relay.auth.ok arrives (or dies on auth.err / timeout / close).
async function frontendAuthProbe(
  wsUrl: string,
  daemonId: string,
  relayToken: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("frontend-auth probe timed out (no relay.auth.ok)"));
    }, 10_000);

    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          t: "relay.auth",
          v: 2,
          role: "frontend",
          daemonId,
          token: relayToken,
          frontendId: "e2e-probe",
        }),
      );
    });
    let settled = false;
    ws.addEventListener("message", (ev) => {
      let msg: { t?: string; e?: string };
      try {
        msg = JSON.parse(String(ev.data)) as { t?: string; e?: string };
      } catch {
        return;
      }
      log(`probe ← ${msg.t ?? "?"}${msg.e ? ` (${msg.e})` : ""}`);
      if (msg.t === "relay.auth.ok") {
        settled = true;
        clearTimeout(timer);
        ws.close();
        resolve();
      } else if (msg.t === "relay.auth.err") {
        settled = true;
        clearTimeout(timer);
        ws.close();
        reject(new Error(`relay.auth.err: ${msg.e ?? "?"}`));
      }
    });
    ws.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("frontend-auth probe WS error"));
    });
    ws.addEventListener("close", (ev) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `frontend-auth probe WS closed before relay.auth.ok (code=${(ev as CloseEvent).code})`,
        ),
      );
    });
  });
}

async function main(): Promise<void> {
  const cargoBin = await cargoBinDir();
  const bin = await buildRelay(cargoBin);

  // Ephemeral test-only resume secret — NOT a production secret.
  const resumeSecret = `e2e-${crypto.randomUUID()}${crypto.randomUUID()}`;

  // freePort() has an unavoidable TOCTOU window (close → bind). Retry a few
  // times on a fresh port if the relay dies before /health is ready (almost
  // always "Address already in use" from a racing binder).
  let relay: ReturnType<typeof spawn> | undefined;
  let port = 0;
  for (let attempt = 1; attempt <= 5 && !relay; attempt++) {
    const candidate = await freePort();
    log(`starting Rust relay on port ${candidate} (attempt ${attempt})…`);
    const proc = spawn([bin, "--port", String(candidate)], {
      env: {
        ...process.env,
        TP_RELAY_RESUME_SECRET: resumeSecret,
        // Secrets hygiene: the test relay never exercises the push path (M0/M2
        // scope), so do NOT let it inherit a real APNs push-seal key that might
        // be set in the dev shell. Blank them explicitly for the ephemeral proc.
        TP_RELAY_PUSH_SEAL_SECRET: "",
        TP_RELAY_PUSH_SEAL_SECRET_PREV: "",
      },
      stdout: "inherit",
      stderr: "inherit",
    });
    const ok = await healthReady(`http://127.0.0.1:${candidate}`, proc);
    if (ok) {
      relay = proc;
      port = candidate;
    } else {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
  if (!relay) die("Rust relay never became healthy (port race exhausted)");
  const httpBase = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}`;

  let pairProc: ReturnType<typeof spawn> | undefined;
  let e2eDir: string | undefined;
  const cleanup = (): void => {
    try {
      pairProc?.kill("SIGTERM");
    } catch {
      /* gone */
    }
    try {
      relay.kill("SIGTERM");
    } catch {
      /* gone */
    }
    // Remove the isolated daemon tree even on a mid-run failure (the tree lives
    // under /tmp; rmSync is best-effort). Guards the dogfood store: it is NOT
    // here — different XDG paths entirely.
    if (e2eDir) {
      try {
        Bun.spawnSync(["rm", "-rf", e2eDir]);
      } catch {
        /* best-effort */
      }
    }
  };
  process.on("exit", cleanup);
  // SIGINT (Ctrl-C) and SIGTERM (e.g. a CI runner killing the gate) both bypass
  // the `exit` event in Bun/Node, so tear down the relay + isolated tree on each
  // before exiting — otherwise the Rust relay + pair holder orphan.
  const onSignal = (): void => {
    cleanup();
    process.exit(1);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  log("relay /health status=ok");

  // Spawn the isolated real daemon + pair it to the Rust relay. The harness env
  // (XDG_*/HOME under mktemp) is set HERE so the daemon's socket/store never
  // collide with the dogfood daemon.
  e2eDir = (
    await new Response(
      spawn(["mktemp", "-d", "-t", "tp-rust-relay-e2e.XXXXXX"], {
        stdout: "pipe",
      }).stdout,
    ).text()
  ).trim();
  log(`isolated daemon tree: ${e2eDir}`);

  const pairOut: string[] = [];
  pairProc = spawn(["bun", "run", PAIR_SCRIPT, "--relay-url", wsUrl], {
    env: {
      ...process.env,
      XDG_RUNTIME_DIR: join(e2eDir, "run"),
      XDG_DATA_HOME: join(e2eDir, "data"),
      XDG_CONFIG_HOME: join(e2eDir, "cfg"),
      HOME: join(e2eDir, "home"),
      LOG_LEVEL: "error",
      TP_NO_AUTO_INSTALL: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Stream the pair holder's stderr through to ours (diagnostics) and collect
  // its stdout for the REAL_PAIR_URL line.
  void (async () => {
    const reader = pairProc.stderr as ReadableStream<Uint8Array>;
    for await (const chunk of reader) {
      process.stderr.write(chunk);
    }
  })();

  // Read REAL_PAIR_URL from stdout.
  let pairUrl = "";
  const stdoutReader = (
    pairProc.stdout as ReadableStream<Uint8Array>
  ).getReader();
  const decoder = new TextDecoder();
  const urlDeadline = Date.now() + 25_000;
  let buf = "";
  while (Date.now() < urlDeadline && !pairUrl) {
    const { value, done } = await stdoutReader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const m = buf.match(/REAL_PAIR_URL=(tp:\/\/\S+)/);
    if (m?.[1]) pairUrl = m[1];
    pairOut.push(buf);
  }
  if (!pairUrl) die("real-daemon-pair never emitted REAL_PAIR_URL");
  log("captured REAL_PAIR_URL from isolated daemon");

  // assert the real daemon REGISTERED with the Rust relay.
  await waitForDaemonRegistered(httpBase);
  const health = (await getJson(`${httpBase}/health`)) as { daemons?: number };
  log(`/health daemons=${health.daemons} OK (real daemon registered)`);
  assertMetricsDaemonOnline(await getText(`${httpBase}/metrics`));

  // frontend-role auth probe against the Rust relay.
  const data = decodePairingData(pairUrl);
  const front = await parsePairingForFrontend(data);
  log(
    `running frontend-auth probe (daemonId=${front.daemonId.slice(0, 12)}…)…`,
  );
  await frontendAuthProbe(wsUrl, front.daemonId, front.relayToken).catch(
    (err: unknown) => die(err instanceof Error ? err.message : String(err)),
  );
  log("relay.auth.ok received — frontend auth pipeline OK against RUST relay");

  // Teardown (kills the pair holder + relay, removes the isolated tree).
  cleanup();

  log("");
  log("PASS — Step 8a local gate: real isolated tp daemon registered with the");
  log("       Rust relay binary, and a frontend-role relay.auth completed");
  log("       (relay.auth.ok). Scope: daemon register + frontend auth.");
  process.exit(0);
}

void main();
