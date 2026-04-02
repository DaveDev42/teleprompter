import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DiagnosticsPanel } from "../../src/components/DiagnosticsPanel";
import { secureGet, secureSet } from "../../src/lib/secure-storage";
import { useConnectionStore } from "../../src/stores/connection-store";
import { usePairingStore } from "../../src/stores/pairing-store";
import { useSettingsStore } from "../../src/stores/settings-store";
import { type Theme, useThemeStore } from "../../src/stores/theme-store";
import { useVoiceStore } from "../../src/stores/voice-store";

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-tp-text-tertiary text-[13px] font-medium tracking-wide uppercase px-4 mb-2 mt-6">
      {children}
    </Text>
  );
}

function SettingsRow({
  label,
  value,
  onPress,
  first,
  last,
  destructive,
}: {
  label: string;
  value?: string;
  onPress?: () => void;
  first?: boolean;
  last?: boolean;
  destructive?: boolean;
}) {
  return (
    <Pressable onPress={onPress} className="mx-4">
      <View
        className={`flex-row items-center justify-between px-4 py-3.5 bg-tp-surface ${
          first ? "rounded-t-card" : ""
        } ${last ? "rounded-b-card" : ""}`}
      >
        <Text
          className={`text-[15px] ${
            destructive ? "text-tp-error" : "text-tp-text-primary"
          }`}
        >
          {label}
        </Text>
        <View className="flex-row items-center">
          {value !== undefined && (
            <Text className="text-tp-text-secondary text-[15px] mr-1">
              {value}
            </Text>
          )}
          {onPress && (
            <Text className="text-tp-text-tertiary text-[15px]">›</Text>
          )}
        </View>
      </View>
      {!last && <View className="h-[0.5px] bg-tp-border ml-4 bg-tp-surface" />}
      {!last && <View className="h-[0.5px] bg-tp-border ml-4" />}
    </Pressable>
  );
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const chatFont = useSettingsStore((s) => s.chatFont);
  const codeFont = useSettingsStore((s) => s.codeFont);
  const terminalFont = useSettingsStore((s) => s.terminalFont);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const apiKey = useVoiceStore((s) => s.apiKey);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  if (showDiagnostics) {
    return (
      <View className="flex-1 bg-tp-bg" style={{ paddingTop: insets.top }}>
        <View className="flex-row items-center justify-between px-4 py-3">
          <Text className="text-tp-text-primary text-xl font-bold">
            Diagnostics
          </Text>
          <Pressable onPress={() => setShowDiagnostics(false)}>
            <Text className="text-tp-accent text-base">Done</Text>
          </Pressable>
        </View>
        <DiagnosticsPanel />
      </View>
    );
  }

  const themeLabel =
    theme === "dark" ? "Dark" : theme === "light" ? "Light" : "System";

  return (
    <ScrollView
      className="flex-1 bg-tp-bg"
      contentContainerStyle={{ paddingTop: insets.top, paddingBottom: 40 }}
    >
      {/* Header */}
      <View className="px-4 pt-2 pb-1">
        <Text className="text-tp-text-primary text-[28px] font-bold">
          Settings
        </Text>
      </View>

      {/* Appearance */}
      <SectionLabel>Appearance</SectionLabel>
      <SettingsRow
        label="Theme"
        value={themeLabel}
        first
        onPress={() => {
          // Cycle through themes
          const next: Theme =
            theme === "dark" ? "light" : theme === "light" ? "system" : "dark";
          setTheme(next);
        }}
      />
      <SettingsRow label="Chat Font" value={chatFont} onPress={() => {}} />
      <SettingsRow label="Code Font" value={codeFont} onPress={() => {}} />
      <SettingsRow
        label="Terminal Font"
        value={terminalFont}
        onPress={() => {}}
      />
      <SettingsRow
        label="Font Size"
        value={`${fontSize}px`}
        last
        onPress={() => {}}
      />

      {/* Voice */}
      <SectionLabel>Voice</SectionLabel>
      <SettingsRow
        label="OpenAI API Key"
        value={apiKey ? "sk-...configured" : "Not set"}
        first
        last
        onPress={() => {}}
      />

      {/* About */}
      <SectionLabel>About</SectionLabel>
      <SettingsRow
        label="Diagnostics"
        first
        onPress={() => setShowDiagnostics(true)}
      />
      <SettingsRow label="Version" value="0.1.1" last />
    </ScrollView>
  );
}
