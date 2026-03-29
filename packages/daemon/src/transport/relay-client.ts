/**
 * Daemon-side Relay client (v2).
 *
 * Connects to a Relay server with self-registration, authenticates,
 * performs in-band key exchange with frontends, and manages per-frontend
 * E2EE session keys for N:N multiplexing.
 */

import type {
  RelayClientMessage,
  RelayServerMessage,
  RelayFrame,
  RelayKeyExchangeFrame,
  WsRec,
  SessionKeys,
  KeyPair,
} from "@teleprompter/protocol";
import {
  encrypt,
  decrypt,
  deriveSessionKeys,
  deriveKxKey,
  toBase64,
  fromBase64,
  createLogger,
} from "@teleprompter/protocol";

const log = createLogger("RelayClient");

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

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
}

export interface RelayClientEvents {
  /** Called when a decrypted input arrives from a frontend via relay */
  onInput?: (sid: string, data: string, frontendId?: string) => void;
  /** Called when relay connection state changes */
  onConnected?: () => void;
  onDisconnected?: () => void;
  /** Called when relay reports presence */
  onPresence?: (online: boolean, sessions?: string[]) => void;
  /** Called when a new frontend completes key exchange */
  onFrontendJoined?: (frontendId: string) => void;
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
  private disposed = false;
  private registered = false;
  private authenticated = false;
  private subscribedSessions = new Set<string>();

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
      // Step 1: Self-register token
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
      this.registered = false;
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
        this.registered = true;
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
        this.events.onConnected?.();
        // Re-subscribe to all sessions
        for (const sid of this.subscribedSessions) {
          this.send({ t: "relay.sub", sid });
        }
        // Step 3: Broadcast daemon's public key for key exchange
        await this.broadcastDaemonPublicKey();
        log.info(`authenticated to relay`);
        break;

      case "relay.auth.err":
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
   */
  private async broadcastDaemonPublicKey(): Promise<void> {
    if (!this.kxKey) return;

    const payload = JSON.stringify({
      pk: await toBase64(this.config.keyPair.publicKey),
      role: "daemon",
    });
    const ct = await encrypt(
      new TextEncoder().encode(payload),
      this.kxKey,
    );
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
      } catch {
        continue;
      }
    }

    if (this.peers.size === 0) {
      log.error("no frontend peers for decryption (key exchange not completed)");
    }
  }

  private async decryptAndDispatch(
    frame: RelayFrame,
    peer: FrontendPeer,
  ): Promise<void> {
    const plaintext = await decrypt(frame.ct, peer.sessionKeys.rx);
    const text = new TextDecoder().decode(plaintext);
    const msg = JSON.parse(text);

    if (msg.t === "in.chat" || msg.t === "in.term") {
      this.events.onInput?.(msg.sid, msg.d, peer.frontendId);
    }
  }

  /**
   * Encrypt and publish a WS record to all connected frontends via relay.
   */
  async publishRecord(rec: WsRec): Promise<void> {
    if (!this.authenticated || this.peers.size === 0) return;

    const json = JSON.stringify(rec);
    const plaintext = new TextEncoder().encode(json);

    for (const peer of this.peers.values()) {
      const ct = await encrypt(plaintext, peer.sessionKeys.tx);
      this.send({
        t: "relay.pub",
        sid: rec.sid,
        ct,
        seq: rec.seq,
      });
    }
  }

  /**
   * Encrypt and publish a state update to all connected frontends via relay.
   */
  async publishState(sid: string, stateMsg: unknown): Promise<void> {
    if (!this.authenticated || this.peers.size === 0) return;

    const json = JSON.stringify(stateMsg);
    const plaintext = new TextEncoder().encode(json);

    for (const peer of this.peers.values()) {
      const ct = await encrypt(plaintext, peer.sessionKeys.tx);
      this.send({
        t: "relay.pub",
        sid,
        ct,
        seq: 0,
      });
    }
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

    const plaintext = new TextEncoder().encode(JSON.stringify(msg));
    const ct = await encrypt(plaintext, peer.sessionKeys.tx);
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

  getPeerCount(): number {
    return this.peers.size;
  }
}
