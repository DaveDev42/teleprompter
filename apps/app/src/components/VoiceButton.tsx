import { View, Text, Pressable, Platform } from "react-native";
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
      ? "bg-purple-600"
      : state === "listening"
        ? "bg-red-600"
        : "bg-yellow-600"
    : "bg-zinc-700";

  return (
    <View className="flex-row items-center gap-2">
      {/* Terminal context toggle */}
      <Pressable
        onPress={toggleTerminalContext}
        className={`px-2 py-1 rounded ${includeTerminal ? "bg-blue-600" : "bg-zinc-800"}`}
      >
        <Text className="text-xs text-gray-300">T</Text>
      </Pressable>

      {/* Mic button */}
      <Pressable
        onPress={isActive ? stopVoice : startVoice}
        className={`${bgColor} rounded-full w-10 h-10 items-center justify-center`}
      >
        <Text className="text-white text-sm">{isActive ? "■" : "🎤"}</Text>
      </Pressable>

      {/* Status */}
      {isActive && (
        <Text className="text-gray-400 text-xs">{stateLabel}</Text>
      )}
      {transcript && isActive && (
        <Text className="text-gray-500 text-xs max-w-32" numberOfLines={1}>
          {transcript}
        </Text>
      )}
    </View>
  );
}
