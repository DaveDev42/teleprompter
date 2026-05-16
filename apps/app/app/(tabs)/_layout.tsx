import { Ionicons } from "@expo/vector-icons";
import type { BottomTabBarButtonProps } from "@react-navigation/bottom-tabs";
import { PlatformPressable } from "@react-navigation/elements";
import { Tabs } from "expo-router";
import { Platform } from "react-native";
import { enableScreens } from "react-native-screens";
import { getPalette } from "../../src/lib/tokens";
import { useThemeStore } from "../../src/stores/theme-store";

// APG Tabs requires "roving tabindex" — only the active tab is in the
// document tab sequence (tabindex=0); inactive ones are tabindex=-1 so
// Tab exits the tablist into content instead of cycling through every
// tab. React Navigation's default tab bar button renders all three tabs
// with tabindex=0, so every keyboard user has to Tab past every nav tab
// to reach content, and SR users lose the Tab vs Arrow distinction that
// signals tablist widget semantics. Override the button render to set
// tabIndex from aria-selected; everything else stays the default render
// (PlatformPressable spread, hover/ripple/press semantics intact).
//
// Roving tabindex requires a way to *reach* the inactive tabs — by
// definition Tab can no longer visit them. The APG Tabs pattern §3.21
// fills that gap with Arrow keys: ArrowRight/ArrowLeft cycle focus
// among siblings inside the same `role="tablist"`, with Home/End
// jumping to the first/last. Without this handler the inactive
// tabindex=-1 tabs are completely unreachable by keyboard — a user
// landing on Sessions can never navigate to Daemons or Settings via
// keyboard at all (a hard WCAG 2.1 SC 2.1.1 Level A failure).
const handleTabKeyDown = (e: {
  key: string;
  preventDefault: () => void;
  currentTarget: HTMLElement | null;
}) => {
  if (Platform.OS !== "web") return;
  const key = e.key;
  if (
    key !== "ArrowRight" &&
    key !== "ArrowLeft" &&
    key !== "Home" &&
    key !== "End"
  ) {
    return;
  }
  // React Navigation wraps each tab `PlatformPressable` in its own
  // <div>; the actual `role="tablist"` is the grandparent. Walk up
  // until we hit the tablist so the sibling lookup is scoped to the
  // bottom tabbar specifically and doesn't accidentally include tabs
  // from another tablist (e.g. session-view Chat/Terminal) if the DOM
  // shape changes upstream.
  const target = e.currentTarget ?? null;
  const tablist =
    (target?.closest?.('[role="tablist"]') as HTMLElement | null) ?? null;
  if (!tablist) return;
  const tabs = Array.from(
    tablist.querySelectorAll<HTMLElement>('[role="tab"]'),
  );
  if (tabs.length === 0) return;
  // `target` is whatever DOM node React attaches the synthetic
  // keydown listener to (PlatformPressable's outer node) — that may
  // be a wrapper, not the `role="tab"` itself. Find the tab by
  // containment instead of strict equality.
  const currentIndex = tabs.findIndex(
    (t) => t === target || (target ? t.contains(target) : false),
  );
  if (currentIndex < 0) return;
  let nextIndex = currentIndex;
  if (key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
  else if (key === "ArrowLeft")
    nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  else if (key === "Home") nextIndex = 0;
  else if (key === "End") nextIndex = tabs.length - 1;
  if (nextIndex === currentIndex) return;
  e.preventDefault();
  // Activate the target tab. PlatformPressable installs a synthetic
  // click handler that routes through React Navigation's tabPress event
  // and triggers the route change, so click() is enough — no router
  // import or hard-coded route table needed. The newly-activated tab
  // will re-render with tabIndex=0; focus it on the next frame after
  // the re-render commits (double rAF mirrors the session-view tablist
  // pattern that survives CI headless Chromium timing).
  tabs[nextIndex].click();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      tabs[nextIndex].focus();
    });
  });
};

const tabBarButton = (props: BottomTabBarButtonProps) => {
  // `aria-selected: boolean` is set by BottomTabItem (see node_modules
  // `@react-navigation/bottom-tabs/src/views/BottomTabItem.tsx`).
  const selected = (props as { "aria-selected"?: boolean })["aria-selected"];
  // PlatformPressable's TS types don't surface `onKeyDown` (RN's
  // Pressable abstraction omits keyboard events; RN Web's underlying
  // <View> does forward it though). Cast through a web-only extra-props
  // bag so the JSX prop reaches the DOM node without TS rejecting it.
  const webExtra = Platform.OS === "web" ? { onKeyDown: handleTabKeyDown } : {};
  return (
    <PlatformPressable
      {...props}
      // RN ignores tabIndex without a DOM; on web it lands as the
      // attribute the browser uses for the Tab sequence.
      tabIndex={selected ? 0 : -1}
      {...(webExtra as object)}
    />
  );
};

// On web, react-native-screens defaults to disabled (since it's a native-only
// optimisation). Opt-in so `<Tabs detachInactiveScreens>` actually wraps each
// scene in <Screen> on web — without this, inactive tab content stays in the
// DOM with `tabIndex=0`, polluting keyboard navigation order (a screen reader
// or keyboard user on the Settings tab can Tab into the "Go to Daemons" button
// from the hidden Sessions tab). With screens enabled + detached, inactive
// scenes render with `display:none` (Screen.web.tsx) and disappear from the
// focus order entirely.
if (Platform.OS === "web") {
  enableScreens(true);
}

export default function TabsLayout() {
  const isDark = useThemeStore((s) => s.isDark);
  const palette = getPalette(isDark);

  return (
    <Tabs
      detachInactiveScreens
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: palette.bgSecondary,
          borderTopColor: palette.border,
        },
        tabBarActiveTintColor: palette.accent,
        tabBarInactiveTintColor: palette.textSecondary,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Sessions",
          tabBarLabel: "Sessions",
          // Avoid the " tab" suffix — the button already has role=tab, so
          // assistive tech announces "Sessions, tab" on its own. Adding
          // "tab" to the label produces "Sessions tab, tab" duplication.
          tabBarAccessibilityLabel: "Sessions",
          tabBarButtonTestID: "tab-sessions",
          tabBarButton,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="list-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="daemons"
        options={{
          title: "Daemons",
          tabBarLabel: "Daemons",
          tabBarAccessibilityLabel: "Daemons",
          tabBarButtonTestID: "tab-daemons",
          tabBarButton,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="server-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarLabel: "Settings",
          tabBarAccessibilityLabel: "Settings",
          tabBarButtonTestID: "tab-settings",
          tabBarButton,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="settings-outline" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
