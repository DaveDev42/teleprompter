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
  constructor(onMessage: MessageHandler) {
    this.onMessage = onMessage;
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
    const frame = encodeFrame(msg, binary ?? null);
    this.writer.write(this.socket, frame);
  }

  close(): void {
    this.socket.end();
  }
}
