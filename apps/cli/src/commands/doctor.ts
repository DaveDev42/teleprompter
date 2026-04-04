import { $ } from "bun";
import { existsSync } from "fs";
import { join } from "path";
import { green, yellow } from "../lib/colors";
import { verifyE2EECrypto } from "../lib/e2ee-verify";
import { spinner } from "../lib/spinner";
import { loadPairingData } from "./pair";

/**
 * tp doctor — diagnose the environment and connectivity.
 * Checks for required tools, permissions, configuration, relay, and E2EE.
 */
export async function doctorCommand(): Promise<void> {
  console.log("Teleprompter Doctor\n");

  let issues = 0;

  // --- Local environment checks ---

  // Bun version
  const bunVersion = Bun.version;
  check("Bun", bunVersion, true);

  // Node version
  try {
    const nodeVersion = (await $`node --version`.text()).trim();
    check("Node.js", nodeVersion, true);
  } catch {
    check("Node.js", "not found", false);
    issues++;
  }

  // pnpm
  try {
    const pnpmVersion = (await $`pnpm --version`.text()).trim();
    check("pnpm", pnpmVersion, true);
  } catch {
    check("pnpm", "not found", false);
    issues++;
  }

  // Claude CLI
  try {
    const claudeVersion = (await $`claude --version`.text()).trim();
    check("Claude CLI", claudeVersion, true);
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
    const gitVersion = (await $`git --version`.text()).trim();
    check("Git", gitVersion.replace("git version ", ""), true);
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
  const pairing = await loadPairingData();
  const pairingPath = join(
    process.env.HOME ?? "/tmp",
    ".config",
    "teleprompter",
    "pairing.json",
  );
  if (pairing) {
    check("Pairing data", pairingPath, true);
  } else {
    check("Pairing data", "not configured → run: tp pair", false);
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
    const relayOk = await checkRelayConnectivity(pairing);
    if (!relayOk) issues++;
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
 * Ping relay and report status.
 * Returns true if relay is reachable.
 */
async function checkRelayConnectivity(pairing: {
  relayUrl: string;
  relayToken: string;
  daemonId: string;
}): Promise<boolean> {
  const PING_COUNT = 3;
  const stop = spinner(`Pinging ${pairing.relayUrl}...`);

  try {
    const ws = new WebSocket(pairing.relayUrl);

    const result = await new Promise<number[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("timeout"));
      }, 10000);

      let pongResolve: ((rtt: number) => void) | null = null;

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            t: "relay.auth",
            role: "daemon",
            daemonId: pairing.daemonId,
            token: pairing.relayToken,
            v: 1,
          }),
        );
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("connection failed"));
      };

      ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(
            typeof event.data === "string"
              ? event.data
              : new TextDecoder().decode(event.data as ArrayBuffer),
          );

          if (msg.t === "relay.auth.ok") {
            // Run pings
            const rtts: number[] = [];
            for (let i = 0; i < PING_COUNT; i++) {
              const rtt = await new Promise<number>((res) => {
                let tid: ReturnType<typeof setTimeout>;
                pongResolve = (rtt: number) => {
                  clearTimeout(tid);
                  res(rtt);
                };
                tid = setTimeout(() => {
                  pongResolve = null;
                  res(-1);
                }, 5000);
                ws.send(JSON.stringify({ t: "relay.ping", ts: Date.now() }));
              });
              if (rtt >= 0) rtts.push(rtt);
              if (i < PING_COUNT - 1) {
                await new Promise((r) => setTimeout(r, 300));
              }
            }
            clearTimeout(timeout);
            ws.close();
            resolve(rtts);
          } else if (msg.t === "relay.pong" && msg.ts && pongResolve) {
            pongResolve(Date.now() - msg.ts);
            pongResolve = null;
          } else if (msg.t === "relay.auth.err") {
            clearTimeout(timeout);
            ws.close();
            reject(new Error(`auth failed: ${msg.e}`));
          }
        } catch {}
      };
    });

    if (result.length > 0) {
      const sorted = [...result].sort((a, b) => a - b);
      const min = sorted[0];
      const max = sorted[sorted.length - 1];
      const avg = Math.round(result.reduce((a, b) => a + b, 0) / result.length);
      stop();
      check(
        "Relay",
        `${pairing.relayUrl} (min=${min}ms avg=${avg}ms max=${max}ms)`,
        true,
      );
      return true;
    }
    stop();
    check("Relay", `${pairing.relayUrl} (all pings timed out)`, false);
    return false;
  } catch (err) {
    stop();
    const msg = err instanceof Error ? err.message : String(err);
    check("Relay", `${pairing.relayUrl} (${msg})`, false);
    return false;
  }
}
