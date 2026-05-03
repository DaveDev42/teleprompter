/**
 * Frontend-side Relay client (v2).
 *
 * Connects to a Relay server via the pairing data obtained from QR scan.
 * Performs in-band key exchange to deliver the frontend's public key
 * to the daemon. Encrypts outgoing input and decrypts incoming records.
 *
 * Implements TransportClient for unified transport layer.
 */

import type {
  ControlRename,
  ControlUnpair,
  KeyPair,
  RecordKind,
  RelayClientMessage,
  RelayFrame,
  RelayServerMessage,
  SessionKeys,
  WsClientMessage,
  WsRec,
  WsSessionMeta,
  WsWorktreeInfo,
} from "@teleprompter/protocol/client";
import {
  CONTROL_RENAME,
  CONTROL_UNPAIR,
  decrypt,
  deriveKxKey,
  deriveSessionKeys,
  encrypt,
  RELAY_CHANNEL_CONTROL,
  RELAY_CHANNEL_META,
  toBase64,
} from "@teleprompter/protocol/client";
import { secureDelete, secureGet, secureSet } from "./secure-storage";
import type { TransportClient, TransportEventHandler } from "./transport";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
/** secure-storage key prefix for cached resume tokens (per daemonId). */
const RESUME_TOKEN_KEY_PREFIX = "relay_resume_";
/**
 * Max frames queued while waiting for relay auth + key exchange to complete.
 * Flushed on `relay.auth.ok` (after sendKeyExchange), cleared on WS close.
 * Guards against unbounded growth if the peer never authenticates.
 */
const MAX_PENDING_ENCRYPTED = 32;

export interface FrontendRelayConfig {
  relayUrl: string;
  daemonId: string;
  token: string;
  /** Frontend key pair */
  keyPair: KeyPair;
  /** Daemon public key (from QR pairing data) */
  daemonPublicKey: Uint8Array;
  /** Raw pairing secret (for kx envelope encryption) */
  pairingSecret: Uint8Array;
  /** Unique frontend identifier for N:N multiplexing */
  frontendId: string;
}

export interface FrontendRelayEvents extends TransportEventHandler {
  /** Fired after relay auth succeeds (distinct from onOpen which fires on WS open) */
  onConnected?: () => void;
  /** Fired on WS close (distinct from onClose in TransportEventHandler — both fire) */
  onDisconnected?: () => void;
  /** Daemon online/offline presence */
  onPresence?: (online: boolean, sessions: string[]) => void;
  /** Push notification received from relay (plaintext) */
  onNotification?: (
    title: string,
    body: string,
    data?: { sid: string; daemonId: string; event: string },
  ) => void;
}

export class FrontendRelayClient implements TransportClient {
  private ws: WebSocket | null = null;
  private config: FrontendRelayConfig;
  private events: FrontendRelayEvents;
  private sessionKeys: SessionKeys | null = null;
  private kxKey: Uint8Array | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private authenticated = false;
  private subscribedSessions = new Set<string>();
  /**
   * Frames that were submitted to an encrypt-and-publish helper before the
   * relay was authenticated. Drained on auth.ok (after kx). Previously
   * dropped silently, which caused ChatView's early resume() to be lost on
   * cold session URL access — daemon never replayed records, Chat/Terminal
   * stayed blank. Push-token, unpair, and rename notices share the same
   * race class and funnel through this queue too.
   *
   * `sid` is the relay-envelope channel; when omitted, sendEncrypted falls
   * back to the control channel (matches its direct-send behavior).
   */
  private pendingEncrypted: Array<{
    msg: Record<string, unknown>;
    sid?: string;
  }> = [];

  /** Called when daemon notifies this frontend that its pairing was removed. */
  onUnpair:
    | ((info: { daemonId: string; reason: ControlUnpair["reason"] }) => void)
    | null = null;

  /** Called when daemon notifies this frontend that the pairing label was changed. */
  onRename: ((info: { daemonId: string; label: string }) => void) | null = null;

  /**
   * Called when the daemon broadcasts its public key after auth (relay.kx).
   * Carries the label the daemon was paired with so the frontend can adopt
   * it without burning bytes in the QR. `label === null` means the daemon
   * has no label set; the frontend should keep its existing fallback.
   */
  onDaemonHello:
    | ((info: { daemonId: string; label: string | null }) => void)
    | null = null;

  /** Track attached session and last seq for auto-resume on reconnect */
  private attachedSid: string | null = null;
  private lastSeq = 0;
  private hasConnectedBefore = false;
  private pingStart = 0;
  /** Last measured round-trip time in ms */
  private rtt = -1;
  /**
   * Resume token from the previous successful relay.auth.ok. Sent via
   * relay.auth.resume on the next connect to skip register+auth+kx. Null
   * until the relay issues one or until secure-storage hydration finishes.
   */
  private resumeToken: string | null = null;
  private resumeExpiresAt = 0;
  /**
   * True between sending relay.auth.resume and receiving auth.ok / auth.err.
   * Used so an auth.err during resume drops the cached token and reconnects
   * via the slow path instead of bubbling up as a fatal error.
   */
  private resuming = false;
  /** True once we've tried to hydrate the cached token from secure-storage. */
  private hydratedResume = false;

  constructor(config: FrontendRelayConfig, events: FrontendRelayEvents = {}) {
    this.config = config;
    this.events = events;
  }

  set onSessionExported(handler:
    | ((sid: string, format: string, content: string) => void)
    | undefined,) {
    this.events.onSessionExported = handler;
  }

  async connect(): Promise<void> {
    if (this.disposed) return;

    // Derive session keys from daemon's public key (from QR)
    if (!this.sessionKeys) {
      this.sessionKeys = await deriveSessionKeys(
        this.config.keyPair,
        this.config.daemonPublicKey,
        "frontend",
      );
    }

    // Derive kx key for key exchange envelope
    if (!this.kxKey) {
      this.kxKey = await deriveKxKey(this.config.pairingSecret);
    }

    // Hydrate cached resume token on first connect. Done lazily here so the
    // constructor stays sync. If hydration fails or the cached entry has
    // expired we just fall through to the slow auth path — no error
    // surfaced to the user.
    if (!this.hydratedResume) {
      this.hydratedResume = true;
      try {
        const cached = await secureGet(
          `${RESUME_TOKEN_KEY_PREFIX}${this.config.daemonId}`,
        );
        if (cached) {
          const parsed = JSON.parse(cached) as {
            token: string;
            expiresAt: number;
          };
          if (parsed.token && parsed.expiresAt > Date.now()) {
            this.resumeToken = parsed.token;
            this.resumeExpiresAt = parsed.expiresAt;
          } else {
            await secureDelete(
              `${RESUME_TOKEN_KEY_PREFIX}${this.config.daemonId}`,
            );
          }
        }
      } catch {
        // ignore — slow path is always safe
      }
    }

    this.cleanup();

    const ws = new WebSocket(this.config.relayUrl);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.events.onOpen?.();
      if (this.resumeToken && this.resumeExpiresAt > Date.now()) {
        this.resuming = true;
        this.sendRelay({
          t: "relay.auth.resume",
          v: 1,
          token: this.resumeToken,
        });
        return;
      }
      this.sendRelay({
        t: "relay.auth",
        role: "frontend",
        daemonId: this.config.daemonId,
        token: this.config.token,
        frontendId: this.config.frontendId,
        v: 2,
      });
    };

    ws.onmessage = (event) => {
      try {
        const msg: RelayServerMessage = JSON.parse(event.data as string);
        this.handleMessage(msg);
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      this.authenticated = false;
      // Clear any frames still parked waiting for auth — a brand-new
      // connection cycle will re-run kx and the stale queue is meaningless
      // (and `resume`/`attach` will be re-issued by callers or by the
      // auto-resume path in handleMessage).
      this.pendingEncrypted = [];
      this.events.onClose?.();
      this.events.onDisconnected?.();
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      this.events.onError?.("Relay WebSocket error");
    };
  }

  private async handleMessage(msg: RelayServerMessage): Promise<void> {
    switch (msg.t) {
      case "relay.auth.ok": {
        this.authenticated = true;
        const resumed = this.resuming && msg.resumed === true;
        this.resuming = false;
        if (msg.resumeToken && msg.resumeExpiresAt) {
          this.resumeToken = msg.resumeToken;
          this.resumeExpiresAt = msg.resumeExpiresAt;
          // Persist async — never block the auth flow on storage.
          void secureSet(
            `${RESUME_TOKEN_KEY_PREFIX}${this.config.daemonId}`,
            JSON.stringify({
              token: msg.resumeToken,
              expiresAt: msg.resumeExpiresAt,
            }),
          ).catch(() => {});
        }
        this.events.onConnected?.();
        // Subscribe to meta + control channels
        this.sendRelay({ t: "relay.sub", sid: RELAY_CHANNEL_META });
        this.sendRelay({ t: "relay.sub", sid: RELAY_CHANNEL_CONTROL });
        // Re-subscribe to all sessions
        for (const sid of this.subscribedSessions) {
          this.sendRelay({ t: "relay.sub", sid });
        }
        // On resume the daemon already holds our public key — skip kx and
        // its session-key derivation. On a fresh auth we must run kx so the
        // daemon can decrypt our frames.
        if (!resumed) {
          await this.sendKeyExchange();
        }
        // Drain any frames queued while auth/kx was pending. Must happen
        // AFTER kx (when applicable) so the daemon can decrypt them.
        await this.flushPendingEncrypted();
        // Auto-resume if we were previously attached
        if (this.hasConnectedBefore && this.attachedSid) {
          this.resume(this.attachedSid, this.lastSeq);
        }
        this.hasConnectedBefore = true;
        break;
      }

      case "relay.auth.err":
        if (this.resuming) {
          // Resume rejected — drop the cached token and reconnect via the
          // slow path. The onclose handler schedules the retry; we just
          // need to make sure we don't surface this as a fatal error.
          this.resuming = false;
          this.resumeToken = null;
          this.resumeExpiresAt = 0;
          void secureDelete(
            `${RESUME_TOKEN_KEY_PREFIX}${this.config.daemonId}`,
          ).catch(() => {});
          this.ws?.close();
          break;
        }
        this.events.onError?.(`Relay auth failed: ${msg.e}`);
        break;

      case "relay.kx.frame":
        // Daemon broadcasted its public key (we already have it from QR).
        // The encrypted payload also carries the daemon's label — decrypt
        // it so the frontend can adopt the daemon's name without it taking
        // up bytes in the QR.
        await this.handleDaemonKxFrame(msg);
        break;

      case "relay.frame":
        await this.handleFrame(msg);
        break;

      case "relay.notification":
        this.events.onNotification?.(msg.title, msg.body, msg.data);
        break;

      case "relay.presence":
        this.events.onPresence?.(msg.online, msg.sessions);
        break;

      case "relay.pong":
        break;

      case "relay.err": {
        const errMsg = msg as { m?: string; e?: string };
        this.events.onError?.(`Relay error: ${errMsg.m ?? errMsg.e}`);
        break;
      }
    }
  }

  /**
   * Decrypt the daemon's relay.kx broadcast and surface its label.
   * The pubkey itself is redundant (we already have it from QR), but the
   * label arrives here instead of in the QR to keep the QR small.
   * Decryption failures are swallowed — the worst case is the frontend
   * keeps its fallback label, which is acceptable.
   */
  private async handleDaemonKxFrame(frame: {
    ct: string;
    from: "daemon" | "frontend";
  }): Promise<void> {
    if (frame.from !== "daemon") return;
    if (!this.kxKey) return;
    try {
      const plaintext = await decrypt(frame.ct, this.kxKey);
      const data = JSON.parse(new TextDecoder().decode(plaintext)) as {
        pk?: unknown;
        role?: unknown;
        label?: unknown;
      };
      // `label` is optional on the wire so older daemons stay compatible —
      // a missing or non-string value maps to null, which the store treats
      // as "keep current label".
      const label = typeof data.label === "string" ? data.label : null;
      this.onDaemonHello?.({ daemonId: this.config.daemonId, label });
    } catch {
      // Decrypt or parse failure — ignore, fallback label stays in effect.
    }
  }

  /**
   * Send the frontend's public key to the daemon via relay key exchange.
   * Encrypted with kxKey so only pairing secret holders can read it.
   */
  private async sendKeyExchange(): Promise<void> {
    if (!this.kxKey) return;

    const payload = JSON.stringify({
      pk: await toBase64(this.config.keyPair.publicKey),
      frontendId: this.config.frontendId,
      role: "frontend",
    });
    const ct = await encrypt(new TextEncoder().encode(payload), this.kxKey);
    this.sendRelay({ t: "relay.kx", ct, role: "frontend" });
  }

  private async handleFrame(frame: RelayFrame): Promise<void> {
    if (frame.from !== "daemon") return;
    if (!this.sessionKeys) return;

    try {
      const plaintext = await decrypt(frame.ct, this.sessionKeys.rx);
      const text = new TextDecoder().decode(plaintext);
      const msg = JSON.parse(text);

      switch (msg.t) {
        case "rec":
          this.trackSeq(msg.seq);
          this.events.onRec?.(msg as WsRec);
          break;
        case "batch":
          for (const rec of msg.d) {
            this.trackSeq(rec.seq);
            this.events.onRec?.(rec as WsRec);
          }
          break;
        case "state":
          this.events.onState?.(msg.sid, msg.d as WsSessionMeta);
          break;
        case "hello":
          this.events.onSessionList?.(msg.d.sessions as WsSessionMeta[]);
          break;
        case "pong":
          if (this.pingStart > 0) {
            this.rtt = Date.now() - this.pingStart;
            this.pingStart = 0;
          }
          break;
        case "err":
          this.events.onError?.(msg.m ?? msg.e);
          break;
        case "worktree.list":
          this.events.onWorktreeList?.(msg.d as WsWorktreeInfo[]);
          break;
        case "worktree.created":
          this.events.onWorktreeCreated?.(
            msg.d as WsWorktreeInfo,
            msg.sid as string | undefined,
          );
          break;
        case "session.exported":
          this.events.onSessionExported?.(msg.sid, msg.format, msg.d);
          break;
        case CONTROL_UNPAIR: {
          if (frame.sid !== RELAY_CHANNEL_CONTROL) {
            console.warn(
              `[FrontendRelay] ignoring ${CONTROL_UNPAIR} on non-control sid=${frame.sid}`,
            );
            break;
          }
          const rawReason = msg.reason;
          const reason: ControlUnpair["reason"] =
            rawReason === "user-initiated" ||
            rawReason === "device-removed" ||
            rawReason === "rotated"
              ? rawReason
              : "user-initiated";
          const daemonId =
            typeof msg.daemonId === "string"
              ? msg.daemonId
              : this.config.daemonId;
          this.onUnpair?.({ daemonId, reason });
          break;
        }
        case CONTROL_RENAME: {
          if (frame.sid !== RELAY_CHANNEL_CONTROL) {
            console.warn(
              `[FrontendRelay] ignoring ${CONTROL_RENAME} on non-control sid=${frame.sid}`,
            );
            break;
          }
          const label = typeof msg.label === "string" ? msg.label : "";
          const daemonId =
            typeof msg.daemonId === "string"
              ? msg.daemonId
              : this.config.daemonId;
          this.onRename?.({ daemonId, label });
          break;
        }
        default:
          console.warn(`[FrontendRelay] unknown message type: ${msg.t}`);
      }
    } catch (err) {
      // Daemon broadcasts control-plane messages (unpair/rename on
      // __control__, and potentially future fan-out on __meta__) to every
      // paired frontend, but each frame is encrypted with a per-frontend
      // session key. So the N-1 frames that aren't ours will fail AEAD
      // verification — expected traffic, not an error. Demote to debug
      // and skip onError so it never surfaces as a user-visible toast.
      //
      // Note the asymmetry with the switch above: valid control messages
      // arriving on the *wrong* sid (e.g. CONTROL_UNPAIR on "s1") are
      // rejected earlier with console.warn. This branch only fires when
      // AEAD itself fails. Missing/undefined frame.sid intentionally
      // falls through to the error path — that is a truly malformed
      // frame worth surfacing loudly.
      if (
        frame.sid === RELAY_CHANNEL_CONTROL ||
        frame.sid === RELAY_CHANNEL_META
      ) {
        console.debug(
          `[FrontendRelay] decrypt failed on ${frame.sid} (expected — frame not addressed to us):`,
          err,
        );
        return;
      }
      console.error(
        `[FrontendRelay] decrypt failed for sid=${frame.sid}:`,
        err,
      );
    }
  }

  private trackSeq(seq: number) {
    if (seq > this.lastSeq) {
      this.lastSeq = seq;
    }
  }

  /** Encrypt and send push token to daemon via relay meta channel */
  async sendPushToken(
    token: string,
    platform: "ios" | "android",
  ): Promise<void> {
    await this.sendEncrypted(
      { t: "pushToken", token, platform },
      RELAY_CHANNEL_META,
    );
  }

  /**
   * Send a control.unpair notice to the daemon over the E2EE data channel.
   *
   * Frontend has a single peer (the daemon), so no peer selector is needed —
   * unlike the daemon side which picks a frontend.
   */
  async sendUnpairNotice(
    reason: ControlUnpair["reason"] = "user-initiated",
  ): Promise<void> {
    const msg: ControlUnpair = {
      t: CONTROL_UNPAIR,
      daemonId: this.config.daemonId,
      frontendId: this.config.frontendId,
      reason,
      ts: Date.now(),
    };
    await this.sendEncrypted(
      msg as unknown as Record<string, unknown>,
      RELAY_CHANNEL_CONTROL,
    );
  }

  /**
   * Send a control.rename notice to the daemon over the E2EE control channel.
   * Mirrors `sendUnpairNotice` structurally.
   */
  async sendRenameNotice(label: string): Promise<void> {
    const msg: ControlRename = {
      t: CONTROL_RENAME,
      daemonId: this.config.daemonId,
      frontendId: this.config.frontendId,
      label,
      ts: Date.now(),
    };
    await this.sendEncrypted(
      msg as unknown as Record<string, unknown>,
      RELAY_CHANNEL_CONTROL,
    );
  }

  // ── Encrypted control message sender ──

  private async sendEncrypted(
    msg: Record<string, unknown>,
    sidOverride?: string,
  ): Promise<void> {
    if (!this.authenticated || !this.sessionKeys) {
      this.enqueuePending(msg, sidOverride);
      return;
    }

    try {
      const ct = await encrypt(
        new TextEncoder().encode(JSON.stringify(msg)),
        this.sessionKeys.tx,
      );

      const sid = sidOverride ?? (msg.sid as string) ?? RELAY_CHANNEL_CONTROL;
      this.sendRelay({ t: "relay.pub", sid, ct, seq: 0 });
    } catch {
      console.error(`[FrontendRelay] encrypt failed for ${msg.t}`);
    }
  }

  /**
   * Park a frame until relay auth + key exchange finishes. Bounded at
   * MAX_PENDING_ENCRYPTED; the oldest frame is dropped when the cap is hit
   * so a misbehaving peer can't grow this unboundedly.
   */
  private enqueuePending(msg: Record<string, unknown>, sid?: string): void {
    if (this.pendingEncrypted.length >= MAX_PENDING_ENCRYPTED) {
      const dropped = this.pendingEncrypted.shift();
      console.warn(
        `[FrontendRelay] pending queue full, dropping oldest ${
          dropped?.msg.t ?? "?"
        }`,
      );
    }
    this.pendingEncrypted.push({ msg, sid });
  }

  /**
   * Called right after sendKeyExchange on relay.auth.ok. Drains everything
   * that was queued during the kx race (e.g. ChatView's resume-on-mount).
   * Swapping the buffer first means any new enqueues triggered mid-flush
   * (which shouldn't happen — we're authenticated now — but defensively)
   * go into a fresh array rather than mutating the one we're iterating.
   */
  private async flushPendingEncrypted(): Promise<void> {
    if (this.pendingEncrypted.length === 0) return;
    const pending = this.pendingEncrypted;
    this.pendingEncrypted = [];
    for (const { msg, sid } of pending) {
      await this.sendEncrypted(msg, sid);
    }
  }

  // ── TransportClient: Session attachment ──

  attach(sid: string): void {
    this.attachedSid = sid;
    this.subscribe(sid);
    this.sendEncrypted({ t: "attach", sid });
  }

  detach(sid: string): void {
    if (this.attachedSid === sid) {
      this.attachedSid = null;
    }
    this.sendEncrypted({ t: "detach", sid });
  }

  resume(sid: string, cursor: number): void {
    this.attachedSid = sid;
    this.subscribe(sid);
    this.sendEncrypted({ t: "resume", sid, c: cursor });
  }

  // ── TransportClient: Input ──

  sendChat(sid: string, text: string): void {
    this.sendEncrypted({ t: "in.chat", sid, d: text });
  }

  sendTermInput(sid: string, data: string): void {
    this.sendEncrypted({ t: "in.term", sid, d: data });
  }

  send(msg: WsClientMessage): void {
    this.sendEncrypted(msg as unknown as Record<string, unknown>);
  }

  // ── TransportClient: Session management ──

  createSession(cwd: string, sid?: string): void {
    this.sendEncrypted({ t: "session.create", cwd, sid });
  }

  stopSession(sid: string): void {
    this.sendEncrypted({ t: "session.stop", sid });
  }

  restartSession(sid: string): void {
    this.sendEncrypted({ t: "session.restart", sid });
  }

  exportSession(
    sid: string,
    format: "json" | "markdown" = "markdown",
    opts?: {
      recordTypes?: RecordKind[];
      timeRange?: { from?: number; to?: number };
      limit?: number;
    },
  ): void {
    this.sendEncrypted({ t: "session.export", sid, format, ...opts });
  }

  // ── TransportClient: Worktree management ──

  requestWorktreeList(): void {
    this.sendEncrypted({ t: "worktree.list" });
  }

  createWorktree(branch: string, baseBranch?: string, path?: string): void {
    this.sendEncrypted({ t: "worktree.create", branch, baseBranch, path });
  }

  removeWorktree(path: string, force?: boolean): void {
    this.sendEncrypted({ t: "worktree.remove", path, force });
  }

  // ── TransportClient: Diagnostics ──

  ping(): void {
    this.pingStart = Date.now();
    // Send encrypted ping to daemon for E2E RTT measurement
    this.sendEncrypted({ t: "ping" });
  }

  getRtt(): number {
    return this.rtt;
  }

  // ── Relay subscription (relay-specific, not in TransportClient) ──

  subscribe(sid: string): void {
    this.subscribedSessions.add(sid);
    if (this.authenticated) {
      this.sendRelay({ t: "relay.sub", sid });
    }
  }

  unsubscribe(sid: string): void {
    this.subscribedSessions.delete(sid);
    if (this.authenticated) {
      this.sendRelay({ t: "relay.unsub", sid });
    }
  }

  // ── Internal ──

  private sendRelay(msg: RelayClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private cleanup(): void {
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

  dispose(): void {
    this.disposed = true;
    this.cleanup();
  }

  isConnected(): boolean {
    return this.authenticated;
  }
}
