import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { useLayout } from "../../src/hooks/use-layout";
import { getPalette } from "../../src/lib/tokens";
import { useThemeStore } from "../../src/stores/theme-store";

export default function TabsLayout() {
  const { isMobile } = useLayout();
  const isDark = useThemeStore((s) => s.isDark);
  const palette = getPalette(isDark);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: palette.bgSecondary,
          borderTopColor: palette.border,
          // Hide tab bar on desktop (sidebar replaces it)
          display: isMobile ? "flex" : "none",
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
