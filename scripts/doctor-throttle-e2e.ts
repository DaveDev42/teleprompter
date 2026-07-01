/**
 * REAL end-to-end verification of the `tp doctor` throttled-pairing fix (#843).
 *
 * Unlike the bun:test coverage — which tests `computeReconnectPlan` (pure) and
 * mocks `isThrottled()` via a stub — this harness drives the WHOLE path with
 * real processes: it seeds a peerless (dead) saved pairing into an isolated
 * store, starts a REAL tp daemon subprocess whose startup reconnectSaved brings
 * that pairing up as a pooled RelayClient against a REAL in-process RelayServer,
 * then force-closes the relay (TCP-RST sim) so the daemon's RelayClient
 * reconnects with no peer ~3 times → enters the dead-pairing throttle
 * (isThrottled() === true, connected === false). It then sends a REAL
 * `doctor.probe` over the daemon's IPC socket and asserts the fix's wire
 * contract end to end:
 *
 *   - relays[0].throttled === true   (the fix carries this over the wire)
 *   - relays[0].connected === false  (throttled = backed off, not connected)
 *   - the CLI render branch shows the idle verdict, NOT "relay unreachable"
 *
 * Everything runs under mktemp XDG dirs — the dogfood daemon/store is never
 * touched. Run: bun run scripts/doctor-throttle-e2e.ts (exit 0 = PASS).
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Subprocess, spawn } from "bun";
import { connectIpcAsClient } from "../apps/cli/src/lib/ipc-client";
import { Store } from "../packages/daemon/src/store/store";
import { createPairingBundle } from "../packages/protocol/src/pairing";
import { getSocketPath } from "../packages/protocol/src/socket-path";
import type {
  IpcDoctorProbeOk,
  IpcMessage,
} from "../packages/protocol/src/types/ipc";
import { RelayServer } from "../packages/relay/src/relay-server";

const REPO = "/Users/dave/Projects/github.com/teleprompter";
const CLI = ["bun", "run", join(REPO, "apps/cli/src/index.ts")];

function log(msg: string): void {
  process.stderr.write(`[doctor-e2e] ${msg}\n`);
}

async function waitForSocket(path: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const c = await Bun.connect({
        unix: path,
        socket: {
          data() {},
          open(s) {
            s.end();
          },
        },
      });
      c.end();
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error(`socket ${path} did not appear in ${timeoutMs}ms`);
}

async function probeDoctor(
  socketPath: string,
): Promise<IpcDoctorProbeOk | null> {
  const client = await connectIpcAsClient(socketPath);
  return await new Promise<IpcDoctorProbeOk | null>((resolve) => {
    let settled = false;
    const finish = (v: IpcDoctorProbeOk | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const timeout = setTimeout(() => {
      client.close();
      finish(null);
    }, 5000);
    client.onMessage((msg: IpcMessage) => {
      if (msg.t === "doctor.probe.ok") {
        clearTimeout(timeout);
        finish(msg);
        client.close();
      }
    });
    client.onClose(() => {
      clearTimeout(timeout);
      finish(null);
    });
    client.send({ t: "doctor.probe" });
  });
}

/** Replicates doctor.ts checkRelayConnectivityViaIpc's exact render branch. */
function renderRelayStatus(relay: {
  connected: boolean;
  throttled?: boolean;
  peerCount: number;
}): { status: string; passed: boolean } {
  if (relay.connected) {
    return {
      status: `connected (${relay.peerCount} peer${relay.peerCount !== 1 ? "s" : ""})`,
      passed: true,
    };
  }
  if (relay.throttled) {
    return {
      status:
        "idle — no frontend connected yet (dead-pairing backoff; not an outage)",
      passed: true,
    };
  }
  return {
    status: "disconnected (relay unreachable or auth failed)",
    passed: false,
  };
}

async function main(): Promise<void> {
  // 1. Isolated XDG dirs (dogfood daemon/store untouched).
  const root = mkdtempSync(join(tmpdir(), "tp-doctor-e2e-"));
  const xdgRuntime = join(root, "run");
  const xdgData = join(root, "data");
  const xdgConfig = join(root, "config");
  const home = join(root, "home");
  for (const d of [xdgRuntime, xdgData, xdgConfig, home]) {
    mkdirSync(d, { recursive: true });
  }

  const childEnv = {
    ...process.env,
    XDG_RUNTIME_DIR: xdgRuntime,
    XDG_DATA_HOME: xdgData,
    XDG_CONFIG_HOME: xdgConfig,
    HOME: home,
    LOG_LEVEL: "error",
    TP_NO_AUTO_INSTALL: "1",
  } as Record<string, string>;

  // Point our OWN getSocketPath at the isolated runtime dir.
  process.env["XDG_RUNTIME_DIR"] = xdgRuntime;

  let relay: RelayServer | undefined;
  let daemon: Subprocess | undefined;
  let failed = false;

  const cleanup = () => {
    try {
      daemon?.kill();
    } catch {
      /* gone */
    }
    try {
      relay?.stop();
    } catch {
      /* gone */
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  };

  try {
    // 2. Real RelayServer.
    relay = new RelayServer();
    const relayPort = relay.start(0);
    const relayUrl = `ws://localhost:${relayPort}`;
    log(`relay up on ${relayUrl}`);

    // 3. Seed ONE peerless (dead) SAVED pairing into the isolated store BEFORE
    //    the daemon starts. On startup the daemon calls reconnectSavedRelays()
    //    (daemon.ts) → relayManager.reconnectSaved() → store.loadPairings() →
    //    addClient(), which puts a RelayClient into the pool getRelayHealth()
    //    iterates. No frontend ever joins → this is a genuine dead pairing, the
    //    exact production scenario (closed tab / old app / never-scanned QR).
    //    A pending pair.begin does NOT add a pooled client, so it must be saved.
    const bundle = await createPairingBundle(relayUrl, "daemon-peerless-test");
    const seedStore = new Store(join(xdgData, "teleprompter", "vault"));
    seedStore.savePairing({
      daemonId: "daemon-peerless-test",
      relayUrl,
      relayToken: bundle.relayToken,
      registrationProof: bundle.registrationProof,
      publicKey: bundle.keyPair.publicKey,
      secretKey: bundle.keyPair.secretKey,
      pairingSecret: bundle.pairingSecret,
    });
    seedStore.close();
    log("seeded peerless saved pairing daemon-peerless-test");

    // 4. Real daemon subprocess (isolated). Its startup reconnectSaved brings the
    //    seeded pairing up as a pooled RelayClient pointing at our relay.
    daemon = spawn({
      cmd: [...CLI, "daemon", "start"],
      env: childEnv,
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    log(`daemon spawned (pid ${daemon.pid})`);

    const socketPath = getSocketPath();
    await waitForSocket(socketPath);
    log(`daemon IPC socket at ${socketPath}`);

    // 5. Give the daemon's RelayClient time to register+auth (peer-less connect).
    await Bun.sleep(2000);
    const before = await probeDoctor(socketPath);
    log(`BEFORE relay kill: ${JSON.stringify(before?.relays)}`);

    // 6. Force-close the relay → daemon reconnects with no peer. 3 peerless reconnects
    //    (backoff 1s + 2s) push it past PEERLESS_RECONNECT_THRESHOLD=3 into the
    //    30-min throttle: isThrottled()=true, connected=false.
    //
    //    NOTE: Bun's graceful `server.stop()` keeps existing sockets alive, so
    //    the daemon's ws wouldn't see a close and would never reconnect. We
    //    force-close it (`server.stop(true)`) to simulate the real production
    //    TCP RST a relay process death sends — the exact trigger for a peerless
    //    reconnect storm. `.stop()` here is graceful and would NOT reproduce the
    //    bug; the force flag is load-bearing. Reach into the private Bun server
    //    handle since RelayServer only exposes the graceful variant.
    log(
      "force-closing relay (TCP RST sim) to induce reconnect storm → throttle",
    );
    const bunServer = (
      relay as unknown as { server: { stop(force?: boolean): void } | null }
    ).server;
    bunServer?.stop(true);
    relay.stop();
    relay = undefined;

    // onclose→schedule(count1,1s)→fail→schedule(count2,2s)→fail→
    // schedule(count3 → 30min throttle). ~1+2s of backoff + margin.
    await Bun.sleep(7000);

    // 7. REAL doctor.probe against the throttled daemon.
    const after = await probeDoctor(socketPath);
    log(`AFTER throttle: ${JSON.stringify(after?.relays)}`);

    if (!after || after.relays.length === 0) {
      throw new Error("doctor.probe returned no relays after throttle");
    }
    const r = after.relays[0];
    if (!r) throw new Error("no relay[0]");

    // 8. Assertions — the fix's wire contract end to end.
    const rendered = renderRelayStatus(r);
    log("");
    log("=== VERDICT ===");
    log(`  connected : ${r.connected}`);
    log(`  throttled : ${r.throttled}`);
    log(`  peerCount : ${r.peerCount}`);
    log(`  rendered  : "${rendered.status}"`);
    log(`  counted as issue? : ${!rendered.passed}`);
    log("");

    const checks: Array<[string, boolean]> = [
      ["throttled === true", r.throttled === true],
      ["connected === false", r.connected === false],
      [
        "render = idle message (not 'relay unreachable')",
        rendered.status.startsWith("idle —"),
      ],
      ["NOT counted as an issue (passed=true)", rendered.passed === true],
    ];
    let allPass = true;
    for (const [name, ok] of checks) {
      log(`  [${ok ? "PASS" : "FAIL"}] ${name}`);
      if (!ok) allPass = false;
    }
    log("");
    if (allPass) {
      log(
        "RESULT: PASS — throttled idle pairing reported as idle, not an outage.",
      );
    } else {
      log("RESULT: FAIL — see failing checks above.");
      failed = true;
    }
  } catch (err) {
    log(
      `ERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    failed = true;
  } finally {
    cleanup();
  }
  process.exit(failed ? 1 : 0);
}

void main();
