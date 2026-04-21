import { connect as netConnect, type Socket } from "node:net";
import {
  createLogger,
  encodeFrame,
  FrameDecoder,
  QueuedWriter,
} from "@teleprompter/protocol";
import type { IpcClient } from "./ipc-client";

const log = createLogger("IpcClient:Windows");

/**
 * Windows Named Pipe client for the CLI → daemon `tp pair new` flow.
 *
 * Mirrors `packages/runner/src/ipc/client-windows.ts` (`connectWindows`),
 * which already solves the same problem for the Runner → Daemon path:
 *
 *   1. Try `Bun.connect({ unix: path })` first — recent Bun builds accept
 *      Windows Named Pipe paths through the same `unix` option.
 *   2. Fall back to `node:net` `createConnection(path)` if Bun's native pipe
 *      client rejects the path.
 *   3. Wire up `FrameDecoder` for incoming data, `encodeFrame` for outgoing,
 *      and surface `close` events through the `IpcClient.onClose` handlers.
 *
 * We intentionally do NOT import from `packages/runner` — the CLI and runner
 * are separate entry points and must not share runtime state. The shape of
 * `connectWindows` is copied here and adapted to the `IpcClient` interface
 * used by `connectIpcAsClient` on POSIX.
 *
 * Reference: `packages/runner/src/ipc/client-windows.ts`.
 */
export async function connectWindowsIpc(path: string): Promise<IpcClient> {
  const messageHandlers: Array<(m: unknown) => void> = [];
  const closeHandlers: Array<() => void> = [];
  let closedFired = false;
  const fireClose = (): void => {
    if (closedFired) return;
    closedFired = true;
    for (const h of closeHandlers) {
      try {
        h();
      } catch {
        /* handler errors must not block the rest */
      }
    }
  };
  const dispatch = (msg: unknown): void => {
    for (const h of messageHandlers) {
      try {
        h(msg);
      } catch {
        /* handler errors must not block the rest */
      }
    }
  };

  // Try Bun.connect first — recent Bun builds accept Windows Named Pipe paths.
  try {
    const writer = new QueuedWriter();
    const decoder = new FrameDecoder();

    const socket = await Bun.connect({
      unix: path,
      socket: {
        data(_socket, data) {
          const messages = decoder.decode(new Uint8Array(data));
          for (const msg of messages) dispatch(msg);
        },
        drain(sock) {
          writer.drain(sock);
        },
        error(_socket, err) {
          log.error("socket error:", err.message);
          fireClose();
        },
        close() {
          log.info("disconnected");
          fireClose();
        },
      },
    });

    log.info(`connected to ${path} (bun native pipe)`);
    return {
      send(msg: unknown) {
        const frame = encodeFrame(msg);
        writer.write(socket, frame);
      },
      onMessage(h) {
        messageHandlers.push(h);
      },
      onClose(h) {
        closeHandlers.push(h);
      },
      close() {
        try {
          socket.end();
        } catch {
          /* best effort */
        }
      },
    };
  } catch {
    log.info("Bun named pipe connect failed, falling back to node:net");
  }

  // Fallback: node:net createConnection accepts a Named Pipe path directly.
  return new Promise<IpcClient>((resolve, reject) => {
    const decoder = new FrameDecoder();
    let connected = false;
    const socket: Socket = netConnect(path, () => {
      connected = true;
      log.info(`connected to ${path} (node:net fallback)`);
      resolve({
        send(msg: unknown) {
          const frame = encodeFrame(msg);
          socket.write(Buffer.from(frame));
        },
        onMessage(h) {
          messageHandlers.push(h);
        },
        onClose(h) {
          closeHandlers.push(h);
        },
        close() {
          try {
            socket.end();
          } catch {
            /* best effort */
          }
        },
      });
    });

    socket.on("data", (data: Buffer) => {
      const messages = decoder.decode(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      );
      for (const msg of messages) dispatch(msg);
    });

    socket.on("error", (err) => {
      log.error("socket error:", err.message);
      if (!connected) {
        // Connect-time failure — surface as a rejection so callers can
        // distinguish "never connected" from "disconnected after connect".
        try {
          socket.destroy();
        } catch {
          /* best effort */
        }
        reject(err);
        return;
      }
      // Post-connect error — treat as a close. Callers that registered
      // `onClose` will be notified; further sends will no-op once the socket
      // is destroyed.
      try {
        socket.destroy();
      } catch {
        /* best effort */
      }
      fireClose();
    });

    socket.on("close", () => {
      log.info("disconnected");
      fireClose();
    });
  });
}
