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
/// Resume (`relay.auth.resume`) remains deferred. The auth token is the verbatim
/// FFI `deriveRelayToken` output (lowercase hex of
/// BLAKE2b-256(pairingSecret || "relay-auth")), byte-equal to the TS golden vector.
final class RelayClient: NSObject {
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

    private(set) var state: State = .idle {
        didSet { onStateChange?(state) }
    }

    /// Optional observer (UI). Invoked on the URLSession delegate queue.
    var onStateChange: ((State) -> Void)?

    /// Cached after `relay.auth.ok` for the (deferred) resume fast-path.
    private(set) var resumeToken: String?
    private(set) var resumeExpiresAt: Double?

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
    private var helloReceived = false

    // MARK: session attach / backfill (M4)

    /// The UI store fed by decrypted session records. Weak: the app owns it for
    /// the process lifetime; the client only writes into it. All writes hop to
    /// `@MainActor` (the store is main-actor isolated).
    weak var sessionStore: SessionStore?
    /// Guard so the auto-attach (on the first `hello`) fires once per connection —
    /// a re-`hello` (e.g. the on-demand fallback also lands) must not re-attach.
    private var didAutoAttach = false
    /// Sessions for which a `TP_SESSION_OK` has already been emitted, so a second
    /// `batch` (overlapping resume + cache replay) does not double-emit the marker.
    private var sessionOkEmitted: Set<String> = []

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
    }

    deinit { disconnect() }

    /// The relay auth token: verbatim FFI output, used as-is in `relay.auth.token`.
    /// Computed here (not stored) so the secret is never retained beyond the call.
    private func authToken() -> String {
        deriveRelayToken(pairingSecret: pairing.pairingSecret)
    }

    // MARK: connect / auth

    /// Open the WebSocket and send `relay.auth`. Idempotent against re-entry: a
    /// second call while already connecting/authenticated is ignored.
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
        pingTimer?.cancel()
        pingTimer = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    private func sendAuth() {
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

    private func send<T: Encodable>(_ message: T, completion: @escaping (Error?) -> Void) {
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
                // A clean close after auth is not a failure; before auth it is.
                if case .authenticated = self.state {
                    self.log.notice("relay closed: \(error.localizedDescription, privacy: .public)")
                } else {
                    self.fail("receive: \(error.localizedDescription)")
                }
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
            fail("relay.auth.err: \(detail)")
        case "relay.presence":
            if let p = try? JSONDecoder().decode(RelayPresence.self, from: data) {
                log.notice("relay.presence daemon=\(p.daemonId, privacy: .public) online=\(p.online)")
            }
        case "relay.pong":
            break // liveness ack
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
        resumeToken = ok.resumeToken
        resumeExpiresAt = ok.resumeExpiresAt
        state = .authenticated(daemonId: ok.daemonId)
        log.notice("\(Self.authOkMarker) daemon=\(ok.daemonId, privacy: .public)")
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
            log.error("\(Self.sessionFailMarker) sid=\(sid, privacy: .public) detail=attach seal: \(error.localizedDescription, privacy: .public)")
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
            log.error("\(Self.sessionFailMarker) sid=\(sid, privacy: .public) detail=resume seal: \(error.localizedDescription, privacy: .public)")
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

            // Seal {pk, frontendId, role} with derive_kx_key(pairingSecret).
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
    /// keys. Idempotent: a second daemon kx.frame (e.g. after the daemon
    /// reconnects) is ignored once keys exist.
    private func onKeyExchangeFrame(_ frame: RelayKeyExchangeFrame) {
        guard frame.from == "daemon" else { return }
        guard sessionKeys == nil else { return } // already derived
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
            // Frontend = CLIENT role → kxClientSessionKeys(own pub, own sec, daemon pub).
            // rx decrypts frames FROM the daemon, tx encrypts frames TO it.
            let keys = try kxClientSessionKeys(
                pk: kp.publicKey, sk: kp.secretKey, peerPk: daemonPk)
            sessionKeys = keys
            log.notice("\(Self.kxOkMarker) daemon=\(self.pairing.daemonId, privacy: .public)")
            scheduleHelloFallback()
        } catch {
            kxFail("daemon kx.frame: \(error)")
        }
    }

    private func kxFail(_ reason: String) {
        log.error("\(Self.kxFailMarker) detail=\(reason, privacy: .public)")
    }

    // MARK: first decrypted frame (M3) + session render (M4)

    /// Handle an inbound E2EE data frame. The first `hello` on `__meta__` from the
    /// daemon is the M3 success terminal (decrypt with rx, decode the session
    /// list); M4 adds the session render path: on `hello` we auto-attach the first
    /// session, then route the daemon's `state`/`batch`/`rec` replies into the
    /// `SessionStore`.
    private func onRelayFrame(_ frame: RelayFrame) {
        guard frame.from == "daemon" else { return }
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
                log.notice("\(Self.frameOkMarker) sessions=\(reply.d.sessions.count)")
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
            log.error("\(Self.frameFailMarker) detail=\(error.localizedDescription, privacy: .public)")
        }
    }

    /// On the first `hello`: store the session list and auto-attach the first
    /// running-or-any session so M4 can drive attach→state→resume→batch on-device
    /// without manual selection. Guarded to fire once per connection.
    private func onHello(_ sessions: [SessionMeta]) {
        let store = sessionStore
        Task { @MainActor in store?.upsertSessions(sessions) }
        guard !didAutoAttach, let first = sessions.first else { return }
        didAutoAttach = true
        attach(sid: first.sid)
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

    /// Daemon's reply to `resume`: apply the history batch, then emit
    /// `TP_SESSION_OK` once we have ≥1 rendered chat item for this session.
    private func onBatch(_ msg: SessionBatch) {
        let store = sessionStore
        let sid = msg.sid
        let recs = msg.d
        Task { @MainActor in
            store?.appendBatch(sid: sid, recs: recs)
            let count = store?.chatItems[sid]?.count ?? 0
            self.emitSessionOk(sid: sid, events: count)
        }
    }

    /// A live record outside a batch (running session). Apply it; if it produces
    /// the session's first chat item, emit `TP_SESSION_OK` too.
    private func onRec(_ rec: SessionRec) {
        let store = sessionStore
        let sid = rec.sid
        Task { @MainActor in
            store?.appendRec(rec)
            let count = store?.chatItems[sid]?.count ?? 0
            self.emitSessionOk(sid: sid, events: count)
        }
    }

    /// Emit the M4 success marker once per session, only when ≥1 event rendered.
    /// Hops back off the main actor to keep the log call on the client's queue.
    @MainActor
    private func emitSessionOk(sid: String, events: Int) {
        guard events >= 1, !sessionOkEmitted.contains(sid) else { return }
        sessionOkEmitted.insert(sid)
        log.notice("\(Self.sessionOkMarker) sid=\(sid, privacy: .public) events=\(events)")
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
        log.error("\(Self.authFailMarker) detail=\(reason, privacy: .public)")
        state = .failed(reason: reason)
        disconnect()
    }

    // MARK: keep-alive

    private func startPing() {
        pingTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + pingInterval, repeating: pingInterval)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            self.send(RelayPing(ts: nil)) { error in
                if let error { self.log.notice("ping: \(error.localizedDescription, privacy: .public)") }
            }
        }
        timer.resume()
        pingTimer = timer
    }
}
