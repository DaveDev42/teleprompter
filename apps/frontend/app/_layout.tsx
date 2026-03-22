import "../global.css";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useDaemon } from "../src/hooks/use-daemon";

export default function RootLayout() {
  // Single WebSocket connection for the entire app
  useDaemon();

  return (
    <>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="pairing/index"
          options={{ presentation: "modal" }}
        />
        <Stack.Screen
          name="pairing/scan"
          options={{ presentation: "fullScreenModal" }}
        />
      </Stack>
    </>
  );
}
