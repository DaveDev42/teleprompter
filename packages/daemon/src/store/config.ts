import { join } from "path";
import { mkdirSync } from "fs";
import { homedir } from "os";

export function getStoreDir(): string {
  const dataHome =
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const storeDir = join(dataHome, "teleprompter", "vault");
  mkdirSync(join(storeDir, "sessions"), { recursive: true });
  return storeDir;
}
