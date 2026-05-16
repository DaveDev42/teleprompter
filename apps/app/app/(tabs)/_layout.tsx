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
const tabBarButton = (props: BottomTabBarButtonProps) => {
  // `aria-selected: boolean` is set by BottomTabItem (see node_modules
  // `@react-navigation/bottom-tabs/src/views/BottomTabItem.tsx`).
  const selected = (props as { "aria-selected"?: boolean })["aria-selected"];
  return (
    <PlatformPressable
      {...props}
      // RN ignores tabIndex without a DOM; on web it lands as the
      // attribute the browser uses for the Tab sequence.
      tabIndex={selected ? 0 : -1}
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
