import "../global.css";
import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { useColorScheme, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { InAppToast } from "../src/components/InAppToast";
import { UpdateBanner } from "../src/components/UpdateBanner";
import { useOtaUpdate } from "../src/hooks/use-ota-update";
import { usePairingDeepLink } from "../src/hooks/use-pairing-deep-link";
import { usePushNotifications } from "../src/hooks/use-push-notifications";
import { useRelay } from "../src/hooks/use-relay";
import { usePairingStore } from "../src/stores/pairing-store";
import { useSettingsStore } from "../src/stores/settings-store";
import { useThemeStore } from "../src/stores/theme-store";
import { useVoiceStore } from "../src/stores/voice-store";

export default function RootLayout() {
  const router = useRouter();
  const loadPairings = usePairingStore((s) => s.load);
  const loadSettings = useSettingsStore((s) => s.load);
  const loadTheme = useThemeStore((s) => s.load);
  const loadVoice = useVoiceStore((s) => s.load);
  const theme = useThemeStore((s) => s.theme);
  const isDark = useThemeStore((s) => s.isDark);
  const setTheme = useThemeStore((s) => s.setTheme);
  const _systemScheme = useColorScheme();

  // Route incoming `teleprompter://pair?d=…` deep links to the pairing screen
  // so the user explicitly confirms before keys are persisted.
  usePairingDeepLink((pairingData) => {
    router.push({
      pathname: "/pairing",
      params: { pairingData },
    });
  });

  // Load saved settings on mount
  useEffect(() => {
    loadPairings();
    loadSettings();
    loadTheme();
    loadVoice();
  }, [loadVoice, loadPairings, loadTheme, loadSettings]);

  // Re-resolve theme when system color scheme changes
  useEffect(() => {
    if (theme === "system") {
      setTheme("system");
    }
  }, [theme, setTheme]);

  // E2EE relay connections for all paired daemons
  useRelay();

  // Push notification registration and handling
  usePushNotifications();

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
        <InAppToast />
      </View>
    </SafeAreaProvider>
  );
}
