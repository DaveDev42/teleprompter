import type { WsClientMessage } from "@teleprompter/protocol";
import { ClientRegistry, createClient, type WsClient } from "./client-registry";

interface WsData {
  client: WsClient;
}

export interface WsServerEvents {
  onHello(client: WsClient): void;
  onAttach(client: WsClient, sid: string): void;
  onDetach(client: WsClient, sid: string): void;
  onResume(client: WsClient, sid: string, cursor: number): void;
  onInChat(client: WsClient, sid: string, text: string): void;
  onInTerm(client: WsClient, sid: string, data: string): void;
}

export class WsServer {
  private server: ReturnType<typeof Bun.serve<WsData>> | null = null;
  readonly registry: ClientRegistry;
  private events: WsServerEvents;

  constructor(registry: ClientRegistry, events: WsServerEvents) {
    this.registry = registry;
    this.events = events;
  }

  start(port: number): void {
    const self = this;

    this.server = Bun.serve<WsData>({
      port,
      fetch(req, server) {
        if (server.upgrade(req, { data: { client: null as unknown as WsClient } })) {
          return;
        }
        return new Response("WebSocket upgrade required", { status: 426 });
      },
      websocket: {
        open(ws) {
          const client = createClient(ws as unknown as WsClient["ws"]);
          ws.data.client = client;
          self.registry.add(client);
          console.log(`[WsServer] client connected id=${client.id}`);
        },
        message(ws, message) {
          const client = ws.data.client;
          let msg: WsClientMessage;
          try {
            msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
          } catch {
            self.registry.send(client, { t: "err", e: "PARSE_ERROR", m: "Invalid JSON" });
            return;
          }

          self.dispatch(client, msg);
        },
        close(ws) {
          const client = ws.data.client;
          self.registry.remove(client);
          console.log(`[WsServer] client disconnected id=${client.id}`);
        },
      },
    });

    console.log(`[WsServer] listening on ws://localhost:${port}`);
  }

  private dispatch(client: WsClient, msg: WsClientMessage): void {
    switch (msg.t) {
      case "hello":
        this.events.onHello(client);
        break;
      case "attach":
        this.events.onAttach(client, msg.sid);
        break;
      case "detach":
        this.events.onDetach(client, msg.sid);
        break;
      case "resume":
        this.events.onResume(client, msg.sid, msg.c);
        break;
      case "in.chat":
        this.events.onInChat(client, msg.sid, msg.d);
        break;
      case "in.term":
        this.events.onInTerm(client, msg.sid, msg.d);
        break;
      case "ping":
        this.registry.send(client, { t: "pong" });
        break;
      default:
        this.registry.send(client, { t: "err", e: "UNKNOWN_TYPE", m: `Unknown message type` });
    }
  }

  stop(): void {
    this.server?.stop();
    this.server = null;
  }

  get port(): number | undefined {
    return this.server?.port;
  }
}
