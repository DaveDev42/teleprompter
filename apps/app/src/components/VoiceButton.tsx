import { Platform, Pressable, Text, View } from "react-native";
import { useVoiceStore } from "../stores/voice-store";

export function VoiceButton() {
  const state = useVoiceStore((s) => s.state);
  const transcript = useVoiceStore((s) => s.transcript);
  const isSpeaking = useVoiceStore((s) => s.isSpeaking);
  const includeTerminal = useVoiceStore((s) => s.includeTerminal);
  const apiKey = useVoiceStore((s) => s.apiKey);
  const startVoice = useVoiceStore((s) => s.startVoice);
  const stopVoice = useVoiceStore((s) => s.stopVoice);
  const toggleTerminalContext = useVoiceStore((s) => s.toggleTerminalContext);

  if (Platform.OS !== "web") {
    return null; // Web only for now
  }

  if (!apiKey) {
    return null; // Need API key first
  }

  const isActive = state !== "idle";

  const stateLabel = {
    idle: "Mic",
    connecting: "...",
    listening: "Listening",
    processing: "Thinking",
  }[state];

  const bgColor = isActive
    ? isSpeaking
      ? "bg-tp-voice-active"
      : state === "listening"
        ? "bg-tp-error"
        : "bg-tp-warning"
    : "bg-tp-bg-tertiary";

  return (
    <View className="flex-row items-center gap-2">
      {/* Terminal context toggle */}
      <Pressable
        onPress={toggleTerminalContext}
        className={`px-2 py-1 rounded ${includeTerminal ? "bg-tp-accent" : "bg-tp-surface"}`}
        accessibilityRole="switch"
        accessibilityLabel="Include terminal context"
        accessibilityState={{ checked: includeTerminal }}
      >
        <Text className="text-xs text-tp-text-secondary">T</Text>
      </Pressable>

      {/* Mic button */}
      <Pressable
        onPress={isActive ? stopVoice : startVoice}
        className={`${bgColor} rounded-full w-10 h-10 items-center justify-center`}
        accessibilityRole="button"
        accessibilityLabel={
          isActive ? `Stop voice, ${stateLabel}` : "Start voice input"
        }
        accessibilityState={{
          busy: state === "connecting" || state === "processing",
        }}
      >
        <Text className="text-tp-text-on-color text-sm">
          {isActive ? "■" : "Mic"}
        </Text>
      </Pressable>

      {/* Status */}
      {isActive && (
        <Text className="text-tp-text-tertiary text-xs">{stateLabel}</Text>
      )}
      {transcript && isActive && (
        <Text
          className="text-tp-text-tertiary text-xs max-w-32"
          numberOfLines={1}
        >
          {transcript}
        </Text>
      )}
    </View>
  );
}
