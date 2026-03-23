import { spawn } from "child_process";
import { resolveRunnerCommand } from "../spawn";

/**
 * Ensure daemon is running. If not, start it in the background.
 * Returns when the daemon WS is reachable.
 */
export async function ensureDaemon(port = 7080): Promise<boolean> {
  // Check if daemon is already running
  if (await isDaemonRunning(port)) return true;

  console.log("[tp] Daemon not running. Starting in background...");

  const args = [
    "run", "apps/cli/src/index.ts",
    "daemon", "start", "--ws-port", String(port),
  ];

  const proc = spawn("bun", args, {
    stdio: "ignore",
    detached: true,
    env: { ...process.env, LOG_LEVEL: "error" },
  });
  proc.unref();

  // Wait for daemon to become reachable
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isDaemonRunning(port)) {
      console.log(`[tp] Daemon started (pid=${proc.pid}, port=${port})`);
      return true;
    }
  }

  console.error("[tp] Failed to start daemon.");
  return false;
}

async function isDaemonRunning(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const timer = setTimeout(() => {
      ws.close();
      resolve(false);
    }, 1500);

    ws.onopen = () => {
      clearTimeout(timer);
      ws.close();
      resolve(true);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
  });
}
