import { existsSync } from "fs";
import { join, extname } from "path";
import { createLogger, type WsClientMessage } from "@teleprompter/protocol";
import { ClientRegistry, createClient, type WsClient } from "./client-registry";

const log = createLogger("WsServer");

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
  onResize?(client: WsClient, sid: string, cols: number, rows: number): void;
  onWorktreeCreate?(client: WsClient, msg: WsClientMessage & { t: "worktree.create" }): void;
  onWorktreeRemove?(client: WsClient, msg: WsClientMessage & { t: "worktree.remove" }): void;
  onWorktreeList?(client: WsClient): void;
  onSessionCreate?(client: WsClient, msg: WsClientMessage & { t: "session.create" }): void;
  onSessionStop?(client: WsClient, sid: string): void;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json",
};

export class WsServer {
  private server: ReturnType<typeof Bun.serve<WsData>> | null = null;
  readonly registry: ClientRegistry;
  private events: WsServerEvents;
  private webDir: string | null = null;

  constructor(registry: ClientRegistry, events: WsServerEvents) {
    this.registry = registry;
    this.events = events;
  }

  /**
   * Set the directory for serving the frontend web build.
   * If set, non-WebSocket HTTP requests serve static files from this dir.
   */
  setWebDir(dir: string): void {
    this.webDir = dir;
  }

  start(port: number): void {
    const self = this;

    this.server = Bun.serve<WsData>({
      port,
      fetch(req, server) {
        if (server.upgrade(req, { data: { client: null as unknown as WsClient } })) {
          return;
        }

        // Serve static frontend files if webDir is set
        if (self.webDir) {
          const url = new URL(req.url);
          let filePath = join(self.webDir, url.pathname === "/" ? "index.html" : url.pathname);

          // SPA fallback: if file doesn't exist and no extension, serve index.html
          if (!existsSync(filePath) && !extname(filePath)) {
            filePath = join(self.webDir, "index.html");
          }

          if (existsSync(filePath)) {
            const file = Bun.file(filePath);
            const ext = extname(filePath);
            return new Response(file, {
              headers: {
                "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
                "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000",
              },
            });
          }
        }

        return new Response("Teleprompter Daemon", { status: 200 });
      },
      websocket: {
        open(ws) {
          const client = createClient(ws as unknown as WsClient["ws"]);
          ws.data.client = client;
          self.registry.add(client);
          log.info(`client connected id=${client.id}`);
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
          log.info(`client disconnected id=${client.id}`);
        },
      },
    });

    log.info(`listening on ws://localhost:${port}`);
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
      case "resize":
        this.events.onResize?.(client, msg.sid, msg.cols, msg.rows);
        break;
      case "ping":
        this.registry.send(client, { t: "pong" });
        break;
      case "worktree.create":
        this.events.onWorktreeCreate?.(client, msg);
        break;
      case "worktree.remove":
        this.events.onWorktreeRemove?.(client, msg);
        break;
      case "worktree.list":
        this.events.onWorktreeList?.(client);
        break;
      case "session.create":
        this.events.onSessionCreate?.(client, msg);
        break;
      case "session.stop":
        this.events.onSessionStop?.(client, msg.sid);
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
