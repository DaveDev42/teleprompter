import { Tabs } from "expo-router";

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: "#111" },
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
        options={{ title: "Sessions", tabBarLabel: "Sessions" }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: "Settings", tabBarLabel: "Settings" }}
      />
    </Tabs>
  );
}
