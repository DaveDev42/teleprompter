import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import Constants from "expo-constants";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
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
import { useKeyboard } from "../../src/hooks/use-keyboard";
import { useOtaUpdate } from "../../src/hooks/use-ota-update";
import { ariaLevel, getPlatformProps } from "../../src/lib/get-platform-props";
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
      {...ariaLevel(3)}
      className="text-tp-text-tertiary text-[13px] font-medium tracking-wide uppercase px-4 mb-2 mt-6"
    >
      {children}
    </Text>
  );
}

function SettingsRow({
  label,
  value,
  valueLabel,
  onPress,
  first,
  last,
  destructive,
  children,
}: {
  label: string;
  value?: string;
  // Spoken status when the visible value lives inside `children` (e.g.
  // the OTA "Updates" row uses a status pill component, not plain text).
  // aria-label hides nested text from assistive tech, so the spoken
  // label has to be composed at the row.
  valueLabel?: string;
  onPress?: () => void;
  first?: boolean;
  last?: boolean;
  destructive?: boolean;
  children?: React.ReactNode;
}) {
  const pp = getPlatformProps({ focusable: !!onPress });
  const spokenValue = value ?? valueLabel;
  return (
    <Pressable
      onPress={onPress}
      className={`mx-4 ${pp.className}`}
      tabIndex={pp.tabIndex}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={
        spokenValue !== undefined ? `${label}, ${spokenValue}` : label
      }
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

// Human-readable status text for screen readers — mirrors the visual
// state shown by UpdateStatusValue. `SettingsRow` uses `aria-label` to
// announce the row, and aria-label hides child text from assistive tech,
// so we have to compose the spoken label ourselves.
function updateStatusLabel(
  status: import("../../src/hooks/use-ota-update").OtaStatus,
): string {
  switch (status) {
    case "checking":
      return "Checking…";
    case "downloading":
      return "Downloading…";
    case "up-to-date":
      return "Up to date";
    case "available":
    case "ready":
      return "Update available";
    case "error":
      return "Check failed";
    case "unavailable":
      return "Dev build";
    default:
      return "";
  }
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
        <ActivityIndicator
          size="small"
          color={indicatorColor}
          className="mr-2"
        />
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
  // Restore focus to the Diagnostics row when the user closes the panel.
  // Without this, focus drops to <body> and keyboard users lose their place.
  // The trigger is a SettingsRow which we look up by aria-label rather than
  // threading a ref through the shared row component.
  const wasShowingRef = useRef(false);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!wasShowingRef.current && showDiagnostics) {
      // Move focus into the panel on open so keyboard users land inside it
      // instead of being dumped onto the tab bar (the Settings row that
      // triggered the swap unmounts during the state transition).
      const t = setTimeout(() => {
        const done = document.querySelector<HTMLElement>('[aria-label="Done"]');
        done?.focus();
      }, 50);
      wasShowingRef.current = showDiagnostics;
      return () => clearTimeout(t);
    }
    if (wasShowingRef.current && !showDiagnostics) {
      const el = document.querySelector<HTMLElement>(
        '[aria-label="Diagnostics"]',
      );
      el?.focus();
    }
    wasShowingRef.current = showDiagnostics;
  }, [showDiagnostics]);
  const diagnosticsKeyMap = useMemo<Record<string, () => void>>(
    () =>
      showDiagnostics
        ? { Escape: () => setShowDiagnostics(false) }
        : ({} as Record<string, () => void>),
    [showDiagnostics],
  );
  useKeyboard(diagnosticsKeyMap);
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
            {...ariaLevel(1)}
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
          valueLabel={updateStatusLabel(otaStatus)}
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
