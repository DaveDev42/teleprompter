import type { IpcClient } from "./ipc-client";

export async function connectWindowsIpc(_path: string): Promise<IpcClient> {
  throw new Error("Windows IPC client not yet implemented for CLI pair flow");
}
