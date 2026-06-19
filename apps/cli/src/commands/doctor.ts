import { Store } from "@teleprompter/daemon";
import type { IpcDoctorProbeOk } from "@teleprompter/protocol";
import { getSocketPath } from "@teleprompter/protocol";
import { existsSync } from "fs";
import { join } from "path";
import { green, yellow } from "../lib/colors";
import { verifyE2EECrypto } from "../lib/e2ee-verify";
import { isDaemonRunning } from "../lib/ensure-daemon";
import { connectIpcAsClient } from "../lib/ipc-client";
import { spinner } from "../lib/spinner";

/**
 * tp doctor — diagnose the environment and connectivity.
 * Checks for required tools, permissions, configuration, relay, and E2EE,
 * then forwards to `claude doctor` so the user sees Claude Code's own
 * diagnostics in the same run.
 *
 * argv is ignored — past versions accepted `--claude` to opt in to the
 * claude-doctor pass, but running both is now the default.
 *
 * env overrides process.env for subprocess invocations (tests inject PATH).
 */
export async function doctorCommand(
  _argv: string[] = [],
  env?: Record<string, string>,
): Promise<void> {
  const spawnEnv = env ?? (process.env as Record<string, string>);
  console.log("Teleprompter Doctor\n");

  let issues = 0;

  // --- Local environment checks ---

  // Bun version
  const bunVersion = Bun.version;
  check("Bun", bunVersion, true);

  // Node version
  try {
    const nodeResult = Bun.spawnSync(["node", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      env: spawnEnv,
    });
    if (nodeResult.exitCode !== 0) throw new Error("node exited non-zero");
    const nodeVersion = new TextDecoder().decode(nodeResult.stdout).trim();
    check("Node.js", nodeVersion, true);
  } catch {
    check("Node.js", "not found", false);
    issues++;
  }

  // pnpm
  try {
    const pnpmResult = Bun.spawnSync(["pnpm", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      env: spawnEnv,
    });
    if (pnpmResult.exitCode !== 0) throw new Error("pnpm exited non-zero");
    const pnpmVersion = new TextDecoder().decode(pnpmResult.stdout).trim();
    check("pnpm", pnpmVersion, true);
  } catch {
    check("pnpm", "not found", false);
    issues++;
  }

  // Claude CLI — result is reused below to gate `claude doctor` invocation
  let claudeFound = false;
  try {
    const claudeResult = Bun.spawnSync(["claude", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      env: spawnEnv,
    });
    if (claudeResult.exitCode !== 0) throw new Error("claude exited non-zero");
    const claudeVersion = new TextDecoder().decode(claudeResult.stdout).trim();
    check("Claude CLI", claudeVersion, true);
    claudeFound = true;
  } catch {
    check(
      "Claude CLI",
      "not found → install: https://docs.anthropic.com/en/docs/claude-code",
      false,
    );
    issues++;
  }

  // Git
  try {
    const gitResult = Bun.spawnSync(["git", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      env: spawnEnv,
    });
    if (gitResult.exitCode !== 0) throw new Error("git exited non-zero");
    const gitVersion = new TextDecoder()
      .decode(gitResult.stdout)
      .trim()
      .replace("git version ", "");
    check("Git", gitVersion, true);
  } catch {
    check("Git", "not found", false);
    issues++;
  }

  // Daemon socket
  const socketPath = join(
    process.env.XDG_RUNTIME_DIR ?? `/tmp/teleprompter-${process.getuid?.()}`,
    "daemon.sock",
  );
  if (existsSync(socketPath)) {
    check("Daemon socket", socketPath, true);
  } else {
    check("Daemon socket", "not running", false);
  }

  // Pairing data
  const store = new Store();
  let pairings: ReturnType<Store["listPairings"]>;
  try {
    pairings = store.listPairings();
  } finally {
    store.close();
  }
  const pairing = pairings[0] ?? null;
  if (pairing) {
    check("Pairing data", `${pairings.length} pairing(s) in store`, true);
  } else {
    check("Pairing data", "no pairings → run: tp pair new", false);
  }

  // Vault directory
  const storeDir = join(
    process.env.XDG_DATA_HOME ??
      join(process.env.HOME ?? "/tmp", ".local", "share"),
    "teleprompter",
    "vault",
  );
  if (existsSync(storeDir)) {
    check("Vault", storeDir, true);
  } else {
    check("Vault", "not created yet (starts on first daemon run)", false);
  }

  // --- Relay connectivity (if paired) ---

  if (pairing?.relayUrl) {
    console.log("");
    const daemonRunning = await isDaemonRunning();
    if (daemonRunning) {
      // Delegate to the daemon's live RelayClient(s) via IPC to avoid opening a
      // second daemon-role WebSocket to the relay (which would hang or conflict).
      const relayOk = await checkRelayConnectivityViaIpc();
      if (!relayOk) issues++;
    } else {
      // The daemon is the sole relay WebSocket client (architecture invariant).
      // Without the daemon running, relay connectivity cannot be probed directly
      // from the CLI. Inform the user and let them start the daemon.
      check(
        "Relay",
        `daemon not running — relay connectivity is verified via the daemon; start it with \`tp daemon start\` or run any tp command`,
        false,
      );
      issues++;
    }
  }

  // --- E2EE self-test (if paired) ---

  if (pairing) {
    console.log("");
    console.log("E2EE self-test:");
    const passed = await verifyE2EECrypto((line) => console.log(line));
    if (passed) {
      check("E2EE", "all checks passed", true);
    } else {
      check("E2EE", "verification failed", false);
      issues++;
    }
  }

  // --- Claude doctor ---

  console.log("\n--- Claude Code Doctor ---\n");
  if (claudeFound) {
    const proc = Bun.spawn(["claude", "doctor"], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: spawnEnv,
    });
    await proc.exited;
  } else {
    console.log("  claude not found on PATH — skipping `claude doctor`.");
  }

  // --- Summary ---

  console.log("");
  if (issues === 0) {
    console.log(green("All checks passed!"));
  } else {
    console.log(yellow(`${issues} issue(s) found.`));
  }
}

function check(name: string, value: string, passed: boolean): void {
  const icon = passed ? `${green("✓")}` : `${yellow("!")}`;
  console.log(`  ${icon} ${name}: ${value}`);
}

/**
 * Delegate relay health check to the daemon's live RelayClient(s) via IPC.
 * Avoids opening a second daemon-role WebSocket (which hangs when daemon is
 * already holding the outbound connection). Returns true if all pairings
 * report as connected.
 */
async function checkRelayConnectivityViaIpc(): Promise<boolean> {
  const stop = spinner("Checking relay via daemon...");
  try {
    const socketPath = getSocketPath();
    const client = await connectIpcAsClient(socketPath);

    const result = await new Promise<IpcDoctorProbeOk | null>((resolve) => {
      let settled = false;
      const finish = (value: IpcDoctorProbeOk | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const timeout = setTimeout(() => {
        client.close();
        finish(null);
      }, 5000);

      client.onMessage((msg) => {
        if (msg.t === "doctor.probe.ok") {
          clearTimeout(timeout);
          // Resolve BEFORE close — Bun's sock.end() fires the close
          // handler synchronously, and that handler's finish(null) would
          // otherwise win the race against finish(msg).
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

    stop();

    if (!result) {
      check("Relay", "daemon did not respond to health probe", false);
      return false;
    }

    if (result.relays.length === 0) {
      check(
        "Relay",
        "no active relay connections (daemon has no pairings)",
        false,
      );
      return false;
    }

    let allOk = true;
    for (const relay of result.relays) {
      const status = relay.connected
        ? `connected (${relay.peerCount} peer${relay.peerCount !== 1 ? "s" : ""})`
        : "disconnected (relay unreachable or auth failed)";
      check(`Relay ${relay.relayUrl}`, status, relay.connected);
      if (!relay.connected) allOk = false;
    }
    return allOk;
  } catch (err) {
    stop();
    const msg = err instanceof Error ? err.message : String(err);
    check("Relay", `IPC probe failed (${msg})`, false);
    return false;
  }
}
