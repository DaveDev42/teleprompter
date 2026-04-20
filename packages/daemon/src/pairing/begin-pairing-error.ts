import type { IpcPairBeginErrReason } from "@teleprompter/protocol";

export class BeginPairingError extends Error {
  constructor(
    public readonly reason: IpcPairBeginErrReason,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = "BeginPairingError";
  }
}
