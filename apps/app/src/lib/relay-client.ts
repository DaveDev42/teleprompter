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
  decrypt,
  deriveKxKey,
  deriveSessionKeys,
  encrypt,
  RELAY_CHANNEL_CONTROL,
  RELAY_CHANNEL_META,
  toBase64,
} from "@teleprompter/protocol/client";
import type { TransportClient, TransportEventHandler } from "./transport";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

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

  /** Track attached session and last seq for auto-resume on reconnect */
  private attachedSid: string | null = null;
  private lastSeq = 0;
  private hasConnectedBefore = false;
  private pingStart = 0;
  /** Last measured round-trip time in ms */
  private rtt = -1;

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

    this.cleanup();

    const ws = new WebSocket(this.config.relayUrl);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.events.onOpen?.();
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
      case "relay.auth.ok":
        this.authenticated = true;
        this.events.onConnected?.();
        // Subscribe to meta + control channels
        this.sendRelay({ t: "relay.sub", sid: RELAY_CHANNEL_META });
        this.sendRelay({ t: "relay.sub", sid: RELAY_CHANNEL_CONTROL });
        // Re-subscribe to all sessions
        for (const sid of this.subscribedSessions) {
          this.sendRelay({ t: "relay.sub", sid });
        }
        // Send key exchange: deliver frontend's public key to daemon
        await this.sendKeyExchange();
        // Auto-resume if we were previously attached
        if (this.hasConnectedBefore && this.attachedSid) {
          this.resume(this.attachedSid, this.lastSeq);
        }
        this.hasConnectedBefore = true;
        break;

      case "relay.auth.err":
        this.events.onError?.(`Relay auth failed: ${msg.e}`);
        break;

      case "relay.kx.frame":
        // Daemon sent its public key (confirmation). We already have it from QR.
        break;

      case "relay.frame":
        await this.handleFrame(msg);
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
        default:
          console.warn(`[FrontendRelay] unknown message type: ${msg.t}`);
      }
    } catch (err) {
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

  // ── Encrypted control message sender ──

  private async sendEncrypted(msg: Record<string, unknown>): Promise<void> {
    if (!this.authenticated || !this.sessionKeys) {
      console.warn(`[FrontendRelay] dropping ${msg.t} — not authenticated`);
      return;
    }

    try {
      const ct = await encrypt(
        new TextEncoder().encode(JSON.stringify(msg)),
        this.sessionKeys.tx,
      );

      const sid = (msg.sid as string) ?? RELAY_CHANNEL_CONTROL;
      this.sendRelay({ t: "relay.pub", sid, ct, seq: 0 });
    } catch {
      console.error(`[FrontendRelay] encrypt failed for ${msg.t}`);
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
