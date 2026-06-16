import SwiftUI

// MARK: - VoiceButton
//
// Mic button + terminal-context toggle. Ported from VoiceButton.tsx.
//
// Mounted by ChatComposer next to the send button when:
//   - An OpenAI API key is present (OpenAIKeychain.isPresent()).
//   - The session is not stopped (disabled == false).
//
// On macOS smoke / Simulator without mic, the button renders but degrades to
// an error state (VoiceStore.lastError) instead of crashing.

struct VoiceButton: View {
    @Bindable var voice: VoiceStore
    /// Hide and stop voice on stopped/read-only sessions (matches VoiceButton.tsx useEffect).
    var disabled: Bool = false

    var body: some View {
        // Hide when no API key is configured.
        if OpenAIKeychain.isPresent() && !disabled {
            content
        }
    }

    @ViewBuilder
    private var content: some View {
        HStack(spacing: 6) {
            // Terminal context toggle ("T" badge).
            Button {
                voice.toggleTerminalContext()
            } label: {
                Text("T")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(voice.includeTerminal ? .white : .secondary)
                    .frame(width: 20, height: 20)
                    .background(
                        RoundedRectangle(cornerRadius: 4)
                            .fill(voice.includeTerminal ? Color.accentColor : Color.secondary.opacity(0.15))
                    )
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Include terminal context")
            .accessibilityAddTraits(voice.includeTerminal ? [.isSelected] : [])
            .accessibilityIdentifier("voice-terminal-toggle")
            .help("Include terminal context in voice prompt")

            // Mic button.
            Button {
                if voice.connection.isActive {
                    voice.stopVoice()
                } else {
                    Task { await voice.startVoice() }
                }
            } label: {
                Image(systemName: micIcon)
                    .font(.title3)
                    .foregroundStyle(micColor)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(micBackground))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(voice.connection.isActive
                                ? "Stop voice (\(voice.connection.label))"
                                : "Start voice input")
            .accessibilityIdentifier("voice-mic-button")
            .help(voice.connection.isActive ? "Stop voice" : "Start voice input")
            // Show error badge.
            .overlay(alignment: .topTrailing) {
                if voice.lastError != nil {
                    Circle()
                        .fill(Color.red)
                        .frame(width: 8, height: 8)
                        .offset(x: 2, y: -2)
                }
            }

            // Status label + live transcript (polite live region equivalent).
            // L11: Show transcript text below status when active and non-empty.
            // Matches VoiceButton.tsx voice-transcript-live-region.
            if voice.connection.isActive {
                VStack(alignment: .leading, spacing: 2) {
                    Text(voice.connection.label)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel(voice.connection.label)
                        .accessibilityIdentifier("voice-status-label")
                    let transcript = voice.connection.transcript
                    if !transcript.isEmpty {
                        Text(transcript)
                            .font(.caption2)
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                            .accessibilityLabel("Transcript: \(transcript)")
                            .accessibilityIdentifier("voice-transcript-label")
                    }
                }
            }
        }
        // Stop voice when session becomes read-only (matches tsx useEffect).
        .onChange(of: disabled) { _, nowDisabled in
            if nowDisabled && voice.connection.isActive {
                voice.stopVoice()
            }
        }
        // Tooltip for last error.
        .popover(isPresented: Binding(
            get: { voice.lastError != nil },
            set: { if !$0 { voice.lastError = nil } }
        )) {
            if let err = voice.lastError {
                Text(err)
                    .padding(12)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Visual helpers

    private var micIcon: String {
        switch voice.connection {
        case .idle:       return "mic"
        case .connecting: return "mic"
        case .listening:  return voice.connection.isSpeaking ? "speaker.wave.2" : "mic.fill"
        case .processing: return "ellipsis"
        }
    }

    private var micColor: Color {
        switch voice.connection {
        case .idle:                 return .secondary
        case .connecting:           return .orange
        case .listening(true, _):   return .white
        case .listening(false, _):  return .white
        case .processing:           return .white
        }
    }

    private var micBackground: Color {
        switch voice.connection {
        case .idle:                return Color.secondary.opacity(0.1)
        case .connecting:          return Color.orange.opacity(0.2)
        case .listening(true, _):  return Color.accentColor
        case .listening(false, _): return Color.red
        case .processing:          return Color.orange
        }
    }
}
