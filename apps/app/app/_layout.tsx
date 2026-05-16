import "../global.css";
import { Stack, usePathname, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { Platform, useColorScheme, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { InAppToast } from "../src/components/InAppToast";
import { UpdateBanner } from "../src/components/UpdateBanner";
import { useOtaUpdate } from "../src/hooks/use-ota-update";
import { usePairingDeepLink } from "../src/hooks/use-pairing-deep-link";
import { usePushNotifications } from "../src/hooks/use-push-notifications";
import { useRelay } from "../src/hooks/use-relay";
import { usePairingStore } from "../src/stores/pairing-store";
import { useSessionStore } from "../src/stores/session-store";
import { useSettingsStore } from "../src/stores/settings-store";
import { useThemeStore } from "../src/stores/theme-store";
import { useVoiceStore } from "../src/stores/voice-store";

export default function RootLayout() {
  const router = useRouter();
  const loadPairings = usePairingStore((s) => s.load);
  const loadSessions = useSessionStore((s) => s.load);
  const loadSettings = useSettingsStore((s) => s.load);
  const loadTheme = useThemeStore((s) => s.load);
  const loadVoice = useVoiceStore((s) => s.load);
  const theme = useThemeStore((s) => s.theme);
  const isDark = useThemeStore((s) => s.isDark);
  const themeLoaded = useThemeStore((s) => s.loaded);
  const setTheme = useThemeStore((s) => s.setTheme);
  const _systemScheme = useColorScheme();

  // Route incoming `tp://p?d=…` deep links to the pairing screen
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
    loadSessions();
    loadSettings();
    loadTheme();
    loadVoice();
  }, [loadVoice, loadPairings, loadSessions, loadTheme, loadSettings]);

  // Re-resolve theme when system color scheme changes. _systemScheme must be
  // in the dep array — useColorScheme()'s return value is what flips on OS
  // appearance changes, so without it the effect never re-fires after mount.
  // The `themeLoaded` gate avoids racing the async load(): on mount the store
  // defaults to "system", and without the gate this effect would write
  // "system" to storage before load() had a chance to read the user's saved
  // preference, clobbering it on the next reload.
  // biome-ignore lint/correctness/useExhaustiveDependencies: _systemScheme is intentionally a dep — see comment above
  useEffect(() => {
    if (!themeLoaded) return;
    if (theme === "system") {
      setTheme("system");
    }
  }, [theme, themeLoaded, setTheme, _systemScheme]);

  // Sync dark/light class to <html> element on web so :root CSS variables
  // defined in global.css (.dark { --tp-* }) are reachable by the browser's
  // selector engine. The View-based toggle still applies for native.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const root = document.documentElement;
    if (isDark) {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }, [isDark]);

  // WCAG 2.4.2 Page Titled (Level A): `document.title` must describe the
  // current page. Expo Router's `Tabs.Screen` / `Stack.Screen` `title`
  // option only feeds the (hidden) native header — it does NOT propagate
  // to `document.title` on web. Without this, every route stays
  // "Teleprompter" and SR users who switch browser tabs can't tell which
  // page they're on. Drive the title from the active pathname here in the
  // root layout so the rule applies to every route (tabs, session,
  // pairing) from one place.
  const pathname = usePathname();
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const titles: Record<string, string> = {
      "/": "Sessions — Teleprompter",
      "/daemons": "Daemons — Teleprompter",
      "/settings": "Settings — Teleprompter",
      "/pairing": "Pairing — Teleprompter",
      "/pairing/scan": "Scan QR — Teleprompter",
    };
    const exact = titles[pathname];
    if (exact) {
      document.title = exact;
    } else if (pathname.startsWith("/session/")) {
      document.title = "Session — Teleprompter";
    } else {
      document.title = "Teleprompter";
    }
  }, [pathname]);

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
