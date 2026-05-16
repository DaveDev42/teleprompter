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

  // Visible text is short ("Connecting…" reads naturally and stays under the
  // 32px max-width). The screen-reader label uses the same word so VoiceOver
  // doesn't announce "dot dot dot" from a bare "..." — keep visible label
  // and announcement in sync.
  const stateLabel = {
    idle: "Mic",
    connecting: "Connecting",
    listening: "Listening",
    processing: "Thinking",
  }[state];

  // RN Web doesn't translate accessibilityState.checked into aria-checked,
  // so a screen reader landing on the switch wouldn't know if terminal
  // context is on or off. Pass aria-checked directly on web. Matches the
  // SegmentedControl / FontPickerModal pattern.
  const ariaCheckedTerminal =
    Platform.OS === "web" ? { "aria-checked": includeTerminal } : {};

  // WAI-ARIA §3.22 (Switch Pattern) requires Space to toggle the switch.
  // Pressable on web renders a <div role="switch">, not a native <button>,
  // so the browser's "Space clicks the focused button" shortcut doesn't
  // apply. Enter happens to work via Pressable's synthetic onClick, but
  // Space falls through silently — the spec-canonical key for switches.
  // Same pattern as the session view's role=tab Space handler (PR #340).
  const switchKeyHandler =
    Platform.OS === "web"
      ? {
          onKeyDown: (e: { key: string; preventDefault: () => void }) => {
            if (e.key === " ") {
              e.preventDefault();
              toggleTerminalContext();
            }
          },
        }
      : {};

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
        {...(switchKeyHandler as object)}
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

      {/* Status — polite live regions for state transitions
          (connecting → listening → processing) and transcript updates.
          Always mounted: NVDA / JAWS attach mutation observers when a
          live region node enters the DOM and watch the parent for text
          content changes. Mounting the container together with its
          first content drops the first announcement (no observer was
          watching the parent at insertion time). Matches InAppToast and
          ConnectionLiveRegion. */}
      <Text
        testID="voice-state-live-region"
        className="text-tp-text-tertiary text-xs"
        style={isActive ? undefined : { display: "none" }}
        accessibilityLiveRegion="polite"
      >
        {isActive ? stateLabel : ""}
      </Text>
      <Text
        testID="voice-transcript-live-region"
        className="text-tp-text-tertiary text-xs max-w-32"
        style={transcript && isActive ? undefined : { display: "none" }}
        numberOfLines={1}
        accessibilityLiveRegion="polite"
      >
        {transcript && isActive ? `Transcript: ${transcript}` : ""}
      </Text>
    </View>
  );
}
