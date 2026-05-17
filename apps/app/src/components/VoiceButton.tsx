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

  // NVDA / JAWS announce only the diff between live-region updates when
  // aria-atomic isn't set, so transitions like "Connecting" → "Listening"
  // and the first word of an incoming transcript get dropped. ARIA 1.2
  // §6.3.2 says role=status implies aria-atomic=true, but the screen
  // readers ignore the implicit value — and RN Web 0.21 silently drops
  // prop-level `aria-atomic` on Text/View, so the attribute has to be
  // applied imperatively. Matches InAppToast / ConnectionLiveRegion /
  // theme-announcement / DiagnosticsPanel. WCAG 4.1.3 Status Messages.
  // RN Web's <Text> ref returns the host React component, not the DOM
  // node directly — querying the testID after mount is the reliable
  // way to reach the underlying element. Re-run when the visibility
  // conditions change (apiKey load, disabled flip) so the attribute is
  // applied whenever the live regions enter the DOM.
  const liveRegionsMounted = !!apiKey && !disabled;
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!liveRegionsMounted) return;
    const stateEl = document.querySelector(
      '[data-testid="voice-state-live-region"]',
    );
    const transcriptEl = document.querySelector(
      '[data-testid="voice-transcript-live-region"]',
    );
    stateEl?.setAttribute("aria-atomic", "true");
    transcriptEl?.setAttribute("aria-atomic", "true");
  }, [liveRegionsMounted]);

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
        {/* The mic button's accessible name is set on the parent
            Pressable via accessibilityLabel. role=button is NOT atomic
            in NVDA browse mode / JAWS reading cursor — the virtual
            cursor descends into children, so the bare "■" (U+25A0
            BLACK SQUARE, in active state) or "Mic" text would be
            announced after the button's accessible name. Hide both
            from web AT to keep the announcement clean. Native AT
            focuses the parent Pressable and reads accessibilityLabel
            directly, so the gate is web-only. WCAG 1.1.1 + 2.5.3. */}
        <Text
          className="text-tp-text-on-color text-sm"
          {...(Platform.OS === "web"
            ? ({ "aria-hidden": true } as object)
            : {})}
        >
          {isActive ? "■" : "Mic"}
        </Text>
      </Pressable>

      {/* Status — polite live regions for state transitions
          (connecting → listening → processing) and transcript updates.
          Always mounted *and* always in the a11y tree: NVDA / JAWS
          attach mutation observers when a live region enters the DOM
          and watch the parent for text content changes. `display: none`
          would remove the node from the a11y tree, defeating the
          purpose — the observer never attaches, and the first
          announcement is dropped. Empty text content keeps the node
          visually inert without hiding it from assistive tech. Matches
          InAppToast and ConnectionLiveRegion. */}
      <Text
        testID="voice-state-live-region"
        className="text-tp-text-tertiary text-xs"
        accessibilityLiveRegion="polite"
        // RN Web translates accessibilityLiveRegion to aria-live, but
        // does NOT add role="status". Without role=status the live
        // region is a generic <div aria-live="polite"> — NVDA/JAWS
        // announce text changes inconsistently because the element
        // lacks the implicit aria-atomic semantics that role=status
        // carries (ARIA 1.2 §6.3.27, WCAG 4.1.3). Matches the
        // InAppToast / ConnectionLiveRegion / SessionStoppedLiveRegion
        // pattern.
        {...(Platform.OS === "web"
          ? ({ role: "status", "aria-live": "polite" } as object)
          : {})}
      >
        {isActive ? stateLabel : ""}
      </Text>
      <Text
        testID="voice-transcript-live-region"
        className="text-tp-text-tertiary text-xs max-w-32"
        numberOfLines={1}
        accessibilityLiveRegion="polite"
        {...(Platform.OS === "web"
          ? ({ role: "status", "aria-live": "polite" } as object)
          : {})}
      >
        {transcript && isActive ? `Transcript: ${transcript}` : ""}
      </Text>
    </View>
  );
}
