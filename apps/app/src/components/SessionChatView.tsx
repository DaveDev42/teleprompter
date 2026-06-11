import type { SessionMeta, SessionRec } from "@teleprompter/protocol/client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  FlatList,
  Keyboard,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAnyRelayConnected } from "../hooks/use-relay";
import { getTransport } from "../hooks/use-transport";
import { getPlatformProps } from "../lib/get-platform-props";
import { deriveInputGates } from "../lib/session-ux";
import { getPalette } from "../lib/tokens";
import {
  addOptimisticUserMessage,
  type ChatMessage,
  processHookEvent,
  useChatStore,
} from "../stores/chat-store";
import { useNotificationStore } from "../stores/notification-store";
import { useSessionStore } from "../stores/session-store";
import { useThemeStore } from "../stores/theme-store";
import { useVoiceStore } from "../stores/voice-store";
import { ChatCard } from "./ChatCard";
import { VoiceButton } from "./VoiceButton";

export function SessionChatView({
  sid,
  session,
  stopped,
}: {
  sid: string;
  session: SessionMeta | undefined;
  stopped: boolean;
}) {
  const messages = useChatStore((s) => s.messages);
  const addRecHandler = useSessionStore((s) => s.addRecHandler);
  const removeRecHandler = useSessionStore((s) => s.removeRecHandler);
  const connected = useAnyRelayConnected();
  const flatListRef = useRef<FlatList>(null);
  // Web uses ScrollView + .map() to keep `role="listitem"` direct
  // descendants of `role="list"` (ARIA §4.3.3 owned-element rule;
  // mirrors the Sessions list ownership fix). FlatList stays on
  // native where virtualization is still needed.
  const chatScrollRef = useRef<ScrollView>(null);
  // Track whether the user is near the bottom so auto-scroll doesn't
  // yank them away when they've scrolled up to read history.
  const isNearBottomRef = useRef(true);
  const sendRef = useRef<View>(null);
  const chatInputRef = useRef<TextInput>(null);
  const [input, setInput] = useState("");
  const setOnPromptReady = useVoiceStore((s) => s.setOnPromptReady);
  const isDark = useThemeStore((s) => s.isDark);
  const placeholderColor = getPalette(isDark).textTertiary;
  const { isEditable, canSend } = deriveInputGates(session, connected, sid);

  // Derive once so both accessibilityHint (native) and aria-description
  // (web setAttribute) share the same string and stay in lock-step as
  // state flips between stopped / disconnected / live.
  const chatInputHint = stopped
    ? "This session has ended. New prompts cannot be sent."
    : !connected
      ? "Disconnected. Compose a message to send when reconnected."
      : "Type a message to send to Claude (Shift+Enter for newline)";

  // RN Web doesn't whitelist `aria-description` in createDOMProps nor
  // map `accessibilityHint` to any ARIA attribute, so a screen reader
  // on web never hears the chat input's contextual hint. Mirror it via
  // setAttribute so the hint stays current as the session transitions.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const el = chatInputRef.current as unknown as HTMLElement | null;
    if (!el) return;
    el.setAttribute("aria-description", chatInputHint);
  }, [chatInputHint]);

  // Wire voice prompt to chat send
  useEffect(() => {
    setOnPromptReady((prompt: string) => {
      if (stopped) return;
      const trimmed = prompt.trim();
      if (!trimmed) return;
      const client = getTransport();
      if (sid && client) {
        // Trim for display + empty-prompt guard; dedup comparison trims separately.
        addOptimisticUserMessage(trimmed);
        client.sendChat(sid, trimmed);
      }
    });
    return () => setOnPromptReady(null);
  }, [sid, stopped, setOnPromptReady]);

  // Reset composer draft on session switch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sid drives the per-session reset
  useEffect(() => {
    setInput("");
  }, [sid]);

  // Move focus to the Back button on first mount / session change. Without
  // this, focus stays on <body> after navigation (especially deep links and
  // browser refreshes on /session/:sid) — keyboard and screen-reader users
  // get dropped onto the page with no announced focus point and have to
  // press Tab blindly to find an anchor. Defer until next frame so RN Web
  // has actually mounted the Pressable's underlying DOM node. Skip if the
  // user has already focused something themselves (e.g. clicked into the
  // chat input before this fires).
  // biome-ignore lint/correctness/useExhaustiveDependencies: sid drives the focus reset
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const raf = requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) {
        return;
      }
      const back = document.querySelector<HTMLElement>(
        '[data-testid="session-back"]',
      );
      back?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [sid]);

  // RN Web's `multiline` TextInput renders as <textarea rows="2"> with a
  // fixed height — Shift+Enter newlines stack invisibly inside the same
  // 52px box. Resize the textarea to fit content on every change (clamped
  // by the existing `max-h-24` Tailwind class via CSS max-height, then
  // internal scroll takes over). Reset to "auto" first so shrinking works
  // when the user deletes lines. `input` is not read directly inside the
  // effect body, but its change is the trigger — el.scrollHeight reflects the
  // updated DOM after RN Web re-renders with the new value.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — input drives re-run via DOM side-effect
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const el = chatInputRef.current as unknown as HTMLTextAreaElement | null;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  // Request record replay exactly once per sid, on the first transition to
  // `connected = true`. Mounting before key exchange completes (connect() is
  // async) means we must wait for `connected` — but subsequent reconnects are
  // already handled inside `RelayClient` (it auto-resumes at `lastSeq`,
  // see `relay-client.ts` `relay.auth.ok` branch). Without the ref guard the
  // effect re-fires `resume(sid, 0)` on every disconnect/reconnect cycle, and
  // because cursor=0 asks for the full 10-frame relay cache the same records
  // get replayed and re-processed → duplicate chat messages on flaky links.
  const resumedSidsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!sid || !connected) return;
    if (resumedSidsRef.current.has(sid)) return;
    const client = getTransport();
    if (client) {
      client.resume(sid, 0);
      resumedSidsRef.current.add(sid);
    }
  }, [sid, connected]);

  // Mirror disabled state to aria-disabled on the Send button. RN Web's
  // Pressable only emits aria-disabled when the native `disabled` prop is
  // also set, which would remove the button from Tab order. We keep it
  // focusable and announce the disabled state via this side-channel.
  const sendDisabled = !input.trim() || !canSend;
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const el = sendRef.current as unknown as HTMLElement | null;
    if (!el) return;
    if (sendDisabled) el.setAttribute("aria-disabled", "true");
    else el.removeAttribute("aria-disabled");
  }, [sendDisabled]);

  // Wire hook event records to chat store (hooks-only mode — PTY io records
  // go exclusively to the terminal tab via SessionTerminalView's own handler).
  useEffect(() => {
    const handler = (rec: SessionRec) => {
      if (rec.k !== "event") return;
      try {
        const eventBytes = Uint8Array.from(atob(rec.d), (c) => c.charCodeAt(0));
        const event = JSON.parse(new TextDecoder("utf-8").decode(eventBytes));
        processHookEvent(event);
      } catch {
        // ignore
      }
    };
    addRecHandler(handler);
    return () => removeRecHandler(handler);
  }, [addRecHandler, removeRecHandler]);

  // Auto-scroll on new messages only when the user is already near the
  // bottom. If they've scrolled up to read history, a new message should not
  // yank them back. The 100ms debounce avoids a scroll per batch-replay frame.
  useEffect(() => {
    if (messages.length === 0) return;
    if (!isNearBottomRef.current) return;
    const t = setTimeout(() => {
      if (Platform.OS === "web") {
        chatScrollRef.current?.scrollToEnd({ animated: true });
      } else {
        flatListRef.current?.scrollToEnd({ animated: true });
      }
    }, 100);
    return () => clearTimeout(t);
  }, [messages.length]);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || !sid || stopped) return;
    const client = getTransport();
    if (!client) {
      // No paired daemon — clearing the input + a toast tells the user
      // their keystrokes weren't lost into a void. Previously this was a
      // silent return, so users couldn't tell why nothing happened.
      useNotificationStore.getState().showToast({
        title: "Not paired",
        body: "Pair a daemon to send messages.",
      });
      setInput("");
      return;
    }
    // User explicitly sending — force the scroll anchor down so their own
    // bubble lands in view even if they were reading history. The
    // near-bottom guard exists to protect *incoming* messages from yanking
    // the view; the user's own send is an intentional jump-to-bottom.
    isNearBottomRef.current = true;
    // Optimistic add must precede sendChat so the echoed hook event dedups.
    addOptimisticUserMessage(trimmed);
    client.sendChat(sid, trimmed);
    setInput("");
  }, [input, sid, stopped]);

  const displayMessages: ChatMessage[] = messages;

  // On web, expose the chat messages container as a `log` landmark.
  // role=log implies `aria-live=polite` + `aria-relevant=additions text`
  // per the ARIA spec, but NVDA/JAWS historically (still in some
  // versions) do NOT honor the implicit aria-live on role=log — they
  // only announce appended messages when aria-live is set explicitly.
  // Every other live region in the app (InAppToast, VoiceButton,
  // DiagnosticsPanel, FontPickerModal) sets aria-live explicitly for
  // exactly this reason. RN Web's createDOMProps passes `aria-live`
  // through to the DOM (the `aria-relevant` claim in an earlier
  // version of this comment was wrong — only relevant gets dropped).
  // FlatList doesn't forward arbitrary ARIA props cleanly, so the role
  // and aria-live ride on the wrapping View.
  const liveRegionProps =
    Platform.OS === "web"
      ? {
          role: "log" as const,
          "aria-live": "polite" as const,
          "aria-label": "Chat log",
        }
      : {};

  const emptyMessage = !connected
    ? "Connecting to daemon..."
    : "Listening to Claude Code...";

  const pp = getPlatformProps();

  return (
    <>
      <View className="flex-1" {...(liveRegionProps as object)}>
        {Platform.OS === "web" ? (
          // Web: ScrollView + .map() so each `role="listitem"` sits
          // directly under `role="list"` (ARIA §4.3.3 required-context
          // for listitem). FlatList inserts at least two roleless
          // wrapper <div>s between the list container and each item,
          // which Chromium auto-repairs but Firefox/Safari don't —
          // NVDA / VoiceOver lose the list semantics entirely there.
          <ScrollView
            ref={chatScrollRef}
            className="flex-1"
            contentContainerStyle={{ paddingVertical: 8 }}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            onScrollBeginDrag={() => Keyboard.dismiss()}
            onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
              const { contentOffset, contentSize, layoutMeasurement } =
                e.nativeEvent;
              const distanceFromBottom =
                contentSize.height - layoutMeasurement.height - contentOffset.y;
              isNearBottomRef.current = distanceFromBottom < 100;
            }}
            scrollEventThrottle={100}
          >
            {/* List container always mounts — keeps the `role="list"`
                landmark stable for AT and matches `app-listitem-aria`'s
                "list role exists" invariant. Empty state nests inside
                so the role doesn't disappear between renders. */}
            <View
              accessibilityLabel="Chat messages"
              {...({ role: "list" } as object)}
            >
              {displayMessages.length === 0 ? (
                <View className="flex-1 items-center justify-center pt-20">
                  <Text className="text-tp-text-tertiary text-[15px]">
                    {emptyMessage}
                  </Text>
                </View>
              ) : (
                displayMessages.map((item) => (
                  <View
                    key={item.id}
                    className="px-4 py-1"
                    {...({ role: "listitem" } as object)}
                  >
                    <ChatCard msg={item} />
                  </View>
                ))
              )}
            </View>
          </ScrollView>
        ) : (
          <FlatList
            ref={flatListRef}
            data={displayMessages}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <View className="px-4 py-1">
                <ChatCard msg={item} />
              </View>
            )}
            className="flex-1"
            contentContainerStyle={{ paddingVertical: 8 }}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            onScrollBeginDrag={() => Keyboard.dismiss()}
            onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
              const { contentOffset, contentSize, layoutMeasurement } =
                e.nativeEvent;
              const distanceFromBottom =
                contentSize.height - layoutMeasurement.height - contentOffset.y;
              isNearBottomRef.current = distanceFromBottom < 100;
            }}
            scrollEventThrottle={100}
            accessibilityRole="list"
            accessibilityLabel="Chat messages"
            ListEmptyComponent={
              <View className="flex-1 items-center justify-center pt-20">
                <Text className="text-tp-text-tertiary text-[15px]">
                  {emptyMessage}
                </Text>
              </View>
            }
          />
        )}
      </View>

      {/* Input bar */}
      <View className="flex-row items-end px-3 py-2 bg-tp-bg-secondary border-t border-tp-border">
        <VoiceButton disabled={stopped} />
        <TextInput
          ref={chatInputRef}
          testID="chat-input"
          className={`flex-1 bg-tp-bg-input text-tp-text-primary rounded-full px-4 py-2 mr-2 max-h-24 text-[15px] ${pp.className}`}
          placeholder={stopped ? "Session ended" : "Send a message..."}
          placeholderTextColor={placeholderColor}
          value={input}
          onChangeText={setInput}
          onSubmitEditing={handleSend}
          // Web: react-native-web's multiline TextInput inserts a newline on
          // Enter regardless of returnKeyType. Intercept onKeyPress so Enter
          // (without Shift) submits like every other chat UI. Native keeps
          // onSubmitEditing as the trigger.
          // `isComposing` guards CJK IME: pressing Enter to commit a Hangul/
          // Kana/Pinyin candidate fires keydown with key="Enter" AND
          // isComposing=true. Without this check the message sends mid-
          // composition and the candidate text is dropped.
          onKeyPress={
            Platform.OS === "web"
              ? (e) => {
                  const ne = e.nativeEvent as unknown as {
                    key: string;
                    shiftKey?: boolean;
                    isComposing?: boolean;
                  };
                  if (ne.key === "Enter" && !ne.shiftKey && !ne.isComposing) {
                    e.preventDefault();
                    handleSend();
                  }
                }
              : undefined
          }
          multiline
          returnKeyType="send"
          editable={isEditable}
          accessibilityLabel="Message input"
          // accessibilityHint is read by native AT but RN Web drops the
          // hint and never maps it to aria-description. The matching
          // aria-description is set imperatively in the effect above so
          // it stays in lock-step with the stopped/disconnected state.
          accessibilityHint={chatInputHint}
          tabIndex={pp.tabIndex}
        />
        <Pressable
          testID="chat-send"
          ref={sendRef}
          // `disabled` maps to HTML `disabled` on RN Web, which removes the
          // button from the browser's Tab order entirely. Keyboard-only
          // users typing in the composer would Tab straight past Send to
          // the rest of the page with no way back. Drop the native
          // `disabled` and use an onPress guard so the button stays
          // focusable and no-ops on activation when not ready. We still
          // want screen readers to hear "disabled" while the composer is
          // empty — RN Web's Pressable strips a spread `aria-disabled`
          // unless the native `disabled` prop is also set, so we apply it
          // via a layout effect on the underlying DOM node.
          onPress={() => {
            if (!input.trim() || !canSend) return;
            handleSend();
          }}
          className={`bg-tp-accent rounded-full w-9 h-9 items-center justify-center ${pp.className}`}
          tabIndex={pp.tabIndex}
          style={{ opacity: input.trim() && canSend ? 1 : 0.4 }}
          accessibilityRole="button"
          accessibilityLabel="Send message"
          accessibilityState={{ disabled: !input.trim() || !canSend }}
        >
          {/* role=button is not atomic in NVDA browse mode / JAWS reading
              cursor — the virtual cursor descends into children, so the
              bare "↑" (U+2191 UPWARDS ARROW) gets announced as "upwards
              arrow" after the button's accessible name ("Send message,
              button, upwards arrow"). The glyph is purely decorative;
              accessibilityLabel already conveys the action. Hide from AT
              on web. Native AT focuses the Pressable and reads
              accessibilityLabel directly, so the gate is web-only.
              WCAG 1.1.1. */}
          <Text
            className="text-tp-text-on-color text-lg font-bold"
            {...(Platform.OS === "web"
              ? ({ "aria-hidden": true } as object)
              : {})}
          >
            ↑
          </Text>
        </Pressable>
      </View>
    </>
  );
}
