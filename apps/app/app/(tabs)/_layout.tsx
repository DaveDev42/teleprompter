import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { useLayout } from "../../src/hooks/use-layout";
import { useThemeStore } from "../../src/stores/theme-store";

export default function TabsLayout() {
  const { isMobile } = useLayout();
  const isDark = useThemeStore((s) => s.isDark);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: isDark ? "#18181B" : "#FFFFFF",
          borderTopColor: isDark ? "#27272A" : "#E4E4E7",
          // Hide tab bar on desktop (sidebar replaces it)
          display: isMobile ? "flex" : "none",
        },
        tabBarActiveTintColor: isDark ? "#3B82F6" : "#2563EB",
        tabBarInactiveTintColor: isDark ? "#71717A" : "#A1A1AA",
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
