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

/**
 * Fast-path resume after a previously successful relay.auth. Carries an
 * opaque HMAC-signed token issued by the relay; the relay verifies the
 * signature without any per-daemon state. On expiry / signature failure
 * the relay returns relay.auth.err and the client falls back to full auth.
 */
export interface RelayAuthResume {
  t: "relay.auth.resume";
  /** Opaque token issued by the relay in a previous relay.auth.ok */
  token: string;
  /** Protocol version */
  v: number;
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

/**
 * iOS notification interruption level (maps to Apple's
 * UNNotificationInterruptionLevel). The APNs HTTP/2 provider API accepts this
 * as `aps.interruption-level`. We only ever send the two non-privileged levels:
 *  - "time-sensitive": breaks through Focus / Do Not Disturb when the user has
 *    allowed time-sensitive notifications. Used for attention-needed events
 *    (permission prompts, elicitation) — no special Apple entitlement required.
 *  - "active" (the implicit default): normal delivery, respects Focus.
 * "critical" (overrides the mute switch) needs a special Apple entitlement and
 * is intentionally not modeled here.
 */
export type PushInterruptionLevel = "active" | "time-sensitive";

export interface RelayPush {
  t: "relay.push";
  /** Target frontend */
  frontendId: string;
  /**
   * Sealed APNs device token blob ("tpps1.<v>.<b64>"). The relay unseals it
   * with PushSealer to recover the hex device token before calling APNs.
   * Daemon treats this as an opaque blob and never persists the plaintext.
   * Required — the legacy plaintext `token` field has been removed.
   */
  sealed: string;
  /** Notification title */
  title: string;
  /** Notification body */
  body: string;
  /**
   * iOS interruption level. Optional for wire back-compat: an older daemon
   * omits it and the relay falls back to default ("active") delivery; an older
   * relay ignores the field. Absent → treated as "active".
   */
  interruptionLevel?: PushInterruptionLevel;
  /** Navigation payload */
  data?: {
    sid: string;
    daemonId: string;
    event: string;
  };
}

/**
 * Frontend → Relay: register a plaintext APNs device token so the relay can
 * seal it. The relay seals the token with a key-versioned relay-side key and
 * routes `relay.push.token` to the daemon. Token is never persisted in plaintext.
 */
export interface RelayPushRegister {
  t: "relay.push.register";
  /** Frontend identifier (matches the frontendId used in relay.auth) */
  frontendId: string;
  /** Plaintext APNs hex device token — relay seals it immediately, never stored plaintext */
  token: string;
  /** Push platform */
  platform: "ios" | "android";
}

export type RelayClientMessage =
  | RelayAuth
  | RelayAuthResume
  | RelayRegister
  | RelayKeyExchange
  | RelayPublish
  | RelaySubscribe
  | RelayUnsubscribe
  | RelayPing
  | RelayPush
  | RelayPushRegister;

// ── Relay → Client ──

export interface RelayAuthOk {
  t: "relay.auth.ok";
  daemonId: string;
  /**
   * Opaque token the client may send via relay.auth.resume on its next
   * connect to skip re-validation. HMAC-signed by the relay; clients treat
   * it as a black box. May be omitted if the relay has resume disabled.
   */
  resumeToken?: string;
  /**
   * Suggested expiry hint (epoch ms) so clients know when to fall back to
   * full auth without waiting for an error round-trip. The relay still
   * enforces expiry on its side regardless of this hint.
   */
  resumeExpiresAt?: number;
  /**
   * Whether this auth.ok was the result of a fast-path resume (true) or
   * full re-authentication (false/undefined). Lets the daemon skip a
   * `relay.kx` round-trip when the cached session keys are still valid.
   */
  resumed?: boolean;
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

/**
 * Relay → Daemon: sealed push token routed from a frontend's `relay.push.register`.
 * The daemon persists the sealed blob in store DB and uses it for future
 * `relay.push` notifications. Daemon treats `sealed` as an opaque string —
 * format is "tpps1.<version>.<base64(nonce||ct)>" and is only meaningful to the relay.
 */
export interface RelayPushTokenSealed {
  t: "relay.push.token";
  /** Frontend identifier that registered the token */
  frontendId: string;
  /** Sealed push token blob — format: "tpps1.<v>.<base64(nonce24||aead_ct)>" */
  sealed: string;
  /** Push platform */
  platform: "ios" | "android";
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
  | RelayNotification
  | RelayPushTokenSealed;
