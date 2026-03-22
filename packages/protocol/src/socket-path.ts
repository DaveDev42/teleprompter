import { join } from "path";
import { mkdirSync } from "fs";

export function getSocketPath(): string {
  const runtimeDir =
    process.env.XDG_RUNTIME_DIR ??
    join("/tmp", `teleprompter-${process.getuid!()}`);
  mkdirSync(runtimeDir, { recursive: true });
  return join(runtimeDir, "daemon.sock");
}
