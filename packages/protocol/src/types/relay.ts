/**
 * Relay protocol types (v2).
 *
 * The Relay is a stateless ciphertext forwarder. It routes opaque
 * encrypted frames between Daemon and Frontend connections.
 * The Relay never sees plaintext — all `ct` payloads are ciphertext.
 *
 * v2 additions:
 * - Self-registration (relay.register) — daemon registers its own token
 * - Key exchange (relay.kx) — in-band pubkey exchange via pairing-secret-encrypted envelopes
 * - frontendId — per-frontend identity for N:N daemon↔frontend multiplexing
 */

// ── Relay channel constants ──

/** Virtual session ID for session list / state updates */
export const RELAY_CHANNEL_META = "__meta__";
/** Virtual session ID for control plane messages */
export const RELAY_CHANNEL_CONTROL = "__control__";

// ── Client → Relay (both Daemon and Frontend) ──

export interface RelayAuth {
  t: "relay.auth";
  /** Role: "daemon" or "frontend" */
  role: "daemon" | "frontend";
  /** Daemon ID (shared during pairing) */
  daemonId: string;
  /** Pairing token for authentication */
  token: string;
  /** Protocol version */
  v: number;
  /** Unique frontend identifier (role=frontend only). Enables N:N multiplexing. */
  frontendId?: string;
}

export interface RelayRegister {
  t: "relay.register";
  /** Daemon ID to register */
  daemonId: string;
  /** BLAKE2b(pairingSecret || "relay-register") — proves knowledge of pairing secret */
  proof: string;
  /** Relay token to register for this daemonId */
  token: string;
  /** Protocol version */
  v: number;
}

export interface RelayKeyExchange {
  t: "relay.kx";
  /** Public key encrypted with kxKey (derived from pairing secret) */
  ct: string;
  /** Sender role */
  role: "daemon" | "frontend";
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
  /** Client timestamp for RTT measurement */
  ts?: number;
}

export interface RelayPush {
  t: "relay.push";
  /** Target frontend */
  frontendId: string;
  /** Expo push token */
  token: string;
  /** Notification title */
  title: string;
  /** Notification body */
  body: string;
  /** Navigation payload */
  data?: {
    sid: string;
    daemonId: string;
    event: string;
  };
}

export type RelayClientMessage =
  | RelayAuth
  | RelayRegister
  | RelayKeyExchange
  | RelayPublish
  | RelaySubscribe
  | RelayUnsubscribe
  | RelayPing
  | RelayPush;

// ── Relay → Client ──

export interface RelayAuthOk {
  t: "relay.auth.ok";
  daemonId: string;
}

export interface RelayAuthErr {
  t: "relay.auth.err";
  e: string;
}

export interface RelayRegisterOk {
  t: "relay.register.ok";
  daemonId: string;
}

export interface RelayRegisterErr {
  t: "relay.register.err";
  e: string;
}

export interface RelayFrame {
  t: "relay.frame";
  sid: string;
  ct: string;
  seq: number;
  from: "daemon" | "frontend";
  /** Frontend identifier (present when from=frontend) */
  frontendId?: string;
}

export interface RelayKeyExchangeFrame {
  t: "relay.kx.frame";
  /** Encrypted public key data */
  ct: string;
  /** Sender role */
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
  /** Echoed client timestamp */
  ts?: number;
}

export interface RelayError {
  t: "relay.err";
  e: string;
  m?: string;
}

export interface RelayNotification {
  t: "relay.notification";
  title: string;
  body: string;
  data?: {
    sid: string;
    daemonId: string;
    event: string;
  };
}

export type RelayServerMessage =
  | RelayAuthOk
  | RelayAuthErr
  | RelayRegisterOk
  | RelayRegisterErr
  | RelayFrame
  | RelayKeyExchangeFrame
  | RelayPresence
  | RelayPong
  | RelayError
  | RelayNotification;
