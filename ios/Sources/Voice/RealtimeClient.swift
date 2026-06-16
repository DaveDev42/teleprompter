import Foundation
import os

// MARK: - OpenAI Realtime API client
//
// Ported from the Expo app's realtime-client.ts. Connects via WebSocket to
// wss://api.openai.com/v1/realtime with the API key passed in a subprotocol
// header (openai-insecure-api-key.<KEY>), matching the TypeScript original.

private let log = Logger(subsystem: "dev.tpmt.teleprompter", category: "voice.realtime")

private let realtimeURL = "wss://api.openai.com/v1/realtime"
private let realtimeModel = "gpt-4o-realtime-preview"

// MARK: - Event callbacks

struct RealtimeEvents {
    var onConnected: (() -> Void)?
    var onDisconnected: (() -> Void)?
    var onError: ((String) -> Void)?
    var onTranscript: ((String) -> Void)?
    var onAudio: ((String) -> Void)?       // base64 PCM16 24kHz chunk
    var onAudioDone: (() -> Void)?
    var onSpeechStart: (() -> Void)?
    var onSpeechEnd: (() -> Void)?
    var onRefinedPrompt: ((String) -> Void)?  // response.text.done only
}

// MARK: - RealtimeClient

/// WebSocket client for the OpenAI Realtime API.
///
/// Thread-safety: all external calls and callbacks run on the main actor.
/// URLSession delegate callbacks are dispatched to `DispatchQueue.main`.
@MainActor
final class RealtimeClient: NSObject {

    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var events: RealtimeEvents
    private var systemPrompt: String
    private var disposed = false

    init(systemPrompt: String = "", events: RealtimeEvents = RealtimeEvents()) {
        self.systemPrompt = systemPrompt
        self.events = events
    }

    // MARK: - Connection

    func connect(apiKey: String) {
        guard !disposed else { return }

        guard let url = URL(string: "\(realtimeURL)?model=\(realtimeModel)") else {
            events.onError?("Invalid Realtime URL")
            return
        }

        // Subprotocol carries the API key — matches the TypeScript WebSocket constructor:
        //   new WebSocket(url, ["realtime", "openai-insecure-api-key.<KEY>"])
        // URLSession encodes these as the Sec-WebSocket-Protocol header.
        // IMPORTANT: the key is never logged.
        let protocols = ["realtime", "openai-insecure-api-key.\(apiKey)"]

        let cfg = URLSessionConfiguration.default
        let sess = URLSession(configuration: cfg, delegate: self, delegateQueue: .main)
        session = sess

        // webSocketTask(with:protocols:) accepts a URL + protocols list.
        let wsTask = sess.webSocketTask(with: url, protocols: protocols)
        task = wsTask
        wsTask.resume()
        receive()
    }

    // MARK: - Send helpers

    func sendAudio(_ base64: String) {
        send(["type": "input_audio_buffer.append", "audio": base64])
    }

    func commitAudio() {
        send(["type": "input_audio_buffer.commit"])
    }

    func sendText(_ text: String) {
        send([
            "type": "conversation.item.create",
            "item": [
                "type": "message",
                "role": "user",
                "content": [["type": "input_text", "text": text]]
            ]
        ])
        send(["type": "response.create"])
    }

    func updateSystemPrompt(_ prompt: String) {
        systemPrompt = prompt
        send(["type": "session.update", "session": ["instructions": prompt]])
    }

    func cancelResponse() {
        send(["type": "response.cancel"])
    }

    // MARK: - Disconnect / dispose

    func disconnect() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
    }

    func dispose() {
        disposed = true
        disconnect()
    }

    // MARK: - Private helpers

    private func configureSession() {
        let prompt = systemPrompt.isEmpty ? defaultSystemPrompt() : systemPrompt
        let payload: [String: Any] = [
            "type": "session.update",
            "session": [
                "modalities": ["text", "audio"],
                "instructions": prompt,
                "voice": "alloy",
                "input_audio_format": "pcm16",
                "output_audio_format": "pcm16",
                "input_audio_transcription": ["model": "whisper-1"],
                "turn_detection": [
                    "type": "server_vad",
                    "threshold": 0.5,
                    "prefix_padding_ms": 300,
                    "silence_duration_ms": 500
                ]
            ]
        ]
        send(payload)
    }

    private func defaultSystemPrompt() -> String {
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

    private func send(_ payload: [String: Any]) {
        guard let task, task.state == .running else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let str = String(data: data, encoding: .utf8) else { return }
        task.send(.string(str)) { _ in }
    }

    private func receive() {
        guard let task else { return }
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let str):
                    self.handleMessage(str)
                case .data(let data):
                    if let str = String(data: data, encoding: .utf8) {
                        self.handleMessage(str)
                    }
                @unknown default:
                    break
                }
                self.receive()
            case .failure:
                // Socket closed or error — onDisconnected fires via delegate.
                break
            }
        }
    }

    private func handleMessage(_ json: String) {
        guard let data = json.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type_ = obj["type"] as? String else { return }

        switch type_ {
        case "session.created", "session.updated":
            break

        case "input_audio_buffer.speech_started":
            events.onSpeechStart?()

        case "input_audio_buffer.speech_stopped":
            events.onSpeechEnd?()

        case "conversation.item.input_audio_transcription.completed":
            let transcript = obj["transcript"] as? String ?? ""
            events.onTranscript?(transcript)

        case "response.audio.delta":
            if let delta = obj["delta"] as? String, !delta.isEmpty {
                events.onAudio?(delta)
            }

        case "response.audio.done":
            events.onAudioDone?()

        case "response.text.done":
            // Authoritative refined-prompt source (matches TypeScript: only here,
            // NOT from response.done, to avoid duplicates).
            if let text = obj["text"] as? String, !text.isEmpty {
                events.onRefinedPrompt?(text)
            }

        case "response.done":
            // Completion signal — no additional action (refined prompt already emitted
            // via response.text.done above).
            break

        case "error":
            let errObj = obj["error"] as? [String: Any]
            let msg = errObj?["message"] as? String ?? "Realtime API error"
            events.onError?(msg)

        default:
            break
        }
    }
}

// MARK: - URLSessionWebSocketDelegate

extension RealtimeClient: URLSessionWebSocketDelegate {
    nonisolated func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol_: String?
    ) {
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.disposed else { return }
            self.events.onConnected?()
            self.configureSession()
        }
    }

    nonisolated func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        DispatchQueue.main.async { [weak self] in
            self?.events.onDisconnected?()
        }
    }

    nonisolated func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        guard let error else { return }
        // L12: Route transport errors (e.g. 401 Bad API key — WebSocket upgrade
        // rejected by server) to onError so VoiceStore.lastError is set and
        // the red badge appears. Previously any non-nil error landed in
        // onDisconnected, leaving lastError nil and the failure silent.
        DispatchQueue.main.async { [weak self] in
            self?.events.onError?(error.localizedDescription)
        }
    }
}
