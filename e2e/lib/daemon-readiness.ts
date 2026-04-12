import { existsSync } from "fs";
import { join } from "path";

/**
 * Wait until the background daemon's IPC socket exists.
 * Replaces the legacy direct-WS readiness probe.
 *
 * Mirrors the path format produced by `getSocketPath()` in
 * @teleprompter/protocol (see packages/protocol/src/socket-path.ts).
 */
export async function waitForDaemonReady(maxWaitMs = 30000): Promise<boolean> {
  const socketPath = resolveSocketPath();
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (existsSync(socketPath)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function resolveSocketPath(): string {
  if (process.platform === "win32") {
    const user = process.env.USERNAME ?? "default";
    return `\\\\.\\pipe\\teleprompter-${user}-daemon`;
  }
  const runtimeDir =
    process.env.XDG_RUNTIME_DIR ??
    join("/tmp", `teleprompter-${process.getuid?.() ?? 501}`);
  return join(runtimeDir, "daemon.sock");
}
