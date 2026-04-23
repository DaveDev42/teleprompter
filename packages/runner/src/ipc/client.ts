import {
  createLogger,
  encodeFrame,
  FrameDecoder,
  getSocketPath,
  type IpcAck,
  type IpcInput,
  type IpcMessage,
  type IpcResize,
  QueuedWriter,
} from "@teleprompter/protocol";

const log = createLogger("IpcClient");

type IncomingMessage = IpcAck | IpcInput | IpcResize;
type MessageHandler = (msg: IncomingMessage) => void;

export class IpcClient {
  private socket: ReturnType<typeof Bun.connect> extends Promise<infer S>
    ? S
    : never = null as never;
  private writer = new QueuedWriter();
  private decoder = new FrameDecoder();
  private onMessage: MessageHandler;
  private winConn: {
    send(msg: IpcMessage, binary?: Uint8Array<ArrayBufferLike> | null): void;
    close(): void;
  } | null = null;

  constructor(onMessage: MessageHandler) {
    this.onMessage = onMessage;
  }

  async connect(socketPath?: string): Promise<void> {
    const path = socketPath ?? getSocketPath();

    if (process.platform === "win32") {
      const { connectWindows } =
        require("./client-windows") as typeof import("./client-windows");
      this.winConn = await connectWindows(path, (msg) => {
        this.onMessage(msg as IncomingMessage);
      });
      return;
    }

    const self = this;
    this.socket = await Bun.connect({
      unix: path,
      socket: {
        data(_socket, data) {
          const frames = self.decoder.decode(new Uint8Array(data));
          for (const frame of frames) {
            self.onMessage(frame.data as IncomingMessage);
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
        },
      },
    });
  }

  send(msg: IpcMessage, binary?: Uint8Array<ArrayBufferLike> | null): void {
    if (this.winConn) {
      this.winConn.send(msg, binary);
      return;
    }
    const frame = encodeFrame(msg, binary ?? null);
    this.writer.write(this.socket, frame);
  }

  close(): void {
    if (this.winConn) {
      this.winConn.close();
      this.winConn = null;
      return;
    }
    this.socket.end();
  }
}
