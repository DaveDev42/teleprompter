import type { IpcMessage } from "@teleprompter/protocol";
import { connectIpcAsClient } from "./ipc-client";

/**
 * Default timeout for a single CLI→daemon IPC request-reply round-trip.
 *
 * 30 s is generous enough for any single-shot daemon op (SQLite write, relay
 * control frame, etc.) while ensuring `tp pair delete` / `tp session delete`
 * never hang forever if the daemon accepts the connection but stalls.
 */
export const DAEMON_OP_TIMEOUT_MS = 30_000;

/**
 * Send one IPC message to the daemon and await a single matching reply.
 *
 * The function encapsulates the full connect → send → timeout → onMessage
 * filter → onClose guard → finally-close pattern that was previously
 * duplicated across `pair.ts`, `session.ts`, and `session-cleanup.tsx`.
 *
 * @param socketPath  Unix domain socket path returned by `getSocketPath()`.
 * @param msg         The `IpcMessage` to send.
 * @param isExpected  Type-guard that returns `true` for the reply types the
 *                    caller cares about; all other inbound messages are
 *                    silently ignored (they are rare race artifacts like an
 *                    `ack` from a concurrent session).
 * @param timeoutMs   How long to wait for a matching reply before rejecting.
 *                    Defaults to {@link DAEMON_OP_TIMEOUT_MS}.
 */
export async function requestDaemonOp<R extends IpcMessage>(
  socketPath: string,
  msg: IpcMessage,
  isExpected: (m: IpcMessage) => m is R,
  timeoutMs: number = DAEMON_OP_TIMEOUT_MS,
): Promise<R> {
  const ipc = await connectIpcAsClient(socketPath);
  try {
    return await new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Daemon did not reply within ${timeoutMs / 1000}s; try 'tp daemon status' or restart the daemon`,
          ),
        );
      }, timeoutMs);
      const done = (settle: () => void): void => {
        clearTimeout(timer);
        settle();
      };
      ipc.onMessage((r) => {
        if (isExpected(r)) done(() => resolve(r));
      });
      ipc.onClose(() =>
        done(() => reject(new Error("Daemon disconnected before replying"))),
      );
      ipc.send(msg);
    });
  } finally {
    try {
      ipc.close();
    } catch {
      /* best effort */
    }
  }
}
