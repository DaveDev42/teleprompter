import {
  encodeFrame,
  FrameDecoder,
  QueuedWriter,
  getSocketPath,
  type IpcMessage,
  type IpcAck,
  type IpcInput,
  type IpcResize,
} from "@teleprompter/protocol";

type IncomingMessage = IpcAck | IpcInput | IpcResize;
type MessageHandler = (msg: IncomingMessage) => void;

export class IpcClient {
  private socket: ReturnType<typeof Bun.connect> extends Promise<infer S>
    ? S
    : never = null!;
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
          const messages = self.decoder.decode(new Uint8Array(data));
          for (const msg of messages) {
            self.onMessage(msg as IncomingMessage);
          }
        },
        drain(socket) {
          self.writer.drain(socket);
        },
        error(_socket, err) {
          console.error("[IpcClient] socket error:", err.message);
        },
        close() {
          console.log("[IpcClient] disconnected");
        },
      },
    });
  }

  send(msg: IpcMessage): void {
    const frame = encodeFrame(msg);
    this.writer.write(this.socket, frame);
  }

  close(): void {
    this.socket.end();
  }
}
