import { Platform, Pressable, Text, View } from "react-native";
import { getPlatformProps } from "../lib/get-platform-props";

export type ViewMode = "chat" | "terminal";

// APG Tabs pattern: tab ↔ tabpanel are bidirectionally linked by id /
// aria-controls / aria-labelledby. Centralise the ids so SegmentedControl
// and the tabpanel wrappers stay in lock-step.
export const SESSION_TAB_CHAT_ID = "session-tab-chat";
export const SESSION_TAB_TERMINAL_ID = "session-tab-terminal";
export const SESSION_TABPANEL_CHAT_ID = "session-tabpanel-chat";
export const SESSION_TABPANEL_TERMINAL_ID = "session-tabpanel-terminal";

export function SessionSegmentedControl({
  mode,
  onModeChange,
}: {
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
}) {
  const pp = getPlatformProps();
  // APG Tabs keyboard model (automatic activation): ArrowLeft/Right cycle
  // focus across the two tabs *and* activate the focused tab; Home/End jump
  // to the first/last. Without this a keyboard-only user is stuck — the
  // sighted-user workaround is clicking, but a SR user with focus on Chat
  // has no announced way to reach Terminal short of tab-cycling past the
  // tablist entirely. RN's Pressable doesn't surface key events on web, so
  // we attach the handler to the role=tablist container instead.
  const tabOrder: ViewMode[] = ["chat", "terminal"];
  const handleTablistKeyDown = (e: {
    key: string;
    preventDefault: () => void;
  }) => {
    let next: ViewMode | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      const idx = tabOrder.indexOf(mode);
      next = tabOrder[(idx + 1) % tabOrder.length]!;
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      const idx = tabOrder.indexOf(mode);
      next = tabOrder[(idx - 1 + tabOrder.length) % tabOrder.length]!;
    } else if (e.key === "Home") {
      next = tabOrder[0]!;
    } else if (e.key === "End") {
      next = tabOrder[tabOrder.length - 1]!;
    } else if (e.key === " " || e.key === "Enter") {
      // APG Tabs §3.23: Space and Enter must activate the focused tab. The
      // tabs render as <div role="tab"> (RN Web Pressable doesn't emit a
      // native <button>), so the browser's "Space clicks the focused button"
      // shortcut doesn't apply. Enter happens to work because Pressable's
      // synthetic onClick listener catches it, but Space falls through with
      // no effect — keyboard-only users can navigate with arrows but can't
      // activate Chat/Terminal from a fresh focus. Read which tab DOM focus
      // is on and route the activation through onModeChange.
      if (Platform.OS === "web") {
        const focusedId = document.activeElement?.id;
        if (focusedId === SESSION_TAB_CHAT_ID) next = "chat";
        else if (focusedId === SESSION_TAB_TERMINAL_ID) next = "terminal";
      }
      // preventDefault so Space doesn't scroll the page when the tab is
      // already selected (no-op activation still consumes the key).
      e.preventDefault();
    }
    if (next && next !== mode) {
      e.preventDefault();
      onModeChange(next);
      // Move DOM focus to the newly-activated tab so AT announces the new
      // selection (otherwise focus stays on the previously-focused tab
      // node, which is now visually inactive — confusing to SR users).
      if (Platform.OS === "web") {
        const id =
          next === "chat" ? SESSION_TAB_CHAT_ID : SESSION_TAB_TERMINAL_ID;
        // React state updates are scheduled as microtasks (React 18 automatic
        // batching) while requestAnimationFrame is a macrotask — in CI /
        // headless Chromium the first raf can fire before React's re-render
        // has flushed the new tabIndex to the DOM, leaving the target element
        // at tabindex=-1 exactly when focus() is called. Double-rAF: the
        // first frame lets React commit its render, the second moves focus
        // after the DOM reflects the updated tabIndex=0 on the target tab.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            document.getElementById(id)?.focus();
          });
        });
      }
    }
  };
  // RN Web's Pressable doesn't translate `accessibilityState.selected` into
  // `aria-selected`, so screen readers can't tell which tab is active. Pass
  // the raw ARIA attribute via a web-only spread; native ignores it. Same
  // pattern for `id` + `aria-controls` — without those the APG Tabs pattern
  // is incomplete (no tab↔panel relationship in the a11y tree), so screen
  // readers don't know which content region belongs to which tab.
  //
  // APG Tabs also requires "roving tabindex": only the currently-selected
  // tab is in the document tab sequence (tabindex=0); the inactive tab gets
  // tabindex=-1 so Tab exits the tablist instead of cycling inside it. With
  // both tabs at tabindex=0 a keyboard user has to Tab through every tab
  // before reaching content, and SR users lose the Tab vs Arrow distinction
  // that signals tablist semantics. Native ignores tabIndex (no DOM).
  const webTabChat =
    Platform.OS === "web"
      ? {
          "aria-selected": mode === "chat",
          id: SESSION_TAB_CHAT_ID,
          "aria-controls": SESSION_TABPANEL_CHAT_ID,
          tabIndex: mode === "chat" ? 0 : -1,
        }
      : {};
  const webTabTerminal =
    Platform.OS === "web"
      ? {
          "aria-selected": mode === "terminal",
          id: SESSION_TAB_TERMINAL_ID,
          "aria-controls": SESSION_TABPANEL_TERMINAL_ID,
          tabIndex: mode === "terminal" ? 0 : -1,
        }
      : {};
  // RN propagates accessibilityRole verbatim to web — but "tabbar" is not a
  // valid ARIA role (the standard is "tablist"). Without a web override SR
  // and DOM tooling see role="tabbar" and skip the tab semantics. Override
  // via the `role` prop on web; native keeps tabbar which RN recognizes.
  // APG §3.21 Tabs: tablist requires `aria-label` (or `aria-labelledby`) so
  // AT users hear "Session view, tablist" instead of an anonymous "tablist"
  // — important when more than one tablist exists in the document
  // (the bottom nav is also `role="tablist"`).
  const tablistWebProps =
    Platform.OS === "web"
      ? {
          role: "tablist" as const,
          "aria-label": "Session view",
          // WAI-ARIA 1.2 §6.6.21: declare horizontal orientation so AT
          // (JAWS in particular) routes ArrowLeft/ArrowRight to tab
          // switching. Without this hint, JAWS treats unspecified
          // orientation as vertical and expects ArrowUp/ArrowDown —
          // since the tablist handler only listens for left/right, JAWS
          // users can never reach inactive tabs at all (WCAG 2.1.1 A).
          "aria-orientation": "horizontal" as const,
          onKeyDown: handleTablistKeyDown,
        }
      : {};
  return (
    <View className="px-4 py-2 bg-tp-bg-secondary">
      <View
        className="flex-row bg-tp-bg-tertiary rounded-btn p-1"
        accessibilityRole="tabbar"
        {...tablistWebProps}
      >
        <Pressable
          testID="tab-chat"
          onPress={() => onModeChange("chat")}
          accessibilityRole="tab"
          accessibilityLabel="Chat"
          accessibilityState={{ selected: mode === "chat" }}
          {...(webTabChat as object)}
          className={`flex-1 py-1.5 rounded-badge items-center ${
            mode === "chat" ? "bg-tp-surface" : ""
          } ${pp.className}`}
        >
          <Text
            className={`text-[13px] ${
              mode === "chat"
                ? "text-tp-text-primary font-semibold"
                : "text-tp-text-secondary font-medium"
            }`}
          >
            Chat
          </Text>
        </Pressable>
        <Pressable
          testID="tab-terminal"
          onPress={() => onModeChange("terminal")}
          accessibilityRole="tab"
          accessibilityLabel="Terminal"
          accessibilityState={{ selected: mode === "terminal" }}
          {...(webTabTerminal as object)}
          className={`flex-1 py-1.5 rounded-badge items-center ${
            mode === "terminal" ? "bg-tp-surface" : ""
          } ${pp.className}`}
        >
          <Text
            className={`text-[13px] ${
              mode === "terminal"
                ? "text-tp-text-primary font-semibold"
                : "text-tp-text-secondary font-medium"
            }`}
          >
            Terminal
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
