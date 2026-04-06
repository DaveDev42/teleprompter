import { mkdirSync } from "fs";
import { join } from "path";

export function getWindowsSocketPath(username?: string): string {
  const user = username ?? process.env.USERNAME ?? "default";
  return `\\\\.\\pipe\\teleprompter-${user}-daemon`;
}

export function getSocketPath(): string {
  if (process.platform === "win32") {
    return getWindowsSocketPath();
  }
  const runtimeDir =
    process.env.XDG_RUNTIME_DIR ??
    join("/tmp", `teleprompter-${process.getuid?.()}`);
  mkdirSync(runtimeDir, { recursive: true });
  return join(runtimeDir, "daemon.sock");
}
