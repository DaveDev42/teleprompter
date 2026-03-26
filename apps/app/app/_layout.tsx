import "../global.css";
import { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useDaemon } from "../src/hooks/use-daemon";
import { useRelay } from "../src/hooks/use-relay";
import { useConnectionStore } from "../src/stores/connection-store";
import { usePairingStore } from "../src/stores/pairing-store";

export default function RootLayout() {
  const daemonUrl = useConnectionStore((s) => s.daemonUrl);
  const loaded = useConnectionStore((s) => s.loaded);
  const loadConnection = useConnectionStore((s) => s.load);
  const isPaired = usePairingStore((s) => s.state === "paired");

  // Load saved connection settings
  useEffect(() => {
    loadConnection();
  }, []);

  // Direct WebSocket to daemon (used when NOT paired via relay)
  useDaemon(loaded && !isPaired ? (daemonUrl ?? undefined) : undefined);

  // E2EE relay connection (used when paired via QR)
  useRelay();

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
