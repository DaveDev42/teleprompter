import { Tabs } from "expo-router";
import { useLayout } from "../../src/hooks/use-layout";

export default function TabsLayout() {
  const { isMobile } = useLayout();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: "#111",
          // Hide tab bar on desktop (sidebar replaces it)
          display: isMobile ? "flex" : "none",
        },
        tabBarActiveTintColor: "#fff",
        tabBarInactiveTintColor: "#666",
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: "Chat", tabBarLabel: "Chat" }}
      />
      <Tabs.Screen
        name="terminal"
        options={{ title: "Terminal", tabBarLabel: "Terminal" }}
      />
      <Tabs.Screen
        name="sessions"
        options={{
          title: "Sessions",
          tabBarLabel: "Sessions",
          // Hide sessions tab on tablet/desktop (shown in sidebar)
          href: isMobile ? undefined : null,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: "Settings", tabBarLabel: "Settings" }}
      />
    </Tabs>
  );
}
