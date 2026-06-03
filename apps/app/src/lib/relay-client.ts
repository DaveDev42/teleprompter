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
  Label,
  RecordKind,
  RelayClientMessage,
  RelayFrame,
  RelayServerMessage,
  SessionClientMessage,
  SessionKeys,
  SessionMeta,
  SessionRec,
  SessionWorktreeInfo,
} from "@teleprompter/protocol/client";
import {
  CONTROL_RENAME,
  CONTROL_UNPAIR,
  decodeKxLabelOrKeep,
  decodeWireLabel,
  decrypt,
  deriveKxKey,
  deriveSessionKeys,
  encrypt,
  makeLabel,
  RELAY_CHANNEL_CONTROL,
  RELAY_CHANNEL_META,
  toBase64,
  WS_PROTOCOL_VERSION,
} from "@teleprompter/protocol/client";
import { secureDelete, secureGet, secureSet } from "./secure-storage";
import type { TransportClient, TransportEventHandler } from "./transport";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
/** secure-storage key prefix for cached resume tokens (per daemonId). */
const RESUME_TOKEN_KEY_PREFIX = "relay_resume_";
/**
 * Cadence for the frontend's relay-level keep-alive ping. Shorter than the
 * daemon-side 30s so mobile clients notice a dead network (Wi-Fi → cellular
 * handoff, sleep, captive portal) faster — without depending on the relay's
 * 90s idle timeout to surface the disconnect. The relay accepts `relay.ping`
 * from any client and replies with `relay.pong` (no per-client state on the
 * relay).
 */
const RELAY_PING_INTERVAL_MS = 15_000;
/**
 * If this many pings go out without a `relay.pong` in between, force-close
 * the socket. Two missed pongs ≈ 30s of silence, which is well past any
 * normal RTT spike and a strong signal the underlying TCP connection is
 * dead. `ws.close()` synthesizes an `onclose`, which fires `onDisconnected`
 * + `scheduleReconnect` like a real close would.
 */
const RELAY_MAX_MISSED_PONGS = 2;

/**
 * Drop any cached resume token for a daemonId. Call after creating a fresh
 * pairing with the same daemonId — without this, the new frontend keypair
 * would attempt `relay.auth.resume`, the relay would accept it, and the
 * daemon-side `sendKeyExchange()` would be skipped. Daemon never learns
 * the new frontend's pubkey → `onFrontendJoined` never fires → `hello`
 * is never sent → Sessions tab stays empty.
 */
export async function clearResumeToken(daemonId: string): Promise<void> {
  await secureDelete(`${RESUME_TOKEN_KEY_PREFIX}${daemonId}`);
}
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

  /**
   * Called when daemon notifies this frontend that the pairing label was
   * changed. `label` is the `Label` tagged union — `{ set: false }` is an
   * authoritative clear (this is a ControlRename surface, decoded with
   * `decodeWireLabel`).
   */
  onRename: ((info: { daemonId: string; label: Label }) => void) | null = null;

  /**
   * Called when the daemon broadcasts its public key after auth (relay.kx),
   * or via the meta `hello` daemonLabel. Carries the label the daemon was
   * paired with so the frontend can adopt it without burning bytes in the QR.
   * `label` is always a concrete `{ set: true, value }` here: these are
   * keep-current surfaces, so the relay client decodes them with
   * `decodeKxLabelOrKeep` and simply does not fire this callback when the
   * daemon advertises no label (the frontend keeps its existing fallback).
   */
  onDaemonHello: ((info: { daemonId: string; label: Label }) => void) | null =
    null;

  /** Track attached session and last seq for auto-resume on reconnect */
  private attachedSid: string | null = null;
  private lastSeq = 0;
  private hasConnectedBefore = false;
  private pingStart = 0;
  /** Last measured round-trip time in ms */
  private rtt = -1;
  /**
   * Periodic relay.ping timer for fast disconnect detection. Started when
   * relay.auth.ok arrives, cleared on close/dispose. See
   * `RELAY_PING_INTERVAL_MS` / `RELAY_MAX_MISSED_PONGS`.
   */
  private relayPingTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Pings sent since the last `relay.pong`. Reset to 0 on each pong, force-
   * close once it exceeds `RELAY_MAX_MISSED_PONGS`.
   */
  private missedRelayPongs = 0;
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
      this.stopRelayPing();
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
        // Subscribe to meta + control channels with `after: 0` so the relay
        // replays anything cached on these sids. The daemon publishes its
        // `hello` (with session list + daemonLabel) to __meta__ once per
        // `onFrontendJoined`, but `onFrontendJoined` only fires on a fresh kx
        // — not on a resume reconnect. Without cache replay, a resumed
        // frontend has no path to refresh Sessions and the tab stays empty
        // (or stale from session-store persistence) until the next manual
        // re-pair. Replaying __meta__ resurrects `hello`; replaying
        // __control__ resurrects any in-flight control.unpair/control.rename.
        this.sendRelay({ t: "relay.sub", sid: RELAY_CHANNEL_META, after: 0 });
        this.sendRelay({
          t: "relay.sub",
          sid: RELAY_CHANNEL_CONTROL,
          after: 0,
        });
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
        // Fire onConnected *after* kx + flush. Subscribers wire this into
        // React state (`useAnyRelayConnected`) and any side-effects that
        // immediately call back into `sendEncrypted` (e.g. ChatView's
        // resume-on-mount effect) would otherwise race the daemon: with
        // `authenticated=true` set above and `sessionKeys` already derived
        // in `connect()`, those calls bypass the pending queue and ship
        // ciphertext the daemon can't decrypt yet — silently dropped on
        // the daemon side because no FrontendPeer exists for this kx
        // generation. Firing onConnected after kx means the first frame
        // any subscriber can send is one the daemon can decrypt.
        this.events.onConnected?.();
        // Begin relay-level keep-alive pings so we notice a dead network
        // before the relay's 90s idle timeout.
        this.startRelayPing();
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
        this.missedRelayPongs = 0;
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
      // `label` is a keep-current surface: the daemon advertises its label
      // here so the frontend can adopt it, but absence (older daemon omits the
      // field, or a `{ set: false }` union) means "keep my existing fallback".
      // `decodeKxLabelOrKeep` returns a concrete `{ set: true, value }` only
      // when a real label is present, else null — so we simply don't fire the
      // callback and the frontend's fallback stays in effect.
      const label = decodeKxLabelOrKeep(data.label);
      if (label) {
        this.onDaemonHello?.({ daemonId: this.config.daemonId, label });
      }
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
      // Advertise our protocol version so the daemon knows whether this
      // frontend can decode the `Label` tagged union on ControlRename. An
      // un-updated app (no `v`, treated as v1 by the daemon) gets a legacy
      // string-shaped label so it never coerces a union object to "" and
      // silently clears the label. See packages/protocol/src/types/label.ts.
      v: WS_PROTOCOL_VERSION,
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
          this.events.onRec?.(msg as SessionRec);
          break;
        case "batch":
          for (const rec of msg.d) {
            this.trackSeq(rec.seq);
            this.events.onRec?.(rec as SessionRec);
          }
          break;
        case "state":
          this.events.onState?.(msg.sid, msg.d as SessionMeta);
          break;
        case "hello":
          this.events.onSessionList?.(msg.d.sessions as SessionMeta[]);
          // `daemonLabel` is included since the label-broadcast fix so the
          // frontend can adopt the label even when it missed the initial
          // relay.kx broadcast (e.g. frontend reconnected while daemon was
          // already online). This is a keep-current surface — older daemons
          // omit the field and a `{ set: false }` union both decode to "keep
          // my fallback", so we only fire the callback for a concrete label.
          if (this.onDaemonHello) {
            const daemonLabel = decodeKxLabelOrKeep(msg.d.daemonLabel);
            if (daemonLabel) {
              this.onDaemonHello({
                daemonId: this.config.daemonId,
                label: daemonLabel,
              });
            }
          }
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
          this.events.onWorktreeList?.(msg.d as SessionWorktreeInfo[]);
          break;
        case "worktree.created":
          this.events.onWorktreeCreated?.(
            msg.d as SessionWorktreeInfo,
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
          // ControlRename is an authoritative surface: `{ set: false }` is a
          // genuine clear, `{ set: true, value }` is the new label. Decode the
          // tagged union forgivingly — a v2 daemon sends the union object, a
          // v1 daemon (or one talking to an older app) sends a legacy string
          // ("" = clear). `decodeWireLabel` normalizes all of these. The old
          // `typeof msg.label === "string" ? msg.label : ""` coerced a union
          // object to "" and silently cleared the label — the data-corruption
          // bug this migration fixes.
          const label = decodeWireLabel(msg.label);
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
      // The wire field is the `Label` tagged union. The daemon's inbound path
      // runs every ControlRename through `decodeWireLabel`, which accepts both
      // this union and a legacy bare string, so an older daemon still
      // understands us. The app's *receive* path (handleFrame's CONTROL_RENAME
      // case) likewise decodes with `decodeWireLabel`, and `sendKeyExchange`
      // advertises `v: WS_PROTOCOL_VERSION` so the daemon version-gates what it
      // sends back to us. See packages/protocol/src/types/label.ts.
      label: makeLabel(label),
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

  send(msg: SessionClientMessage): void {
    this.sendEncrypted(msg as unknown as Record<string, unknown>);
  }

  // ── TransportClient: Session management ──

  createSession(
    cwd: string,
    sid?: string,
    size?: { cols: number; rows: number },
  ): void {
    this.sendEncrypted({
      t: "session.create",
      cwd,
      sid,
      cols: size?.cols,
      rows: size?.rows,
    });
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

  private startRelayPing(): void {
    this.stopRelayPing();
    this.missedRelayPongs = 0;
    this.relayPingTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      // Increment *before* sending so the count covers in-flight pings.
      // If the previous N intervals all elapsed without a pong, the socket
      // is effectively dead — force a close to drive reconnection.
      this.missedRelayPongs += 1;
      if (this.missedRelayPongs > RELAY_MAX_MISSED_PONGS) {
        this.stopRelayPing();
        this.ws?.close();
        return;
      }
      this.sendRelay({ t: "relay.ping", ts: Date.now() });
    }, RELAY_PING_INTERVAL_MS);
  }

  private stopRelayPing(): void {
    if (this.relayPingTimer) {
      clearInterval(this.relayPingTimer);
      this.relayPingTimer = null;
    }
    this.missedRelayPongs = 0;
  }

  private cleanup(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopRelayPing();
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
