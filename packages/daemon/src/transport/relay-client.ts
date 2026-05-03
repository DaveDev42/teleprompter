/**
 * Daemon-side Relay client (v2).
 *
 * Connects to a Relay server with self-registration, authenticates,
 * performs in-band key exchange with frontends, and manages per-frontend
 * E2EE session keys for N:N multiplexing.
 */

import type {
  ControlRename,
  ControlUnpair,
  KeyPair,
  RelayClientMessage,
  RelayControlMessage,
  RelayFrame,
  RelayKeyExchangeFrame,
  RelayServerMessage,
  SessionKeys,
  WsRec,
} from "@teleprompter/protocol";
import {
  CONTROL_RENAME,
  CONTROL_UNPAIR,
  createLogger,
  decrypt,
  deriveKxKey,
  deriveSessionKeys,
  encrypt,
  fromBase64,
  parseRelayControlMessage,
  RELAY_CHANNEL_CONTROL,
  toBase64,
} from "@teleprompter/protocol";

const log = createLogger("RelayClient");

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
/** How often to send relay.ping (ms) */
const PING_INTERVAL_MS = 30_000;

interface FrontendPeer {
  frontendId: string;
  publicKey: Uint8Array;
  sessionKeys: SessionKeys;
}

export interface RelayClientConfig {
  /** Relay server URL (e.g., wss://relay.example.com) */
  relayUrl: string;
  /** Daemon ID */
  daemonId: string;
  /** Relay auth token (derived from pairing secret) */
  token: string;
  /** Registration proof for relay self-registration */
  registrationProof: string;
  /** Daemon key pair for E2EE */
  keyPair: KeyPair;
  /** Raw pairing secret (for kx envelope encryption) */
  pairingSecret: Uint8Array;
  /** Optional human-readable label for this pairing */
  label?: string | null;
}

export interface RelayClientEvents {
  /** Called when a decrypted input arrives from a frontend via relay */
  onInput?: (
    kind: "chat" | "term",
    sid: string,
    data: string,
    frontendId?: string,
  ) => void;
  /** Called when a decrypted control message arrives from a frontend via relay */
  onControlMessage?: (msg: RelayControlMessage, frontendId: string) => void;
  /** Called when relay connection state changes */
  onConnected?: () => void;
  onDisconnected?: () => void;
  /** Called when relay reports presence */
  onPresence?: (online: boolean, sessions?: string[]) => void;
  /** Called when a new frontend completes key exchange */
  onFrontendJoined?: (frontendId: string) => void;
  /** Called when a frontend sends a pushToken message */
  onPushToken?: (
    frontendId: string,
    token: string,
    platform: "ios" | "android",
  ) => void;
}

export class RelayClient {
  private ws: WebSocket | null = null;
  private config: RelayClientConfig;
  private events: RelayClientEvents;
  /** Per-frontend E2EE peers */
  private peers = new Map<string, FrontendPeer>();
  /** Symmetric key for key-exchange envelopes (from pairing secret) */
  private kxKey: Uint8Array | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private authenticated = false;
  private subscribedSessions = new Set<string>();
  /**
   * Resume token issued by the relay on the previous successful auth. Used to
   * skip register+auth on reconnect; a single failed resume falls back to the
   * full handshake on the next connection attempt.
   */
  private resumeToken: string | null = null;
  private resumeExpiresAt = 0;
  /**
   * True while the current connection is mid-resume — set after sending
   * `relay.auth.resume`, cleared on auth.ok or auth.err. Used so an
   * `auth.err` on a resume attempt schedules a fresh full-auth reconnect
   * instead of giving up.
   */
  private resuming = false;

  /** Called when an inbound control.unpair frame is received from a frontend. */
  onUnpair:
    | ((info: { frontendId: string; reason: ControlUnpair["reason"] }) => void)
    | null = null;

  /** Called when an inbound control.rename frame is received from a frontend. */
  onRename: ((info: { frontendId: string; label: string }) => void) | null =
    null;

  constructor(config: RelayClientConfig, events: RelayClientEvents = {}) {
    this.config = config;
    this.events = events;
  }

  async connect(): Promise<void> {
    if (this.disposed) return;

    // Derive kx key from pairing secret (for key exchange envelopes)
    if (!this.kxKey) {
      this.kxKey = await deriveKxKey(this.config.pairingSecret);
    }

    this.cleanup();

    const ws = new WebSocket(this.config.relayUrl);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      // Fast path: try resume if we have a non-expired token from a previous
      // session. The relay still issues a fresh token in resume.ok, so the
      // window keeps rolling forward as long as connectivity is healthy.
      if (this.resumeToken && Date.now() < this.resumeExpiresAt) {
        this.resuming = true;
        this.send({
          t: "relay.auth.resume",
          token: this.resumeToken,
          v: 2,
        });
        return;
      }
      // Slow path: full self-register + auth.
      this.send({
        t: "relay.register",
        daemonId: this.config.daemonId,
        proof: this.config.registrationProof,
        token: this.config.token,
        v: 2,
      });
    };

    ws.onmessage = (event) => {
      try {
        const msg: RelayServerMessage = JSON.parse(event.data as string);
        this.handleMessage(msg);
      } catch {
        // ignore malformed
      }
    };

    ws.onclose = () => {
      this.authenticated = false;
      this.events.onDisconnected?.();
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  private async handleMessage(msg: RelayServerMessage): Promise<void> {
    switch (msg.t) {
      case "relay.register.ok":
        // Step 2: Authenticate
        this.send({
          t: "relay.auth",
          role: "daemon",
          daemonId: this.config.daemonId,
          token: this.config.token,
          v: 2,
        });
        break;

      case "relay.register.err":
        log.error(`registration failed: ${msg.e}`);
        break;

      case "relay.auth.ok":
        this.authenticated = true;
        // Cache the rolling resume token for the next reconnect.
        if (msg.resumeToken && msg.resumeExpiresAt) {
          this.resumeToken = msg.resumeToken;
          this.resumeExpiresAt = msg.resumeExpiresAt;
        }
        this.resuming = false;
        this.events.onConnected?.();
        // Re-subscribe to all sessions
        for (const sid of this.subscribedSessions) {
          this.send({ t: "relay.sub", sid });
        }
        // Step 3: Broadcast daemon's public key for key exchange. Skip when
        // we resumed AND we already have peers — the keypair is stable across
        // reconnects so existing peers' sessionKeys are still valid. Saves
        // one encrypted frame per resume per pairing without weakening kx
        // (any frontend that joined while we were offline will trigger kx
        // via its own auth.ok path).
        if (!(msg.resumed && this.peers.size > 0)) {
          await this.broadcastDaemonPublicKey();
        }
        // Step 4: Start heartbeat ping
        this.startPing();
        log.info(`${msg.resumed ? "resumed" : "authenticated"} to relay`);
        break;

      case "relay.auth.err":
        if (this.resuming) {
          // Resume failed (token expired / rotated secret / daemon
          // unregistered). Drop the token and reconnect; ws.onopen will pick
          // the slow path.
          this.resuming = false;
          this.resumeToken = null;
          this.resumeExpiresAt = 0;
          log.warn(`resume rejected (${msg.e}); falling back to full auth`);
          this.ws?.close();
          break;
        }
        log.error(`auth failed: ${msg.e}`);
        break;

      case "relay.kx.frame":
        await this.handleKxFrame(msg);
        break;

      case "relay.frame":
        await this.handleFrame(msg);
        break;

      case "relay.presence":
        this.events.onPresence?.(msg.online, msg.sessions);
        break;

      case "relay.pong":
        break;

      case "relay.err":
        log.error(`relay error: ${msg.m ?? msg.e}`);
        break;
    }
  }

  /**
   * Broadcast the daemon's public key to all connected frontends.
   * Encrypted with kxKey so only holders of the pairing secret can read it.
   *
   * The payload also carries this pairing's `label` so the frontend can
   * adopt the daemon's name without it taking up bytes in the QR. Sending
   * `label: null` is a positive signal that the daemon has no label
   * configured — the frontend keeps whatever fallback it already has
   * (typically the device name).
   */
  private async broadcastDaemonPublicKey(): Promise<void> {
    if (!this.kxKey) return;

    const payload = JSON.stringify({
      pk: await toBase64(this.config.keyPair.publicKey),
      role: "daemon",
      label: this.config.label ?? null,
    });
    const ct = await encrypt(new TextEncoder().encode(payload), this.kxKey);
    this.send({ t: "relay.kx", ct, role: "daemon" });
  }

  /**
   * Handle a key exchange frame from a frontend.
   * Decrypts the frontend's public key and derives per-frontend session keys.
   */
  private async handleKxFrame(frame: RelayKeyExchangeFrame): Promise<void> {
    if (frame.from !== "frontend") return;
    if (!this.kxKey) return;

    try {
      const plaintext = await decrypt(frame.ct, this.kxKey);
      const data = JSON.parse(new TextDecoder().decode(plaintext));
      // data = { pk: base64, frontendId: string, role: "frontend" }

      if (!data.pk || !data.frontendId) {
        log.error("kx frame missing pk or frontendId");
        return;
      }

      const frontendPubKey = await fromBase64(data.pk);
      const sessionKeys = await deriveSessionKeys(
        this.config.keyPair,
        frontendPubKey,
        "daemon",
      );

      this.peers.set(data.frontendId, {
        frontendId: data.frontendId,
        publicKey: frontendPubKey,
        sessionKeys,
      });

      log.info(`key exchange completed with frontend ${data.frontendId}`);
      this.events.onFrontendJoined?.(data.frontendId);
    } catch (err) {
      log.error("kx frame decrypt/parse failed:", err);
    }
  }

  private async handleFrame(frame: RelayFrame): Promise<void> {
    if (frame.from !== "frontend") return;

    // Try frontendId-based lookup first (O(1))
    if (frame.frontendId) {
      const peer = this.peers.get(frame.frontendId);
      if (peer) {
        await this.decryptAndDispatch(frame, peer);
        return;
      }
    }

    // Fallback: try all peers (for backward compat)
    for (const peer of this.peers.values()) {
      try {
        await this.decryptAndDispatch(frame, peer);
        return;
      } catch {}
    }

    if (this.peers.size === 0) {
      log.error(
        "no frontend peers for decryption (key exchange not completed)",
      );
    }
  }

  private async decryptAndDispatch(
    frame: RelayFrame,
    peer: FrontendPeer,
  ): Promise<void> {
    const plaintext = await decrypt(frame.ct, peer.sessionKeys.rx);
    const text = new TextDecoder().decode(plaintext);
    const msg = JSON.parse(text);

    if (frame.sid === RELAY_CHANNEL_CONTROL) {
      if (msg.t === CONTROL_UNPAIR) {
        const m = msg as ControlUnpair;
        this.onUnpair?.({ frontendId: m.frontendId, reason: m.reason });
        return;
      }
      if (msg.t === CONTROL_RENAME) {
        const m = msg as ControlRename;
        this.onRename?.({ frontendId: m.frontendId, label: m.label });
        return;
      }
    }

    if (msg.t === "in.chat" || msg.t === "in.term") {
      const kind = msg.t === "in.chat" ? "chat" : "term";
      this.events.onInput?.(kind, msg.sid, msg.d, peer.frontendId);
    } else if (msg.t === "pushToken") {
      this.events.onPushToken?.(peer.frontendId, msg.token, msg.platform);
    } else {
      // Control plane messages: attach, detach, resume, resize, ping,
      // session.create, session.stop, session.restart, session.export,
      // worktree.create, worktree.remove, worktree.list, hello
      const parsed = parseRelayControlMessage(msg);
      if (!parsed) {
        log.warn(`dropped malformed relay control message: t=${msg.t}`);
        return;
      }
      this.events.onControlMessage?.(parsed, peer.frontendId);
    }
  }

  /**
   * Encrypt `payload` for `peer` and push it into the outbound `relay.pub`
   * frame carrying the given `sid`/`seq`. The single private helper that all
   * higher-level publish methods funnel through — centralising the
   * JSON.stringify → TextEncoder → encrypt → send sequence so future protocol
   * shifts only need to touch one place.
   */
  private async sendEncrypted(
    peer: FrontendPeer,
    sid: string,
    seq: number,
    payload: unknown,
  ): Promise<void> {
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const ct = await encrypt(plaintext, peer.sessionKeys.tx);
    this.send({ t: "relay.pub", sid, ct, seq });
  }

  /** Broadcast `payload` to every connected peer under `sid`/`seq`. */
  private async broadcastEncrypted(
    sid: string,
    seq: number,
    payload: unknown,
  ): Promise<void> {
    if (!this.authenticated || this.peers.size === 0) return;
    for (const peer of this.peers.values()) {
      await this.sendEncrypted(peer, sid, seq, payload);
    }
  }

  /** Encrypt and publish a WS record to all connected frontends via relay. */
  async publishRecord(rec: WsRec): Promise<void> {
    return this.broadcastEncrypted(rec.sid, rec.seq, rec);
  }

  /** Encrypt and publish a state update to all connected frontends via relay. */
  async publishState(sid: string, stateMsg: unknown): Promise<void> {
    return this.broadcastEncrypted(sid, 0, stateMsg);
  }

  /**
   * Encrypt and publish a message to a specific frontend peer.
   * Used for sending session list (hello) to a newly connected frontend.
   */
  async publishToPeer(
    frontendId: string,
    sid: string,
    msg: unknown,
  ): Promise<void> {
    if (!this.authenticated) return;
    const peer = this.peers.get(frontendId);
    if (!peer) return;
    await this.sendEncrypted(peer, sid, 0, msg);
  }

  /**
   * Send an encrypted control frame (unpair / rename) to `frontendId` on the
   * virtual `RELAY_CHANNEL_CONTROL` sid. Returns `true` if the frame was
   * handed to the transport. Missing authentication or peer session returns
   * `false` after logging — the caller's retry/notification logic owns the
   * "peer never appeared" branch.
   */
  private async sendControl(
    method: "sendUnpairNotice" | "sendRenameNotice",
    frontendId: string,
    msg: ControlUnpair | ControlRename,
  ): Promise<boolean> {
    if (!this.authenticated) {
      log.warn(
        `${method}: not authenticated; skipping notice for ${frontendId}`,
      );
      return false;
    }
    const peer = this.peers.get(frontendId);
    if (!peer) {
      log.warn(
        `${method}: no peer session for frontend ${frontendId}; skipping`,
      );
      return false;
    }
    try {
      await this.sendEncrypted(peer, RELAY_CHANNEL_CONTROL, 0, msg);
      return true;
    } catch (err) {
      log.warn(`${method}: send failed for ${frontendId}: ${err}`);
      return false;
    }
  }

  /**
   * Send an unpair control notice to a specific frontend peer.
   * The payload rides the existing encrypted data channel on the virtual
   * control session (RELAY_CHANNEL_CONTROL) — the relay never sees plaintext.
   */
  async sendUnpairNotice(
    frontendId: string,
    reason: ControlUnpair["reason"] = "user-initiated",
  ): Promise<boolean> {
    const msg: ControlUnpair = {
      t: CONTROL_UNPAIR,
      daemonId: this.config.daemonId,
      frontendId,
      reason,
      ts: Date.now(),
    };
    return this.sendControl("sendUnpairNotice", frontendId, msg);
  }

  /** Encrypted control.rename notice to `frontendId`; see sendUnpairNotice for mechanics. */
  async sendRenameNotice(frontendId: string, label: string): Promise<boolean> {
    const msg: ControlRename = {
      t: CONTROL_RENAME,
      daemonId: this.config.daemonId,
      frontendId,
      label,
      ts: Date.now(),
    };
    return this.sendControl("sendRenameNotice", frontendId, msg);
  }

  /**
   * Send a push notification request to the relay server.
   * The relay forwards this to the Expo Push API on behalf of the daemon.
   */
  sendPush(
    frontendId: string,
    token: string,
    title: string,
    body: string,
    data?: { sid: string; daemonId?: string; event: string },
  ): void {
    const msg: RelayClientMessage = {
      t: "relay.push",
      frontendId,
      token,
      title,
      body,
      data: data
        ? {
            sid: data.sid,
            daemonId: data.daemonId ?? this.config.daemonId,
            event: data.event,
          }
        : undefined,
    };
    this.send(msg);
  }

  subscribe(sid: string): void {
    this.subscribedSessions.add(sid);
    if (this.authenticated) {
      this.send({ t: "relay.sub", sid });
    }
  }

  unsubscribe(sid: string): void {
    this.subscribedSessions.delete(sid);
    if (this.authenticated) {
      this.send({ t: "relay.unsub", sid });
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send({ t: "relay.ping", ts: Date.now() });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private send(msg: RelayClientMessage): void {
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
    this.stopPing();
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

  /**
   * True once `relay.auth.ok` has been received. The WebSocket may be open
   * earlier; callers that need a "relay is reachable and has accepted us"
   * signal (e.g. CLI unpair-notify) should poll this.
   */
  isConnected(): boolean {
    return this.authenticated;
  }

  getPeerCount(): number {
    return this.peers.size;
  }

  /** List frontendIds that have completed key exchange with this daemon. */
  listPeerFrontendIds(): string[] {
    return Array.from(this.peers.keys());
  }

  /** The daemonId this client is registered as on the relay. */
  get daemonId(): string {
    return this.config.daemonId;
  }
}
