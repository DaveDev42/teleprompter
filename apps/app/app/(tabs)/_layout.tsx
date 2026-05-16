import { Ionicons } from "@expo/vector-icons";
import type { BottomTabBarButtonProps } from "@react-navigation/bottom-tabs";
import { PlatformPressable } from "@react-navigation/elements";
import { Tabs } from "expo-router";
import { useEffect } from "react";
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

  // APG §3.21 Tabs: tablist requires `aria-label` (or `aria-labelledby`)
  // so AT users hear "Main navigation, tablist" instead of an anonymous
  // "tablist". The bottom tablist is rendered inside React Navigation's
  // BottomTabBar — the library exposes no prop to set ARIA attributes on
  // the tablist container, so set it imperatively. Scope the lookup by
  // matching the tablist that contains the `tab-sessions` testID so we
  // never collide with the session-view tablist (which sets its own
  // aria-label in app/session/[sid].tsx).
  //
  // ARIA 1.2 §6.3.26 also requires `role="tab"` elements to be owned by
  // their `role="tablist"`. React Navigation wraps each tab anchor in a
  // sibling <div>, so the tabs are grandchildren of the tablist rather
  // than direct children — the accessibility tree may not treat them
  // as owned tabs without an explicit `aria-owns` bridge. Set the
  // ownership in the same pass: give each tab an `id` and list the
  // ids on the tablist's `aria-owns`.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const sync = () => {
      const sessionsTab = document.querySelector(
        '[data-testid="tab-sessions"]',
      );
      const tablist = sessionsTab?.closest('[role="tablist"]');
      if (!tablist) return;
      if (!tablist.getAttribute("aria-label")) {
        tablist.setAttribute("aria-label", "Main navigation");
      }
      // WCAG 2.4.1 Bypass Blocks (Level A) + ARIA 1.2 §5.3.10: the bottom
      // tablist needs a `role="navigation"` landmark wrapper so AT users
      // can jump to it via landmark-navigation ("D" in NVDA, "W" in
      // VoiceOver). A `role="tablist"` is a widget role, not a landmark
      // — without the navigation wrapper, the only landmark on each
      // screen is `role="main"` and there's no way to reach the tablist
      // by landmark mode at all. React Navigation renders its bottom
      // tab bar wrapper without a role, so promote the tablist's parent
      // <div> in the same imperative pass (mirrors the existing
      // aria-label / aria-owns setup).
      const wrapper = tablist.parentElement;
      if (wrapper && wrapper.getAttribute("role") !== "navigation") {
        wrapper.setAttribute("role", "navigation");
        // Label the landmark so it announces as "Main navigation,
        // navigation" rather than an anonymous one. Keep the tablist's
        // own aria-label too — duplicate naming is the lesser evil
        // versus removing it and breaking the existing
        // `app-tablist-aria-label.spec.ts` invariant.
        if (!wrapper.getAttribute("aria-label")) {
          wrapper.setAttribute("aria-label", "Main navigation");
        }
      }
      // Map each known testID to a stable id, then publish them via
      // aria-owns so the tablist's accessibility subtree matches the
      // ARIA requirement even though the DOM has wrapper <div>s in
      // between.
      const slugs = ["tab-sessions", "tab-daemons", "tab-settings"];
      const ownedIds: string[] = [];
      for (const slug of slugs) {
        const tab = document.querySelector<HTMLElement>(
          `[data-testid="${slug}"]`,
        );
        if (!tab) continue;
        if (!tab.id) tab.id = slug;
        ownedIds.push(tab.id);
      }
      if (ownedIds.length > 0) {
        tablist.setAttribute("aria-owns", ownedIds.join(" "));
      }
    };
    sync();
    const id = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(id);
  }, []);

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
