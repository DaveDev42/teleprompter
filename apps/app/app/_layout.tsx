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
  const loadPairings = usePairingStore((s) => s.load);
  const pairingsLoaded = usePairingStore((s) => s.loaded);

  // Load saved settings on mount
  useEffect(() => {
    loadConnection();
    loadPairings();
  }, []);

  // Direct WebSocket to local daemon (always available for local dev)
  useDaemon(loaded ? (daemonUrl ?? undefined) : undefined);

  // E2EE relay connections for all paired daemons (runs in parallel with direct WS)
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
