import Foundation

// MARK: - VoiceBackend seam
//
// Abstraction over the voice pipeline so VoiceStore can drive either the
// OpenAI Realtime API (cloud) or a fully on-device STT→refine→TTS pipeline
// behind a single, backend-NEUTRAL callback surface.
//
// The 9-callback surface mirrors `RealtimeEvents` (RealtimeClient.swift) field
// for field. This is intentional: the OpenAI adapter (`RealtimeClientBackend`)
// is a thin pass-through to `RealtimeClient`, and the on-device backend can be
// implemented to satisfy the same contract.
//
// STATE-MACHINE NOTE (read before adding a backend):
// The surface is OpenAI-shaped. On the on-device path TTS is local
// (AVSpeechSynthesizer), so `onAudio` / `onAudioDone` never fire and the turn
// completes at `onRefinedPrompt`. To avoid VoiceStore being stuck in
// `.processing` forever, VoiceStore's `onRefinedPrompt` handler is responsible
// for restoring `.listening(isSpeaking:false, transcript:"")` after delivering
// the prompt. That restore is idempotent for OpenAI too (its turn is likewise
// complete at `onRefinedPrompt`). On-device "speaking" polish is OPTIONAL: a
// backend MAY emit `onSpeechStart` when it begins speaking the confirmation,
// but it MUST NOT depend on `onAudio` / `onAudioDone` to leave any state.
//
// Concurrency: closures are `@MainActor`-annotated to match VoiceStore's
// main-actor isolation. The project builds under SWIFT_VERSION=5.0 with no
// strict-concurrency flag, so these annotations are cosmetic (not enforced) —
// they document intent without changing codegen. The underlying
// `RealtimeEvents` closures stay plain/non-isolated, exactly as today.

/// Backend-neutral event surface, mirroring `RealtimeEvents` field for field.
///
/// All closures are optional and default to `nil`. They are expected to be
/// invoked on the main actor (the adapter hops to main via `RealtimeClient`'s
/// existing main-actor dispatch; the on-device backend should do likewise).
struct VoiceBackendEvents {
    /// Transport/session established. On-device backends fire this as soon as
    /// the local pipeline (STT/audio) is ready.
    var onConnected: (@MainActor () -> Void)?
    /// Transport/session torn down.
    var onDisconnected: (@MainActor () -> Void)?
    /// Non-recoverable error message to surface in the UI.
    var onError: (@MainActor (String) -> Void)?
    /// Latest (interim or final) transcript text for the current utterance.
    var onTranscript: (@MainActor (String) -> Void)?
    /// Base64 PCM16 24 kHz audio chunk for playback. OpenAI-only — on-device
    /// backends do NOT emit this (TTS is local).
    var onAudio: (@MainActor (String) -> Void)?
    /// Audio playback for the current turn is complete. OpenAI-only.
    var onAudioDone: (@MainActor () -> Void)?
    /// VAD detected the start of user speech (or, optionally on-device, the
    /// start of the spoken confirmation).
    var onSpeechStart: (@MainActor () -> Void)?
    /// VAD detected the end of user speech; model response is pending.
    var onSpeechEnd: (@MainActor () -> Void)?
    /// The refined prompt is ready to send to Claude Code. Authoritative turn
    /// completion for BOTH backends.
    var onRefinedPrompt: (@MainActor (String) -> Void)?

    init(
        onConnected: (@MainActor () -> Void)? = nil,
        onDisconnected: (@MainActor () -> Void)? = nil,
        onError: (@MainActor (String) -> Void)? = nil,
        onTranscript: (@MainActor (String) -> Void)? = nil,
        onAudio: (@MainActor (String) -> Void)? = nil,
        onAudioDone: (@MainActor () -> Void)? = nil,
        onSpeechStart: (@MainActor () -> Void)? = nil,
        onSpeechEnd: (@MainActor () -> Void)? = nil,
        onRefinedPrompt: (@MainActor (String) -> Void)? = nil
    ) {
        self.onConnected = onConnected
        self.onDisconnected = onDisconnected
        self.onError = onError
        self.onTranscript = onTranscript
        self.onAudio = onAudio
        self.onAudioDone = onAudioDone
        self.onSpeechStart = onSpeechStart
        self.onSpeechEnd = onSpeechEnd
        self.onRefinedPrompt = onRefinedPrompt
    }
}

// MARK: - VoiceBackend protocol

/// A pluggable voice pipeline. The full lifecycle is: `start()` to begin the
/// session, `sendAudio(_:)` to stream captured mic chunks (base64 PCM16
/// 24 kHz), and `dispose()` to tear everything down.
///
/// Main-actor isolated to match VoiceStore. Backends own their own transport /
/// recognizer / synthesizer and must surface all state via `VoiceBackendEvents`.
@MainActor
protocol VoiceBackend: AnyObject {
    /// Begin the voice session. Mirrors `RealtimeClient.connect(apiKey:)` but
    /// the backend captures any credentials it needs at construction time, so
    /// this takes no arguments.
    func start()

    /// Stream a captured base64-encoded PCM16 24 kHz mic chunk to the backend.
    /// Mirrors `RealtimeClient.sendAudio(_:)`.
    func sendAudio(_ base64: String)

    /// Tear down the session and release all resources. Idempotent.
    func dispose()
}

// MARK: - VoiceBackendKind
//
// NOTE: `VoiceBackendKind` is canonically declared in
// Settings/SettingsStore.swift (same module) so that
// `SettingsStore.resolvedVoiceBackendKind(hasKey:)` compiles standalone. It is
// intentionally NOT redeclared here — a second declaration in the same module
// would be a duplicate-symbol error. This seam consumes that type as-is:
//   enum VoiceBackendKind: String, CaseIterable { case onDevice; case openAIRealtime }

// MARK: - RealtimeClientBackend (OpenAI adapter)

/// `VoiceBackend` adapter over `RealtimeClient`. Captures the API key and
/// system prompt at init, bridges `VoiceBackendEvents` → `RealtimeEvents`, and
/// forwards `start()` → `connect(apiKey:)`, `sendAudio(_:)`, and `dispose()`.
///
/// `RealtimeClient.swift` is NOT modified — this adapter consumes it as-is.
@MainActor
final class RealtimeClientBackend: VoiceBackend {

    private let apiKey: String
    private let client: RealtimeClient

    /// - Parameters:
    ///   - apiKey: OpenAI API key (passed to `connect(apiKey:)` on `start()`;
    ///     never logged).
    ///   - systemPrompt: instructions forwarded to the Realtime session.
    ///   - events: backend-neutral callbacks, bridged to `RealtimeEvents`.
    init(apiKey: String, systemPrompt: String, events: VoiceBackendEvents) {
        self.apiKey = apiKey
        self.client = RealtimeClient(
            systemPrompt: systemPrompt,
            events: RealtimeClientBackend.bridge(events)
        )
    }

    func start() {
        // API key flows straight to RealtimeClient and is never stored in a
        // logged property.
        client.connect(apiKey: apiKey)
    }

    func sendAudio(_ base64: String) {
        client.sendAudio(base64)
    }

    func dispose() {
        client.dispose()
    }

    // MARK: - Event bridging

    /// Maps the backend-neutral `VoiceBackendEvents` onto `RealtimeEvents`.
    ///
    /// `RealtimeEvents` closures are plain (non-isolated). The bridged closures
    /// are invoked by `RealtimeClient` on the main actor (its callbacks are
    /// dispatched to `DispatchQueue.main`), so calling the `@MainActor`-annotated
    /// `VoiceBackendEvents` closures is safe. We assume main-actor via
    /// `MainActor.assumeIsolated` to satisfy the isolation hop without an async
    /// detour, preserving the synchronous callback timing of the original.
    private static func bridge(_ ev: VoiceBackendEvents) -> RealtimeEvents {
        var out = RealtimeEvents()

        if let cb = ev.onConnected {
            out.onConnected = { MainActor.assumeIsolated { cb() } }
        }
        if let cb = ev.onDisconnected {
            out.onDisconnected = { MainActor.assumeIsolated { cb() } }
        }
        if let cb = ev.onError {
            out.onError = { msg in MainActor.assumeIsolated { cb(msg) } }
        }
        if let cb = ev.onTranscript {
            out.onTranscript = { text in MainActor.assumeIsolated { cb(text) } }
        }
        if let cb = ev.onAudio {
            out.onAudio = { b64 in MainActor.assumeIsolated { cb(b64) } }
        }
        if let cb = ev.onAudioDone {
            out.onAudioDone = { MainActor.assumeIsolated { cb() } }
        }
        if let cb = ev.onSpeechStart {
            out.onSpeechStart = { MainActor.assumeIsolated { cb() } }
        }
        if let cb = ev.onSpeechEnd {
            out.onSpeechEnd = { MainActor.assumeIsolated { cb() } }
        }
        if let cb = ev.onRefinedPrompt {
            out.onRefinedPrompt = { prompt in MainActor.assumeIsolated { cb(prompt) } }
        }

        return out
    }
}
