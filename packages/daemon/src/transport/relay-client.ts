/**
 * Daemon-side Relay client.
 *
 * Connects to a Relay server, authenticates, subscribes to sessions,
 * and encrypts/decrypts frames using E2EE session keys.
 */

import type {
  RelayClientMessage,
  RelayServerMessage,
  RelayFrame,
  WsRec,
  SessionKeys,
  KeyPair,
} from "@teleprompter/protocol";
import { encrypt, decrypt, deriveSessionKeys, createLogger } from "@teleprompter/protocol";

const log = createLogger("RelayClient");

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export interface RelayClientConfig {
  /** Relay server URL (e.g., wss://relay.example.com) */
  relayUrl: string;
  /** Daemon ID */
  daemonId: string;
  /** Relay auth token (derived from pairing secret) */
  token: string;
  /** Daemon key pair for E2EE */
  keyPair: KeyPair;
  /** Frontend public key (from pairing) */
  frontendPublicKey: Uint8Array;
}

export interface RelayClientEvents {
  /** Called when a decrypted record arrives from the frontend via relay */
  onRecord?: (rec: WsRec) => void;
  /** Called when a decrypted input arrives from the frontend via relay */
  onInput?: (sid: string, data: string) => void;
  /** Called when relay connection state changes */
  onConnected?: () => void;
  onDisconnected?: () => void;
  /** Called when relay reports presence */
  onPresence?: (online: boolean) => void;
}

export class RelayClient {
  private ws: WebSocket | null = null;
  private config: RelayClientConfig;
  private events: RelayClientEvents;
  private sessionKeys: SessionKeys | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private authenticated = false;
  private subscribedSessions = new Set<string>();

  constructor(config: RelayClientConfig, events: RelayClientEvents = {}) {
    this.config = config;
    this.events = events;
  }

  async connect(): Promise<void> {
    if (this.disposed) return;

    // Derive session keys if not done yet and frontend pubkey is available
    if (!this.sessionKeys && !isZeroKey(this.config.frontendPublicKey)) {
      this.sessionKeys = await deriveSessionKeys(
        this.config.keyPair,
        this.config.frontendPublicKey,
        "daemon",
      );
    }

    this.cleanup();

    const ws = new WebSocket(this.config.relayUrl);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.send({
        t: "relay.auth",
        role: "daemon",
        daemonId: this.config.daemonId,
        token: this.config.token,
        v: 1,
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
      case "relay.auth.ok":
        this.authenticated = true;
        this.events.onConnected?.();
        // Re-subscribe to all sessions
        for (const sid of this.subscribedSessions) {
          this.send({ t: "relay.sub", sid });
        }
        log.info(`authenticated to relay`);
        break;

      case "relay.auth.err":
        log.error(`auth failed: ${msg.e}`);
        break;

      case "relay.frame":
        await this.handleFrame(msg);
        break;

      case "relay.presence":
        this.events.onPresence?.(msg.online);
        break;

      case "relay.pong":
        break;

      case "relay.err":
        log.error(`relay error: ${msg.m ?? msg.e}`);
        break;
    }
  }

  private async handleFrame(frame: RelayFrame): Promise<void> {
    if (frame.from !== "frontend") return; // Only process frontend frames
    if (!this.sessionKeys) return;

    try {
      const plaintext = await decrypt(frame.ct, this.sessionKeys.rx);
      const text = new TextDecoder().decode(plaintext);
      const msg = JSON.parse(text);

      if (msg.t === "rec") {
        this.events.onRecord?.(msg as WsRec);
      } else if (msg.t === "in.chat" || msg.t === "in.term") {
        this.events.onInput?.(msg.sid, msg.d);
      }
    } catch (err) {
      log.error(`decrypt/parse failed:`, err);
    }
  }

  /**
   * Encrypt and publish a WS record to the relay.
   */
  async publishRecord(rec: WsRec): Promise<void> {
    if (!this.authenticated || !this.sessionKeys) return;

    const plaintext = new TextEncoder().encode(JSON.stringify(rec));
    const ct = await encrypt(plaintext, this.sessionKeys.tx);

    this.send({
      t: "relay.pub",
      sid: rec.sid,
      ct,
      seq: rec.seq,
    });
  }

  /**
   * Encrypt and publish a state update to the relay.
   */
  async publishState(sid: string, stateMsg: unknown): Promise<void> {
    if (!this.authenticated || !this.sessionKeys) return;

    const plaintext = new TextEncoder().encode(JSON.stringify(stateMsg));
    const ct = await encrypt(plaintext, this.sessionKeys.tx);

    this.send({
      t: "relay.pub",
      sid,
      ct,
      seq: 0, // state messages don't have seq
    });
  }

  /**
   * Subscribe to a session on the relay.
   */
  subscribe(sid: string): void {
    this.subscribedSessions.add(sid);
    if (this.authenticated) {
      this.send({ t: "relay.sub", sid });
    }
  }

  /**
   * Unsubscribe from a session.
   */
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

  /**
   * Set the frontend public key after pairing completes.
   * This enables E2EE for subsequent messages.
   */
  async setFrontendPublicKey(pubkey: Uint8Array): Promise<void> {
    this.config.frontendPublicKey = pubkey;
    this.sessionKeys = await deriveSessionKeys(
      this.config.keyPair,
      pubkey,
      "daemon",
    );
  }
}

function isZeroKey(key: Uint8Array): boolean {
  return key.every((b) => b === 0);
}
