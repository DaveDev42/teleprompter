import AVFoundation
import Foundation
import Speech
import os

// FoundationModels is weak-linked: the framework only exists on iOS 26 /
// macOS 26 / visionOS 26 SDKs+runtimes. Importing at top level is safe (the
// symbols resolve lazily); ALL usage is gated behind
// `if #available(iOS 26.0, macOS 26.0, visionOS 26.0, *)` plus a runtime
// `SystemLanguageModel.default.availability == .available` check. On older OSes
// the import is a no-op and we never touch any FoundationModels symbol.
#if canImport(FoundationModels)
import FoundationModels
#endif

// MARK: - On-device (offline) voice backend
//
// Mirrors the RealtimeClient event contract (the 9-callback VoiceBackendEvents
// surface) but runs entirely on-device:
//
//   STT  = SFSpeechRecognizer (Speech.framework, iOS 17 baseline). When the
//          recognizer supports on-device recognition we force
//          requiresOnDeviceRecognition = true so audio never leaves the device.
//   VAD  = there is NO server VAD here. End-of-utterance is detected by a
//          silence timer (~1.2s) that is reset on every partial result.
//   Refine = FoundationModels (iOS 26+) when available; otherwise the raw STT
//            transcript is forwarded verbatim (never blocks).
//   TTS  = AVSpeechSynthesizer (all platforms) speaks a short confirmation.
//
// IMPORTANT (double-tap hazard): VoiceStore.onConnected starts its OWN
// MicCapture pump and feeds sendAudio (VoiceStore.swift:144-151). THIS backend
// owns its own AVAudioEngine tap, so for the on-device kind VoiceStore MUST NOT
// start that pump — otherwise two taps fight over the same input node. The
// caller's VoiceStore fork handles that branch (see notes). sendAudio() here is
// a deliberate no-op.

private let log = Logger(subsystem: "dev.tpmt.teleprompter", category: "voice.ondevice")

/// End-of-utterance silence window. SFSpeechRecognizer has no VAD, so we treat
/// "no new partial result for this long" as the user having finished speaking.
private let silenceTimeout: TimeInterval = 1.2

@MainActor
final class OnDeviceVoiceClient: NSObject, VoiceBackend {

    // MARK: - Stored config

    private let systemPrompt: String
    private let events: VoiceBackendEvents

    // MARK: - Audio / recognition state

    private let recognizer: SFSpeechRecognizer?
    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let synthesizer = AVSpeechSynthesizer()

    /// Silence timer driving end-of-utterance detection.
    private var silenceTimer: Timer?
    /// Latest partial transcript seen since the last reset.
    private var latestTranscript: String = ""
    /// True once we have committed the current utterance (refine in flight or
    /// done) so duplicate `isFinal` + timer fires don't double-submit.
    private var utteranceCommitted = false

    /// Disposed flag + generation guard so late async refine results are dropped
    /// after teardown.
    private var disposed = false
    private var generation = 0

    // MARK: - Init

    init(systemPrompt: String, events: VoiceBackendEvents) {
        self.systemPrompt = systemPrompt
        self.events = events
        // Locale-default recognizer; nil when the device has no STT support for
        // the current locale.
        self.recognizer = SFSpeechRecognizer(locale: Locale.current)
        super.init()
    }

    // MARK: - Availability

    /// Cheap, synchronous-friendly check the caller uses to decide whether the
    /// on-device backend is usable at all. Returns true when a recognizer exists
    /// for the current locale AND speech authorization is not denied/restricted.
    /// The actual authorization *request* happens in start().
    static func isAvailable() -> Bool {
        guard SFSpeechRecognizer(locale: Locale.current) != nil else { return false }
        switch SFSpeechRecognizer.authorizationStatus() {
        case .denied, .restricted:
            return false
        case .authorized, .notDetermined:
            return true
        @unknown default:
            return true
        }
    }

    // MARK: - VoiceBackend

    func start() {
        guard !disposed else { return }

        // 1. Request speech-recognition authorization. On denied/restricted →
        //    surface an error and bail (graceful degrade, mirrors VoiceStore).
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            // requestAuthorization's completion is NOT on the main actor; hop.
            Task { @MainActor [weak self] in
                guard let self, !self.disposed else { return }
                switch status {
                case .authorized:
                    self.beginListening()
                case .denied, .restricted:
                    self.events.onError?(
                        VoiceError.permissionDenied.errorDescription
                            ?? "Speech recognition permission denied")
                case .notDetermined:
                    self.events.onError?("Speech recognition not authorized")
                @unknown default:
                    self.events.onError?("Speech recognition unavailable")
                }
            }
        }
    }

    /// No-op: this backend owns its own mic tap. VoiceStore must not pump audio
    /// into us for the on-device kind. Kept to satisfy the protocol.
    func sendAudio(_ base64: String) {
        // Intentionally empty — see the double-tap note at the top of this file.
    }

    func dispose() {
        teardown()
    }

    // MARK: - Pipeline

    private func beginListening() {
        guard !disposed else { return }

        guard let recognizer, recognizer.isAvailable else {
            events.onError?(
                VoiceError.microphoneUnavailable.errorDescription
                    ?? "Speech recognizer unavailable")
            return
        }

        // 2. Mic availability — on Simulator/macOS with no input device, degrade.
        guard hasMicrophoneDevice() else {
            log.notice("On-device voice: microphone unavailable — degrading gracefully")
            events.onError?(
                VoiceError.microphoneUnavailable.errorDescription
                    ?? "Microphone unavailable")
            return
        }

        // 3. Configure AVAudioSession (iOS only — matches VoiceAudio.swift:80-85).
        #if !os(macOS)
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(
                .playAndRecord, mode: .voiceChat,
                options: [.defaultToSpeaker, .allowBluetoothHFP])
            try session.setActive(true)
        } catch {
            events.onError?(error.localizedDescription)
            return
        }
        #endif

        // 4. Build the recognition request + audio engine tap.
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        // Keep audio on-device when the recognizer supports it (offline + private).
        if recognizer.supportsOnDeviceRecognition {
            req.requiresOnDeviceRecognition = true
        }
        request = req

        let audioEngine = AVAudioEngine()
        engine = audioEngine
        let inputNode = audioEngine.inputNode
        let hardwareFormat = inputNode.inputFormat(forBus: 0)

        guard hardwareFormat.channelCount > 0 else {
            teardown()
            events.onError?(
                VoiceError.microphoneUnavailable.errorDescription
                    ?? "Microphone unavailable")
            return
        }

        // Install a tap in the native hardware format; feed each buffer to the
        // recognition request. ~85ms buffer matches VoiceAudio.swift cadence.
        //
        // The tap runs on AVAudioEngine's realtime render thread. It must NOT
        // read `self.request` (a @MainActor-isolated stored property that
        // stopAudio() nils on main) — that is a cross-thread data race and a
        // use-after-free on the request. Capture a local strong reference to the
        // request instead: the closure appends to `req` directly, the request
        // stays alive for the closure's lifetime, and there is no read of actor
        // state off the main actor. removeTap() (in stopAudio) bounds delivery.
        let tapBufferSize = AVAudioFrameCount(hardwareFormat.sampleRate * 0.085)
        inputNode.installTap(onBus: 0, bufferSize: tapBufferSize, format: hardwareFormat) {
            (buffer, _) in
            req.append(buffer)
        }

        latestTranscript = ""
        utteranceCommitted = false

        // 5. Start the recognition task. Capture the current generation so a
        //    late callback from THIS task (after a rearm() bumps the generation
        //    and starts a fresh task) is dropped — `task.cancel()` only requests
        //    cancellation and does not synchronously suppress already-delivered
        //    results, and the `Task {}` hop decouples timing further.
        let gen = generation
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            Task { @MainActor [weak self] in
                self?.handleRecognition(result: result, error: error, gen: gen)
            }
        }

        do {
            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            teardown()
            events.onError?(error.localizedDescription)
            return
        }

        // 6. Engine running + task started → tell VoiceStore we're "connected"
        //    so it transitions .connecting → .listening.
        events.onConnected?()
    }

    /// Handle a partial/final recognition callback on the main actor.
    ///
    /// `gen` is the generation captured when the originating `recognitionTask`
    /// was created. A callback whose `gen` no longer matches `generation` is
    /// stale (a fresh task was started by `rearm()`), so it is dropped — without
    /// this, a buffered `isFinal` from the OLD task would `commitUtterance` a
    /// second time after `rearm()` reset `utteranceCommitted` to false.
    private func handleRecognition(result: SFSpeechRecognitionResult?, error: Error?, gen: Int) {
        guard !disposed, generation == gen else { return }

        if let result {
            let text = result.bestTranscription.formattedString
            latestTranscript = text
            events.onTranscript?(text)

            if result.isFinal {
                commitUtterance(text)
                return
            }
            // Reset the silence timer on every fresh partial result.
            restartSilenceTimer()
            return
        }

        if let error {
            // A recognition error after we've already committed (e.g. the task
            // ending normally post-finish) is benign; otherwise surface it only
            // if nothing is in flight.
            if !utteranceCommitted {
                log.error("On-device recognition error: \(error.localizedDescription)")
                // Don't hard-error the whole session on a transient STT hiccup —
                // if we have any transcript, commit it; else report.
                if !latestTranscript.isEmpty {
                    commitUtterance(latestTranscript)
                } else {
                    events.onError?(error.localizedDescription)
                }
            }
        }
    }

    // MARK: - Silence-timer end-of-utterance detection

    private func restartSilenceTimer() {
        silenceTimer?.invalidate()
        let gen = generation
        silenceTimer = Timer.scheduledTimer(
            withTimeInterval: silenceTimeout,
            repeats: false
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, !self.disposed, self.generation == gen else { return }
                // No new speech for `silenceTimeout` → treat as end-of-utterance.
                self.commitUtterance(self.latestTranscript)
            }
        }
    }

    /// Commit the current utterance: stop capture, emit onSpeechEnd, run refine.
    private func commitUtterance(_ transcript: String) {
        guard !disposed, !utteranceCommitted else { return }
        utteranceCommitted = true

        silenceTimer?.invalidate()
        silenceTimer = nil

        // Stop pulling audio while we process this turn (single-shot semantics).
        stopAudio()

        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            // Nothing said — re-arm listening cleanly instead of submitting empty.
            log.notice("On-device voice: empty utterance, re-arming")
            rearm()
            return
        }

        // onSpeechEnd moves VoiceStore to .processing.
        events.onSpeechEnd?()

        let gen = generation
        Task { @MainActor [weak self] in
            guard let self else { return }
            let refined = await self.refine(trimmed)
            guard !self.disposed, self.generation == gen else { return }
            // onRefinedPrompt delivers the prompt. The VoiceStore fork restores
            // state to .listening after onPromptReady (backend-neutral fix), so
            // we do NOT depend on onAudio/onAudioDone here.
            self.events.onRefinedPrompt?(refined)
            self.speakConfirmation(for: refined)
        }
    }

    // MARK: - Refine (FoundationModels with raw-transcript fallback)

    /// Turn messy speech into a clean Claude Code prompt using the on-device
    /// language model when available; otherwise return the raw transcript.
    /// Never throws — any failure falls back to the raw transcript.
    private func refine(_ transcript: String) async -> String {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, visionOS 26.0, *) {
            guard SystemLanguageModel.default.availability == .available else {
                return transcript
            }
            do {
                let instructions = """
                    You convert a user's spoken, possibly messy request into a single
                    clean, actionable prompt for Claude Code (a coding agent). Keep it
                    faithful to the user's intent — do not add tasks they didn't ask
                    for and do not answer the request yourself. Remove filler words and
                    false starts. Output ONLY the refined prompt text, nothing else.
                    """
                let session = LanguageModelSession(instructions: instructions)
                let response = try await session.respond(to: transcript)
                let refined = response.content.trimmingCharacters(in: .whitespacesAndNewlines)
                return refined.isEmpty ? transcript : refined
            } catch {
                log.error(
                    "FoundationModels refine failed, using raw transcript: \(error.localizedDescription)"
                )
                return transcript
            }
        }
        #endif
        // Pre-26 OSes or no FoundationModels: forward the raw transcript.
        return transcript
    }

    // MARK: - TTS confirmation

    /// Speak a SHORT confirmation. With FoundationModels we may generate a
    /// one-line spoken summary; otherwise we speak a fixed short line. We emit
    /// onSpeechStart before speaking but DO NOT emit onAudio/onAudioDone — those
    /// are reserved for the OpenAI PCM path.
    private func speakConfirmation(for refinedPrompt: String) {
        guard !disposed else { return }
        let gen = generation
        Task { @MainActor [weak self] in
            guard let self else { return }
            let line = await self.spokenSummary(for: refinedPrompt)
            guard !self.disposed, self.generation == gen else { return }

            // Optional polish: signal TTS-speaking start + a fresh empty transcript.
            self.events.onSpeechStart?()
            self.events.onTranscript?("")

            let utterance = AVSpeechUtterance(string: line)
            utterance.rate = AVSpeechUtteranceDefaultSpeechRate
            self.synthesizer.speak(utterance)

            // Re-arm listening so the next utterance can start. The VoiceStore
            // onRefinedPrompt fork already restored .listening; re-arming our own
            // capture lets the user speak again.
            self.rearm()
        }
    }

    /// One-line spoken confirmation. Uses FoundationModels to summarize when
    /// available; otherwise a fixed short line.
    private func spokenSummary(for refinedPrompt: String) async -> String {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, visionOS 26.0, *) {
            if SystemLanguageModel.default.availability == .available {
                do {
                    let instructions = """
                        Summarize the following Claude Code prompt into ONE short spoken
                        confirmation sentence (max 8 words), present tense, like "Fixing
                        the login crash." Output only that sentence.
                        """
                    let session = LanguageModelSession(instructions: instructions)
                    let response = try await session.respond(to: refinedPrompt)
                    let summary = response.content.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !summary.isEmpty { return summary }
                } catch {
                    log.error("FoundationModels summary failed: \(error.localizedDescription)")
                }
            }
        }
        #endif
        return "Sent."
    }

    // MARK: - Re-arm / teardown

    /// Restart listening for the next utterance without a full dispose.
    private func rearm() {
        guard !disposed else { return }
        // Tear down just the recognition/audio (not the synthesizer), then start
        // a fresh listening cycle. Bump generation so any stale callbacks drop.
        stopAudio()
        utteranceCommitted = false
        latestTranscript = ""
        beginListening()
    }

    /// Stop only the audio engine + recognition request/task + silence timer.
    /// Does NOT mark disposed and does NOT stop the synthesizer.
    private func stopAudio() {
        generation += 1
        silenceTimer?.invalidate()
        silenceTimer = nil
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        engine = nil
        request?.endAudio()
        request = nil
        task?.cancel()
        task = nil
    }

    /// Full idempotent teardown.
    private func teardown() {
        guard !disposed else { return }
        disposed = true
        stopAudio()
        synthesizer.stopSpeaking(at: .immediate)
        #if !os(macOS)
        try? AVAudioSession.sharedInstance().setActive(
            false,
            options: .notifyOthersOnDeactivation)
        #endif
    }
}
