import "../global.css";
import { Tabs } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useDaemon } from "../src/hooks/use-daemon";

export default function RootLayout() {
  // Single WebSocket connection for the entire app
  useDaemon();

  return (
    <>
      <StatusBar style="light" />
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
      </Tabs>
    </>
  );
}
