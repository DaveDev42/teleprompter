import type {
  WsClientMessage,
  WsRec,
  WsServerMessage,
  WsSessionMeta,
  WsWorktreeCreated,
  WsWorktreeInfo,
  WsWorktreeListReply,
} from "@teleprompter/protocol/client";

/** Production relay URL */
const PRODUCTION_RELAY_URL = "wss://relay.tpmt.dev";

/**
 * Auto-detect WS URL.
 * - Dev: Metro/Expo Go → local daemon (ws://host:7080)
 * - Dev: Daemon-served web → same host
 * - Production: wss://relay.tpmt.dev
 */
function getDefaultUrl(): string {
  // Web environment
  if (typeof window !== "undefined" && window.location) {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    // Dev server (Metro/Expo) — extract host, use daemon port
    // Metro uses 8081 by default, but Expo MCP may use 8082+ if 8081 is busy
    const port = parseInt(host?.split(":")[1] ?? "0", 10);
    if ((port >= 8081 && port <= 8099) || host?.includes(":19006")) {
      const devHost = host.split(":")[0];
      return `ws://${devHost}:7080`;
    }
    // Daemon-served web build — same host and port
    if (host && !host.includes("tpmt.dev")) {
      return `${proto}//${host}`;
    }
  }

  // React Native dev: extract host from Expo's __DEV__ source URL or Constants
  if (__DEV__) {
    try {
      const Constants = require("expo-constants").default;
      const hostUri =
        Constants?.expoGoConfig?.debuggerHost ??
        Constants?.expoConfig?.hostUri ??
        Constants?.manifest?.debuggerHost ??
        Constants?.manifest2?.extra?.expoGo?.debuggerHost;
      if (hostUri) {
        const host = hostUri.split(":")[0];
        if (host && host !== "localhost") {
          return `ws://${host}:7080`;
        }
      }
    } catch {}

    try {
      const sourceUrl = (globalThis as Record<string, unknown>)
        .__expo_source_url as string | undefined;
      if (sourceUrl) {
        const match = sourceUrl.match(/\/\/([^:/]+)/);
        if (match?.[1] && match[1] !== "localhost") {
          return `ws://${match[1]}:7080`;
        }
      }
    } catch {}

    return "ws://localhost:7080";
  }

  return PRODUCTION_RELAY_URL;
}

const DEFAULT_URL = getDefaultUrl();
/** Exposed for debugging */
export const resolvedWsUrl = DEFAULT_URL;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export type WsEventHandler = {
  onSessionList?: (sessions: WsSessionMeta[]) => void;
  onRec?: (rec: WsRec) => void;
  onState?: (sid: string, meta: WsSessionMeta) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: string) => void;
  onWorktreeList?: (worktrees: WsWorktreeInfo[]) => void;
  onWorktreeCreated?: (info: WsWorktreeInfo, sid?: string) => void;
};

export class DaemonWsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: WsEventHandler;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  /** Track attached session and last seq for auto-resume on reconnect */
  private attachedSid: string | null = null;
  private lastSeq = 0;
  private hasConnectedBefore = false;
  private pingStart = 0;
  /** Last measured round-trip time in ms */
  rtt = -1;

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
      this.send({ t: "hello", v: 1 });
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
        // Auto-resume if we were previously attached
        if (this.hasConnectedBefore && this.attachedSid) {
          this.resume(this.attachedSid, this.lastSeq);
        }
        this.hasConnectedBefore = true;
        break;
      case "rec":
        this.trackSeq(msg.seq);
        this.handlers.onRec?.(msg);
        break;
      case "batch":
        for (const rec of msg.d) {
          this.trackSeq(rec.seq);
          this.handlers.onRec?.(rec);
        }
        break;
      case "state":
        this.handlers.onState?.(msg.sid, msg.d);
        break;
      case "pong":
        if (this.pingStart > 0) {
          this.rtt = Date.now() - this.pingStart;
          this.pingStart = 0;
        }
        break;
      case "err":
        this.handlers.onError?.(msg.m ?? msg.e);
        break;
      case "worktree.list":
        this.handlers.onWorktreeList?.(msg.d);
        break;
      case "worktree.created":
        this.handlers.onWorktreeCreated?.(msg.d, msg.sid);
        break;
    }
  }

  private trackSeq(seq: number) {
    if (seq > this.lastSeq) {
      this.lastSeq = seq;
    }
  }

  send(msg: WsClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  attach(sid: string) {
    this.attachedSid = sid;
    this.send({ t: "attach", sid });
  }

  detach(sid: string) {
    if (this.attachedSid === sid) {
      this.attachedSid = null;
    }
    this.send({ t: "detach", sid });
  }

  resume(sid: string, cursor: number) {
    this.attachedSid = sid;
    this.send({ t: "resume", sid, c: cursor });
  }

  sendChat(sid: string, text: string) {
    this.send({ t: "in.chat", sid, d: text });
  }

  sendTermInput(sid: string, data: string) {
    this.send({ t: "in.term", sid, d: data });
  }

  /** Send ping and measure RTT on pong */
  ping() {
    this.pingStart = Date.now();
    this.send({ t: "ping" });
  }

  /** Get the last measured RTT in ms (-1 if not measured) */
  getRtt(): number {
    return this.rtt;
  }

  // ── Worktree / Session management ──

  requestWorktreeList() {
    this.send({ t: "worktree.list" } as WsClientMessage);
  }

  createWorktree(branch: string, baseBranch?: string, path?: string) {
    this.send({
      t: "worktree.create",
      branch,
      baseBranch,
      path,
    } as WsClientMessage);
  }

  removeWorktree(path: string, force?: boolean) {
    this.send({ t: "worktree.remove", path, force } as WsClientMessage);
  }

  createSession(cwd: string, sid?: string) {
    this.send({ t: "session.create", cwd, sid } as WsClientMessage);
  }

  stopSession(sid: string) {
    this.send({ t: "session.stop", sid } as WsClientMessage);
  }

  restartSession(sid: string) {
    this.send({ t: "session.restart", sid } as WsClientMessage);
  }

  exportSession(sid: string, format: "json" | "markdown" = "markdown") {
    this.send({ t: "session.export", sid, format } as WsClientMessage);
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
