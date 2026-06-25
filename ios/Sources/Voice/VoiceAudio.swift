import AVFoundation
import Foundation
import os

// MARK: - Voice audio protocols (matches audio-types.ts)

// @MainActor: both protocols are implemented by MainActor-isolated classes
// (MicCapture, PcmAudioPlayer) and are called exclusively from MainActor
// contexts (VoiceStore). Annotating the protocols avoids Swift 6
// "conformance crosses into main actor-isolated code" errors.
@MainActor
protocol VoiceAudioCapture {
    /// Start microphone capture, streaming base64 PCM16 24 kHz chunks.
    /// `@Sendable`: chunks are delivered from a real-time audio thread, so the
    /// callback crosses isolation domains (see `MicCapture.onChunk`).
    func start(onChunk: @escaping @Sendable (String) -> Void) async throws
    func stop()
}

@MainActor
protocol VoiceAudioPlayerProtocol {
    func start()
    /// Queue a base64 PCM16 24 kHz chunk for sequential playback.
    func play(_ base64: String)
    func stop()
}

// MARK: - Availability

/// Returns true if there is a microphone available on this device/platform.
///
/// On macOS in headless CI and on Simulator without a host mic, the input
/// node may report zero channels — this guard prevents crashes in those
/// environments. Matches the QRScannerView.hasCameraDevice() pattern.
func hasMicrophoneDevice() -> Bool {
    #if os(macOS)
    // On macOS, use AVCaptureDeviceDiscoverySession (devices(for:) deprecated macOS 10.15).
    let session = AVCaptureDevice.DiscoverySession(
        deviceTypes: [.microphone],
        mediaType: .audio,
        position: .unspecified)
    return !session.devices.isEmpty
    #else
    // On iOS/iPadOS: the input node is always present on real hardware.
    // On Simulator without host mic, inputNode.inputFormat(forBus:) returns 0 channels.
    let engine = AVAudioEngine()
    let inputFormat = engine.inputNode.inputFormat(forBus: 0)
    return inputFormat.channelCount > 0
    #endif
}

// MARK: - AudioCapture (AVAudioEngine-based)

private let log = Logger(subsystem: "dev.tpmt.app", category: "voice.audio")
private let targetSampleRate: Double = 24000

/// Microphone capture using AVAudioEngine.
///
/// Installs a tap on `inputNode`, converts to mono Float32, resamples to 24 kHz,
/// encodes to PCM16, and calls `onChunk` with base64-encoded data.
///
/// Degrades gracefully when no microphone is available (simulator / macOS without mic).
///
/// @MainActor: MicCapture is always created and managed on the main actor by
/// VoiceStore; marking it MainActor prevents Swift 6 "sending non-Sendable" errors
/// when VoiceStore awaits its methods from MainActor-isolated async Tasks.
@MainActor
final class MicCapture: VoiceAudioCapture {
    private var engine: AVAudioEngine?
    // `@Sendable`: the callback is invoked from the AVAudioEngine tap (a real-time
    // audio thread). It is captured into a local constant before `installTap` so
    // the audio-thread closure never reads `self` (a `@MainActor` instance) off
    // the main actor — the only thing crossing the thread boundary is this
    // Sendable closure plus the produced base64 String.
    private var onChunk: (@Sendable (String) -> Void)?

    func start(onChunk: @escaping @Sendable (String) -> Void) async throws {
        self.onChunk = onChunk

        // Check mic availability before configuring — prevents crashes on
        // Simulator / macOS smoke where no real input device is attached.
        guard hasMicrophoneDevice() else {
            throw VoiceError.microphoneUnavailable
        }

        // Request permission (iOS) — on macOS this is handled by the system prompt
        // or entitlement; AVAudioSession is iOS-only.
        #if !os(macOS)
        // Use AVAudioApplication on iOS 17+ (requestRecordPermission deprecated in iOS 17).
        let granted: Bool
        if #available(iOS 17.0, *) {
            granted = await AVAudioApplication.requestRecordPermission()
        } else {
            granted = await withCheckedContinuation { cont in
                AVAudioSession.sharedInstance().requestRecordPermission { allowed in
                    cont.resume(returning: allowed)
                }
            }
        }
        guard granted else {
            throw VoiceError.permissionDenied
        }
        #endif

        // Configure AVAudioSession for simultaneous capture + playback.
        // voiceChat mode enables HW echo cancellation so TTS is not re-captured.
        #if !os(macOS)
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(
            .playAndRecord, mode: .voiceChat,
            options: [.defaultToSpeaker, .allowBluetoothHFP])
        try audioSession.setActive(true)
        #endif

        let audioEngine = AVAudioEngine()
        self.engine = audioEngine

        let inputNode = audioEngine.inputNode
        let hardwareFormat = inputNode.inputFormat(forBus: 0)

        guard hardwareFormat.channelCount > 0 else {
            self.engine = nil
            throw VoiceError.microphoneUnavailable
        }

        let hwRate = hardwareFormat.sampleRate

        // Install tap in native hardware format; convert to Float32 mono + resample below.
        // Buffer size ~85ms at 24kHz ≈ 2048 samples — close to audio-native.ts cadence.
        let tapBufferSize = AVAudioFrameCount(hardwareFormat.sampleRate * 0.085)

        // Capture the @Sendable callback into a local BEFORE installing the tap.
        // The tap block runs on a real-time audio thread, so it must not touch
        // `self` (a @MainActor instance) — it closes over `cb` (Sendable) only.
        let cb = onChunk
        inputNode.installTap(onBus: 0, bufferSize: tapBufferSize, format: hardwareFormat) {
            (buffer, _) in
            guard let channelData = buffer.floatChannelData else { return }

            let frameCount = Int(buffer.frameLength)
            // Mix to mono: average all channels.
            let numChannels = Int(buffer.format.channelCount)
            var mono = [Float](repeating: 0, count: frameCount)
            for ch in 0..<numChannels {
                let chData = channelData[ch]
                for i in 0..<frameCount {
                    mono[i] += chData[i] / Float(numChannels)
                }
            }

            // Resample to 24kHz if hardware rate differs.
            let resampled = resampleLinear(mono, fromRate: hwRate, toRate: targetSampleRate)
            let pcmData = float32ToPcm16(resampled)
            let base64 = pcmData.base64EncodedString()
            DispatchQueue.main.async { cb(base64) }
        }

        try audioEngine.start()
    }

    func stop() {
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
        onChunk = nil
        #if !os(macOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }
}

// MARK: - AudioPlayer (AVAudioEngine-based)

/// Plays base64-encoded PCM16 24 kHz audio chunks sequentially via AVAudioPlayerNode.
///
/// Mirrors the TypeScript AudioPlayer's sequential-scheduling + barge-in stop/start logic.
///
/// @MainActor: PcmAudioPlayer is always created and managed on the main actor by
/// VoiceStore; this prevents Swift 6 region-isolation errors on the stored property.
@MainActor
final class PcmAudioPlayer: VoiceAudioPlayerProtocol {
    private var engine: AVAudioEngine?
    private var playerNode: AVAudioPlayerNode?
    private var nextPlayTime: AVAudioTime?
    private let format = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: targetSampleRate,
        channels: 1,
        interleaved: false)!

    func start() {
        stop()  // tear down any previous engine first (barge-in)

        #if !os(macOS)
        // Re-activate the session in case stop() deactivated it.
        try? AVAudioSession.sharedInstance().setCategory(
            .playAndRecord, mode: .voiceChat,
            options: [.defaultToSpeaker, .allowBluetoothHFP])
        try? AVAudioSession.sharedInstance().setActive(true)
        #endif

        let eng = AVAudioEngine()
        let player = AVAudioPlayerNode()
        eng.attach(player)
        eng.connect(player, to: eng.mainMixerNode, format: format)
        try? eng.start()
        player.play()
        engine = eng
        playerNode = player
        nextPlayTime = nil
    }

    func play(_ base64: String) {
        guard let player = playerNode, let eng = engine else { return }
        let samples = decodePcm16Base64(base64)
        guard !samples.isEmpty else { return }

        guard
            let pcmBuffer = AVAudioPCMBuffer(
                pcmFormat: format,
                frameCapacity: AVAudioFrameCount(samples.count))
        else {
            return
        }
        pcmBuffer.frameLength = AVAudioFrameCount(samples.count)
        if let channelData = pcmBuffer.floatChannelData {
            for i in 0..<samples.count {
                channelData[0][i] = samples[i]
            }
        }

        // Sequential scheduling: queue each buffer to start immediately after the previous one.
        // L10: For the first chunk, anchor nextPlayTime from the render-time of the
        // scheduled buffer rather than lastRenderTime (which is a past timestamp and
        // causes chunk overlap or gaps).  We schedule at nil (immediate), then convert
        // the player-time of the scheduled buffer's start into the host-timeline via
        // nodeTime(forPlayerTime:).  If the conversion isn't available yet (the
        // player hasn't rendered its first frame), we fall back to a small fixed
        // pre-roll so the second chunk queues cleanly.  This mirrors the TypeScript
        // AudioPlayer's monotonically-advancing currentTime.
        let sampleRate = format.sampleRate
        let frameDuration = Double(samples.count) / sampleRate
        if let next = nextPlayTime {
            player.scheduleBuffer(pcmBuffer, at: next, options: [], completionHandler: nil)
            let nextSample = next.sampleTime + AVAudioFramePosition(frameDuration * sampleRate)
            nextPlayTime = AVAudioTime(sampleTime: nextSample, atRate: sampleRate)
        } else {
            // First chunk: schedule at nil (immediate play after player.play() in start()).
            player.scheduleBuffer(pcmBuffer, at: nil, options: [], completionHandler: nil)
            // Derive the anchor from the actual scheduled start time so subsequent
            // chunks queue contiguously regardless of when lastRenderTime was sampled.
            // playerTime(atHostTime:) / nodeTime(forPlayerTime:) may not be available
            // on the very first frame; fall back to the player-timeline origin (0)
            // plus the first chunk's duration so the next chunk queues contiguously.
            let anchorSample: AVAudioFramePosition
            if let renderTime = player.lastRenderTime,
                renderTime.isSampleTimeValid,
                let playerTime = player.playerTime(forNodeTime: renderTime),
                playerTime.isSampleTimeValid
            {
                // Anchor: current player-timeline position + duration of this chunk.
                anchorSample =
                    playerTime.sampleTime + AVAudioFramePosition(frameDuration * sampleRate)
            } else {
                // Fallback: the first chunk was scheduled at nil (player-timeline 0),
                // so the next chunk should start exactly one chunk-duration later.
                // No pre-roll offset — adding one would insert a silent gap.
                anchorSample = AVAudioFramePosition(frameDuration * sampleRate)
            }
            nextPlayTime = AVAudioTime(sampleTime: anchorSample, atRate: sampleRate)
        }

        if !eng.isRunning { try? eng.start() }
    }

    func stop() {
        playerNode?.stop()
        engine?.stop()
        engine = nil
        playerNode = nil
        nextPlayTime = nil
    }
}

// MARK: - VoiceError

enum VoiceError: LocalizedError {
    case microphoneUnavailable
    case permissionDenied
    case noApiKey

    var errorDescription: String? {
        switch self {
        case .microphoneUnavailable: return "Microphone unavailable"
        case .permissionDenied: return "Microphone permission denied"
        case .noApiKey: return "OpenAI API key not set"
        }
    }
}
