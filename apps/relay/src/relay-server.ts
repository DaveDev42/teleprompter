import type {
  RelayClientMessage,
  RelayServerMessage,
  RelayFrame,
} from "@teleprompter/protocol";
import { createLogger } from "@teleprompter/protocol";

const log = createLogger("Relay");

const MAX_RECENT_FRAMES = 10;
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_MESSAGES = 100;
const MAX_SUBSCRIPTIONS_PER_CLIENT = 50;

interface CachedFrame {
  sid: string;
  ct: string;
  seq: number;
  from: "daemon" | "frontend";
}

interface RateLimiter {
  count: number;
  windowStart: number;
}

interface ConnectedClient {
  ws: any; // Bun ServerWebSocket
  role: "daemon" | "frontend";
  daemonId: string;
  /** Session IDs this client is subscribed to */
  subscriptions: Set<string>;
  /** Rate limiter state */
  rateLimiter: RateLimiter;
}

interface DaemonState {
  online: boolean;
  sessions: Set<string>;
  lastSeen: number;
}

export class RelayServer {
  /** All authenticated clients */
  private clients = new Map<any, ConnectedClient>();

  /** daemonId → set of connected clients (both daemon and frontend) */
  private daemonGroups = new Map<string, Set<any>>();

  /** daemonId → daemon presence state */
  private daemonStates = new Map<string, DaemonState>();

  /** "daemonId:sid" → recent ciphertext frames (ring buffer) */
  private recentFrames = new Map<string, CachedFrame[]>();

  /** Token → daemonId mapping (set during pairing) */
  private validTokens = new Map<string, string>();

  /** Port the server is listening on */
  private port = 0;
  private server: any = null;

  /**
   * Register a valid pairing token for a daemon.
   * In production, this would come from the pairing flow.
   * For now, tokens are pre-registered.
   */
  registerToken(token: string, daemonId: string) {
    this.validTokens.set(token, daemonId);
  }

  start(port: number = 0): number {
    const self = this;

    this.server = Bun.serve({
      port,
      fetch(req, server) {
        if (server.upgrade(req)) return undefined;
        return new Response("Teleprompter Relay", { status: 200 });
      },
      websocket: {
        open(ws) {
          // Wait for auth message
        },
        message(ws, message) {
          self.handleMessage(ws, message);
        },
        close(ws) {
          self.handleClose(ws);
        },
      },
    });

    this.port = this.server.port;
    log.info(`listening on ws://localhost:${this.port}`);
    return this.port;
  }

  stop() {
    this.server?.stop();
    this.clients.clear();
    this.daemonGroups.clear();
    this.daemonStates.clear();
    this.recentFrames.clear();
    log.info("stopped");
  }

  getPort(): number {
    return this.port;
  }

  private send(ws: any, msg: RelayServerMessage) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // client disconnected
    }
  }

  private handleMessage(ws: any, raw: string | Buffer | ArrayBuffer) {
    let msg: RelayClientMessage;
    try {
      const text =
        typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      msg = JSON.parse(text);
    } catch {
      this.send(ws, { t: "relay.err", e: "PARSE_ERROR", m: "Invalid JSON" });
      return;
    }

    // Rate limiting for authenticated clients
    const client = this.clients.get(ws);
    if (client && msg.t !== "relay.ping") {
      if (!this.checkRateLimit(client)) {
        this.send(ws, {
          t: "relay.err",
          e: "RATE_LIMITED",
          m: "Too many messages. Slow down.",
        });
        return;
      }
    }

    switch (msg.t) {
      case "relay.auth":
        this.handleAuth(ws, msg);
        break;
      case "relay.pub":
        this.handlePublish(ws, msg);
        break;
      case "relay.sub":
        this.handleSubscribe(ws, msg);
        break;
      case "relay.unsub":
        this.handleUnsubscribe(ws, msg);
        break;
      case "relay.ping":
        this.send(ws, { t: "relay.pong" });
        break;
      default:
        this.send(ws, {
          t: "relay.err",
          e: "UNKNOWN_TYPE",
          m: `Unknown message type: ${(msg as any).t}`,
        });
    }
  }

  private handleAuth(ws: any, msg: RelayClientMessage & { t: "relay.auth" }) {
    const expectedDaemonId = this.validTokens.get(msg.token);
    if (!expectedDaemonId || expectedDaemonId !== msg.daemonId) {
      this.send(ws, {
        t: "relay.auth.err",
        e: "Invalid token or daemon ID",
      });
      return;
    }

    const client: ConnectedClient = {
      ws,
      role: msg.role,
      daemonId: msg.daemonId,
      rateLimiter: { count: 0, windowStart: Date.now() },
      subscriptions: new Set(),
    };
    this.clients.set(ws, client);

    // Add to daemon group
    if (!this.daemonGroups.has(msg.daemonId)) {
      this.daemonGroups.set(msg.daemonId, new Set());
    }
    this.daemonGroups.get(msg.daemonId)!.add(ws);

    // Update daemon state
    if (msg.role === "daemon") {
      this.daemonStates.set(msg.daemonId, {
        online: true,
        sessions: new Set(),
        lastSeen: Date.now(),
      });
    }

    this.send(ws, { t: "relay.auth.ok", daemonId: msg.daemonId });
    log.info(`${msg.role} authenticated for daemon ${msg.daemonId}`);

    // Send presence to frontends
    this.broadcastPresence(msg.daemonId);
  }

  private handlePublish(
    ws: any,
    msg: RelayClientMessage & { t: "relay.pub" },
  ) {
    const client = this.clients.get(ws);
    if (!client) {
      this.send(ws, {
        t: "relay.err",
        e: "NOT_AUTHENTICATED",
        m: "Send relay.auth first",
      });
      return;
    }

    const key = `${client.daemonId}:${msg.sid}`;

    // Update daemon state with session
    const state = this.daemonStates.get(client.daemonId);
    if (state) {
      state.sessions.add(msg.sid);
      state.lastSeen = Date.now();
    }

    // Store in recent frames ring buffer
    if (!this.recentFrames.has(key)) {
      this.recentFrames.set(key, []);
    }
    const frames = this.recentFrames.get(key)!;
    const frame: CachedFrame = {
      sid: msg.sid,
      ct: msg.ct,
      seq: msg.seq,
      from: client.role,
    };
    frames.push(frame);
    if (frames.length > MAX_RECENT_FRAMES) {
      frames.shift();
    }

    // Forward to all subscribers of this session in the same daemon group
    const group = this.daemonGroups.get(client.daemonId);
    if (!group) return;

    const relayFrame: RelayFrame = {
      t: "relay.frame",
      sid: msg.sid,
      ct: msg.ct,
      seq: msg.seq,
      from: client.role,
    };

    for (const peerWs of group) {
      if (peerWs === ws) continue; // don't echo back
      const peer = this.clients.get(peerWs);
      if (!peer) continue;
      if (peer.subscriptions.has(msg.sid)) {
        this.send(peerWs, relayFrame);
      }
    }
  }

  private handleSubscribe(
    ws: any,
    msg: RelayClientMessage & { t: "relay.sub" },
  ) {
    const client = this.clients.get(ws);
    if (!client) {
      this.send(ws, {
        t: "relay.err",
        e: "NOT_AUTHENTICATED",
      });
      return;
    }

    // Enforce subscription limit
    if (client.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_CLIENT) {
      this.send(ws, {
        t: "relay.err",
        e: "TOO_MANY_SUBS",
        m: `Max ${MAX_SUBSCRIPTIONS_PER_CLIENT} subscriptions per client`,
      });
      return;
    }

    client.subscriptions.add(msg.sid);

    // Send cached recent frames if requested
    if (msg.after !== undefined) {
      const key = `${client.daemonId}:${msg.sid}`;
      const frames = this.recentFrames.get(key) ?? [];
      for (const frame of frames) {
        if (frame.seq > msg.after) {
          this.send(ws, {
            t: "relay.frame",
            sid: frame.sid,
            ct: frame.ct,
            seq: frame.seq,
            from: frame.from,
          });
        }
      }
    }
  }

  private handleUnsubscribe(
    ws: any,
    msg: RelayClientMessage & { t: "relay.unsub" },
  ) {
    const client = this.clients.get(ws);
    if (!client) return;
    client.subscriptions.delete(msg.sid);
  }

  private handleClose(ws: any) {
    const client = this.clients.get(ws);
    if (!client) return;

    this.clients.delete(ws);

    // Remove from daemon group
    const group = this.daemonGroups.get(client.daemonId);
    if (group) {
      group.delete(ws);
      if (group.size === 0) {
        this.daemonGroups.delete(client.daemonId);
      }
    }

    // Update daemon state if this was the daemon
    if (client.role === "daemon") {
      const state = this.daemonStates.get(client.daemonId);
      if (state) {
        state.online = false;
        state.lastSeen = Date.now();
      }
      this.broadcastPresence(client.daemonId);
    }

    log.info(`${client.role} disconnected from daemon ${client.daemonId}`);
  }

  private checkRateLimit(client: ConnectedClient): boolean {
    const now = Date.now();
    const rl = client.rateLimiter;

    if (now - rl.windowStart > RATE_LIMIT_WINDOW_MS) {
      // New window
      rl.count = 1;
      rl.windowStart = now;
      return true;
    }

    rl.count++;
    return rl.count <= RATE_LIMIT_MAX_MESSAGES;
  }

  private broadcastPresence(daemonId: string) {
    const state = this.daemonStates.get(daemonId);
    if (!state) return;

    const presence: RelayServerMessage = {
      t: "relay.presence",
      daemonId,
      online: state.online,
      sessions: [...state.sessions],
      lastSeen: state.lastSeen,
    };

    const group = this.daemonGroups.get(daemonId);
    if (!group) return;

    for (const ws of group) {
      const client = this.clients.get(ws);
      if (client?.role === "frontend") {
        this.send(ws, presence);
      }
    }
  }
}
