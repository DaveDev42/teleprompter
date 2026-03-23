import "../global.css";
import { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useDaemon } from "../src/hooks/use-daemon";
import { useConnectionStore } from "../src/stores/connection-store";

export default function RootLayout() {
  const daemonUrl = useConnectionStore((s) => s.daemonUrl);
  const loaded = useConnectionStore((s) => s.loaded);
  const loadConnection = useConnectionStore((s) => s.load);

  // Load saved connection settings
  useEffect(() => {
    loadConnection();
  }, []);

  // Single WebSocket connection for the entire app
  useDaemon(loaded ? (daemonUrl ?? undefined) : undefined);

  return (
    <SafeAreaProvider>
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
    </SafeAreaProvider>
  );
}
