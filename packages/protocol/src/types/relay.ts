/**
 * Relay protocol types.
 *
 * The Relay is a stateless ciphertext forwarder. It routes opaque
 * encrypted frames between Daemon and Frontend connections.
 * The Relay never sees plaintext — all `d` payloads are ciphertext.
 */

// ── Client → Relay (both Daemon and Frontend) ──

export interface RelayAuth {
  t: "relay.auth";
  /** Role: "daemon" or "frontend" */
  role: "daemon" | "frontend";
  /** Daemon ID (shared during pairing) */
  daemonId: string;
  /** Pairing token for authentication */
  token: string;
}

export interface RelayPublish {
  t: "relay.pub";
  /** Session ID */
  sid: string;
  /** Opaque ciphertext frame (base64) */
  ct: string;
  /** Monotonic sequence for ordering */
  seq: number;
}

export interface RelaySubscribe {
  t: "relay.sub";
  /** Session ID to subscribe to */
  sid: string;
  /** Optional: resume from this seq (get missed frames) */
  after?: number;
}

export interface RelayUnsubscribe {
  t: "relay.unsub";
  sid: string;
}

export interface RelayPing {
  t: "relay.ping";
}

export type RelayClientMessage =
  | RelayAuth
  | RelayPublish
  | RelaySubscribe
  | RelayUnsubscribe
  | RelayPing;

// ── Relay → Client ──

export interface RelayAuthOk {
  t: "relay.auth.ok";
  daemonId: string;
}

export interface RelayAuthErr {
  t: "relay.auth.err";
  e: string;
}

export interface RelayFrame {
  t: "relay.frame";
  sid: string;
  ct: string;
  seq: number;
  from: "daemon" | "frontend";
}

export interface RelayPresence {
  t: "relay.presence";
  daemonId: string;
  /** Whether the daemon is currently online */
  online: boolean;
  /** Sessions available */
  sessions: string[];
  /** Last seen timestamp */
  lastSeen: number;
}

export interface RelayPong {
  t: "relay.pong";
}

export interface RelayError {
  t: "relay.err";
  e: string;
  m?: string;
}

export type RelayServerMessage =
  | RelayAuthOk
  | RelayAuthErr
  | RelayFrame
  | RelayPresence
  | RelayPong
  | RelayError;
