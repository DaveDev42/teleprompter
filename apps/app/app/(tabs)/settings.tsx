import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import Constants from "expo-constants";
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApiKeyModal } from "../../src/components/ApiKeyModal";
import { DiagnosticsPanel } from "../../src/components/DiagnosticsPanel";
import {
  FontPickerModal,
  type FontPickerMode,
  FontSizeModal,
} from "../../src/components/FontPickerModal";
import { useOtaUpdate } from "../../src/hooks/use-ota-update";
import { getPlatformProps } from "../../src/lib/get-platform-props";
import { useSettingsStore } from "../../src/stores/settings-store";
import { type Theme, useThemeStore } from "../../src/stores/theme-store";
import { useVoiceStore } from "../../src/stores/voice-store";

// Mirrors `--tp-text-secondary` in global.css. ActivityIndicator.color
// expects a literal — CSS variables only resolve on web. Keep these in
// sync with the secondary text token across themes.
const INDICATOR_LIGHT = "#71717a";
const INDICATOR_DARK = "#a1a1aa";

function SectionLabel({ children }: { children: string }) {
  return (
    <Text
      accessibilityRole="header"
      className="text-tp-text-tertiary text-[13px] font-medium tracking-wide uppercase px-4 mb-2 mt-6"
    >
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
  children,
}: {
  label: string;
  value?: string;
  onPress?: () => void;
  first?: boolean;
  last?: boolean;
  destructive?: boolean;
  children?: React.ReactNode;
}) {
  const pp = getPlatformProps({ focusable: !!onPress });
  return (
    <Pressable
      onPress={onPress}
      className={`mx-4 ${pp.className}`}
      tabIndex={pp.tabIndex}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={value !== undefined ? `${label}, ${value}` : label}
    >
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
          {children}
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
      {!last && <View className="h-[0.5px] bg-tp-border ml-4" />}
    </Pressable>
  );
}

function UpdateStatusValue({
  status,
}: {
  status: import("../../src/hooks/use-ota-update").OtaStatus;
}) {
  const isDark = useThemeStore((s) => s.isDark);
  const indicatorColor = isDark ? INDICATOR_DARK : INDICATOR_LIGHT;
  if (status === "checking" || status === "downloading") {
    return (
      <View className="flex-row items-center">
        <ActivityIndicator size="small" color={indicatorColor} className="mr-2" />
        <Text className="text-tp-text-secondary text-[13px]">
          {status === "checking" ? "Checking..." : "Downloading..."}
        </Text>
      </View>
    );
  }
  if (status === "up-to-date") {
    return (
      <View className="flex-row items-center">
        <View className="w-2 h-2 rounded-full bg-tp-success mr-1.5" />
        <Text className="text-tp-success text-[13px] font-medium">
          Up to date
        </Text>
      </View>
    );
  }
  if (status === "available" || status === "ready") {
    return (
      <View className="flex-row items-center">
        <View className="w-2 h-2 rounded-full bg-tp-accent mr-1.5" />
        <Text className="text-tp-accent text-[13px] font-medium">
          Update available
        </Text>
      </View>
    );
  }
  if (status === "error") {
    return <Text className="text-tp-error text-[13px]">Check failed</Text>;
  }
  if (status === "unavailable") {
    return <Text className="text-tp-text-tertiary text-[13px]">Dev build</Text>;
  }
  return null;
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const tabBarHeight = useBottomTabBarHeight();
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const chatFont = useSettingsStore((s) => s.chatFont);
  const codeFont = useSettingsStore((s) => s.codeFont);
  const terminalFont = useSettingsStore((s) => s.terminalFont);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const setChatFont = useSettingsStore((s) => s.setChatFont);
  const setCodeFont = useSettingsStore((s) => s.setCodeFont);
  const setTerminalFont = useSettingsStore((s) => s.setTerminalFont);
  const setFontSize = useSettingsStore((s) => s.setFontSize);
  const apiKey = useVoiceStore((s) => s.apiKey);
  const setApiKey = useVoiceStore((s) => s.setApiKey);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [fontPickerMode, setFontPickerMode] = useState<FontPickerMode | null>(
    null,
  );
  const [showFontSize, setShowFontSize] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const { status: otaStatus, restart, checkAndFetch } = useOtaUpdate();

  const pp = getPlatformProps();

  if (showDiagnostics) {
    return (
      <View className="flex-1 bg-tp-bg" style={{ paddingTop: insets.top }}>
        <View className="flex-row items-center justify-between px-4 py-3">
          <Text className="text-tp-text-primary text-xl font-bold">
            Diagnostics
          </Text>
          <Pressable
            onPress={() => setShowDiagnostics(false)}
            tabIndex={pp.tabIndex}
            className={pp.className}
            accessibilityRole="button"
            accessibilityLabel="Done"
          >
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
      contentContainerStyle={{
        paddingTop: insets.top,
        paddingBottom: tabBarHeight + 24,
        alignItems: "center",
      }}
    >
      <View className="w-full max-w-2xl">
        {/* Header */}
        <View className="px-4 pt-2 pb-1">
          <Text
            accessibilityRole="header"
            className="text-tp-text-primary text-[28px] font-bold"
          >
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
              theme === "dark"
                ? "light"
                : theme === "light"
                  ? "system"
                  : "dark";
            setTheme(next);
          }}
        />
        <SettingsRow
          label="Chat Font"
          value={chatFont}
          onPress={() => setFontPickerMode("chat")}
        />
        <SettingsRow
          label="Code Font"
          value={codeFont}
          onPress={() => setFontPickerMode("code")}
        />
        <SettingsRow
          label="Terminal Font"
          value={terminalFont}
          onPress={() => setFontPickerMode("terminal")}
        />
        <SettingsRow
          label="Font Size"
          value={`${fontSize}px`}
          last
          onPress={() => setShowFontSize(true)}
        />

        {/* Voice */}
        <SectionLabel>Voice</SectionLabel>
        <SettingsRow
          label="OpenAI API Key"
          value={apiKey ? "sk-...configured" : "Not set"}
          first
          last
          onPress={() => setShowApiKey(true)}
        />

        {/* About */}
        <SectionLabel>About</SectionLabel>
        <SettingsRow
          label="Version"
          value={Constants.expoConfig?.version ?? "dev"}
          first
        />
        <SettingsRow
          label="Updates"
          first={false}
          last
          onPress={
            otaStatus === "ready"
              ? restart
              : otaStatus === "up-to-date" || otaStatus === "error"
                ? checkAndFetch
                : undefined
          }
          value={undefined}
        >
          <UpdateStatusValue status={otaStatus} />
        </SettingsRow>

        {otaStatus === "ready" && (
          <View className="mx-4 mt-3">
            <View className="bg-tp-surface rounded-card p-4">
              <Text className="text-tp-text-primary text-[15px] font-semibold">
                New version available
              </Text>
              <Text className="text-tp-text-secondary text-[13px] mt-1">
                A new update is ready to install.{"\n"}Restart the app to apply
                changes.
              </Text>
              <Pressable
                onPress={restart}
                className={`bg-tp-accent rounded-btn items-center py-2.5 mt-3 ${pp.className}`}
                tabIndex={pp.tabIndex}
                accessibilityRole="button"
                accessibilityLabel="Restart to update"
              >
                <Text className="text-tp-text-on-color text-[14px] font-semibold">
                  Restart to Update
                </Text>
              </Pressable>
            </View>
          </View>
        )}

        <View className={otaStatus === "ready" ? "" : "mt-3"}>
          <SettingsRow
            label="Diagnostics"
            first
            last
            onPress={() => setShowDiagnostics(true)}
          />
        </View>
        <FontPickerModal
          visible={fontPickerMode !== null}
          mode={fontPickerMode ?? "chat"}
          currentFont={
            fontPickerMode === "chat"
              ? chatFont
              : fontPickerMode === "code"
                ? codeFont
                : terminalFont
          }
          onSelect={(font) => {
            if (fontPickerMode === "chat") setChatFont(font);
            else if (fontPickerMode === "code") setCodeFont(font);
            else setTerminalFont(font);
          }}
          onClose={() => setFontPickerMode(null)}
        />
        <FontSizeModal
          visible={showFontSize}
          currentSize={fontSize}
          onChangeSize={setFontSize}
          onClose={() => setShowFontSize(false)}
        />
        <ApiKeyModal
          visible={showApiKey}
          currentKey={apiKey}
          onSave={setApiKey}
          onClose={() => setShowApiKey(false)}
        />
      </View>
    </ScrollView>
  );
}
