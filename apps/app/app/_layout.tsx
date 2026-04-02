import "../global.css";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { useColorScheme, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { UpdateBanner } from "../src/components/UpdateBanner";
import { useDaemon } from "../src/hooks/use-daemon";
import { useOtaUpdate } from "../src/hooks/use-ota-update";
import { useRelay } from "../src/hooks/use-relay";
import { useConnectionStore } from "../src/stores/connection-store";
import { usePairingStore } from "../src/stores/pairing-store";
import { useSettingsStore } from "../src/stores/settings-store";
import { useThemeStore } from "../src/stores/theme-store";

export default function RootLayout() {
  const daemonUrl = useConnectionStore((s) => s.daemonUrl);
  const loaded = useConnectionStore((s) => s.loaded);
  const loadConnection = useConnectionStore((s) => s.load);
  const loadPairings = usePairingStore((s) => s.load);
  const loadSettings = useSettingsStore((s) => s.load);
  const theme = useThemeStore((s) => s.theme);
  const isDark = useThemeStore((s) => s.isDark);
  const setTheme = useThemeStore((s) => s.setTheme);
  const systemScheme = useColorScheme();

  // Load saved settings on mount
  useEffect(() => {
    loadConnection();
    loadPairings();
    loadSettings();
  }, []);

  // Re-resolve theme when system color scheme changes
  useEffect(() => {
    if (theme === "system") {
      setTheme("system");
    }
  }, [systemScheme, theme]);

  // Direct WebSocket to local daemon (always available for local dev)
  useDaemon(loaded ? (daemonUrl ?? undefined) : undefined);

  // E2EE relay connections for all paired daemons (runs in parallel with direct WS)
  useRelay();

  // OTA update check on app launch
  const { status: otaStatus, restart } = useOtaUpdate();

  return (
    <SafeAreaProvider>
      <View className={`flex-1 ${isDark ? "dark" : ""}`}>
        <StatusBar style={isDark ? "light" : "dark"} />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen
            name="session/[sid]"
            options={{ animation: "slide_from_right" }}
          />
          <Stack.Screen
            name="pairing/index"
            options={{ presentation: "modal" }}
          />
          <Stack.Screen
            name="pairing/scan"
            options={{ presentation: "fullScreenModal" }}
          />
        </Stack>
        <UpdateBanner status={otaStatus} onRestart={restart} />
      </View>
    </SafeAreaProvider>
  );
}
