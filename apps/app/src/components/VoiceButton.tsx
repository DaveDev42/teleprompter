import { useEffect } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { getPlatformProps } from "../lib/get-platform-props";
import { useVoiceStore } from "../stores/voice-store";

export function VoiceButton({ disabled = false }: { disabled?: boolean }) {
  const state = useVoiceStore((s) => s.state);
  const transcript = useVoiceStore((s) => s.transcript);
  const isSpeaking = useVoiceStore((s) => s.isSpeaking);
  const includeTerminal = useVoiceStore((s) => s.includeTerminal);
  const apiKey = useVoiceStore((s) => s.apiKey);
  const startVoice = useVoiceStore((s) => s.startVoice);
  const stopVoice = useVoiceStore((s) => s.stopVoice);
  const toggleTerminalContext = useVoiceStore((s) => s.toggleTerminalContext);

  // If voice capture is running when the session becomes read-only, stop it.
  // Hiding the button alone would orphan the mic/network session with no UI
  // exit until the user navigates away.
  useEffect(() => {
    if (disabled && state !== "idle") {
      stopVoice();
    }
  }, [disabled, state, stopVoice]);

  if (Platform.OS !== "web") {
    return null; // Web only for now
  }

  if (!apiKey) {
    return null; // Need API key first
  }

  if (disabled) {
    return null; // Hide mic on stopped / read-only sessions
  }

  const isActive = state !== "idle";
  const pp = getPlatformProps();

  const stateLabel = {
    idle: "Mic",
    connecting: "...",
    listening: "Listening",
    processing: "Thinking",
  }[state];

  // RN Web doesn't translate accessibilityState.checked into aria-checked,
  // so a screen reader landing on the switch wouldn't know if terminal
  // context is on or off. Pass aria-checked directly on web. Matches the
  // SegmentedControl / FontPickerModal pattern.
  const ariaCheckedTerminal =
    Platform.OS === "web" ? { "aria-checked": includeTerminal } : {};

  // Same gap for `accessibilityState.busy` — createDOMProps emits
  // aria-busy only when it sees aria-busy/accessibilityBusy directly,
  // so connecting/processing states wouldn't be announced. Pass it
  // through on web for the mic Pressable.
  const ariaBusyMic =
    Platform.OS === "web"
      ? { "aria-busy": state === "connecting" || state === "processing" }
      : {};

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
        className={`px-2 py-1 rounded ${includeTerminal ? "bg-tp-accent" : "bg-tp-surface"} ${pp.className}`}
        tabIndex={pp.tabIndex}
        accessibilityRole="switch"
        accessibilityLabel="Include terminal context"
        accessibilityState={{ checked: includeTerminal }}
        {...(ariaCheckedTerminal as object)}
      >
        <Text className="text-xs text-tp-text-secondary">T</Text>
      </Pressable>

      {/* Mic button */}
      <Pressable
        onPress={isActive ? stopVoice : startVoice}
        className={`${bgColor} rounded-full w-10 h-10 items-center justify-center ${pp.className}`}
        tabIndex={pp.tabIndex}
        accessibilityRole="button"
        accessibilityLabel={
          isActive ? `Stop voice, ${stateLabel}` : "Start voice input"
        }
        accessibilityState={{
          busy: state === "connecting" || state === "processing",
        }}
        {...(ariaBusyMic as object)}
      >
        <Text className="text-tp-text-on-color text-sm">
          {isActive ? "■" : "Mic"}
        </Text>
      </Pressable>

      {/* Status — wrap in a polite live region so state transitions
          (connecting → listening → processing) announce to screen readers. */}
      {isActive && (
        <Text
          className="text-tp-text-tertiary text-xs"
          accessibilityLiveRegion="polite"
        >
          {stateLabel}
        </Text>
      )}
      {transcript && isActive && (
        <Text
          className="text-tp-text-tertiary text-xs max-w-32"
          numberOfLines={1}
          accessibilityLiveRegion="polite"
          accessibilityLabel={`Transcript: ${transcript}`}
        >
          {transcript}
        </Text>
      )}
    </View>
  );
}
