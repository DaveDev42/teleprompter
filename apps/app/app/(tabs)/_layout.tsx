import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { Platform } from "react-native";
import { enableScreens } from "react-native-screens";
import { getPalette } from "../../src/lib/tokens";
import { useThemeStore } from "../../src/stores/theme-store";

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
          tabBarAccessibilityLabel: "Sessions tab",
          tabBarButtonTestID: "tab-sessions",
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
          tabBarAccessibilityLabel: "Daemons tab",
          tabBarButtonTestID: "tab-daemons",
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
          tabBarAccessibilityLabel: "Settings tab",
          tabBarButtonTestID: "tab-settings",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="settings-outline" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
