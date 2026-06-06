import type {
  RelayAuthOk,
  RelayClientMessage,
  RelayFrame,
  RelayKeyExchangeFrame,
  RelayNotification,
  RelayServerMessage,
} from "@teleprompter/protocol";
import { createLogger, parseRelayClientMessage } from "@teleprompter/protocol";
import { PushService } from "./push";
import { PushSealer } from "./push-seal";
import { ResumeTokenSigner } from "./resume-token";

type ServerWebSocket = Bun.ServerWebSocket<unknown>;
type BunServer = ReturnType<typeof Bun.serve>;

const log = createLogger("Relay");

// Build identity — injected at compile time via `bun build --define`.
// Falls back to "unknown" for local dev builds (no --define).
// @ts-expect-error — dot notation is required for bun --define substitution;
// noPropertyAccessFromIndexSignature does not apply here intentionally.
const BUILD_SHA: string = process.env.TP_BUILD_SHA ?? "unknown";
// @ts-expect-error — dot notation is required for bun --define substitution;
// noPropertyAccessFromIndexSignature does not apply here intentionally.
const BUILD_TIME: string = process.env.TP_BUILD_TIME ?? "unknown";

/**
 * The slice of a Bun ServerWebSocket the backpressure guard needs. Spelled out
 * as an explicit interface so the guard can be unit-tested with a fake socket
 * and so the `getBufferedAmount()` call is statically required — the previous
 * `(ws as { bufferedAmount?: number }).bufferedAmount` cast silently read a
 * property that does not exist on ServerWebSocket and the guard never fired.
 */
export interface BackpressureSocket {
  getBufferedAmount(): number;
}

/**
 * Returns true when the socket's queued send buffer has grown past the
 * threshold, meaning the peer is not draining and the relay should force-close
 * it (the client reconnects via the recent-frames cache). Pure function of the
 * socket's buffered amount so it is directly unit-testable.
 */
export function isBackpressured(
  ws: BackpressureSocket,
  thresholdBytes: number,
): boolean {
  return ws.getBufferedAmount() > thresholdBytes;
}

/**
 * Escape the five HTML-significant characters before interpolating
 * attacker-controlled strings (daemonId, session IDs) into the /admin
 * dashboard markup. A daemon self-registers its own daemonId over the wire,
 * and `parseRelayClientMessage` only requires it to be a string — so without
 * escaping, a daemonId like `<img src=x onerror=...>` would execute as stored
 * XSS in an operator's browser when they open /admin.
 */
export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

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
/**
 * Upper bound on the per-daemon `sessions` Set. A long-lived daemon publishes
 * to a fresh sid per Claude run; sids are added on every relay.pub but the Set
 * has no natural expiry while the daemon stays online, so without a cap it grows
 * unbounded — leaking memory and bloating every presence broadcast (the full Set
 * is serialized on each relay.presence). When the cap is exceeded we drop the
 * oldest sid (Set preserves insertion order), which only affects the presence
 * session list / dashboard, not frame routing (routing keys off recentFrames and
 * live subscriptions, not this Set).
 */
const MAX_SESSIONS_PER_DAEMON = 256;

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
  /**
   * HMAC secret for issuing resume tokens. Defaults to env
   * TP_RELAY_RESUME_SECRET; if neither is set, an ephemeral secret is
   * generated at startup (resume tokens stop working across restarts).
   */
  resumeSecret?: string;
  /** Resume token TTL in ms (default: 1h, env: TP_RELAY_RESUME_TTL_MS) */
  resumeTtlMs?: number;
  /**
   * Override the PushService used for Expo push delivery. Primarily for tests
   * that need a deterministic delivery result (e.g. a mock fetchFn returning a
   * known Expo ticket) without hitting the real Expo Push API over the network.
   * Defaults to a fresh `new PushService()`.
   */
  pushService?: PushService;
  /**
   * Secret for sealing push tokens (Path X). Defaults to env
   * TP_RELAY_PUSH_SEAL_SECRET; if neither is set, an ephemeral secret is
   * generated at startup (sealed tokens stop working across restarts).
   */
  pushSealSecret?: string;
  /** Previous secret for key-rotation overlap (env: TP_RELAY_PUSH_SEAL_SECRET_PREV). */
  pushSealSecretPrev?: string;
  /** Current key version number (env: TP_RELAY_PUSH_SEAL_VERSION, default 1). */
  pushSealVersion?: number;
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
  /** Frames that parsed as JSON but were not a well-formed RelayClientMessage. */
  unknownTypeDrops: number;
  evictions: number;
  resumesAttempted: number;
  resumesAccepted: number;
  resumesRejected: number;
}

type CachedFrame =
  | { from: "daemon"; sid: string; ct: string; seq: number }
  | {
      from: "frontend";
      sid: string;
      ct: string;
      seq: number;
      frontendId: string;
    };

interface RateLimiter {
  count: number;
  windowStart: number;
}

type ConnectedClient =
  | {
      ws: ServerWebSocket;
      role: "daemon";
      daemonId: string;
      subscriptions: Set<string>;
      rateLimiter: RateLimiter;
    }
  | {
      ws: ServerWebSocket;
      role: "frontend";
      daemonId: string;
      /** Unique frontend identifier — always present for frontend clients. */
      frontendId: string;
      subscriptions: Set<string>;
      rateLimiter: RateLimiter;
    };

interface DaemonState {
  online: boolean;
  sessions: Set<string>;
  lastSeen: number;
  /** Number of frontends attached per session */
  attached: Map<string, number>;
  /** Group-wide rate limiter (daemon + all attached frontends share budget) */
  rateLimiter: RateLimiter;
  /**
   * The registration token for this daemon. Stored here so evictDaemon and
   * re-registration can remove/update validTokens in O(1) without scanning
   * the entire validTokens map.
   */
  registrationToken: string | null;
}

export class RelayServer {
  /** All authenticated clients */
  private clients = new Map<ServerWebSocket, ConnectedClient>();

  private readonly pushService: PushService;

  /** daemonId → set of connected clients (both daemon and frontend) */
  private daemonGroups = new Map<string, Set<ServerWebSocket>>();

  /** daemonId → daemon presence state */
  private daemonStates = new Map<string, DaemonState>();

  /** "daemonId:sid" → recent ciphertext frames (ring buffer) */
  private recentFrames = new Map<string, CachedFrame[]>();

  /** Token → daemonId mapping */
  private validTokens = new Map<string, string>();

  /** daemonId → { token, proof } for self-registration */
  // proof is `null` (not `""`) when the daemonId was populated by a plain
  // relay.auth (token-only) rather than a proof-carrying relay.register: the
  // wire proof can legitimately be any string, so an empty-string sentinel
  // collides with a real proof="" and would let the different-credentials guard
  // in handleRegister be bypassed. `null` is an out-of-band "no proof recorded".
  private registrations = new Map<
    string,
    { token: string; proof: string | null }
  >();

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
    unknownTypeDrops: 0,
    evictions: 0,
    resumesAttempted: 0,
    resumesAccepted: 0,
    resumesRejected: 0,
  };

  private readonly resumeSigner: ResumeTokenSigner;
  private readonly pushSealer: PushSealer;

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
    this.pushService = options?.pushService ?? new PushService();
    this.resumeSigner = new ResumeTokenSigner({
      secret: options?.resumeSecret,
      ttlMs: options?.resumeTtlMs ?? envInt("TP_RELAY_RESUME_TTL_MS"),
    });
    if (this.resumeSigner.ephemeral) {
      log.info(
        "resume tokens use an ephemeral secret; set TP_RELAY_RESUME_SECRET to keep resume working across restarts",
      );
    }
    this.pushSealer = new PushSealer({
      secret: options?.pushSealSecret,
      secretPrev: options?.pushSealSecretPrev,
      version: options?.pushSealVersion,
    });
    if (this.pushSealer.ephemeral) {
      log.info(
        "push-seal tokens use an ephemeral secret; set TP_RELAY_PUSH_SEAL_SECRET to keep sealed tokens working across restarts",
      );
    }
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

  /** Size of a daemon's tracked-session Set (for testing the bounded cap). */
  getDaemonSessionCount(daemonId: string): number | undefined {
    return this.daemonStates.get(daemonId)?.sessions.size;
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

  /** Override offline-evict TTL for testing */
  setOfflineEvictAfterMs(ms: number): void {
    this.offlineEvictAfterMs = ms;
  }

  /** Check whether a token is currently valid (for testing eviction / re-registration). */
  hasValidToken(token: string): boolean {
    return this.validTokens.has(token);
  }

  /** Check whether a daemonId is in registrations (for testing eviction). */
  hasRegistration(daemonId: string): boolean {
    return this.registrations.has(daemonId);
  }

  private staleTimeoutMs = STALE_TIMEOUT_MS;
  private staleCheckIntervalMs = STALE_CHECK_INTERVAL_MS;
  private offlineEvictAfterMs = OFFLINE_EVICT_AFTER_MS;

  start(port: number = 0): number {
    const self = this;

    this.server = Bun.serve({
      port,
      fetch(req, server) {
        if (server.upgrade(req, { data: undefined })) return undefined;

        // Health check endpoint
        const url = new URL(req.url);
        if (url.pathname === "/health") {
          // Single pass over daemonStates to compute all three aggregates.
          const agg = self.aggregateDaemonStats();
          return Response.json({
            status: "ok",
            buildSha: BUILD_SHA,
            buildTime: BUILD_TIME,
            protocolVersion: 2,
            clients: self.clients.size,
            pendingAuth: self.pendingAuth.size,
            daemons: agg.daemonsOnline,
            sessions: agg.sessionsTotal,
            attached: agg.attachedTotal,
            uptime: Math.floor(process.uptime()),
            metrics: { ...self.metrics },
          });
        }

        // Prometheus-style metrics endpoint
        if (url.pathname === "/metrics") {
          // Single pass over daemonStates shared with /health aggregation.
          const agg = self.aggregateDaemonStats();
          const lines: string[] = [];
          const m = self.metrics;
          lines.push(`relay_clients ${self.clients.size}`);
          lines.push(`relay_pending_auth ${self.pendingAuth.size}`);
          lines.push(`relay_daemons_online ${agg.daemonsOnline}`);
          lines.push(`relay_sessions_total ${agg.sessionsTotal}`);
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
          lines.push(`relay_unknown_type_drops ${m.unknownTypeDrops}`);
          lines.push(`relay_evictions ${m.evictions}`);
          lines.push(`relay_resumes_attempted ${m.resumesAttempted}`);
          lines.push(`relay_resumes_accepted ${m.resumesAccepted}`);
          lines.push(`relay_resumes_rejected ${m.resumesRejected}`);
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
    (
      d,
    ) => `<tr><td style="font-family:monospace;font-size:.85rem">${escapeHtml(d.id)}</td>
<td><span class="badge ${d.online ? "badge-on" : "badge-off"}">${d.online ? "online" : "offline"}</span></td>
<td>${d.sessions.length > 0 ? d.sessions.map(escapeHtml).join(", ") : "—"}</td>
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

  /**
   * Single-pass aggregation over daemonStates.
   *
   * /health and /metrics both need daemonsOnline + sessionsTotal + (health
   * also needs attachedTotal). This helper collapses those three folds into
   * one iteration so neither endpoint allocates temporary spread arrays or
   * performs multiple O(n) passes — important at 10k connection scale.
   */
  private aggregateDaemonStats(): {
    daemonsOnline: number;
    sessionsTotal: number;
    attachedTotal: number;
  } {
    let daemonsOnline = 0;
    let sessionsTotal = 0;
    let attachedTotal = 0;
    for (const s of this.daemonStates.values()) {
      if (s.online) daemonsOnline++;
      sessionsTotal += s.sessions.size;
      attachedTotal += s.attached.size;
    }
    return { daemonsOnline, sessionsTotal, attachedTotal };
  }

  private send(ws: ServerWebSocket, msg: RelayServerMessage) {
    // Slow consumer guard: if the per-socket send buffer is already past the
    // threshold, the peer is not draining and additional frames would just
    // pile up RAM. Force-close so the client reconnects via the recent-frames
    // cache instead.
    if (ws.readyState !== 1) {
      return;
    }
    // Bun's ServerWebSocket exposes the queued send-buffer size via
    // getBufferedAmount() (a method, not a `bufferedAmount` property — that
    // lives on the browser/client WebSocket). See isBackpressured() above for
    // why this matters: the old `(ws as { bufferedAmount?: number })` cast read
    // a non-existent property, so the guard was dead code.
    if (isBackpressured(ws, this.backpressureBytes)) {
      const buffered = ws.getBufferedAmount();
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
    // Check frame size limit BEFORE counting the frame as received. An
    // oversized frame is rejected and counted in oversizedDrops; counting it
    // in framesIn too would double-count it and break the
    // framesIn ≈ framesOut + drops accounting the /metrics endpoint relies on.
    const rawSize =
      typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength;
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
    this.metrics.framesIn++;

    let parsed: unknown;
    try {
      const text =
        typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      parsed = JSON.parse(text);
    } catch {
      this.send(ws, { t: "relay.err", e: "PARSE_ERROR", m: "Invalid JSON" });
      return;
    }

    // Zero-trust boundary: a syntactically valid JSON frame is not yet a valid
    // RelayClientMessage. parseRelayClientMessage validates the discriminant
    // AND every field each handler dereferences (sid/ct/seq on relay.pub,
    // token on relay.auth, cols/rows are N/A here but role/v are, etc.), so the
    // switch below never reaches a handler with a missing or wrong-typed field.
    // A hostile/buggy peer that sends a malformed frame gets UNKNOWN_TYPE back
    // instead of crashing a handler on an undefined dereference.
    const msg = parseRelayClientMessage(parsed);
    if (msg === null) {
      const t =
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as { t?: unknown }).t === "string"
          ? (parsed as { t: string }).t
          : "(none)";
      this.metrics.unknownTypeDrops++;
      this.send(ws, {
        t: "relay.err",
        e: "UNKNOWN_TYPE",
        m: `Unknown or malformed message type: ${t}`,
      });
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
      case "relay.auth.resume":
        this.handleAuthResume(ws, msg);
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
        // The `case "relay.push"` arm already narrows msg to the relay.push
        // variant; no cast needed.
        this.handlePush(ws, msg).catch((err) =>
          log.error(`handlePush failed: ${err}`),
        );
        break;
      case "relay.push.register":
        // Path X: frontend registers a plaintext push token; relay seals it
        // and routes relay.push.token to the daemon.
        this.handlePushRegister(ws, msg).catch((err) =>
          log.error(`handlePushRegister failed: ${err}`),
        );
        break;
      default: {
        // Unreachable at runtime: parseRelayClientMessage already rejected any
        // frame that is not one of the variants above (out-of-spec `t`, missing
        // fields), replying UNKNOWN_TYPE before the switch. The switch is
        // exhaustive over RelayClientMessage, so `msg` narrows to `never` here —
        // this assertion makes a future un-handled variant a compile error.
        const _exhaustive: never = msg;
        log.error(
          `unreachable relay message dispatch: ${JSON.stringify(_exhaustive)}`,
        );
      }
    }
  }

  private handleRegister(
    ws: ServerWebSocket,
    msg: RelayClientMessage & { t: "relay.register" },
  ) {
    // Check if daemonId is already registered with a different proof.
    // A `null` recorded proof means the entry was seeded by a token-only
    // relay.auth (no proof to compare against), so it does not block a later
    // proof-carrying relay.register — only a *different non-null* proof does.
    const existing = this.registrations.get(msg.daemonId);
    if (existing && existing.proof !== null && existing.proof !== msg.proof) {
      this.send(ws, {
        t: "relay.register.err",
        e: "Daemon ID already registered with different credentials",
      });
      return;
    }

    // M12: If this daemon was already registered with a DIFFERENT token (e.g.
    // the daemon restarted and generated a fresh token), remove the old token
    // from validTokens so it cannot be used for auth any longer. O(1) via the
    // token stored on the existing registration record.
    if (existing && existing.token !== msg.token) {
      this.validTokens.delete(existing.token);
      // Keep daemonStates.registrationToken in sync if the state exists.
      const state = this.daemonStates.get(msg.daemonId);
      if (state) {
        state.registrationToken = msg.token;
      }
    }

    // Register token → daemonId mapping
    this.validTokens.set(msg.token, msg.daemonId);
    this.registrations.set(msg.daemonId, {
      token: msg.token,
      proof: msg.proof,
    });

    // Keep daemonStates.registrationToken in sync (set on first registration).
    const state = this.daemonStates.get(msg.daemonId);
    if (state && state.registrationToken === null) {
      state.registrationToken = msg.token;
    }

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

    // Validate frontendId: the wire type marks it optional (daemon auth omits
    // it), but the ConnectedClient discriminated union requires it for
    // role=frontend. Reject early so the ternary below can safely cast.
    if (msg.role === "frontend" && !msg.frontendId) {
      this.send(ws, {
        t: "relay.auth.err",
        e: "frontendId is required for role=frontend",
      });
      return;
    }

    // Build a typed ConnectedClient from the validated relay.auth message.
    // The discriminated union ensures frontendId is structurally required for
    // role=frontend and absent for role=daemon — no optional field, no sentinel.
    const client: ConnectedClient =
      msg.role === "frontend"
        ? {
            ws,
            role: "frontend",
            daemonId: msg.daemonId,
            // msg.frontendId is guaranteed non-empty by the guard above.
            frontendId: msg.frontendId as string,
            rateLimiter: { count: 0, windowStart: Date.now() },
            subscriptions: new Set(),
          }
        : {
            ws,
            role: "daemon",
            daemonId: msg.daemonId,
            rateLimiter: { count: 0, windowStart: Date.now() },
            subscriptions: new Set(),
          };

    // Register client and upsert daemon state. The daemon registration token
    // (msg.token for full auth) is passed for DaemonState bookkeeping so that
    // evictDaemon can clean up validTokens in O(1) without scanning the map.
    this.registerClient(ws, client);
    this.upsertDaemonState(client, msg.token);

    // Ensure registrations is populated so handleAuthResume's O(1)
    // registrations.has() check works even when the daemon authenticated via
    // a token installed by registerToken() rather than relay.register. The
    // proof field is not available here — record `null` (no proof) rather than
    // an empty string, so a later proof-carrying relay.register is not falsely
    // accepted by the different-credentials guard (proof="" would collide).
    if (msg.role === "daemon" && !this.registrations.has(msg.daemonId)) {
      this.registrations.set(msg.daemonId, { token: msg.token, proof: null });
    }

    const ok: RelayAuthOk = this.buildAuthOk(client, false);
    this.send(ws, ok);
    log.info(`${msg.role} authenticated for daemon ${msg.daemonId}`);

    // Send presence to frontends
    this.broadcastPresence(msg.daemonId);
  }

  /**
   * Fast-path resume. Verifies the HMAC token; on success the socket gets
   * the same ConnectedClient state as a full relay.auth would produce.
   * On any failure we return relay.auth.err so the client falls back to
   * the full auth path (token + role + daemonId).
   */
  private handleAuthResume(
    ws: ServerWebSocket,
    msg: RelayClientMessage & { t: "relay.auth.resume" },
  ) {
    this.metrics.resumesAttempted++;
    const payload = this.resumeSigner.verify(msg.token);
    if (!payload) {
      this.metrics.resumesRejected++;
      this.send(ws, {
        t: "relay.auth.err",
        e: "Resume token invalid or expired",
      });
      return;
    }
    // Daemon must still be a known token holder; resume cannot bypass
    // pairing revocation. (Tokens issued before unregister stay valid until
    // expiry — same trust model as the full relay.auth check.) Check via
    // registrations (daemonId → {token, proof}) for O(1) lookup. The old
    // O(n) scan over validTokens.values() was pre-H5 — now that every
    // registration path keeps registrations in sync with validTokens (and
    // evictDaemon deletes both), registrations.has is the correct O(1) check.
    // Note: registerToken() (test helper only) populates validTokens without
    // registrations; in that narrow case the daemon won't pass resume anyway
    // because resume tokens are issued after a full auth/register cycle.
    const stillRegistered = this.registrations.has(payload.daemonId);
    if (!stillRegistered) {
      this.metrics.resumesRejected++;
      this.send(ws, {
        t: "relay.auth.err",
        e: "Daemon no longer registered",
      });
      return;
    }

    this.clearPendingAuth(ws);

    // Build a typed ConnectedClient from the verified resume token payload.
    // The discriminated union on ResumeTokenPayload guarantees frontendId is
    // structurally present for role=frontend — no optional field, no sentinel.
    const client: ConnectedClient =
      payload.role === "frontend"
        ? {
            ws,
            role: "frontend",
            daemonId: payload.daemonId,
            frontendId: payload.frontendId,
            rateLimiter: { count: 0, windowStart: Date.now() },
            subscriptions: new Set(),
          }
        : {
            ws,
            role: "daemon",
            daemonId: payload.daemonId,
            rateLimiter: { count: 0, windowStart: Date.now() },
            subscriptions: new Set(),
          };

    this.registerClient(ws, client);
    // Resume does not carry the registration token — pass null so
    // upsertDaemonState keeps the existing registrationToken on DaemonState.
    this.upsertDaemonState(client, null);

    this.metrics.resumesAccepted++;
    const ok = this.buildAuthOk(client, true);
    this.send(ws, ok);
    log.info(
      `${payload.role} resumed for daemon ${payload.daemonId}${
        payload.role === "frontend" ? ` (frontendId=${payload.frontendId})` : ""
      }`,
    );
    this.broadcastPresence(payload.daemonId);
  }

  /**
   * Shared helper: add the client to the clients map and daemon group.
   * Called from both handleAuth and handleAuthResume after the ConnectedClient
   * is fully constructed.
   */
  private registerClient(ws: ServerWebSocket, client: ConnectedClient): void {
    this.clients.set(ws, client);
    if (!this.daemonGroups.has(client.daemonId)) {
      this.daemonGroups.set(client.daemonId, new Set());
    }
    this.daemonGroups.get(client.daemonId)?.add(ws);
  }

  /**
   * Shared helper: upsert DaemonState after a successful auth or resume.
   *
   * For role=daemon: sets online=true and preserves existing rateLimiter /
   * sessions / attached so a daemon reconnect does not lose session history.
   * `registrationToken` is set from `regToken` when provided (full auth path)
   * or kept from the existing state (resume path, regToken=null).
   *
   * For role=frontend: ensures a DaemonState entry exists so the group
   * rate-limit check works even when the daemon is still offline.
   */
  private upsertDaemonState(
    client: ConnectedClient,
    regToken: string | null,
  ): void {
    if (client.role === "daemon") {
      const existing = this.daemonStates.get(client.daemonId);
      this.daemonStates.set(client.daemonId, {
        online: true,
        sessions: existing?.sessions ?? new Set(),
        lastSeen: Date.now(),
        attached: existing?.attached ?? new Map(),
        rateLimiter: existing?.rateLimiter ?? {
          count: 0,
          windowStart: Date.now(),
        },
        registrationToken: existing?.registrationToken ?? regToken,
      });
    } else if (!this.daemonStates.has(client.daemonId)) {
      // Frontend reconnects before daemon — seed a minimal DaemonState so the
      // group rate-limit and presence paths don't need null-guards.
      this.daemonStates.set(client.daemonId, {
        online: false,
        sessions: new Set(),
        lastSeen: Date.now(),
        attached: new Map(),
        rateLimiter: { count: 0, windowStart: Date.now() },
        registrationToken: null,
      });
    }
  }

  /**
   * Build a relay.auth.ok response. The discriminated ConnectedClient union
   * makes it impossible to reach the frontend arm without a real frontendId —
   * there is no `?? ""` sentinel and no empty-string that would cause
   * ResumeTokenSigner.verify to reject the token on reconnect.
   */
  private buildAuthOk(client: ConnectedClient, resumed: boolean): RelayAuthOk {
    const { token, expiresAt } = this.resumeSigner.issue(
      client.role === "frontend"
        ? {
            role: "frontend",
            daemonId: client.daemonId,
            frontendId: client.frontendId, // always present: discriminated union
          }
        : { role: "daemon", daemonId: client.daemonId },
    );
    return {
      t: "relay.auth.ok",
      daemonId: client.daemonId,
      resumeToken: token,
      resumeExpiresAt: expiresAt,
      resumed,
    };
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

    // Update daemon state with session. Only the daemon's own traffic refreshes
    // lastSeen — otherwise a frontend that keeps publishing to an already-dead
    // daemon would perpetually reset the offline-eviction clock (checkStaleDaemons
    // evicts on `now - lastSeen > offlineEvictAfterMs`), leaking DaemonState and
    // recentFrames forever. This mirrors handlePing, which also only bumps
    // lastSeen for role=daemon. sessions is daemon-only too: a frontend publishes
    // under the daemon's group but does not define the daemon's session set.
    const state = this.daemonStates.get(client.daemonId);
    if (state && client.role === "daemon") {
      state.sessions.add(msg.sid);
      // Bound the Set: drop oldest sids past the cap (insertion-ordered).
      while (state.sessions.size > MAX_SESSIONS_PER_DAEMON) {
        const oldest = state.sessions.values().next().value;
        if (oldest === undefined) break;
        state.sessions.delete(oldest);
      }
      state.lastSeen = Date.now();
    }

    // Store in recent frames ring buffer. CachedFrame is a discriminated union
    // so the frontend arm requires a frontendId (never undefined).
    if (!this.recentFrames.has(key)) {
      this.recentFrames.set(key, []);
    }
    const frames = this.recentFrames.get(key) ?? [];
    const frame: CachedFrame =
      client.role === "frontend"
        ? {
            from: "frontend",
            sid: msg.sid,
            ct: msg.ct,
            seq: msg.seq,
            frontendId: client.frontendId,
          }
        : { from: "daemon", sid: msg.sid, ct: msg.ct, seq: msg.seq };
    frames.push(frame);
    if (frames.length > this.maxRecentFrames) {
      frames.shift();
    }

    // Forward to all subscribers of this session in the same daemon group
    const group = this.daemonGroups.get(client.daemonId);
    if (!group) return;

    // RelayFrame.frontendId is optional in the wire protocol (it's only
    // meaningful for frontend-originated frames and may be absent for daemon
    // frames). Construct it only when the sender is a frontend.
    const relayFrame: RelayFrame =
      client.role === "frontend"
        ? {
            t: "relay.frame",
            sid: msg.sid,
            ct: msg.ct,
            seq: msg.seq,
            from: "frontend",
            frontendId: client.frontendId,
          }
        : {
            t: "relay.frame",
            sid: msg.sid,
            ct: msg.ct,
            seq: msg.seq,
            from: "daemon",
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

    // Send cached recent frames if requested. CachedFrame is a discriminated
    // union — frontendId is only present on the frontend arm, so we spread the
    // frame into the RelayFrame shape using the discriminant.
    if (msg.after !== undefined) {
      const key = `${client.daemonId}:${msg.sid}`;
      const frames = this.recentFrames.get(key) ?? [];
      for (const frame of frames) {
        if (frame.seq > msg.after) {
          const replayFrame: RelayFrame =
            frame.from === "frontend"
              ? {
                  t: "relay.frame",
                  sid: frame.sid,
                  ct: frame.ct,
                  seq: frame.seq,
                  from: "frontend",
                  frontendId: frame.frontendId,
                }
              : {
                  t: "relay.frame",
                  sid: frame.sid,
                  ct: frame.ct,
                  seq: frame.seq,
                  from: "daemon",
                };
          this.send(ws, replayFrame);
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

    // Update attached count. Only decrement when the key is present —
    // mirroring the M13 fix in handleClose: no phantom ?? 1 fallback.
    if (client.role === "frontend") {
      const state = this.daemonStates.get(client.daemonId);
      if (state) {
        const current = state.attached.get(msg.sid);
        if (current !== undefined) {
          const next = current - 1;
          if (next <= 0) state.attached.delete(msg.sid);
          else state.attached.set(msg.sid, next);
        }
      }
    }
  }

  private handleClose(ws: ServerWebSocket) {
    this.clearPendingAuth(ws);
    const client = this.clients.get(ws);
    if (!client) return;

    this.clients.delete(ws);

    // Release attached-frontend counts for every session this frontend was
    // subscribed to. A frontend that drops without sending relay.unsub (tab
    // close, network loss, crash) would otherwise leak its attached count,
    // pinning state.attached above zero forever and skewing presence/metrics.
    // Mirror handleUnsubscribe's decrement, but across all subscriptions.
    //
    // M13 fix: only decrement when the key is actually present. The old
    // `?? 1` fallback would subtract 1 from a phantom "1" and delete an
    // entry that was never set, potentially clobbering another frontend's
    // session tracking that arrives between this close and a subscribe.
    if (client.role === "frontend") {
      const state = this.daemonStates.get(client.daemonId);
      if (state) {
        for (const sid of client.subscriptions) {
          const current = state.attached.get(sid);
          if (current === undefined) continue; // key absent — nothing to release
          const next = current - 1;
          if (next <= 0) state.attached.delete(sid);
          else state.attached.set(sid, next);
        }
      }
    }

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
    // relay.ping is exempt from the per-client / per-daemon-group rate limit
    // (line 620) so authenticated keepalives never get throttled. That exemption
    // must NOT extend to unauthenticated sockets — otherwise a peer that never
    // sends relay.auth can flood relay.ping and get unlimited relay.pong replies
    // within the 10s auth-timeout window, an unauthenticated CPU amplifier.
    // Only known (authenticated) clients get a pong.
    const client = this.clients.get(ws);
    if (!client) return;
    // Update lastSeen for daemon clients
    if (client.role === "daemon") {
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

    // The guard enforces exactly one of {token, sealed} is present.
    // Path X: if `sealed` is present, unseal before calling Expo.
    // Legacy: if `token` is present, use it directly (plaintext back-compat).
    let plaintextToken: string;
    if (msg.sealed !== undefined) {
      const unsealResult = await this.pushSealer.unseal(msg.sealed);
      if (unsealResult.ok) {
        plaintextToken = unsealResult.token;
      } else if (unsealResult.reason === "legacy") {
        // A non-"tpps1." blob arrived in the `sealed` slot. This happens in the
        // upgrade window when an old daemon (no token/sealed split) puts a
        // plaintext Expo token into `sealed`. Use it verbatim — same treatment
        // as the `token` field — so the push isn't dropped. (A new daemon sends
        // such legacy plaintext via `token`, but we accept it here too.)
        plaintextToken = msg.sealed;
      } else {
        // reason === "unseal_failed": a real "tpps1." blob we cannot decrypt
        // (key rotated out of the current/prev window, or tampered). The token
        // is unrecoverable — signal the daemon to drop it and let the app
        // re-register a fresh sealed token.
        log.warn(
          `push unseal failed for frontendId ${msg.frontendId}: reason=${unsealResult.reason}`,
        );
        this.send(ws, {
          t: "relay.err",
          e: "PUSH_UNSEAL_FAILED",
          m: `Push token unseal failed for frontendId ${msg.frontendId}`,
        });
        return;
      }
    } else {
      // Legacy plaintext token path (back-compat)
      plaintextToken = msg.token ?? "";
    }

    const result = await this.pushService.sendOrDeliver({
      frontendId: msg.frontendId,
      daemonId: client.daemonId,
      token: plaintextToken,
      title: msg.title,
      body: msg.body,
      isFrontendConnected,
      interruptionLevel: msg.interruptionLevel,
      data: msg.data,
    });

    // Exhaustive switch over DeliveryResult — all variants are handled
    // explicitly so a future variant added to DeliveryResult becomes a
    // compile error (TypeScript narrows `result` to `never` in the default arm).
    switch (result) {
      case "ws":
        // Frontend is live on WebSocket — deliver in-band as a notification.
        if (targetFrontendWs) {
          const notification: RelayNotification = {
            t: "relay.notification",
            title: msg.title,
            body: msg.body,
            data: msg.data,
          };
          this.send(targetFrontendWs, notification);
        }
        break;
      case "push":
        // Expo push sent successfully — no reply needed; daemon is fire-and-forget.
        log.debug(`push delivered via Expo for frontendId ${msg.frontendId}`);
        break;
      case "rate_limited":
        // Push rate-limited — inform the daemon so it can back off.
        this.send(ws, {
          t: "relay.err",
          e: "PUSH_RATE_LIMITED",
          m: `Push rate limit exceeded for frontendId ${msg.frontendId}`,
        });
        break;
      case "deduped":
        // Duplicate push suppressed within the dedup window — log only.
        log.debug(`push deduped for frontendId ${msg.frontendId}`);
        break;
      case "error":
        // Expo API error — inform the daemon so it can retry or surface.
        this.send(ws, {
          t: "relay.err",
          e: "PUSH_DELIVERY_ERROR",
          m: `Push delivery failed for frontendId ${msg.frontendId}`,
        });
        break;
      default: {
        // Compile-time exhaustiveness guard.
        const _exhaustive: never = result;
        log.error(`unhandled DeliveryResult: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /**
   * Handle a relay.push.register from an authenticated frontend.
   *
   * Seals the plaintext token with the relay-side key and routes
   * relay.push.token { frontendId, sealed, platform } to the daemon socket
   * in the same daemon group. The daemon persists the sealed blob; the relay
   * only ever handles the plaintext transiently during this call.
   */
  private async handlePushRegister(
    ws: ServerWebSocket,
    msg: RelayClientMessage & { t: "relay.push.register" },
  ): Promise<void> {
    const client = this.clients.get(ws);
    if (!client || client.role !== "frontend") {
      this.send(ws, {
        t: "relay.err",
        e: "UNAUTHORIZED",
        m: "Only frontends can send relay.push.register",
      });
      return;
    }

    // Find the daemon socket in the same daemon group
    const group = this.daemonGroups.get(client.daemonId);
    let daemonWs: ServerWebSocket | null = null;
    if (group) {
      for (const memberWs of group) {
        const member = this.clients.get(memberWs);
        if (member && member.role === "daemon") {
          daemonWs = memberWs;
          break;
        }
      }
    }

    // Seal the plaintext token
    const sealed = await this.pushSealer.seal(msg.token);

    if (!daemonWs) {
      // Daemon not connected — drop silently; the frontend will re-register
      // on reconnect.
      log.debug(
        `relay.push.register: no daemon connected for group ${client.daemonId}, dropping sealed token for frontend ${msg.frontendId}`,
      );
      return;
    }

    // Route relay.push.token to the daemon
    this.send(daemonWs, {
      t: "relay.push.token",
      frontendId: msg.frontendId,
      sealed,
      platform: msg.platform,
    });
    log.debug(
      `relay.push.register: sealed token routed to daemon for frontend ${msg.frontendId} (platform=${msg.platform})`,
    );
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
        now - state.lastSeen > this.offlineEvictAfterMs
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
   *
   * H5 fix: also removes the daemon's entry from validTokens and registrations
   * so its token cannot be used for auth after eviction (security: token-expiry
   * bypass). Uses O(1) lookup via daemonState.registrationToken — no scan.
   */
  private evictDaemon(daemonId: string): void {
    // O(1) token cleanup: grab the token stored on the state, then delete both
    // validTokens and registrations entries before dropping the state.
    const state = this.daemonStates.get(daemonId);
    if (state?.registrationToken) {
      this.validTokens.delete(state.registrationToken);
    }
    this.registrations.delete(daemonId);
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
