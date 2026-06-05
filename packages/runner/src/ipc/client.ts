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

export class IpcClient {
  private socket: ReturnType<typeof Bun.connect> extends Promise<infer S>
    ? S
    : never = null as never;
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
    this.socket = await Bun.connect({
      unix: path,
      socket: {
        data(_socket, data) {
          const frames = self.decoder.decode(new Uint8Array(data));
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
          self.onClose?.();
        },
      },
    });
  }

  /**
   * Send an IPC message. If the QueuedWriter signals a queue overflow
   * (write() returns false AND the writer is in an overflowed state), the
   * socket is closed immediately — continuing would silently drop all
   * subsequent PTY io and hook events, causing permanent data loss. The
   * onClose callback fires so the owning Runner can initiate a full teardown.
   */
  send(msg: IpcMessage, binary?: Uint8Array<ArrayBufferLike> | null): void {
    const frame = encodeFrame(msg, binary ?? null);
    const ok = this.writer.write(this.socket, frame);
    if (!ok && this.writer.isOverflowed) {
      log.error(
        "IPC send queue overflowed — closing socket to surface the failure",
      );
      this.close();
    }
  }

  close(): void {
    this.socket.end();
  }
}
