import {
  createLogger,
  encodeFrame,
  FrameDecoder,
  getSocketPath,
  type IpcAck,
  type IpcInput,
  type IpcMessage,
  type IpcResize,
  parseIpcMessage,
  QueuedWriter,
} from "@teleprompter/protocol";

const log = createLogger("IpcClient");

type IncomingMessage = IpcAck | IpcInput | IpcResize;
type MessageHandler = (msg: IncomingMessage) => void;
type CloseHandler = () => void;

/**
 * The only IPC messages the daemon sends back to a runner. Anything else on
 * this socket (a pair/session command reply, a malformed frame) is dropped —
 * the runner has no handler for it, and acting on an under-validated struct is
 * how a `Cannot read properties of undefined` reaches the PTY write path.
 */
const RUNNER_INBOUND: ReadonlySet<IncomingMessage["t"]> = new Set([
  "ack",
  "input",
  "resize",
]);

function isRunnerInbound(msg: IpcMessage): msg is IncomingMessage {
  return RUNNER_INBOUND.has(msg.t as IncomingMessage["t"]);
}

/** Discriminated union representing the socket state. */
type SocketState =
  | { connected: false }
  | { connected: true; socket: Awaited<ReturnType<typeof Bun.connect>> };

export class IpcClient {
  private state: SocketState = { connected: false };
  private writer: QueuedWriter;
  private decoder = new FrameDecoder();
  private onMessage: MessageHandler;
  private onClose: CloseHandler | undefined;

  constructor(
    onMessage: MessageHandler,
    onClose?: CloseHandler,
    /** Injected QueuedWriter — use in tests to control overflow behaviour. */
    writer?: QueuedWriter,
  ) {
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.writer = writer ?? new QueuedWriter();
  }

  async connect(socketPath?: string): Promise<void> {
    const path = socketPath ?? getSocketPath();

    const self = this;
    const socket = await Bun.connect({
      unix: path,
      socket: {
        data(_socket, data) {
          // FrameDecoder.decode() throws on a protocol-fatal frame (length
          // exceeding MAX_FRAME_SIZE, or a payload that fails JSON.parse) — the
          // codec is explicit that the caller must tear down the connection on
          // such a frame. Bun does NOT translate a throw out of this callback
          // into a socket `error`/`close`, so without this guard the socket
          // stays in `{ connected: true }` on a wedged stream: send() keeps
          // returning early-success while every PTY io and hook event is
          // silently dropped. Catch, reset the decoder, and end() the socket so
          // the close handler runs and the owning Runner tears down cleanly.
          let frames: ReturnType<FrameDecoder["decode"]>;
          try {
            frames = self.decoder.decode(new Uint8Array(data));
          } catch (err) {
            log.error(
              "IPC frame decode failed — tearing down socket:",
              err instanceof Error ? err.message : String(err),
            );
            self.decoder.reset();
            if (self.state.connected) self.state.socket.end();
            return;
          }
          for (const frame of frames) {
            const msg = parseIpcMessage(frame.data);
            if (!msg) {
              log.warn("dropped malformed IPC frame");
              continue;
            }
            if (!isRunnerInbound(msg)) {
              log.warn(`dropped unexpected IPC message: ${msg.t}`);
              continue;
            }
            self.onMessage(msg);
          }
        },
        drain(socket) {
          self.writer.drain(socket);
        },
        error(_socket, err) {
          log.error("socket error:", err.message);
        },
        close() {
          log.info("disconnected");
          self.state = { connected: false };
          self.onClose?.();
        },
      },
    });
    this.state = { connected: true, socket };
  }

  /**
   * Send an IPC message. If the QueuedWriter signals a queue overflow
   * (write() returns false AND the writer is in an overflowed state), the
   * socket is closed immediately — continuing would silently drop all
   * subsequent PTY io and hook events, causing permanent data loss. The
   * onClose callback fires so the owning Runner can initiate a full teardown.
   *
   * Calls before `connect()` resolves are silently dropped (not connected yet).
   */
  send(msg: IpcMessage, binary?: Uint8Array<ArrayBufferLike> | null): void {
    if (!this.state.connected) {
      log.warn("send() called before connect() — dropping message");
      return;
    }
    const frame = encodeFrame(msg, binary ?? null);
    const ok = this.writer.write(this.state.socket, frame);
    if (!ok && this.writer.isOverflowed) {
      log.error(
        "IPC send queue overflowed — closing socket to surface the failure",
      );
      this.close();
    }
  }

  close(): void {
    if (!this.state.connected) return;
    this.state.socket.end();
  }
}
