import { join } from "path";
import { mkdirSync } from "fs";
import { homedir } from "os";

export function getVaultDir(): string {
  const dataHome =
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const vaultDir = join(dataHome, "teleprompter", "vault");
  mkdirSync(join(vaultDir, "sessions"), { recursive: true });
  return vaultDir;
}
