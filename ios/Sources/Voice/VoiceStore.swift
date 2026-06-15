import SwiftUI
import os

// MARK: - Voice connection state (matches voice-store.ts discriminated union)

enum VoiceConnectionStatus: Equatable {
    case idle
    case connecting
    /// VAD detected speech start; `isSpeaking` = TTS currently playing.
    case listening(isSpeaking: Bool, transcript: String)
    /// VAD detected speech end; waiting for model response.
    case processing(transcript: String)

    var isActive: Bool {
        switch self {
        case .idle: return false
        default:    return true
        }
    }

    var label: String {
        switch self {
        case .idle:        return "Mic"
        case .connecting:  return "Connecting"
        case .listening:   return "Listening"
        case .processing:  return "Thinking"
        }
    }

    var isSpeaking: Bool {
        if case .listening(let speaking, _) = self { return speaking }
        return false
    }

    var transcript: String {
        switch self {
        case .listening(_, let t): return t
        case .processing(let t):   return t
        default:                   return ""
        }
    }
}

// MARK: - VoiceStore

private let log = Logger(subsystem: "dev.tpmt.teleprompter", category: "voice.store")

/// Observable state machine for voice input/output.
///
/// Matches the TypeScript `useVoiceStore` (voice-store.ts), ported to Swift
/// `@Observable` / `@MainActor`. All state transitions occur on the main actor.
@Observable
@MainActor
final class VoiceStore {

    // MARK: - Observed state

    var connection: VoiceConnectionStatus = .idle
    var includeTerminal: Bool = false
    /// Last refined prompt from the model (for display in chat).
    private(set) var refinedPrompt: String = ""
    /// Error message to surface in the UI (nil when no error).
    var lastError: String?

    // MARK: - Injected dependencies (set at mount time)

    /// Session store — used to read terminal context.
    weak var sessionStore: SessionStore?
    /// The active session id — used for terminal context lookup and prompt routing.
    var activeSid: String?
    /// Called when a refined prompt is ready to send to Claude Code.
    var onPromptReady: ((String) -> Void)?

    // MARK: - Private audio/realtime state

    @ObservationIgnored private var client: RealtimeClient?
    @ObservationIgnored private var capture: MicCapture?
    @ObservationIgnored private var player: PcmAudioPlayer?
    /// Generation counter — incremented on every teardown to invalidate in-flight async work.
    @ObservationIgnored private var generation = 0

    // MARK: - Public API

    /// Start voice session. No-op if already active or no API key is configured.
    func startVoice() async {
        guard !connection.isActive else { return }

        guard let apiKey = OpenAIKeychain.get(), !apiKey.isEmpty else {
            lastError = VoiceError.noApiKey.errorDescription
            return
        }

        lastError = nil
        cleanup()
        let gen = generation

        connection = .connecting
        refinedPrompt = ""

        // Check microphone availability before opening the WS socket.
        // On Simulator / macOS smoke with no real mic, degrade gracefully.
        guard hasMicrophoneDevice() else {
            log.notice("Voice: microphone unavailable — degrading gracefully")
            connection = .idle
            lastError = VoiceError.microphoneUnavailable.errorDescription
            return
        }

        // Build system prompt with optional terminal context.
        var prompt = buildSystemPrompt()
        if includeTerminal, let store = sessionStore, let sid = activeSid {
            prompt += formatTerminalContext(store: store, sid: sid)
        }

        let cap = MicCapture()
        let pl = PcmAudioPlayer()
        capture = cap
        player = pl

        let newClient = RealtimeClient(systemPrompt: prompt, events: makeEvents(gen: gen))
        client = newClient
        // API key is passed here and never stored in a logged property.
        newClient.connect(apiKey: apiKey)
    }

    /// Stop voice session.
    func stopVoice() {
        cleanup()
        connection = .idle
    }

    func toggleTerminalContext() {
        includeTerminal.toggle()
    }

    // MARK: - Private helpers

    private func makeEvents(gen: Int) -> RealtimeEvents {
        var ev = RealtimeEvents()

        ev.onConnected = { [weak self] in
            guard let self, self.generation == gen else { return }
            self.connection = .listening(isSpeaking: false, transcript: "")
            // Start capture after connection established.
            Task { @MainActor [weak self] in
                guard let self, self.generation == gen else { return }
                do {
                    self.player?.start()
                    try await self.capture?.start { [weak self] chunk in
                        self?.client?.sendAudio(chunk)
                    }
                } catch let err as VoiceError {
                    log.error("Voice capture failed: \(err.localizedDescription)")
                    if self.generation == gen {
                        self.cleanup()
                        self.connection = .idle
                        self.lastError = err.errorDescription
                    }
                } catch {
                    log.error("Voice capture failed: \(error)")
                    if self.generation == gen {
                        self.cleanup()
                        self.connection = .idle
                    }
                }
            }
        }

        ev.onDisconnected = { [weak self] in
            guard let self else { return }
            self.connection = .idle
            self.cleanup()
        }

        ev.onError = { [weak self] msg in
            guard let self else { return }
            log.error("Voice realtime error: \(msg)")
            self.lastError = msg
            self.connection = .idle
            self.cleanup()
        }

        ev.onSpeechStart = { [weak self] in
            guard let self, self.generation == gen else { return }
            // User started speaking — cancel TTS barge-in.
            self.player?.stop()
            self.player?.start()
        }

        ev.onSpeechEnd = { [weak self] in
            guard let self, self.generation == gen else { return }
            let t = self.connection.transcript
            self.connection = .processing(transcript: t)
        }

        ev.onTranscript = { [weak self] text in
            guard let self, self.generation == gen else { return }
            // Preserve isSpeaking flag across transcript arrival.
            let speaking = self.connection.isSpeaking
            self.connection = .listening(isSpeaking: speaking, transcript: text)
        }

        ev.onAudio = { [weak self] base64 in
            guard let self, self.generation == gen else { return }
            if case .listening(_, let t) = self.connection {
                self.connection = .listening(isSpeaking: true, transcript: t)
            }
            self.player?.play(base64)
        }

        ev.onAudioDone = { [weak self] in
            guard let self, self.generation == gen else { return }
            if case .listening(_, let t) = self.connection {
                self.connection = .listening(isSpeaking: false, transcript: t)
            }
        }

        ev.onRefinedPrompt = { [weak self] prompt in
            guard let self else { return }
            self.refinedPrompt = prompt
            self.onPromptReady?(prompt)
        }

        return ev
    }

    private func cleanup() {
        generation += 1
        capture?.stop()
        capture = nil
        player?.stop()
        player = nil
        client?.dispose()
        client = nil
    }

    private func buildSystemPrompt() -> String {
        return """
        You are a voice interface for Teleprompter, a remote Claude Code controller.

        Your role:
        1. Listen to the user's voice input
        2. Clean up and refine it into a clear, actionable prompt for Claude Code
        3. Respond briefly with a spoken confirmation

        Rules:
        - Keep spoken responses SHORT (1-2 sentences max)
        - Output the refined prompt as text in your response
        - The refined prompt will be automatically sent to Claude Code
        - If the user's intent is unclear, ask a brief clarifying question

        Example:
        - User: "um, can you like fix the bug in the login page, the one where it crashes"
        - Your response: "Fixing the login crash bug."
        - (Refined prompt sent to Claude: "Fix the bug in the login page that causes a crash")
        """
    }
}
