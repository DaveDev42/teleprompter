/**
 * Frontend-side Relay client (v2).
 *
 * Connects to a Relay server via the pairing data obtained from QR scan.
 * Performs in-band key exchange to deliver the frontend's public key
 * to the daemon. Encrypts outgoing input and decrypts incoming records.
 */

import type {
  RelayClientMessage,
  RelayServerMessage,
  RelayFrame,
  WsRec,
  SessionKeys,
  KeyPair,
} from "@teleprompter/protocol/client";
import {
  encrypt,
  decrypt,
  deriveSessionKeys,
  deriveKxKey,
  toBase64,
} from "@teleprompter/protocol/client";

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

export interface FrontendRelayEvents {
  /** Decrypted record from daemon */
  onRecord?: (rec: WsRec) => void;
  /** Decrypted state from daemon */
  onState?: (msg: unknown) => void;
  /** Connection state */
  onConnected?: () => void;
  onDisconnected?: () => void;
  /** Daemon online/offline presence */
  onPresence?: (online: boolean, sessions: string[]) => void;
}

export class FrontendRelayClient {
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

  constructor(config: FrontendRelayConfig, events: FrontendRelayEvents = {}) {
    this.config = config;
    this.events = events;
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
      this.send({
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
      this.events.onDisconnected?.();
      this.scheduleReconnect();
    };

    ws.onerror = () => {};
  }

  private async handleMessage(msg: RelayServerMessage): Promise<void> {
    switch (msg.t) {
      case "relay.auth.ok":
        this.authenticated = true;
        this.events.onConnected?.();
        // Subscribe to meta channel for session list / state updates
        this.send({ t: "relay.sub", sid: "__meta__" });
        // Re-subscribe to all sessions
        for (const sid of this.subscribedSessions) {
          this.send({ t: "relay.sub", sid });
        }
        // Send key exchange: deliver frontend's public key to daemon
        await this.sendKeyExchange();
        break;

      case "relay.auth.err":
        console.error(`[FrontendRelay] auth failed: ${msg.e}`);
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

      case "relay.err":
        console.error(`[FrontendRelay] error: ${msg.m ?? msg.e}`);
        break;
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
    const ct = await encrypt(
      new TextEncoder().encode(payload),
      this.kxKey,
    );
    this.send({ t: "relay.kx", ct, role: "frontend" });
  }

  private async handleFrame(frame: RelayFrame): Promise<void> {
    if (frame.from !== "daemon") return;
    if (!this.sessionKeys) return;

    try {
      const plaintext = await decrypt(frame.ct, this.sessionKeys.rx);
      const text = new TextDecoder().decode(plaintext);
      const msg = JSON.parse(text);

      if (msg.t === "rec") {
        this.events.onRecord?.(msg as WsRec);
      } else if (msg.t === "state" || msg.t === "hello") {
        this.events.onState?.(msg);
      }
    } catch {
      console.error(`[FrontendRelay] decrypt failed`);
    }
  }

  /** Encrypt and send chat input to daemon via relay */
  async sendChat(sid: string, text: string): Promise<void> {
    if (!this.authenticated || !this.sessionKeys) return;

    const msg = { t: "in.chat", sid, d: text };
    const ct = await encrypt(
      new TextEncoder().encode(JSON.stringify(msg)),
      this.sessionKeys.tx,
    );

    this.send({ t: "relay.pub", sid, ct, seq: 0 });
  }

  /** Encrypt and send terminal input to daemon via relay */
  async sendTermInput(sid: string, data: string): Promise<void> {
    if (!this.authenticated || !this.sessionKeys) return;

    const msg = { t: "in.term", sid, d: data };
    const ct = await encrypt(
      new TextEncoder().encode(JSON.stringify(msg)),
      this.sessionKeys.tx,
    );

    this.send({ t: "relay.pub", sid, ct, seq: 0 });
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
