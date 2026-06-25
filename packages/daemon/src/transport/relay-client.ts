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
  Label,
  PushInterruptionLevel,
  RelayClientMessage,
  RelayControlMessage,
  RelayFrame,
  RelayKeyExchangeFrame,
  RelayServerMessage,
  SessionKeys,
  SessionRec,
  SessionStateMsg,
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
  parseControlMessage,
  parseRelayControlMessage,
  parseRelayServerMessage,
  RELAY_CHANNEL_CONTROL,
  toBase64,
  WS_PROTOCOL_VERSION,
} from "@teleprompter/protocol";

const log = createLogger("RelayClient");

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
/**
 * Maximum useful exponent for the backoff formula `RECONNECT_BASE_MS * 2^n`.
 * Once n reaches this value the delay already equals RECONNECT_MAX_MS, so
 * incrementing further is wasted compute (2^n overflows to Infinity for large n).
 * Clamping the counter here keeps the arithmetic clean.
 */
const MAX_RECONNECT_ATTEMPT = Math.ceil(
  Math.log2(RECONNECT_MAX_MS / RECONNECT_BASE_MS),
);
/**
 * After this many consecutive reconnects without any frontend peer ever
 * joining, the pairing is treated as "dead" (a closed browser tab, an old
 * app instance, an unscanned QR) and its reconnect cadence is throttled to
 * {@link PEERLESS_RECONNECT_MS} so a pile of dead pairings cannot drown the
 * relay in a reconnect storm. A real frontend joining (key exchange in
 * `handleKxFrame`) resets the counter to 0, restoring fast reconnect — so a
 * phone that was merely asleep for days reconnects at full speed the moment
 * it comes back. The threshold is small but non-zero so a single transient
 * network blip on a live-but-momentarily-idle pairing does not get throttled.
 */
const PEERLESS_RECONNECT_THRESHOLD = 3;
/**
 * Throttled reconnect interval (30 min) applied once a pairing crosses
 * {@link PEERLESS_RECONNECT_THRESHOLD}. At 10 dead pairings this caps the
 * total reconnect rate at ~20/hour instead of the thousands/hour an
 * un-throttled 30 s cadence produced (observed: 3113 re-auths over 41 h
 * from 9 mostly-dead pairings).
 */
const PEERLESS_RECONNECT_MS = 30 * 60_000;
/** How often to send relay.ping (ms) */
const PING_INTERVAL_MS = 30_000;

/**
 * Pure reconnect-delay policy, extracted so the dead-pairing throttle can be
 * unit-tested without standing up a relay or faking WebSocket internals.
 *
 * - `peerlessReconnects >= PEERLESS_RECONNECT_THRESHOLD` → the pairing has
 *   reconnected this many times with no frontend ever joining: it is treated
 *   as dead and throttled to {@link PEERLESS_RECONNECT_MS} (30 min), so a pile
 *   of dead pairings cannot storm the relay.
 * - Otherwise → standard exponential backoff
 *   `RECONNECT_BASE_MS * 2^attempt`, capped at `RECONNECT_MAX_MS`.
 *
 * Returns both the delay and the next `attempt` value (clamped). The throttled
 * branch leaves `attempt` unchanged so a recovered pairing resumes fast
 * backoff from where it left off.
 */
export function computeReconnectPlan(
  attempt: number,
  peerlessReconnects: number,
): { delay: number; nextAttempt: number } {
  if (peerlessReconnects >= PEERLESS_RECONNECT_THRESHOLD) {
    return { delay: PEERLESS_RECONNECT_MS, nextAttempt: attempt };
  }
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
  const nextAttempt = Math.min(attempt + 1, MAX_RECONNECT_ATTEMPT);
  return { delay, nextAttempt };
}

/**
 * Pure accounting for the dead-pairing throttle counter, extracted so its
 * (previously buggy) gating can be unit-tested without faking WebSocket
 * lifecycles.
 *
 * `hadPeer` means "a frontend completed key exchange during the connection
 * that just ended". When it did, the pairing is alive and the counter resets
 * to 0; otherwise the just-ended connection saw no peer and the counter ticks.
 *
 * The critical subtlety this guards against: the `peers` Map is PRESERVED
 * across reconnects (resume fast-path), so gating on `peers.size` would keep
 * the counter pinned at 0 forever after the first kx and silently defeat the
 * throttle for any pairing that ever had a live frontend (the 9-pairing →
 * 3113 re-auth incident). The signal MUST be per-connection, not Map size.
 */
export function nextPeerlessReconnects(
  current: number,
  hadPeer: boolean,
): number {
  return hadPeer ? 0 : current + 1;
}

interface FrontendPeer {
  frontendId: string;
  publicKey: Uint8Array;
  sessionKeys: SessionKeys;
  /**
   * The frontend's advertised WS protocol version, parsed from its `relay.kx`
   * payload (`data.v`). Defaults to 1 when the field is absent (a frontend
   * built before the Label-union bump). Retained for future version-gating
   * (e.g. new message types); no longer used to gate ControlRename emission —
   * the Label union is always sent unconditionally (ADR-0003 A1).
   */
  protocolVersion: number;
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
  /** Human-readable label for this pairing as a tagged union. */
  label?: Label | undefined;
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
  /**
   * Called when the relay routes a relay.push.token to us (Path X).
   * `sealed` is the opaque blob ("tpps1.<v>.<b64>") sealed by the relay.
   */
  onPushTokenSealed?: (
    frontendId: string,
    sealed: string,
    platform: "ios" | "android",
  ) => void;
  /**
   * Called when the relay replies PUSH_UNSEAL_FAILED — the sealed blob could
   * not be decrypted (key rotated out of the current/prev window, or tampered).
   * The daemon should evict all push tokens and await re-registration from the
   * app. No frontendId is available in the relay.err wire type.
   */
  onPushUnsealFailed?: () => void;
  /**
   * Called when the relay replies PUSH_TOKEN_DEAD — APNs returned 400
   * (BadDeviceToken) or 410 (Unregistered). The daemon should evict all push
   * tokens for this pairing and await re-registration from the app.
   * No frontendId is available in the relay.err wire type.
   */
  onPushTokenDead?: () => void;
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
  /**
   * Consecutive reconnects in which no frontend peer ever joined. Incremented
   * in `scheduleReconnect`, reset to 0 in `handleKxFrame` when a real frontend
   * completes key exchange. Drives the dead-pairing throttle (see
   * {@link PEERLESS_RECONNECT_THRESHOLD}). Unlike `reconnectAttempt` this is
   * NOT reset on `ws.onopen` — a dead pairing's socket opens fine; what makes
   * it dead is that no peer ever follows.
   */
  private peerlessReconnects = 0;
  /**
   * Whether a frontend peer completed key exchange DURING the current
   * connection. Reset to `false` in `cleanup()` (start of every connect), set
   * to `true` in `handleKxFrame`. This is the correct signal for the
   * dead-pairing throttle: the `peers` Map is deliberately PRESERVED across
   * reconnects (for the resume session-key fast-path — see the `relay.auth.ok`
   * handler), so `peers.size` stays non-zero forever after the first kx and
   * could never re-trigger the throttle. A genuinely-dead pairing (socket
   * opens, no frontend ever joins THIS connection) leaves this `false` and so
   * keeps accumulating `peerlessReconnects`.
   */
  private hadPeerThisConnection = false;
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
  onRename: ((info: { frontendId: string; label: Label }) => void) | null =
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

    // Re-check disposed after the await: a cancel()/dispose() during the
    // deriveKxKey derivation (common on Ctrl+C mid-pairing) sets disposed=true
    // and runs cleanup(). The guard at the top only covers pre-await disposal,
    // so without this re-check we would open a brand-new WebSocket that nobody
    // owns (not in the manager pool, never reconnected) — a phantom socket that
    // holds a relay slot until the server's idle/auth timeout.
    if (this.disposed) return;

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
      if (typeof event.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        // ignore malformed JSON
        return;
      }
      const msg = parseRelayServerMessage(parsed);
      if (!msg) {
        log.warn("dropped malformed relay frame");
        return;
      }
      this.handleMessage(msg).catch((err) => {
        log.error("unhandled error in handleMessage:", err);
      });
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
        // Close immediately to trigger ws.onclose → scheduleReconnect rather
        // than waiting ~10s for the relay's auth-timeout to drop the socket
        // (the relay does not close on register.err). Mirrors the resume path.
        this.ws?.close();
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
        // Close immediately so ws.onclose schedules a reconnect, instead of
        // stalling ~10s for the relay's slowloris auth-timeout to close us.
        // Mirrors the resume arm above.
        this.ws?.close();
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
        if (msg.e === "PUSH_UNSEAL_FAILED") {
          // The relay could not decrypt a real "tpps1." sealed token we sent
          // (its key was rotated out of the current/prev window, or the blob
          // was tampered). The relay.err wire type does not carry a frontendId,
          // so we cannot surgically evict the specific stale entry from
          // PushNotifier here — that is a known v1 limitation. Self-heal path:
          // the app re-registers via relay.push.register on every relay
          // reconnect, which makes the relay re-seal under the current key and
          // route a fresh relay.push.token to us. Log at warn so operators can
          // correlate the event with a seal-key rotation.
          log.warn(
            `relay reported PUSH_UNSEAL_FAILED — sealed push token rejected by relay; app re-registers on next relay reconnect. relay: ${msg.m ?? "(no detail)"}`,
          );
          this.events.onPushUnsealFailed?.();
        } else if (msg.e === "PUSH_TOKEN_DEAD") {
          // APNs returned 400 (BadDeviceToken) or 410 (Unregistered) — the
          // device token is permanently dead. Signal the daemon to evict the
          // stale entry from push_tokens so future notification events don't
          // keep sending to a dead token. The relay.err wire type does not
          // carry a frontendId, so we cannot surgically evict by ID — same v1
          // limitation as PUSH_UNSEAL_FAILED. The app re-registers on next
          // relay reconnect via relay.push.register.
          log.warn(
            `relay reported PUSH_TOKEN_DEAD — APNs device token permanently invalid; app re-registers on next relay reconnect. relay: ${msg.m ?? "(no detail)"}`,
          );
          this.events.onPushTokenDead?.();
        } else {
          log.error(`relay error: ${msg.m ?? msg.e}`);
        }
        break;

      case "relay.notification":
        // Push notifications target frontends, not the daemon. The daemon is
        // never a notification sink — ignore, but keep the arm so the switch
        // stays exhaustive over RelayServerMessage.
        break;

      case "relay.push.token":
        // Path X: sealed push token routed from a frontend's relay.push.register.
        // Validate platform narrowing (the guard already ensures it's "ios"|"android",
        // but be explicit for the type check).
        if (msg.platform === "ios" || msg.platform === "android") {
          this.events.onPushTokenSealed?.(
            msg.frontendId,
            msg.sealed,
            msg.platform,
          );
        } else {
          log.warn(
            `relay.push.token: unexpected platform=${msg.platform}, dropping`,
          );
        }
        break;

      default: {
        // Exhaustiveness guard: every RelayServerMessage variant is handled
        // above. If a new variant is added without an arm, this assignment
        // fails to compile.
        const _exhaustive: never = msg;
        return _exhaustive;
      }
    }
  }

  /**
   * Broadcast the daemon's public key to all connected frontends.
   * Encrypted with kxKey so only holders of the pairing secret can read it.
   *
   * The payload also carries this pairing's `label` so the frontend can
   * adopt the daemon's name without it taking up bytes in the QR. The label
   * is sent as the `Label` tagged union; `{ set: false }` is a positive
   * signal that the daemon has no label configured — the frontend reads this
   * surface with keep-current semantics (`decodeKxLabelOrKeep`) and so keeps
   * whatever fallback it already has (typically the device name). `v`
   * advertises the daemon's WS protocol version so a frontend can adapt.
   */
  private async broadcastDaemonPublicKey(): Promise<void> {
    if (!this.kxKey) return;

    const payload = JSON.stringify({
      pk: await toBase64(this.config.keyPair.publicKey),
      role: "daemon",
      v: WS_PROTOCOL_VERSION,
      label: this.config.label ?? { set: false },
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
      // data = { pk: base64, frontendId: string, role: "frontend", v?: number }

      if (
        typeof data.pk !== "string" ||
        !data.pk ||
        typeof data.frontendId !== "string" ||
        !data.frontendId
      ) {
        log.error(
          "kx frame missing/invalid pk or frontendId (both must be non-empty strings)",
        );
        return;
      }

      const frontendPubKey = await fromBase64(data.pk);
      const sessionKeys = await deriveSessionKeys(
        this.config.keyPair,
        frontendPubKey,
        "daemon",
      );

      // Frontends that omit `v` default to 1. ControlRename no longer gates on
      // this (the daemon always emits the Label union now — ADR-0003 A1.3#1);
      // the version is retained only for future gating of new message types.
      const protocolVersion =
        typeof data.v === "number" && Number.isFinite(data.v) ? data.v : 1;

      // Capture first-join BEFORE the set below — drives the kx re-broadcast guard.
      const isNewPeer = !this.peers.has(data.frontendId);

      this.peers.set(data.frontendId, {
        frontendId: data.frontendId,
        publicKey: frontendPubKey,
        sessionKeys,
        protocolVersion,
      });

      // A real frontend just joined: this pairing is alive. Clear the
      // dead-pairing throttle so any future reconnect happens at full speed,
      // and mark this connection as having seen a peer so a drop+reconnect
      // during a live session does not count toward the throttle.
      this.peerlessReconnects = 0;
      this.hadPeerThisConnection = true;

      log.info(`key exchange completed with frontend ${data.frontendId}`);

      // kx delivery race fix: the daemon broadcasts its pubkey once at auth time
      // (`relay.auth.ok` handler), but the relay does NOT cache kx frames — it only
      // fans out to peers connected AT THAT MOMENT. A frontend that connects AFTER
      // the auth-time broadcast therefore never receives the daemon pubkey and can
      // never derive its session keys (no `TP_KX_OK` on the app). The frontend's own
      // kx.frame reaches us (this handler) regardless of timing, so re-broadcast our
      // pubkey on a frontend's FIRST join — that guarantees the late-connecting app
      // gets it. The loopback fake daemon already did this (local-relay-loopback.ts);
      // the real daemon was missing it, masking a genuine pairing race in tests.
      //
      // Guard on `isNewPeer` (captured before the set) to avoid a re-broadcast loop:
      // the re-broadcast lands on an already-keyed frontend's `alreadyKeyed` path,
      // which re-sends its kx — that second kx.frame finds the frontend already in
      // `peers`, so we suppress and the exchange terminates after one round-trip.
      if (isNewPeer) {
        await this.broadcastDaemonPublicKey();
      }

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
        // The frontendId already pins the exact peer, so its session keys are
        // the only ones that can decrypt this frame — the all-peers fallback
        // below would never succeed for it. Contain a decrypt/parse throw to a
        // warn (instead of escaping to the top-level catch as a silent drop)
        // and return; do not fall through.
        try {
          await this.decryptAndDispatch(frame, peer);
        } catch (err) {
          log.warn(
            `decrypt/dispatch failed for peer ${peer.frontendId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return;
      }
    }

    // Fallback: try all peers (for backward compat)
    for (const peer of this.peers.values()) {
      try {
        await this.decryptAndDispatch(frame, peer);
        return;
      } catch (err) {
        log.warn(
          `fallback decrypt failed for peer ${peer.frontendId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
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
      // The unpair/rename branches reach pairing removal and label updates —
      // the most consequential decrypted surface. Narrow through the boundary
      // guard so a malformed frame can never fire either handler.
      if (msg.t === CONTROL_UNPAIR || msg.t === CONTROL_RENAME) {
        const control = parseControlMessage(msg);
        if (!control) {
          log.warn(`dropped malformed control frame: t=${msg.t}`);
          return;
        }
        if (control.t === CONTROL_UNPAIR) {
          this.onUnpair?.({
            frontendId: control.frontendId,
            reason: control.reason,
          });
        } else {
          // `parseControlMessage` already normalized the wire label via
          // `decodeWireLabel`; on this surface `{ set: false }` is an
          // authoritative clear.
          this.onRename?.({
            frontendId: control.frontendId,
            label: control.label,
          });
        }
        return;
      }
    }

    if (msg.t === "in.chat" || msg.t === "in.term") {
      // Input frames reach the PTY/chat write path — validate the two fields
      // `onInput` dereferences before trusting them.
      if (typeof msg.sid !== "string" || typeof msg.d !== "string") {
        log.warn(`dropped malformed input frame: t=${msg.t}`);
        return;
      }
      const kind = msg.t === "in.chat" ? "chat" : "term";
      this.events.onInput?.(kind, msg.sid, msg.d, peer.frontendId);
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
  ): Promise<boolean> {
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const ct = await encrypt(plaintext, peer.sessionKeys.tx);
    return this.send({ t: "relay.pub", sid, ct, seq });
  }

  /** Broadcast `payload` to every connected peer under `sid`/`seq`. */
  private async broadcastEncrypted(
    sid: string,
    seq: number,
    payload: unknown,
  ): Promise<void> {
    if (!this.authenticated || this.peers.size === 0) return;
    // Best-effort per peer: an encrypt()/send() throw for ONE peer (e.g. a
    // peer with corrupt or rotated session keys) must NOT abort the loop and
    // silently deny the frame to every *subsequent* peer. The daemon is N:N
    // (multiple frontends per pairing), so a single bad peer would otherwise
    // drop a record/state broadcast for all the healthy ones. Contain the
    // failure to a warn — mirrors the per-peer containment in the handleFrame
    // fallback loop above.
    for (const peer of this.peers.values()) {
      try {
        await this.sendEncrypted(peer, sid, seq, payload);
      } catch (err) {
        log.warn(
          `broadcast send failed for peer ${peer.frontendId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** Encrypt and publish a WS record to all connected frontends via relay. */
  async publishRecord(rec: SessionRec): Promise<void> {
    return this.broadcastEncrypted(rec.sid, rec.seq, rec);
  }

  /** Encrypt and publish a state update to all connected frontends via relay. */
  async publishState(sid: string, stateMsg: SessionStateMsg): Promise<void> {
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
      // Honour the actual transmit result: `send()` silently no-ops when the
      // socket is null/closing, which happens if a concurrent dispose()
      // (e.g. a racing removePairing) ran cleanup() mid-iteration. Returning
      // the real boolean stops the caller's notified count from being inflated
      // by frames that never left the daemon.
      return await this.sendEncrypted(peer, RELAY_CHANNEL_CONTROL, 0, msg);
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

  /**
   * Encrypted control.rename notice to `frontendId`; see sendUnpairNotice for
   * mechanics.
   *
   * Always emits the `Label` union object (`{ set, value? }`) — the per-peer
   * version-gate that previously downgraded to a legacy string for v1 peers
   * has been removed (ADR-0003 Amendment 1, A1.3#1). The `label` field is
   * always present and is either `{ set: true, value }` (set) or
   * `{ set: false }` (authoritative clear).
   */
  async sendRenameNotice(frontendId: string, label: Label): Promise<boolean> {
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
   * The relay unseals the blob and delivers to APNs on behalf of the daemon.
   *
   * `sealed` is the opaque blob from the relay ("tpps1.<v>.<b64>") or, in the
   * back-compat upgrade window, a legacy plaintext APNs token stored before
   * Path X was active. The daemon treats it as opaque and never unwraps it;
   * the relay's PushSealer classifies non-"tpps1." blobs as "legacy" and uses
   * them verbatim as the APNs device token.
   */
  sendPush(
    frontendId: string,
    sealed: string,
    title: string,
    body: string,
    interruptionLevel?: PushInterruptionLevel,
    data?: { sid: string; daemonId?: string; event: string },
  ): void {
    const msg: RelayClientMessage = {
      t: "relay.push",
      frontendId,
      sealed,
      title,
      body,
      interruptionLevel,
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
    // Guard against a dispose() that raced an in-flight relay.auth.ok handler:
    // handleMessage awaits broadcastDaemonPublicKey() before calling startPing,
    // and a concurrent dispose()→cleanup()→stopPing() can complete during that
    // await (disposed=true, pingTimer already null). Without this re-check the
    // stale continuation would install a fresh interval that dispose() will
    // never clear, leaking a live 30s timer for the process lifetime.
    if (this.disposed) return;
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

  /**
   * Write `msg` to the relay socket. Returns `true` only if the frame was
   * actually handed to an OPEN socket; `false` when the socket is null/closing
   * (e.g. a concurrent `dispose()` already ran `cleanup()` and nulled `ws`).
   * Callers that report delivery to the user (e.g. `sendControl`'s notified
   * count) MUST honour the return so they never count a silently-dropped frame.
   */
  private send(msg: RelayClientMessage): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;

    // A reconnect in which no peer completed kx during the just-ended
    // connection counts toward the dead-pairing throttle. We track this with
    // `hadPeerThisConnection` (reset in `cleanup()`), NOT `peers.size`: the
    // `peers` Map is preserved across reconnects for the resume fast-path, so
    // once any frontend ever joined, `peers.size` would stay non-zero forever
    // and the throttle could never re-arm — silently defeating it for every
    // pairing that ever had a live frontend (the 9-pairing → 3113 re-auth
    // failure mode). A genuinely-dead pairing leaves `hadPeerThisConnection`
    // false and accumulates these; a live pairing resets it in `handleKxFrame`.
    this.peerlessReconnects = nextPeerlessReconnects(
      this.peerlessReconnects,
      this.hadPeerThisConnection,
    );

    const { delay, nextAttempt } = computeReconnectPlan(
      this.reconnectAttempt,
      this.peerlessReconnects,
    );
    this.reconnectAttempt = nextAttempt;
    // connect() can reject (corrupt stored relayUrl → WebSocket ctor throws,
    // or deriveKxKey rejects on a sodium-init failure). An uncaught rejection
    // from this timer would permanently kill the reconnect loop and escape to
    // the process unhandledRejection handler instead of our logger — the
    // pairing then shows in `tp pair list` but never reconnects. Catch, log,
    // and reschedule so exponential backoff continues.
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        log.error("reconnect attempt failed, will retry:", err);
        this.scheduleReconnect();
      });
    }, delay);
  }

  private cleanup(): void {
    // Reset the per-connection peer flag at the start of every (re)connect.
    // The `peers` Map itself is intentionally NOT cleared here — it carries
    // session keys reused by the resume fast-path. Only this connection-scoped
    // signal resets, so the dead-pairing throttle can re-arm for a pairing
    // whose frontend has gone away even though stale peer entries remain.
    this.hadPeerThisConnection = false;
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

  /** The relay URL this client connects to. */
  get relayUrl(): string {
    return this.config.relayUrl;
  }

  /** The pairing label for this relay client (keep-current surface: absence or
   * `{ set: false }` means "keep the app's current label", not "clear"). */
  get label(): Label | undefined {
    return this.config.label;
  }
}
