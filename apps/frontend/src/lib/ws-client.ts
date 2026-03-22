import type {
  WsClientMessage,
  WsServerMessage,
  WsSessionMeta,
  WsRec,
} from "@teleprompter/protocol";

const DEFAULT_URL = "ws://localhost:7070";
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export type WsEventHandler = {
  onSessionList?: (sessions: WsSessionMeta[]) => void;
  onRec?: (rec: WsRec) => void;
  onState?: (sid: string, meta: WsSessionMeta) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: string) => void;
};

export class DaemonWsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: WsEventHandler;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(url: string = DEFAULT_URL, handlers: WsEventHandler = {}) {
    this.url = url;
    this.handlers = handlers;
  }

  connect() {
    if (this.disposed) return;
    this.cleanup();

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.handlers.onOpen?.();
      this.send({ t: "hello" });
    };

    ws.onmessage = (event) => {
      try {
        const msg: WsServerMessage = JSON.parse(event.data as string);
        this.handleMessage(msg);
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      this.handlers.onClose?.();
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      this.handlers.onError?.("WebSocket error");
    };
  }

  private handleMessage(msg: WsServerMessage) {
    switch (msg.t) {
      case "hello":
        this.handlers.onSessionList?.(msg.d.sessions);
        break;
      case "rec":
        this.handlers.onRec?.(msg);
        break;
      case "batch":
        for (const rec of msg.d) {
          this.handlers.onRec?.(rec);
        }
        break;
      case "state":
        this.handlers.onState?.(msg.sid, msg.d);
        break;
      case "pong":
        break;
      case "err":
        this.handlers.onError?.(msg.m ?? msg.e);
        break;
    }
  }

  send(msg: WsClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  attach(sid: string) {
    this.send({ t: "attach", sid });
  }

  detach(sid: string) {
    this.send({ t: "detach", sid });
  }

  resume(sid: string, cursor: number) {
    this.send({ t: "resume", sid, c: cursor });
  }

  sendChat(sid: string, text: string) {
    this.send({ t: "in.chat", sid, d: text });
  }

  sendTermInput(sid: string, data: string) {
    // data should be base64 encoded
    this.send({ t: "in.term", sid, d: data });
  }

  private scheduleReconnect() {
    if (this.disposed) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private cleanup() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close();
      }
      this.ws = null;
    }
  }

  dispose() {
    this.disposed = true;
    this.cleanup();
  }
}
