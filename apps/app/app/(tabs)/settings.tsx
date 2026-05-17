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
  // The Settings screen heading is level 1. These section labels sit directly
  // under it (Appearance / Voice / About), so they should be level 2 —
  // jumping straight to level 3 breaks "headings only" navigation in
  // screen readers.
  return (
    <Text
      accessibilityRole="header"
      {...ariaLevel(2)}
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
  hasPopup,
  expanded,
  controlsId,
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
  // APG §6.6: a control that opens a dialog should advertise that via
  // `aria-haspopup="dialog"` so the screen reader announces
  // "<label>, button, has popup dialog" — without it the user pressing
  // Enter/Space gets the dialog open with no prior cue. Pass `true`
  // when the row opens a true ARIA dialog (FontPickerModal,
  // FontSizeModal, ApiKeyModal, etc).
  hasPopup?: boolean;
  // APG Disclosure pattern: a control that toggles a sibling region
  // (not a dialog) must expose `aria-expanded` so AT users can tell
  // whether the panel is currently open. `hasPopup` rows open modal
  // dialogs where `aria-haspopup="dialog"` is the right signal; this
  // is for the Diagnostics row, which swaps the Settings subtree for
  // an inline panel. `undefined` (default) omits the attribute so
  // dialog/info rows aren't mislabelled.
  expanded?: boolean;
  // APG Disclosure pattern §3.9: pair `aria-expanded` with
  // `aria-controls` pointing at the `id` of the controlled region so
  // AT users can programmatically jump from the trigger to the panel
  // it discloses. Only meaningful when `expanded` is also set —
  // disclosure pattern only.
  controlsId?: string;
  first?: boolean;
  last?: boolean;
  destructive?: boolean;
  children?: React.ReactNode;
}) {
  const pp = getPlatformProps({ focusable: !!onPress });
  const spokenValue = value ?? valueLabel;
  // Info-only rows (no onPress) render as a Pressable without an
  // accessibilityRole, which RN Web emits as a bare <div>. aria-label
  // on a generic div is ignored by ARIA, so VoiceOver/NVDA either
  // concatenate the raw child text ("Version0.1.19") or read them as
  // unrelated nodes. Fall back to role="group" on web so the row has
  // an ARIA-valid container and the composed aria-label is honored.
  // Native AT picks up `accessibilityLabel` from a Pressable without
  // role, so no native change is needed.
  const webRoleProps =
    Platform.OS === "web" && !onPress ? { role: "group" as const } : {};
  // RN Web's accessibility prop bridge doesn't translate any
  // `accessibilityHasPopup` equivalent, so spread the raw ARIA
  // attribute on web. Native screen readers don't have a true
  // `has-popup-dialog` announcement so this is a web-only signal.
  const webHasPopupProps =
    Platform.OS === "web" && hasPopup && onPress
      ? { "aria-haspopup": "dialog" as const }
      : {};
  // WCAG 4.1.2 Name, Role, Value: when the row toggles an inline
  // disclosure region, mirror its open/closed state as `aria-expanded`
  // so screen readers announce "expanded" / "collapsed" alongside the
  // button. RN Web doesn't bridge any `accessibilityExpanded`
  // equivalent, so emit the raw ARIA attribute on web.
  const webExpandedProps =
    Platform.OS === "web" && onPress && expanded !== undefined
      ? { "aria-expanded": expanded }
      : {};
  const webControlsProps =
    Platform.OS === "web" && onPress && controlsId
      ? { "aria-controls": controlsId }
      : {};
  return (
    <Pressable
      onPress={onPress}
      className={`mx-4 ${pp.className}`}
      tabIndex={pp.tabIndex}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={
        spokenValue !== undefined ? `${label}, ${spokenValue}` : label
      }
      {...webRoleProps}
      {...webHasPopupProps}
      {...webExpandedProps}
      {...webControlsProps}
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
            // The parent Pressable carries accessibilityLabel which on
            // web becomes aria-label. Per ARIA, aria-label replaces the
            // accessible name computation — but `role=button` is not
            // atomic for virtual-cursor traversal in NVDA/JAWS browse
            // mode, so a virtual cursor can still descend into this
            // Text and announce "›" as "right-pointing angle quotation
            // mark". The chevron is a sighted-user affordance for "row
            // is tappable" — exposing it to AT pollutes every Settings
            // row readout. Hide on web. Native AT focuses the parent
            // Pressable and reads its accessibilityLabel without
            // descending. WCAG 1.1.1.
            <Text
              className="text-tp-text-tertiary text-[15px]"
              {...(Platform.OS === "web"
                ? ({ "aria-hidden": true } as object)
                : {})}
            >
              ›
            </Text>
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
    const spinnerLabel =
      status === "checking" ? "Checking for updates" : "Downloading update";
    return (
      <View className="flex-row items-center">
        {/* ActivityIndicator renders as <div role="progressbar"> on
            web (react-native-web) but does NOT propagate any
            accessible name. ARIA 1.2 §6.3.20 requires role=progressbar
            to have an accessible name, otherwise NVDA / JAWS /
            VoiceOver announce "progress bar" with no context.
            accessibilityLabel doesn't reach the inner progressbar div
            on web, so pass aria-label imperatively. Native AT reads
            accessibilityLabel from the underlying View.
            WCAG 4.1.2 (Name, Role, Value). */}
        <ActivityIndicator
          size="small"
          color={indicatorColor}
          className="mr-2"
          accessibilityLabel={spinnerLabel}
          {...(Platform.OS === "web"
            ? ({ "aria-label": spinnerLabel } as object)
            : {})}
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
        <View
          className="w-2 h-2 rounded-full bg-tp-success mr-1.5"
          {...(Platform.OS === "web"
            ? ({ "aria-hidden": true } as object)
            : {})}
        />
        <Text className="text-tp-success text-[13px] font-medium">
          Up to date
        </Text>
      </View>
    );
  }
  if (status === "available" || status === "ready") {
    return (
      <View className="flex-row items-center">
        <View
          className="w-2 h-2 rounded-full bg-tp-accent mr-1.5"
          {...(Platform.OS === "web"
            ? ({ "aria-hidden": true } as object)
            : {})}
        />
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
  // Toggling Theme cycles its label (System → Dark → Light → ...) but
  // focus stays on the row button, so screen readers don't re-announce
  // anything — the user pressed Enter and heard silence. Mirror the
  // freshly-cycled theme into a small polite live region so AT speaks
  // it. Stored as state (rather than derived from `theme`) so we can
  // skip the initial mount announcement.
  const [themeAnnouncement, setThemeAnnouncement] = useState("");
  // RN Web 0.21 silently drops the prop-level `aria-atomic` when
  // spread on a <View>, and even with `role="status"` (which implies
  // atomic=true per ARIA 1.2) NVDA/JAWS only announce the diff between
  // updates — so cycling "System" → "Dark" speaks only "Dark", losing
  // the "Theme:" prefix. Set the attribute imperatively, matching
  // InAppToast / ConnectionLiveRegion. WCAG 4.1.3.
  const themeAnnouncementRef = useRef<View>(null);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const el = themeAnnouncementRef.current as unknown as HTMLElement | null;
    el?.setAttribute("aria-atomic", "true");
  }, []);
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
      <View
        className="flex-1 bg-tp-bg"
        style={{ paddingTop: insets.top }}
        // The Settings tab's normal branch sets `role="main"` (WCAG 2.4.1
        // Bypass Blocks). The Diagnostics subview replaces the entire
        // subtree via early return, so without re-applying `role="main"`
        // here the landmark vanishes when the panel mounts — AT users
        // lose their landmark-navigation jump target mid-flow.
        // The `id` matches the `aria-controls` value on the Diagnostics
        // disclosure trigger above (APG Disclosure Pattern §3.9). RN
        // Web doesn't surface a typed `nativeID` for View, so spread
        // the raw `id` on web.
        {...(Platform.OS === "web"
          ? { role: "main" as const, id: "settings-diagnostics-panel" }
          : {})}
      >
        <View className="flex-row items-center justify-between px-4 py-3">
          <Text
            className="text-tp-text-primary text-xl font-bold"
            accessibilityRole="header"
            {...ariaLevel(1)}
          >
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
      // See `apps/app/app/(tabs)/index.tsx` for the rationale — WCAG 2.4.1
      // landmark for AT skip navigation. Web-only because RN's
      // `AccessibilityRole` union excludes "main".
      {...(Platform.OS === "web" ? { role: "main" as const } : {})}
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
            const nextLabel =
              next === "dark" ? "Dark" : next === "light" ? "Light" : "System";
            setThemeAnnouncement(`Theme: ${nextLabel}`);
          }}
        />
        {/* SR-only polite live region for theme cycling. Visually
            collapsed; AT picks up changes because aria-live=polite. */}
        <View
          ref={themeAnnouncementRef}
          testID="theme-announcement"
          accessibilityLiveRegion="polite"
          {...(Platform.OS === "web"
            ? {
                role: "status" as const,
                "aria-live": "polite" as const,
              }
            : {})}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            overflow: "hidden",
          }}
          pointerEvents="none"
        >
          <Text className="text-tp-text-primary">{themeAnnouncement}</Text>
        </View>
        <SettingsRow
          label="Chat Font"
          value={chatFont}
          onPress={() => setFontPickerMode("chat")}
          hasPopup
        />
        <SettingsRow
          label="Code Font"
          value={codeFont}
          onPress={() => setFontPickerMode("code")}
          hasPopup
        />
        <SettingsRow
          label="Terminal Font"
          value={terminalFont}
          onPress={() => setFontPickerMode("terminal")}
          hasPopup
        />
        <SettingsRow
          label="Font Size"
          value={`${fontSize}px`}
          last
          onPress={() => setShowFontSize(true)}
          hasPopup
        />

        {/* Voice */}
        <SectionLabel>Voice</SectionLabel>
        <SettingsRow
          label="OpenAI API Key"
          value={apiKey ? "sk-...configured" : "Not set"}
          first
          last
          onPress={() => setShowApiKey(true)}
          hasPopup
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
            expanded={showDiagnostics}
            controlsId="settings-diagnostics-panel"
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
