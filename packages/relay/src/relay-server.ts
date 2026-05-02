import type {
  RelayClientMessage,
  RelayFrame,
  RelayKeyExchangeFrame,
  RelayNotification,
  RelayServerMessage,
} from "@teleprompter/protocol";
import { createLogger } from "@teleprompter/protocol";
import { PushService } from "./push";

type ServerWebSocket = Bun.ServerWebSocket<unknown>;
type BunServer = ReturnType<typeof Bun.serve>;

const log = createLogger("Relay");

const DEFAULT_MAX_RECENT_FRAMES = 10;
const DEFAULT_MAX_FRAME_SIZE = 1024 * 1024; // 1 MB
const RATE_LIMIT_WINDOW_MS = 1000;
/**
 * Per-client rate limit. Sized for PTY io bursts (Claude streaming output can
 * exceed 100 frames/sec on heavy responses). Keep in sync with daemon-side
 * batching expectations.
 */
const RATE_LIMIT_MAX_MESSAGES = 500;
/**
 * Per-daemon-group rate limit (sum across daemon + all attached frontends).
 * Acts as a second-level budget so one runaway frontend does not pin the
 * relay's CPU even if it stays under the per-client cap.
 */
const DAEMON_GROUP_RATE_LIMIT = 5_000;
const MAX_SUBSCRIPTIONS_PER_CLIENT = 50;
/**
 * How long an unauthenticated socket may stay open before the relay closes it.
 * Daemons / frontends that dial in must send `relay.register` or `relay.auth`
 * within this window — anything longer is treated as slowloris.
 */
const AUTH_TIMEOUT_MS = 10_000;
/**
 * Maximum send-buffer (bytes) tolerated on a slow consumer before the relay
 * disconnects it. With 1 MB max frame size, 4 MB is roughly four queued
 * worst-case frames — anything beyond that means the peer has stalled and
 * we'd rather force a reconnect than buffer indefinitely.
 */
const BACKPRESSURE_THRESHOLD_BYTES = 4 * 1024 * 1024;
/**
 * Bun ServerWebSocket idleTimeout (seconds). Daemons send `relay.ping` every
 * 30s (see `packages/daemon/src/transport/relay-client.ts`), so 90s tolerates
 * three missed pings before the kernel-level cleanup kicks in. Active traffic
 * resets this timer continuously, so connected users never trip it.
 */
const WS_IDLE_TIMEOUT_S = 90;
/** How long without a ping before a daemon is considered stale (ms) */
const STALE_TIMEOUT_MS = 90_000;
/** How often to check for stale daemons (ms) */
const STALE_CHECK_INTERVAL_MS = 30_000;
/**
 * How long to retain per-daemon session state + recent-frame cache after
 * the daemon has been marked offline, before the relay evicts everything.
 * Until this elapses a returning daemon can resume without re-bootstrapping
 * its frontends from scratch. Defaults to 1 hour; the relay has no
 * durability guarantee beyond this window.
 */
const OFFLINE_EVICT_AFTER_MS = 60 * 60_000;

export interface RelayServerOptions {
  /** Max cached frames per session (default: 10, env: TP_RELAY_CACHE_SIZE) */
  cacheSize?: number;
  /** Max WebSocket frame size in bytes (default: 1MB, env: TP_RELAY_MAX_FRAME_SIZE) */
  maxFrameSize?: number;
  /** Per-client messages per second (default: 500, env: TP_RELAY_RATE_PER_CLIENT) */
  ratePerClient?: number;
  /** Per-daemon-group messages per second (default: 5000, env: TP_RELAY_RATE_PER_DAEMON) */
  ratePerDaemon?: number;
  /** Slow-consumer disconnect threshold in bytes (default: 4MB, env: TP_RELAY_BACKPRESSURE_BYTES) */
  backpressureBytes?: number;
  /** Auth handshake timeout in ms (default: 10000, env: TP_RELAY_AUTH_TIMEOUT_MS) */
  authTimeoutMs?: number;
}

/**
 * Counters surfaced via `/health` for capacity monitoring. All values are
 * since-last-restart; pulled by external Prometheus / scraper if needed.
 */
interface RelayMetrics {
  framesIn: number;
  framesOut: number;
  rateLimitedDrops: number;
  daemonRateLimitedDrops: number;
  backpressureDisconnects: number;
  authTimeouts: number;
  oversizedDrops: number;
  evictions: number;
}

interface CachedFrame {
  sid: string;
  ct: string;
  seq: number;
  from: "daemon" | "frontend";
  frontendId?: string;
}

interface RateLimiter {
  count: number;
  windowStart: number;
}

interface ConnectedClient {
  ws: ServerWebSocket; // Bun ServerWebSocket
  role: "daemon" | "frontend";
  daemonId: string;
  /** Unique frontend identifier (frontend only) */
  frontendId?: string;
  /** Session IDs this client is subscribed to */
  subscriptions: Set<string>;
  /** Rate limiter state */
  rateLimiter: RateLimiter;
}

interface DaemonState {
  online: boolean;
  sessions: Set<string>;
  lastSeen: number;
  /** Number of frontends attached per session */
  attached: Map<string, number>;
  /** Group-wide rate limiter (daemon + all attached frontends share budget) */
  rateLimiter: RateLimiter;
}

export class RelayServer {
  /** All authenticated clients */
  private clients = new Map<ServerWebSocket, ConnectedClient>();

  private pushService = new PushService();

  /** daemonId → set of connected clients (both daemon and frontend) */
  private daemonGroups = new Map<string, Set<ServerWebSocket>>();

  /** daemonId → daemon presence state */
  private daemonStates = new Map<string, DaemonState>();

  /** "daemonId:sid" → recent ciphertext frames (ring buffer) */
  private recentFrames = new Map<string, CachedFrame[]>();

  /** Token → daemonId mapping */
  private validTokens = new Map<string, string>();

  /** daemonId → { token, proof } for self-registration */
  private registrations = new Map<string, { token: string; proof: string }>();

  /** Sockets that are open but not yet authenticated (for slowloris timeout) */
  private pendingAuth = new Map<
    ServerWebSocket,
    ReturnType<typeof setTimeout>
  >();

  /** Port the server is listening on */
  private port = 0;
  private server: BunServer | null = null;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;

  private readonly maxRecentFrames: number;
  private readonly maxFrameSize: number;
  private readonly ratePerClient: number;
  private readonly ratePerDaemon: number;
  private readonly backpressureBytes: number;
  private readonly authTimeoutMs: number;

  private readonly metrics: RelayMetrics = {
    framesIn: 0,
    framesOut: 0,
    rateLimitedDrops: 0,
    daemonRateLimitedDrops: 0,
    backpressureDisconnects: 0,
    authTimeouts: 0,
    oversizedDrops: 0,
    evictions: 0,
  };

  constructor(options?: RelayServerOptions) {
    const envInt = (key: string) => {
      const n = parseInt(process.env[key] ?? "", 10);
      return Number.isFinite(n) ? n : undefined;
    };
    this.maxRecentFrames =
      options?.cacheSize ??
      envInt("TP_RELAY_CACHE_SIZE") ??
      DEFAULT_MAX_RECENT_FRAMES;
    this.maxFrameSize =
      options?.maxFrameSize ??
      envInt("TP_RELAY_MAX_FRAME_SIZE") ??
      DEFAULT_MAX_FRAME_SIZE;
    this.ratePerClient =
      options?.ratePerClient ??
      envInt("TP_RELAY_RATE_PER_CLIENT") ??
      RATE_LIMIT_MAX_MESSAGES;
    this.ratePerDaemon =
      options?.ratePerDaemon ??
      envInt("TP_RELAY_RATE_PER_DAEMON") ??
      DAEMON_GROUP_RATE_LIMIT;
    this.backpressureBytes =
      options?.backpressureBytes ??
      envInt("TP_RELAY_BACKPRESSURE_BYTES") ??
      BACKPRESSURE_THRESHOLD_BYTES;
    this.authTimeoutMs =
      options?.authTimeoutMs ??
      envInt("TP_RELAY_AUTH_TIMEOUT_MS") ??
      AUTH_TIMEOUT_MS;
  }

  /**
   * Register a valid pairing token for a daemon.
   * Used by tests.
   */
  registerToken(token: string, daemonId: string) {
    this.validTokens.set(token, daemonId);
  }

  /** Get daemon state for testing/monitoring */
  getDaemonState(
    daemonId: string,
  ): { online: boolean; lastSeen: number } | undefined {
    const state = this.daemonStates.get(daemonId);
    if (!state) return undefined;
    return { online: state.online, lastSeen: state.lastSeen };
  }

  /** Override stale timeout for testing */
  setStaleTimeoutMs(ms: number): void {
    this.staleTimeoutMs = ms;
  }

  /** Override stale check interval for testing */
  setStaleCheckIntervalMs(ms: number): void {
    this.staleCheckIntervalMs = ms;
    // Restart the check if already running
    if (this.staleCheckTimer) {
      this.startStaleCheck();
    }
  }

  private staleTimeoutMs = STALE_TIMEOUT_MS;
  private staleCheckIntervalMs = STALE_CHECK_INTERVAL_MS;

  start(port: number = 0): number {
    const self = this;

    this.server = Bun.serve({
      port,
      fetch(req, server) {
        if (server.upgrade(req, { data: undefined })) return undefined;

        // Health check endpoint
        const url = new URL(req.url);
        if (url.pathname === "/health") {
          return Response.json({
            status: "ok",
            version: "0.1.5",
            protocolVersion: 2,
            clients: self.clients.size,
            pendingAuth: self.pendingAuth.size,
            daemons: [...self.daemonStates.entries()].filter(
              ([, s]) => s.online,
            ).length,
            sessions: [...self.daemonStates.values()].reduce(
              (sum, s) => sum + s.sessions.size,
              0,
            ),
            attached: [...self.daemonStates.values()].reduce(
              (sum, s) => sum + s.attached.size,
              0,
            ),
            uptime: Math.floor(process.uptime()),
            metrics: { ...self.metrics },
          });
        }

        // Prometheus-style metrics endpoint
        if (url.pathname === "/metrics") {
          const lines: string[] = [];
          const m = self.metrics;
          lines.push(`relay_clients ${self.clients.size}`);
          lines.push(`relay_pending_auth ${self.pendingAuth.size}`);
          lines.push(
            `relay_daemons_online ${[...self.daemonStates.values()].filter((s) => s.online).length}`,
          );
          lines.push(
            `relay_sessions_total ${[...self.daemonStates.values()].reduce((sum, s) => sum + s.sessions.size, 0)}`,
          );
          lines.push(`relay_frames_in ${m.framesIn}`);
          lines.push(`relay_frames_out ${m.framesOut}`);
          lines.push(`relay_rate_limited_drops ${m.rateLimitedDrops}`);
          lines.push(
            `relay_daemon_rate_limited_drops ${m.daemonRateLimitedDrops}`,
          );
          lines.push(
            `relay_backpressure_disconnects ${m.backpressureDisconnects}`,
          );
          lines.push(`relay_auth_timeouts ${m.authTimeouts}`);
          lines.push(`relay_oversized_drops ${m.oversizedDrops}`);
          lines.push(`relay_evictions ${m.evictions}`);
          lines.push(`relay_uptime_seconds ${Math.floor(process.uptime())}`);
          return new Response(`${lines.join("\n")}\n`, {
            headers: { "Content-Type": "text/plain; version=0.0.4" },
          });
        }

        // Admin dashboard
        if (url.pathname === "/admin") {
          const daemons = [...self.daemonStates.entries()].map(([id, s]) => ({
            id,
            online: s.online,
            sessions: [...s.sessions],
            lastSeen: new Date(s.lastSeen).toISOString(),
          }));
          const html = `<!DOCTYPE html>
<html><head><title>Teleprompter Relay</title>
<meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>body{font-family:system-ui;background:#111;color:#eee;padding:2rem;max-width:800px;margin:0 auto}
h1{color:#fff;font-size:1.5rem}table{width:100%;border-collapse:collapse;margin:1rem 0}
td,th{padding:.5rem;text-align:left;border-bottom:1px solid #333}
th{color:#888;font-size:.75rem;text-transform:uppercase}.ok{color:#4ade80}.off{color:#666}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:.75rem}
.badge-on{background:#166534;color:#4ade80}.badge-off{background:#333;color:#888}
#refresh{color:#60a5fa;cursor:pointer;font-size:.75rem}</style></head>
<body><h1>Teleprompter Relay</h1>
<p>Clients: <b>${self.clients.size}</b> | Uptime: <b>${Math.floor(process.uptime())}s</b>
<span id="refresh" onclick="location.reload()"> ↻ refresh</span></p>
<h2 style="font-size:1rem;color:#888">Daemons (${daemons.length})</h2>
${
  daemons.length === 0
    ? '<p style="color:#666">No daemons connected</p>'
    : `
<table><tr><th>ID</th><th>Status</th><th>Sessions</th><th>Last Seen</th></tr>
${daemons
  .map(
    (d) => `<tr><td style="font-family:monospace;font-size:.85rem">${d.id}</td>
<td><span class="badge ${d.online ? "badge-on" : "badge-off"}">${d.online ? "online" : "offline"}</span></td>
<td>${d.sessions.length > 0 ? d.sessions.join(", ") : "—"}</td>
<td style="color:#888;font-size:.85rem">${d.lastSeen}</td></tr>`,
  )
  .join("")}
</table>`
}
</body></html>`;
          return new Response(html, {
            headers: { "Content-Type": "text/html" },
          });
        }

        return new Response("Teleprompter Relay", { status: 200 });
      },
      websocket: {
        idleTimeout: WS_IDLE_TIMEOUT_S,
        open(ws) {
          // Slowloris guard: drop sockets that never authenticate.
          const timer = setTimeout(() => {
            if (self.pendingAuth.has(ws) && !self.clients.has(ws)) {
              self.metrics.authTimeouts++;
              log.warn("closing socket: auth handshake timeout");
              try {
                ws.close(1008, "Auth timeout");
              } catch {
                // already closing
              }
            }
          }, self.authTimeoutMs);
          self.pendingAuth.set(ws, timer);
        },
        message(ws, message) {
          self.handleMessage(ws, message);
        },
        close(ws) {
          self.handleClose(ws);
        },
      },
    });

    this.port = this.server.port ?? 0;
    this.startStaleCheck();
    log.info(`listening on ws://localhost:${this.port}`);
    return this.port;
  }

  stop() {
    this.stopStaleCheck();
    this.pushService.dispose();
    for (const timer of this.pendingAuth.values()) {
      clearTimeout(timer);
    }
    this.pendingAuth.clear();
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

  private send(ws: ServerWebSocket, msg: RelayServerMessage) {
    // Slow consumer guard: if the per-socket send buffer is already past the
    // threshold, the peer is not draining and additional frames would just
    // pile up RAM. Force-close so the client reconnects via the recent-frames
    // cache instead.
    if (ws.readyState !== 1) {
      return;
    }
    const buffered = (ws as { bufferedAmount?: number }).bufferedAmount ?? 0;
    if (buffered > this.backpressureBytes) {
      this.metrics.backpressureDisconnects++;
      log.warn(
        `closing socket: backpressure ${buffered} bytes exceeds ${this.backpressureBytes}`,
      );
      try {
        ws.close(1013, "Backpressure");
      } catch {
        // already closed
      }
      return;
    }
    try {
      ws.send(JSON.stringify(msg));
      this.metrics.framesOut++;
    } catch {
      // client disconnected
    }
  }

  private handleMessage(
    ws: ServerWebSocket,
    raw: string | Buffer | ArrayBuffer,
  ) {
    this.metrics.framesIn++;
    // Check frame size limit
    const rawSize =
      typeof raw === "string"
        ? Buffer.byteLength(raw)
        : (raw as ArrayBuffer).byteLength;
    if (rawSize > this.maxFrameSize) {
      this.metrics.oversizedDrops++;
      log.warn(
        `closing connection: frame size ${rawSize} exceeds limit ${this.maxFrameSize}`,
      );
      this.send(ws, {
        t: "relay.err",
        e: "FRAME_TOO_LARGE",
        m: `Frame size ${rawSize} exceeds limit of ${this.maxFrameSize} bytes`,
      });
      ws.close(1009, "Frame too large");
      return;
    }

    let msg: RelayClientMessage;
    try {
      const text =
        typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      msg = JSON.parse(text);
    } catch {
      this.send(ws, { t: "relay.err", e: "PARSE_ERROR", m: "Invalid JSON" });
      return;
    }

    // Rate limiting for authenticated clients (per-client + per-daemon group)
    const client = this.clients.get(ws);
    if (client && msg.t !== "relay.ping") {
      if (!this.checkRateLimit(client)) {
        this.metrics.rateLimitedDrops++;
        this.send(ws, {
          t: "relay.err",
          e: "RATE_LIMITED",
          m: "Too many messages. Slow down.",
        });
        return;
      }
      if (!this.checkDaemonGroupRateLimit(client)) {
        this.metrics.daemonRateLimitedDrops++;
        this.send(ws, {
          t: "relay.err",
          e: "RATE_LIMITED",
          m: "Daemon group budget exceeded. Slow down.",
        });
        return;
      }
    }

    switch (msg.t) {
      case "relay.register":
        this.handleRegister(ws, msg);
        break;
      case "relay.auth":
        this.handleAuth(ws, msg);
        break;
      case "relay.kx":
        this.handleKeyExchange(ws, msg);
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
        this.handlePing(ws, msg);
        break;
      case "relay.push":
        this.handlePush(
          ws,
          msg as RelayClientMessage & { t: "relay.push" },
        ).catch((err) => log.error(`handlePush failed: ${err}`));
        break;
      default:
        this.send(ws, {
          t: "relay.err",
          e: "UNKNOWN_TYPE",
          m: `Unknown message type: ${(msg as RelayClientMessage).t}`,
        });
    }
  }

  private handleRegister(
    ws: ServerWebSocket,
    msg: RelayClientMessage & { t: "relay.register" },
  ) {
    // Check if daemonId is already registered with a different proof
    const existing = this.registrations.get(msg.daemonId);
    if (existing && existing.proof !== msg.proof) {
      this.send(ws, {
        t: "relay.register.err",
        e: "Daemon ID already registered with different credentials",
      });
      return;
    }

    // Register token → daemonId mapping
    this.validTokens.set(msg.token, msg.daemonId);
    this.registrations.set(msg.daemonId, {
      token: msg.token,
      proof: msg.proof,
    });

    this.send(ws, { t: "relay.register.ok", daemonId: msg.daemonId });
  }

  private handleAuth(
    ws: ServerWebSocket,
    msg: RelayClientMessage & { t: "relay.auth" },
  ) {
    const expectedDaemonId = this.validTokens.get(msg.token);
    if (!expectedDaemonId || expectedDaemonId !== msg.daemonId) {
      this.send(ws, {
        t: "relay.auth.err",
        e: "Invalid token or daemon ID",
      });
      return;
    }

    // Auth completed — cancel slowloris timer.
    this.clearPendingAuth(ws);

    const client: ConnectedClient = {
      ws,
      role: msg.role,
      daemonId: msg.daemonId,
      frontendId: msg.frontendId,
      rateLimiter: { count: 0, windowStart: Date.now() },
      subscriptions: new Set(),
    };
    this.clients.set(ws, client);

    // Add to daemon group
    if (!this.daemonGroups.has(msg.daemonId)) {
      this.daemonGroups.set(msg.daemonId, new Set());
    }
    this.daemonGroups.get(msg.daemonId)?.add(ws);

    // Update daemon state — preserve existing rateLimiter if the daemon is
    // resuming (frontend may have created the entry first via group rate-limit
    // path, though current ordering is daemon-first).
    if (msg.role === "daemon") {
      const existing = this.daemonStates.get(msg.daemonId);
      this.daemonStates.set(msg.daemonId, {
        online: true,
        sessions: existing?.sessions ?? new Set(),
        lastSeen: Date.now(),
        attached: existing?.attached ?? new Map(),
        rateLimiter: existing?.rateLimiter ?? {
          count: 0,
          windowStart: Date.now(),
        },
      });
    } else {
      // Frontend auth: ensure a DaemonState exists so group rate-limit works
      // even if the daemon is still offline (frontend reconnects before daemon).
      if (!this.daemonStates.has(msg.daemonId)) {
        this.daemonStates.set(msg.daemonId, {
          online: false,
          sessions: new Set(),
          lastSeen: Date.now(),
          attached: new Map(),
          rateLimiter: { count: 0, windowStart: Date.now() },
        });
      }
    }

    this.send(ws, { t: "relay.auth.ok", daemonId: msg.daemonId });
    log.info(`${msg.role} authenticated for daemon ${msg.daemonId}`);

    // Send presence to frontends
    this.broadcastPresence(msg.daemonId);
  }

  private handleKeyExchange(
    ws: ServerWebSocket,
    msg: RelayClientMessage & { t: "relay.kx" },
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

    const group = this.daemonGroups.get(client.daemonId);
    if (!group) return;

    const frame: RelayKeyExchangeFrame = {
      t: "relay.kx.frame",
      ct: msg.ct,
      from: client.role,
    };

    // Forward to all peers of opposite role in the daemon group
    for (const peerWs of group) {
      if (peerWs === ws) continue;
      const peer = this.clients.get(peerWs);
      if (!peer) continue;
      if (peer.role !== client.role) {
        this.send(peerWs, frame);
      }
    }
  }

  private handlePublish(
    ws: ServerWebSocket,
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
    const frames = this.recentFrames.get(key) ?? [];
    const frame: CachedFrame = {
      sid: msg.sid,
      ct: msg.ct,
      seq: msg.seq,
      from: client.role,
      frontendId: client.frontendId,
    };
    frames.push(frame);
    if (frames.length > this.maxRecentFrames) {
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
      frontendId: client.frontendId,
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
    ws: ServerWebSocket,
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

    // Track attached frontends per session
    if (client.role === "frontend") {
      const state = this.daemonStates.get(client.daemonId);
      if (state) {
        state.attached.set(msg.sid, (state.attached.get(msg.sid) ?? 0) + 1);
      }
    }

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
            frontendId: frame.frontendId,
          });
        }
      }
    }
  }

  private handleUnsubscribe(
    ws: ServerWebSocket,
    msg: RelayClientMessage & { t: "relay.unsub" },
  ) {
    const client = this.clients.get(ws);
    if (!client) return;
    client.subscriptions.delete(msg.sid);

    // Update attached count
    if (client.role === "frontend") {
      const state = this.daemonStates.get(client.daemonId);
      if (state) {
        const count = (state.attached.get(msg.sid) ?? 1) - 1;
        if (count <= 0) state.attached.delete(msg.sid);
        else state.attached.set(msg.sid, count);
      }
    }
  }

  private handleClose(ws: ServerWebSocket) {
    this.clearPendingAuth(ws);
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
    return this.tickWindow(client.rateLimiter, this.ratePerClient);
  }

  /**
   * Group budget shared across daemon + all attached frontends. Protects the
   * relay event loop from any single pairing pinning CPU even if every
   * individual client stays under their per-client cap.
   */
  private checkDaemonGroupRateLimit(client: ConnectedClient): boolean {
    const state = this.daemonStates.get(client.daemonId);
    if (!state) return true;
    return this.tickWindow(state.rateLimiter, this.ratePerDaemon);
  }

  private tickWindow(rl: RateLimiter, max: number): boolean {
    const now = Date.now();
    if (now - rl.windowStart > RATE_LIMIT_WINDOW_MS) {
      rl.count = 1;
      rl.windowStart = now;
      return true;
    }
    rl.count++;
    return rl.count <= max;
  }

  private clearPendingAuth(ws: ServerWebSocket) {
    const timer = this.pendingAuth.get(ws);
    if (timer) {
      clearTimeout(timer);
      this.pendingAuth.delete(ws);
    }
  }

  private handlePing(
    ws: ServerWebSocket,
    msg: RelayClientMessage & { t: "relay.ping" },
  ) {
    // Update lastSeen for daemon clients
    const client = this.clients.get(ws);
    if (client?.role === "daemon") {
      const state = this.daemonStates.get(client.daemonId);
      if (state) {
        state.lastSeen = Date.now();
      }
    }
    this.send(ws, { t: "relay.pong", ts: msg.ts });
  }

  private async handlePush(
    ws: ServerWebSocket,
    msg: RelayClientMessage & { t: "relay.push" },
  ) {
    const client = this.clients.get(ws);
    if (!client || client.role !== "daemon") {
      this.send(ws, {
        t: "relay.err",
        e: "UNAUTHORIZED",
        m: "Only daemons can send push requests",
      });
      return;
    }

    // Find the target frontend by frontendId in the same daemon group
    const group = this.daemonGroups.get(client.daemonId);
    let targetFrontendWs: ServerWebSocket | null = null;
    if (group) {
      for (const memberWs of group) {
        const member = this.clients.get(memberWs);
        if (
          member &&
          member.role === "frontend" &&
          member.frontendId === msg.frontendId
        ) {
          targetFrontendWs = memberWs;
          break;
        }
      }
    }

    const isFrontendConnected = targetFrontendWs !== null;

    const result = await this.pushService.sendOrDeliver({
      frontendId: msg.frontendId,
      daemonId: client.daemonId,
      token: msg.token,
      title: msg.title,
      body: msg.body,
      isFrontendConnected,
      data: msg.data,
    });

    if (result === "ws" && targetFrontendWs) {
      const notification: RelayNotification = {
        t: "relay.notification",
        title: msg.title,
        body: msg.body,
        data: msg.data,
      };
      this.send(targetFrontendWs, notification);
    }
  }

  private startStaleCheck(): void {
    this.stopStaleCheck();
    this.staleCheckTimer = setInterval(
      () => this.checkStaleDaemons(),
      this.staleCheckIntervalMs,
    );
  }

  private stopStaleCheck(): void {
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }
  }

  private checkStaleDaemons(): void {
    const now = Date.now();
    for (const [daemonId, state] of this.daemonStates) {
      if (state.online && now - state.lastSeen > this.staleTimeoutMs) {
        state.online = false;
        const staleSec = Math.round((now - state.lastSeen) / 1000);
        log.info(
          `daemon ${daemonId} marked offline (stale — no ping for ${staleSec}s)`,
        );
        this.broadcastPresence(daemonId);
      } else if (
        !state.online &&
        now - state.lastSeen > OFFLINE_EVICT_AFTER_MS
      ) {
        this.evictDaemon(daemonId);
      }
    }
  }

  /**
   * Drop all per-daemon cached state. Called when a daemon has been offline
   * long enough that retaining it would be pure memory leak — no returning
   * frontend can use the stale cache. The next successful register/auth
   * rebuilds state from scratch.
   */
  private evictDaemon(daemonId: string): void {
    this.daemonStates.delete(daemonId);
    for (const key of this.recentFrames.keys()) {
      if (key.startsWith(`${daemonId}:`)) {
        this.recentFrames.delete(key);
      }
    }
    this.metrics.evictions++;
    log.info(`daemon ${daemonId} evicted from relay state after offline TTL`);
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
