import Foundation
import Security
import os

/// Relay WebSocket client — connects, authenticates as `role=frontend`, keeps the
/// socket alive (ADR-0001 Phase 3, M2).
///
/// Wraps `URLSessionWebSocketTask` (no third-party dependency). The state machine
/// is `idle → connecting → authenticating → authenticated` (or `failed`). On a
/// successful auth it emits the `TP_RELAY_AUTH_OK daemon=<id>` marker — the
/// on-device proof that the app reached the relay, the relay accepted the
/// `relay.auth` frame shape + token, and the receive loop decoded the response.
/// A rejection emits `TP_RELAY_AUTH_FAIL detail=<…>` (never the token/secret).
///
/// M3 extends auth with the in-band key exchange: after `relay.auth.ok` the
/// client subscribes to `__meta__`/`__control__`, sends its sealed `relay.kx`
/// pubkey + frontendId, derives per-frontend session keys, and decrypts the first
/// `hello` frame (the session list) — emitting `TP_KX_OK` then `TP_FRAME_OK`.
/// M7 implements the fast-path `relay.auth.resume` (persisted across background).
/// The auth token is the verbatim FFI `deriveRelayToken` output (lowercase hex of
/// BLAKE2b-256(pairingSecret || "relay-auth")), byte-equal to the TS golden vector.
// `@unchecked Sendable`: RelayClient uses a hand-rolled hybrid concurrency model
// that the compiler cannot verify statically. Thread-safety is maintained manually:
// - All SessionStore / PairingStore writes hop to the main actor via
//   `Task { @MainActor in }` (see onHello, onState, onBatch, onRec,
//   scheduleReconnect, startPing, sendManualPing).
// - Mutable properties written from URLSession delegate / DispatchSource handlers
//   are either guarded by those serial queues or are `nonisolated(unsafe)` with the
//   documented invariant that all writes go through `Task { @MainActor in }`.
// - The class is deliberately NOT @MainActor so URLSession callbacks run off-main
//   on the session's queue and then hop to the main actor only for store mutations.
// This assertion is intentional and correct — do not replace with `Sendable` without
// first auditing all stored-property access patterns.
final class RelayClient: NSObject, @unchecked Sendable {
    /// Connection lifecycle. `authenticated` is the M2 success terminal.
    enum State: Equatable {
        case idle
        case connecting
        case authenticating
        case authenticated(daemonId: String)
        case failed(reason: String)
    }

    /// On-device verification markers (kept in sync with `scripts/ios.sh`).
    static let authOkMarker = "TP_RELAY_AUTH_OK"
    static let authFailMarker = "TP_RELAY_AUTH_FAIL"
    /// M3 markers: kx session keys derived, and the first decrypted `hello` frame.
    static let kxOkMarker = "TP_KX_OK"
    static let kxFailMarker = "TP_KX_FAIL"
    static let frameOkMarker = "TP_FRAME_OK"
    static let frameFailMarker = "TP_FRAME_FAIL"
    /// M4 marker: a session attached + its history backfilled (≥1 event record
    /// rendered as a chat item). Emitted once per session after its first `batch`.
    static let sessionOkMarker = "TP_SESSION_OK"
    static let sessionFailMarker = "TP_SESSION_FAIL"
    /// M5 marker: input round-tripped — the app sent an `in.chat` probe and saw
    /// the daemon echo it back as an `io` record (the bytes the app sent appeared
    /// in the terminal stream). Emitted once per session.
    static let inputOkMarker = "TP_INPUT_OK"
    static let inputFailMarker = "TP_INPUT_FAIL"

    private(set) var state: State = .idle {
        didSet { onStateChange?(state) }
    }

    /// Optional observer (UI). Invoked on the URLSession delegate queue.
    var onStateChange: ((State) -> Void)?

    /// M8: Called when an inbound `control.presence` frame arrives. `online` is
    /// the daemon's current presence. Used to drive per-daemon status dots.
    var onPresence: ((_ daemonId: String, _ online: Bool) -> Void)?

    /// H7: Called when an inbound `control.unpair` frame is received from the
    /// daemon. The app should remove the pairing from PairingStore and dismiss
    /// any UI associated with this daemon.
    var onUnpair: ((_ daemonId: String, _ reason: String) -> Void)?

    /// H8: Called when an inbound `control.rename` frame is received from the
    /// daemon. The new label should be persisted in PairingStore.
    var onRename: ((_ daemonId: String, _ label: String?) -> Void)?

    /// Cached after `relay.auth.ok` for the M7 resume fast-path. Persisted to
    /// UserDefaults so it survives backgrounding (keyed by daemonId).
    private(set) var resumeToken: String? {
        didSet { persistResumeToken() }
    }
    private(set) var resumeExpiresAt: Double? {
        didSet { persistResumeToken() }
    }
    /// True while the current connection attempt is trying the resume fast-path.
    /// On `relay.auth.err` during resume: clear token + retry full auth.
    private var isResuming = false

    private let pairing: Pairing
    private let session: URLSession
    private let log = Logger(subsystem: "dev.tpmt.teleprompter", category: "relay")
    private let pingInterval: TimeInterval

    private var task: URLSessionWebSocketTask?
    private var pingTimer: DispatchSourceTimer?

    // MARK: kx / E2EE session state (M3)

    /// The frontend's ephemeral X25519 keypair for this connection, generated in
    /// `startKeyExchange`. Held so the (deferred) kx.frame-derived variant can
    /// re-derive session keys; not persisted across connects.
    private var kxKeyPair: FfiKeyPair?
    /// The per-frontend session keys (`rx` decrypts inbound, `tx` encrypts
    /// outbound), derived once the frontend has both keypairs. Nil until kx.
    private var sessionKeys: FfiSessionKeys?
    /// Set once the first `hello` frame is decrypted, so the on-demand fallback
    /// timer does not double-request after a successful auto-`hello`.
    /// Reset to false on normal reconnect so the fallback can fire again on the
    /// new connection. Does NOT gate `TP_FRAME_OK` — use `frameOkEmitted` for that.
    private var helloReceived = false
    /// Sticky per-process flag: once `TP_FRAME_OK` is logged it stays true so a
    /// reconnect-triggered second successful `hello` never re-emits the marker.
    private var frameOkEmitted = false

    // MARK: session attach / backfill (M4)

    /// The UI store fed by decrypted session records. Weak: the app owns it for
    /// the process lifetime; the client only writes into it. All writes hop to
    /// `@MainActor` (the store is main-actor isolated).
    ///
    /// On assignment, installs the three Tranche E terminal relay callbacks so
    /// `TerminalView` can call `in.term` / `resize` / history fetch without
    /// having a direct reference to this client (SessionDetailView is frozen and
    /// cannot add new parameters to TerminalView).
    weak var sessionStore: SessionStore? {
        didSet { installTerminalCallbacks() }
    }

    // MARK: terminal history buffer (Tranche E)

    /// Concatenated raw PTY bytes for each session, accumulated from io records
    /// (both batch backfill and live). Used for history replay when a terminal
    /// view attaches after backfill has already fired (e.g. user navigates to
    /// the terminal tab later).
    ///
    /// `nonisolated(unsafe)` because all writes happen inside `Task { @MainActor in }`
    /// blocks (serialized on the main actor), and all reads occur on the main actor
    /// from TerminalView / SwiftTermView. The non-isolated annotation suppresses the
    /// concurrency checker so the value can be captured in non-`@MainActor` closures
    /// stored as `(String) -> Data?` in the associated-object slots on SessionStore.
    /// Callers MUST only access this property on the main actor.
    nonisolated(unsafe) private(set) var ioHistory: [String: Data] = [:]
    /// Guard so the auto-attach (on the first `hello`) fires once per connection —
    /// a re-`hello` (e.g. the on-demand fallback also lands) must not re-attach.
    private var didAutoAttach = false
    /// Sessions for which a `TP_SESSION_OK` has already been emitted, so a second
    /// `batch` (overlapping resume + cache replay) does not double-emit the marker.
    private var sessionOkEmitted: Set<String> = []

    // MARK: input round-trip probe (M5)

    /// The probe text the app auto-sends as `in.chat` once a session is attached +
    /// backfilled, used to prove the input→io round-trip on-device. A daemon (or
    /// the loopback) echoes input back as an `io` record; when that record's bytes
    /// contain this token, the app emits `TP_INPUT_OK`. Per sid: nil until sent.
    private var inputProbe: [String: String] = [:]
    /// Sessions for which `TP_INPUT_OK` has fired, so a repeated echo (or a later
    /// io record still containing the token) does not double-emit.
    private var inputOkEmitted: Set<String> = []
    /// A fixed probe token — deterministic so the smoke harness can correlate it.
    private static let probeToken = "tp-input-probe"

    // MARK: H6 reconnect state

    /// Number of consecutive reconnect attempts. Reset to 0 on successful auth.
    private var reconnectAttempt = 0
    /// Maximum reconnect backoff in seconds. Cap matches the daemon's RECONNECT_MAX_MS.
    private static let reconnectMaxDelay: TimeInterval = 30
    /// Timer driving the next reconnect attempt.
    private var reconnectTimer: DispatchSourceTimer?

    // MARK: L5 missed-pong tracking

    /// Number of consecutive missed relay.pong responses. Reset on every pong.
    private var missedPongs = 0
    /// After this many missed pongs, cancel the socket and trigger reconnect.
    private static let maxMissedPongs = 2

    // MARK: M12 RTT tracking

    /// Timestamp of the most recently sent `relay.ping`.
    /// Written from three contexts (ping DispatchSource, receiveLoop, sendManualPing);
    /// all writes are serialized through `Task { @MainActor in }` to avoid data races.
    /// `nonisolated(unsafe)` lets the value be captured in non-isolated closures that
    /// are guaranteed to only write through the main actor.
    /// Callers MUST only access this property on the main actor.
    nonisolated(unsafe) private var lastPingSentAt: Date? = nil
    /// The most recent measured round-trip time in milliseconds, computed as
    /// (pong arrival time) − (ping sent time) × 1000. Nil until the first pong.
    /// Exposed via `PairingViewModel.rtt(for:)` for the Diagnostics panel (M12).
    /// All writes go through `Task { @MainActor in }`. Callers MUST be on main actor.
    nonisolated(unsafe) private(set) var latestRTT: Int? = nil

    // MARK: M7 resume-token UserDefaults keys

    private var resumeTokenDefaultsKey: String {
        "tp.relay.\(pairing.daemonId).resumeToken"
    }
    private var resumeExpiresAtDefaultsKey: String {
        "tp.relay.\(pairing.daemonId).resumeExpiresAt"
    }

    /// - Parameters:
    ///   - pairing: the daemon pairing carrying relay URL, daemonId, secret, frontendId.
    ///   - session: injectable for tests (default ephemeral, no cookies/cache).
    ///   - pingInterval: keep-alive cadence; 30s matches the daemon + relay idle window.
    init(pairing: Pairing,
         session: URLSession = .init(configuration: .ephemeral),
         pingInterval: TimeInterval = 30) {
        self.pairing = pairing
        self.session = session
        self.pingInterval = pingInterval
        super.init()
        // M7: Load persisted resume token so it survives backgrounding.
        let defaults = UserDefaults.standard
        resumeToken = defaults.string(forKey: resumeTokenDefaultsKey)
        if let exp = defaults.object(forKey: resumeExpiresAtDefaultsKey) as? Double {
            resumeExpiresAt = exp
        }
    }

    deinit { disconnect() }

    /// The relay auth token: verbatim FFI output, used as-is in `relay.auth.token`.
    /// Computed here (not stored) so the secret is never retained beyond the call.
    private func authToken() -> String {
        deriveRelayToken(pairingSecret: pairing.pairingSecret)
    }

    // MARK: connect / auth

    /// Open the WebSocket and send auth. Idempotent against re-entry: a second
    /// call while already connecting/authenticated is ignored.
    func connect() {
        switch state {
        case .connecting, .authenticating, .authenticated:
            return
        case .idle, .failed:
            break
        }
        guard let url = URL(string: pairing.relayURL) else {
            fail("invalid relay URL")
            return
        }
        state = .connecting
        let t = session.webSocketTask(with: url)
        task = t
        t.resume()
        receiveLoop()
        sendAuth()
    }

    /// Tear down the socket and timers. Safe to call repeatedly.
    func disconnect() {
        reconnectTimer?.cancel()
        reconnectTimer = nil
        pingTimer?.cancel()
        pingTimer = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    private func sendAuth() {
        // M7: Use resume fast-path if we have a non-expired token.
        if let token = resumeToken,
           let exp = resumeExpiresAt,
           Date().timeIntervalSince1970 * 1000 < exp {
            isResuming = true
            state = .authenticating
            let resume = RelayAuthResume(token: token)
            send(resume) { [weak self] error in
                if let error { self?.fail("auth.resume send: \(error)") }
            }
        } else {
            sendFullAuth()
        }
    }

    private func sendFullAuth() {
        let auth = RelayAuth(
            daemonId: pairing.daemonId,
            token: authToken(),
            frontendId: pairing.frontendId)
        state = .authenticating
        send(auth) { [weak self] error in
            if let error { self?.fail("auth send: \(error)") }
        }
    }

    // MARK: send

    private func send<T: Encodable>(_ message: T, completion: @escaping @Sendable (Error?) -> Void) {
        guard let task else {
            completion(URLError(.networkConnectionLost))
            return
        }
        do {
            let data = try JSONEncoder().encode(message)
            // Send as text — the relay parses UTF-8 JSON, binary frames are reserved
            // for the framed-codec data path (M3+).
            let json = String(decoding: data, as: UTF8.self)
            task.send(.string(json)) { completion($0) }
        } catch {
            completion(error)
        }
    }

    // MARK: receive loop

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(message):
                self.handle(message)
                self.receiveLoop() // continue until the socket closes
            case let .failure(error):
                // H6: any receive failure → schedule reconnect.
                self.log.notice("relay closed: \(error.localizedDescription, privacy: .public)")
                self.scheduleReconnect()
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let data: Data
        switch message {
        case let .string(s): data = Data(s.utf8)
        case let .data(d): data = d
        @unknown default: return
        }
        guard let envelope = try? JSONDecoder().decode(RelayServerEnvelope.self, from: data) else {
            log.notice("relay: undecodable frame")
            return
        }
        switch envelope.t {
        case "relay.auth.ok":
            if let ok = try? JSONDecoder().decode(RelayAuthOk.self, from: data) {
                onAuthOk(ok)
            }
        case "relay.auth.err":
            let detail = (try? JSONDecoder().decode(RelayAuthErr.self, from: data))?.e ?? "unknown"
            onAuthErr(detail: detail)
        case "relay.presence":
            if let p = try? JSONDecoder().decode(RelayPresence.self, from: data) {
                onPresenceFrame(p)
            }
        case "relay.pong":
            // L5: reset missed-pong counter on every pong.
            missedPongs = 0
            // M12: compute RTT from ping-sent timestamp. Both lastPingSentAt and
            // latestRTT are accessed inside the @MainActor block so reads/writes are
            // serialized with all writers (ping timer, sendManualPing).
            // pongAt is captured outside so the timestamp reflects actual pong arrival,
            // not the moment the main actor eventually runs the block.
            let pongAt = Date()
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let sentAt = self.lastPingSentAt {
                    self.latestRTT = Int(pongAt.timeIntervalSince(sentAt) * 1000)
                    self.lastPingSentAt = nil
                }
            }
        case "relay.kx.frame":
            if let frame = try? JSONDecoder().decode(RelayKeyExchangeFrame.self, from: data) {
                onKeyExchangeFrame(frame)
            }
        case "relay.frame":
            if let frame = try? JSONDecoder().decode(RelayFrame.self, from: data) {
                onRelayFrame(frame)
            }
        default:
            log.notice("relay: ignoring t=\(envelope.t, privacy: .public)")
        }
    }

    private func onAuthOk(_ ok: RelayAuthOk) {
        // M7: Cache the rolling resume token.
        if let token = ok.resumeToken, let exp = ok.resumeExpiresAt {
            resumeToken = token
            resumeExpiresAt = exp
        }
        isResuming = false
        reconnectAttempt = 0
        state = .authenticated(daemonId: ok.daemonId)
        log.notice("\(Self.authOkMarker, privacy: .public) daemon=\(ok.daemonId, privacy: .public)")
        startPing()
        // Subscribe BEFORE sending relay.kx so we never miss the daemon's
        // auto-`hello`: it publishes to `__meta__` the instant kx completes
        // (`relay-manager.ts:132`), and a frame published to a sid we haven't
        // subscribed to is dropped (`relay-server.ts:1161`). `after: 0` also lets
        // the relay replay a cached hello if the ordering still races.
        subscribe(RelayChannel.meta, after: 0)
        subscribe(RelayChannel.control, after: 0)
        startKeyExchange()
    }

    private func onAuthErr(detail: String) {
        if isResuming {
            // M7: Resume failed (token expired / rotated secret). Clear the token
            // and reconnect using full auth on the next attempt.
            log.notice("relay.auth.err during resume (\(detail, privacy: .public)); falling back to full auth")
            isResuming = false
            resumeToken = nil
            resumeExpiresAt = nil
            // Bug 2 fix: do NOT manually cancel the task here. scheduleReconnect()
            // already tears it down (task?.cancel + task = nil). Cancelling here
            // causes the pending receiveLoop .receive callback to fire .failure,
            // which calls scheduleReconnect() a second time — the idempotency guard
            // in scheduleReconnect() stops the second call, but we avoid the race
            // entirely by letting scheduleReconnect() own teardown.
            scheduleReconnect()
        } else {
            fail("relay.auth.err: \(detail)")
        }
    }

    // MARK: M8 presence

    private func onPresenceFrame(_ p: RelayPresence) {
        log.notice("relay.presence daemon=\(p.daemonId, privacy: .public) online=\(p.online)")
        onPresence?(p.daemonId, p.online)
    }

    // MARK: kx (M3)

    private func subscribe(_ sid: String, after: Int?) {
        send(RelaySubscribe(sid: sid, after: after)) { [weak self] error in
            if let error { self?.log.notice("sub \(sid, privacy: .public): \(error.localizedDescription, privacy: .public)") }
        }
    }

    // MARK: session attach / backfill (M4)

    /// Attach to a session. Sends BOTH the relay-level `relay.sub` (so the relay
    /// forwards the daemon's reply on this sid) AND the app-level `attach` (sealed
    /// with tx, published via `relay.pub` — so the daemon produces a `state`
    /// reply). `relay.sub` alone yields no daemon response; `attach` without a sub
    /// means the reply is dropped. The daemon's `state` reply then triggers
    /// `resume` (`onState`).
    func attach(sid: String) {
        guard let keys = sessionKeys else {
            log.notice("attach before kx — dropping sid=\(sid, privacy: .public)")
            return
        }
        subscribe(sid, after: 0)
        do {
            let body = try JSONEncoder().encode(SessionAttach(sid: sid))
            let ct = try seal(plaintext: body, key: keys.tx, nonce: try randomBytes(24))
            send(RelayPublish(sid: sid, ct: ct, seq: 0)) { [weak self] error in
                if let error { self?.log.notice("attach \(sid, privacy: .public): \(error.localizedDescription, privacy: .public)") }
            }
        } catch {
            log.error("\(Self.sessionFailMarker, privacy: .public) sid=\(sid, privacy: .public) detail=attach seal: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Request a history backfill for `sid` from `cursor`: `resume { c: cursor }`
    /// returns records with `seq > cursor`. Sealed with tx, published on the
    /// session sid; the daemon replies with a `batch` (`onBatch`).
    func sendResume(sid: String, cursor: Int) {
        guard let keys = sessionKeys else {
            log.notice("resume before kx — dropping sid=\(sid, privacy: .public)")
            return
        }
        do {
            let body = try JSONEncoder().encode(SessionResume(sid: sid, c: cursor))
            let ct = try seal(plaintext: body, key: keys.tx, nonce: try randomBytes(24))
            send(RelayPublish(sid: sid, ct: ct, seq: 0)) { [weak self] error in
                if let error { self?.log.notice("resume \(sid, privacy: .public): \(error.localizedDescription, privacy: .public)") }
            }
        } catch {
            log.error("\(Self.sessionFailMarker, privacy: .public) sid=\(sid, privacy: .public) detail=resume seal: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Generate the frontend's ephemeral keypair and send its pubkey + frontendId
    /// to the daemon (sealed with the kx-envelope key). Session keys are NOT
    /// derived here — they need the daemon's *current* pubkey, which arrives in
    /// the daemon's `relay.kx.frame` (`onKeyExchangeFrame`). The two kx broadcasts
    /// are independent, so deriving from the kx.frame (not the bundle) is correct
    /// even across a daemon keypair rotation and matches the documented invariant
    /// "the frontend gets the daemon pubkey from the kx.frame".
    private func startKeyExchange() {
        do {
            // Ephemeral keypair from 32 random bytes (FFI hashes the seed → sk).
            let kp = try kxSeedKeypair(seed: try randomBytes(32))
            kxKeyPair = kp

            // Seal {pk, frontendId, role, v} with derive_kx_key(pairingSecret).
            // M11: include `v` so the daemon knows our protocol version.
            let kxKey = deriveKxKey(pairingSecret: pairing.pairingSecret)
            let payload = KxPayload(
                pk: kp.publicKey.base64EncodedString(),
                frontendId: pairing.frontendId)
            let plaintext = try JSONEncoder().encode(payload)
            let ct = try seal(plaintext: plaintext, key: kxKey, nonce: try randomBytes(24))
            send(RelayKeyExchange(ct: ct)) { [weak self] error in
                if let error { self?.kxFail("kx send: \(error.localizedDescription)") }
            }
        } catch {
            kxFail("kx send: \(error)")
        }
    }

    /// The daemon broadcasts its own `relay.kx` on connect; the relay delivers it
    /// here. Decrypt the daemon's sealed kx payload with the kx-envelope key to
    /// recover its authoritative pubkey, then derive the per-frontend session
    /// keys.
    ///
    /// H5 fix: when a daemon kx.frame arrives and we already have session keys
    /// (e.g. after a daemon restart), we STILL re-send our own kx via
    /// `startKeyExchange()` so the daemon re-establishes its peer entry for our
    /// frontendId. Session keys are re-derived unconditionally so a daemon keypair
    /// rotation is handled correctly (the daemon's new pubkey is in the fresh frame).
    private func onKeyExchangeFrame(_ frame: RelayKeyExchangeFrame) {
        guard frame.from == "daemon" else { return }
        guard let kp = kxKeyPair else {
            kxFail("daemon kx.frame before frontend keypair")
            return
        }
        do {
            let kxKey = deriveKxKey(pairingSecret: pairing.pairingSecret)
            let plaintext = try open(encoded: frame.ct, key: kxKey)
            let payload = try JSONDecoder().decode(DaemonKxPayload.self, from: plaintext)
            guard let daemonPk = Data(base64Encoded: payload.pk), daemonPk.count == 32 else {
                kxFail("daemon kx.frame bad pk")
                return
            }
            let alreadyKeyed = sessionKeys != nil

            if alreadyKeyed {
                // H5 / Bug 1 fix: daemon restarted with a fresh kx broadcast — re-send
                // our own kx so the daemon re-populates its peers map for our frontendId.
                //
                // CRITICAL ORDER: call startKeyExchange() FIRST so a NEW keypair is
                // generated and stored in kxKeyPair. Then re-read kxKeyPair and derive
                // session keys from it. The old code derived keys from the OLD `kp`
                // (captured above) then called startKeyExchange() — the daemon receives
                // our NEW pubkey (from startKeyExchange) but the frontend's sessionKeys
                // were derived from the OLD secret key → AEAD mismatch in both directions.
                log.notice("relay: daemon kx re-exchange (daemon restart?) — re-sending kx")
                helloReceived = false
                didAutoAttach = false
                startKeyExchange()
                // Re-read the keypair that startKeyExchange() just stored so we derive
                // session keys from the SAME keypair whose pubkey was just sent.
                guard let freshKp = kxKeyPair else {
                    kxFail("kx re-exchange: keypair missing after startKeyExchange")
                    return
                }
                let keys = try kxClientSessionKeys(
                    pk: freshKp.publicKey, sk: freshKp.secretKey, peerPk: daemonPk)
                sessionKeys = keys
            } else {
                // First kx: derive session keys from the keypair we already sent.
                // Frontend = CLIENT role → kxClientSessionKeys(own pub, own sec, daemon pub).
                // rx decrypts frames FROM the daemon, tx encrypts frames TO it.
                let keys = try kxClientSessionKeys(
                    pk: kp.publicKey, sk: kp.secretKey, peerPk: daemonPk)
                sessionKeys = keys
                log.notice("\(Self.kxOkMarker, privacy: .public) daemon=\(self.pairing.daemonId, privacy: .public)")
            }

            // M10: Adopt the daemon's label if local label is unset.
            if let labelWire = payload.label, labelWire.set,
               let labelValue = labelWire.value, !labelValue.isEmpty {
                let store = PairingStore.shared
                let did = self.pairing.daemonId
                if store.label(for: did) == nil {
                    store.setLabel(labelValue, for: did)
                    log.notice("relay: adopted daemon label '\(labelValue, privacy: .public)' for daemon=\(did, privacy: .public)")
                }
            }

            scheduleHelloFallback()
        } catch {
            kxFail("daemon kx.frame: \(error)")
        }
    }

    private func kxFail(_ reason: String) {
        log.error("\(Self.kxFailMarker, privacy: .public) detail=\(reason, privacy: .public)")
    }

    // MARK: first decrypted frame (M3) + session render (M4)

    /// Handle an inbound E2EE data frame. The first `hello` on `__meta__` from the
    /// daemon is the M3 success terminal (decrypt with rx, decode the session
    /// list); M4 adds the session render path: on `hello` we auto-attach the first
    /// session, then route the daemon's `state`/`batch`/`rec` replies into the
    /// `SessionStore`. H7/H8: frames on `__control__` are decoded as control messages.
    private func onRelayFrame(_ frame: RelayFrame) {
        guard frame.from == "daemon" else { return }

        // H7/H8: handle inbound control messages from the daemon.
        if frame.sid == RelayChannel.control {
            guard let keys = sessionKeys else {
                log.notice("control frame before kx — dropping")
                return
            }
            do {
                let plaintext = try open(encoded: frame.ct, key: keys.rx)
                let env = try JSONDecoder().decode(RelayServerEnvelope.self, from: plaintext)
                switch env.t {
                case "control.unpair":
                    if let msg = try? JSONDecoder().decode(ControlUnpairInbound.self, from: plaintext) {
                        log.notice("relay: inbound control.unpair daemon=\(msg.daemonId, privacy: .public) reason=\(msg.reason, privacy: .public)")
                        onUnpair?(msg.daemonId, msg.reason)
                    } else {
                        log.notice("relay: malformed control.unpair — dropping")
                    }
                case "control.rename":
                    if let msg = try? JSONDecoder().decode(ControlRenameInbound.self, from: plaintext) {
                        let newLabel: String? = msg.label.set ? msg.label.value : nil
                        log.notice("relay: inbound control.rename daemon=\(msg.daemonId, privacy: .public) label=\(newLabel ?? "(clear)", privacy: .public)")
                        onRename?(msg.daemonId, newLabel)
                    } else {
                        log.notice("relay: malformed control.rename (possibly legacy string label from v1 daemon) — dropping")
                    }
                default:
                    log.notice("relay: ignoring control t=\(env.t, privacy: .public)")
                }
            } catch {
                log.error("relay: control frame decrypt failed: \(error.localizedDescription, privacy: .public)")
            }
            return
        }

        guard let keys = sessionKeys else {
            log.notice("relay.frame before kx — dropping")
            return
        }
        do {
            let plaintext = try open(encoded: frame.ct, key: keys.rx)
            let env = try JSONDecoder().decode(RelayServerEnvelope.self, from: plaintext)
            switch env.t {
            case "hello":
                let reply = try JSONDecoder().decode(SessionHelloReply.self, from: plaintext)
                helloReceived = true
                // Bug 3 fix: gate the marker on frameOkEmitted (sticky), not helloReceived
                // (which resets on reconnect). This prevents double-emitting TP_FRAME_OK
                // when a reconnect triggers a second successful hello.
                if !frameOkEmitted {
                    frameOkEmitted = true
                    log.notice("\(Self.frameOkMarker, privacy: .public) sessions=\(reply.d.sessions.count, privacy: .public)")
                }
                onHello(reply.d.sessions)
            case "state":
                let msg = try JSONDecoder().decode(SessionStateMsg.self, from: plaintext)
                onState(msg)
            case "batch":
                let msg = try JSONDecoder().decode(SessionBatch.self, from: plaintext)
                onBatch(msg)
            case "rec":
                let rec = try JSONDecoder().decode(SessionRec.self, from: plaintext)
                onRec(rec)
            default:
                log.notice("relay.frame decrypted t=\(env.t, privacy: .public) sid=\(frame.sid, privacy: .public)")
            }
        } catch {
            log.error("\(Self.frameFailMarker, privacy: .public) detail=\(error.localizedDescription, privacy: .public)")
        }
    }

    /// On the first `hello`: store the session list and auto-attach the first
    /// running-or-any session so M4 can drive attach→state→resume→batch on-device
    /// without manual selection. Guarded to fire once per connection.
    ///
    /// H3 fix: uses `replaceSessionsForDaemon` instead of `upsertSessions` so
    /// that daemon-deleted sessions are removed from the UI on the next hello —
    /// ghost rows no longer persist. Passes `daemonId` so the store can maintain
    /// the per-daemon bucket correctly.
    private func onHello(_ sessions: [SessionMeta]) {
        let store = sessionStore
        let did = daemonId
        Task { @MainActor in store?.replaceSessionsForDaemon(daemonId: did, sessions: sessions) }
        guard !didAutoAttach, let first = sessions.first else { return }
        didAutoAttach = true
        attach(sid: first.sid)
    }

    /// Send a fresh `hello` request to the daemon on demand (e.g. pull-to-refresh).
    ///
    /// M1 fix: mirrors Expo `handleRefresh → refreshSessionList`. Seals a `hello`
    /// request with the frontend's tx key and publishes on `__meta__`; the daemon
    /// replies with the current session list, which lands in `onHello` →
    /// `replaceSessionsForDaemon`. No-op if kx has not completed yet.
    func sendHello() {
        guard let keys = sessionKeys else {
            log.notice("sendHello before kx — no-op")
            return
        }
        do {
            let req = try JSONEncoder().encode(HelloRequest())
            let ct = try seal(plaintext: req, key: keys.tx, nonce: try randomBytes(24))
            send(RelayPublish(sid: RelayChannel.meta, ct: ct, seq: 0)) { [weak self] error in
                if let error { self?.log.notice("sendHello: \(error.localizedDescription, privacy: .public)") }
            }
        } catch {
            log.notice("sendHello seal: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Daemon's reply to `attach`: refresh metadata, then request the full history
    /// backfill (`resume { c }`) using the store's cursor so we never re-fetch
    /// records already applied (idempotent on overlap).
    private func onState(_ msg: SessionStateMsg) {
        let store = sessionStore
        let sid = msg.sid
        Task { @MainActor in
            store?.appendState(msg.d)
            let cursor = store?.cursor(for: sid) ?? 0
            self.sendResume(sid: sid, cursor: cursor)
        }
    }

    /// Daemon's reply to `resume`: apply the history batch, emit `TP_SESSION_OK`
    /// once we have ≥1 rendered chat item, then (M5) auto-send the input probe so
    /// the input→io round-trip is exercised on-device. Also check for an echoed
    /// probe in case io records arrived inside the backfill batch.
    private func onBatch(_ msg: SessionBatch) {
        let store = sessionStore
        let sid = msg.sid
        let recs = msg.d
        Task { @MainActor in
            store?.appendBatch(sid: sid, recs: recs)
            // Accumulate raw io bytes for terminal history replay.
            for rec in recs where rec.k == "io" {
                if let d = SessionStore.ioData(from: rec) {
                    self.ioHistory[sid, default: Data()].append(d)
                }
            }
            let count = store?.chatItems[sid]?.count ?? 0
            self.emitSessionOk(sid: sid, events: count)
            self.maybeSendProbe(sid: sid)
            self.checkInputEcho(sid: sid)
        }
    }

    /// A live record outside a batch (running session). Apply it, emit
    /// `TP_SESSION_OK` if it's the first chat item, and (M5) check whether an io
    /// record carried the echoed input probe.
    private func onRec(_ rec: SessionRec) {
        let store = sessionStore
        let sid = rec.sid
        Task { @MainActor in
            store?.appendRec(rec)
            // Accumulate raw io bytes for terminal history replay.
            if rec.k == "io", let d = SessionStore.ioData(from: rec) {
                self.ioHistory[sid, default: Data()].append(d)
            }
            let count = store?.chatItems[sid]?.count ?? 0
            self.emitSessionOk(sid: sid, events: count)
            self.checkInputEcho(sid: sid)
        }
    }

    /// Emit the M4 success marker once per session, only when ≥1 event rendered.
    /// Hops back off the main actor to keep the log call on the client's queue.
    @MainActor
    private func emitSessionOk(sid: String, events: Int) {
        guard events >= 1, !sessionOkEmitted.contains(sid) else { return }
        sessionOkEmitted.insert(sid)
        log.notice("\(Self.sessionOkMarker, privacy: .public) sid=\(sid, privacy: .public) events=\(events, privacy: .public)")
    }

    // MARK: send input (M5)

    /// Send input into a session. `kind == .chat` sends `in.chat` with plain text
    /// (the daemon appends the newline); `kind == .term` sends `in.term` with the
    /// text's UTF-8 bytes base64-encoded (raw PTY bytes). Sealed with tx, published
    /// via `relay.pub` on the session sid — the same path as attach/resume.
    enum InputKind { case chat, term }

    func sendInput(sid: String, kind: InputKind, text: String) {
        guard let keys = sessionKeys else {
            log.notice("input before kx — dropping sid=\(sid, privacy: .public)")
            return
        }
        do {
            let body: Data
            switch kind {
            case .chat:
                body = try JSONEncoder().encode(SessionInChat(sid: sid, d: text))
            case .term:
                let d = Data(text.utf8).base64EncodedString()
                body = try JSONEncoder().encode(SessionInTerm(sid: sid, d: d))
            }
            let ct = try seal(plaintext: body, key: keys.tx, nonce: try randomBytes(24))
            send(RelayPublish(sid: sid, ct: ct, seq: 0)) { [weak self] error in
                if let error { self?.log.notice("input \(sid, privacy: .public): \(error.localizedDescription, privacy: .public)") }
            }
        } catch {
            log.error("\(Self.inputFailMarker, privacy: .public) sid=\(sid, privacy: .public) detail=input seal: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Send a PTY resize for a session. Wire: `{ t:"resize", sid, cols, rows }`.
    /// Sealed with tx, published via `relay.pub` on the session sid so the daemon
    /// routes it to the runner's PTY (`parseRelayControlMessage` → resize branch).
    /// `cols` and `rows` must be positive integers; values ≤ 0 are clamped to 1
    /// to satisfy the daemon's `isPositiveInt` guard.
    func sendResize(sid: String, cols: Int, rows: Int) {
        guard let keys = sessionKeys else {
            log.notice("resize before kx — dropping sid=\(sid, privacy: .public)")
            return
        }
        let safeCols = max(1, cols)
        let safeRows = max(1, rows)
        do {
            let body = try JSONEncoder().encode(SessionResize(sid: sid, cols: safeCols, rows: safeRows))
            let ct = try seal(plaintext: body, key: keys.tx, nonce: try randomBytes(24))
            send(RelayPublish(sid: sid, ct: ct, seq: 0)) { [weak self] error in
                if let error { self?.log.notice("resize \(sid, privacy: .public): \(error.localizedDescription, privacy: .public)") }
            }
        } catch {
            log.error("resize \(sid, privacy: .public) detail=seal: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Retrieve buffered raw PTY bytes for `sid` for terminal history replay.
    /// Returns nil when no io records have been received yet for this session.
    /// Callers MUST be on the main actor (matches the write side).
    func terminalHistory(for sid: String) -> Data? {
        ioHistory[sid]
    }

    // MARK: - Control-message bridge (integration pass)

    /// The daemon this client is paired with. Read-only mirror of the pairing so
    /// extensions (session CRUD, control.rename/unpair) can address the daemon
    /// without reaching into the `private` `pairing` field.
    var daemonId: String { pairing.daemonId }

    /// This frontend's stable identity on the relay (for `control.*` messages).
    var frontendId: String { pairing.frontendId }

    /// Whether the E2EE session keys have been derived — i.e. it is safe to seal
    /// and publish. `publishControl` checks this too; exposed so callers can give
    /// UI feedback ("not connected yet") before attempting a send.
    ///
    /// M8: this now also reflects reconnect — keys are cleared on each reconnect
    /// and re-established after kx completes. UI should observe `PairingViewModel.isOnline`.
    var isReady: Bool { sessionKeys != nil }

    /// Seal an app-level control message with the frontend's tx key and publish
    /// it via `relay.pub` on `sid`. This is the single bridge that cross-file
    /// extensions use for control sends — `session.create` (RelaySessionOps),
    /// `control.rename` / `control.unpair` (PairingRelayOps) — so the raw crypto
    /// members (`sessionKeys`, `send`, `randomBytes`, `seal`) stay `private`.
    ///
    /// Mirrors the established attach/resume/input seal→publish pattern exactly:
    /// seal with `keys.tx` + a fresh 24-byte nonce, then `RelayPublish(sid, ct)`.
    /// No-op (logged) if kx has not completed, matching the other senders.
    ///
    /// - Parameters:
    ///   - msg: any `Encodable` control payload (its own `t` tags the wire type).
    ///   - sid: routing channel — a session sid, or `RelayChannel.meta` /
    ///          `RelayChannel.control` for daemon-level control.
    @discardableResult
    func publishControl<T: Encodable>(_ msg: T, on sid: String) -> Bool {
        guard let keys = sessionKeys else {
            log.notice("control send before kx — dropping sid=\(sid, privacy: .public)")
            return false
        }
        do {
            let body = try JSONEncoder().encode(msg)
            let ct = try seal(plaintext: body, key: keys.tx, nonce: try randomBytes(24))
            send(RelayPublish(sid: sid, ct: ct, seq: 0)) { [weak self] error in
                if let error {
                    self?.log.notice("control \(sid, privacy: .public): \(error.localizedDescription, privacy: .public)")
                }
            }
            return true
        } catch {
            log.error("control send seal sid=\(sid, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    /// Install the three Tranche E terminal relay callbacks on `sessionStore`
    /// (via the associated-object extension in `TerminalOps.swift`). Called in
    /// the `sessionStore` didSet so the store is always wired before any view
    /// can observe it. Weak capture prevents a retain cycle (store → client).
    private func installTerminalCallbacks() {
        guard let store = sessionStore else { return }
        Task { @MainActor [weak self, weak store] in
            guard let store else { return }
            store.terminalSendBytes = { [weak self] sid, bytes in
                guard let client = self else { return }
                let b64 = Data(bytes).base64EncodedString()
                client.sendInput(sid: sid, kind: .term, text: b64)
            }
            store.terminalResize = { [weak self] sid, cols, rows in
                self?.sendResize(sid: sid, cols: cols, rows: rows)
            }
            store.terminalHistory = { [weak self] sid in
                // ioHistory is @MainActor; this closure is always called from
                // the main actor (TerminalView attaches on MainActor).
                self?.ioHistory[sid]
            }
        }
    }

    /// Auto-send the input probe once per session (after attach+backfill), so the
    /// smoke harness exercises the input→io round-trip without a UI gesture. The
    /// probe token is fixed so the loopback daemon can echo it back as an io rec.
    @MainActor
    private func maybeSendProbe(sid: String) {
        guard inputProbe[sid] == nil else { return }
        inputProbe[sid] = Self.probeToken
        sendInput(sid: sid, kind: .chat, text: Self.probeToken)
    }

    /// After any io record applies, check whether the session's terminal output
    /// now contains the probe token (the daemon echoed our input back). If so,
    /// emit `TP_INPUT_OK` once — the on-device proof the input round-trip works.
    @MainActor
    private func checkInputEcho(sid: String) {
        guard let probe = inputProbe[sid], !inputOkEmitted.contains(sid) else { return }
        guard let out = sessionStore?.terminalOutput[sid], out.contains(probe) else { return }
        inputOkEmitted.insert(sid)
        log.notice("\(Self.inputOkMarker, privacy: .public) sid=\(sid, privacy: .public)")
    }

    /// Belt-and-suspenders against the kx→auto-hello timing race: if no `hello`
    /// arrives shortly after kx, request one on-demand (sealed with tx, published
    /// on `__meta__`; the daemon's command-dispatcher replies on `__meta__`).
    private func scheduleHelloFallback() {
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, !self.helloReceived, let keys = self.sessionKeys else { return }
            do {
                let req = try JSONEncoder().encode(HelloRequest())
                let ct = try seal(plaintext: req, key: keys.tx, nonce: try self.randomBytes(24))
                self.send(RelayPublish(sid: RelayChannel.meta, ct: ct, seq: 0)) { error in
                    if let error { self.log.notice("hello req: \(error.localizedDescription, privacy: .public)") }
                }
            } catch {
                self.log.notice("hello req seal: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    /// Fresh cryptographically-random bytes (kx seed / AEAD nonce).
    private func randomBytes(_ count: Int) throws -> Data {
        var bytes = Data(count: count)
        let rc = bytes.withUnsafeMutableBytes { ptr in
            SecRandomCopyBytes(kSecRandomDefault, count, ptr.baseAddress!)
        }
        guard rc == errSecSuccess else {
            throw NSError(domain: "RelayClient", code: Int(rc),
                          userInfo: [NSLocalizedDescriptionKey: "SecRandomCopyBytes failed"])
        }
        return bytes
    }

    private func fail(_ reason: String) {
        // Never log the token or secret — `reason` is constructed from relay
        // error strings and URLError descriptions only.
        log.error("\(Self.authFailMarker, privacy: .public) detail=\(reason, privacy: .public)")
        state = .failed(reason: reason)
        disconnect()
    }

    // MARK: H6 auto-reconnect

    /// Schedule the next reconnect attempt using exponential backoff (1s, 2s, 4s…
    /// capped at 30s). Resets kx state so the full handshake runs on reconnect.
    /// Idempotent: a second call while a reconnect timer is already pending is a
    /// no-op. This prevents the double-fire that occurs when `onAuthErr` cancels
    /// the task (causing a `.failure` in the receive loop) and both code paths
    /// call `scheduleReconnect()` — only the first call creates a timer (Bug 2 fix).
    private func scheduleReconnect() {
        // Bug 2 fix: if a reconnect timer is already queued, don't create another.
        guard reconnectTimer == nil else { return }
        // Clear state so the reconnect starts fresh (kx, hello, probe).
        pingTimer?.cancel()
        pingTimer = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        sessionKeys = nil
        kxKeyPair = nil
        didAutoAttach = false
        helloReceived = false   // Bug 3 fix: allow fallback hello on new connection
        // M12: clear RTT on disconnect — stale values are misleading.
        // Hop to main actor (all RTT writes serialized there — Bug 4 fix).
        Task { @MainActor [weak self] in
            self?.lastPingSentAt = nil
            self?.latestRTT = nil
        }
        // helloReceived was reset above (Bug 3 fix) so scheduleHelloFallback fires again.
        // Do NOT reset frameOkEmitted (sticky marker guard) or sessionOkEmitted (per-session).

        let delay = Self.reconnectDelay(attempt: reconnectAttempt)
        reconnectAttempt += 1
        log.notice("relay: scheduling reconnect in \(delay, privacy: .public)s (attempt=\(self.reconnectAttempt, privacy: .public))")

        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + delay)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            self.reconnectTimer = nil
            self.state = .idle
            self.connect()
        }
        timer.resume()
        reconnectTimer = timer
    }

    /// Exponential backoff: 1s × 2^attempt, capped at `reconnectMaxDelay` (30s).
    static func reconnectDelay(attempt: Int) -> TimeInterval {
        let base = 1.0
        let cap = reconnectMaxDelay
        return min(base * pow(2.0, Double(attempt)), cap)
    }

    // MARK: keep-alive + L5 missed-pong

    private func startPing() {
        pingTimer?.cancel()
        missedPongs = 0
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + pingInterval, repeating: pingInterval)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            // L5: track missed pongs — disconnect after maxMissedPongs consecutive misses.
            self.missedPongs += 1
            if self.missedPongs > Self.maxMissedPongs {
                self.log.notice("relay: \(self.missedPongs, privacy: .public) missed pongs — triggering reconnect")
                self.pingTimer?.cancel()
                self.pingTimer = nil
                self.scheduleReconnect()
                return
            }
            // M12: record the send time then immediately send the ping, both inside
            // the @MainActor Task so lastPingSentAt is guaranteed to be set before any
            // pong can arrive and read it on the same actor.
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.lastPingSentAt = Date()
                self.send(RelayPing(ts: nil)) { [weak self] error in
                    if let error { self?.log.notice("ping: \(error.localizedDescription, privacy: .public)") }
                }
            }
        }
        timer.resume()
        pingTimer = timer
    }

    // MARK: M12 manual ping (for Diagnostics RTT button)

    /// Send a one-shot `relay.ping` for an immediate RTT measurement.
    /// The result is available via `latestRTT` after the next `relay.pong` arrives.
    /// Safe to call at any connection state — the send is a no-op if the task is nil.
    func sendManualPing() {
        // M12: set lastPingSentAt and send the ping atomically on the main actor so
        // the timestamp is always set before any pong can arrive on the main actor.
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.lastPingSentAt = Date()
            self.send(RelayPing(ts: nil)) { [weak self] error in
                if let error { self?.log.notice("manual ping: \(error.localizedDescription, privacy: .public)") }
            }
        }
    }

    // MARK: M7 resume-token persistence

    private func persistResumeToken() {
        let defaults = UserDefaults.standard
        if let token = resumeToken, let exp = resumeExpiresAt {
            defaults.set(token, forKey: resumeTokenDefaultsKey)
            defaults.set(exp, forKey: resumeExpiresAtDefaultsKey)
        } else {
            defaults.removeObject(forKey: resumeTokenDefaultsKey)
            defaults.removeObject(forKey: resumeExpiresAtDefaultsKey)
        }
    }
}
