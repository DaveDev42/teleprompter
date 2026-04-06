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
import { secureDelete } from "../src/lib/secure-storage";
import { usePairingStore } from "../src/stores/pairing-store";
import { useSettingsStore } from "../src/stores/settings-store";
import { useThemeStore } from "../src/stores/theme-store";
import { useVoiceStore } from "../src/stores/voice-store";

export default function RootLayout() {
  const loadPairings = usePairingStore((s) => s.load);
  const loadSettings = useSettingsStore((s) => s.load);
  const loadTheme = useThemeStore((s) => s.load);
  const loadVoice = useVoiceStore((s) => s.load);
  const theme = useThemeStore((s) => s.theme);
  const isDark = useThemeStore((s) => s.isDark);
  const setTheme = useThemeStore((s) => s.setTheme);
  const systemScheme = useColorScheme();

  // Load saved settings on mount
  useEffect(() => {
    loadPairings();
    loadSettings();
    loadTheme();
    loadVoice();
    // One-time cleanup: remove stale daemon_url from removed connection-store
    secureDelete("daemon_url");
  }, []);

  // Re-resolve theme when system color scheme changes
  useEffect(() => {
    if (theme === "system") {
      setTheme("system");
    }
  }, [systemScheme, theme]);

  // Direct WebSocket to local daemon (always available for local dev)
  useDaemon();

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
