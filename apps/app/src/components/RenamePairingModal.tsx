import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { ariaLevel, getPlatformProps } from "../lib/get-platform-props";
import { useThemeStore } from "../stores/theme-store";
import { ModalContainer } from "./ModalContainer";

// Mirrors `--tp-text-tertiary` in apps/app/global.css. TextInput's
// placeholderTextColor takes a literal — CSS variable strings work on
// web but native silently falls back to the system default, leaving
// placeholders unreadable. Keep these in sync with the CSS tokens.
const PLACEHOLDER_LIGHT = "#a1a1aa";
const PLACEHOLDER_DARK = "#71717a";

export function RenamePairingModal({
  visible,
  initialValue,
  daemonId,
  onCancel,
  onSave,
}: {
  visible: boolean;
  initialValue: string;
  daemonId?: string;
  onCancel: () => void;
  onSave: (value: string) => void | Promise<void>;
}) {
  const pp = getPlatformProps();
  const isDark = useThemeStore((s) => s.isDark);
  const placeholderColor = isDark ? PLACEHOLDER_DARK : PLACEHOLDER_LIGHT;
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (visible) setValue(initialValue);
  }, [visible, initialValue]);

  const isUnchanged = value === initialValue;

  const handleSave = () => {
    if (isUnchanged) return;
    void onSave(value);
  };

  // Mirror disabled state to aria-disabled on web. RN Web's Pressable
  // `disabled` prop strips the button from the Tab order, hiding it from
  // keyboard users who would otherwise discover it and learn that
  // editing the label re-enables Save. Match ApiKeyModal's pattern:
  // keep the button focusable and announce inert state via aria-disabled.
  const saveRef = useRef<View>(null);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!visible) return;
    const el = saveRef.current as unknown as HTMLElement | null;
    if (!el) return;
    if (isUnchanged) el.setAttribute("aria-disabled", "true");
    else el.removeAttribute("aria-disabled");
  }, [visible, isUnchanged]);

  // RN Web's createDOMProps doesn't whitelist `aria-description` and
  // doesn't map `accessibilityHint` to any ARIA attribute. Mirror the
  // visible helper text ("Empty value clears the label …") onto the
  // input via setAttribute when the modal opens so screen-reader users
  // get the same context sighted users do — otherwise the input
  // announces only its accessibleLabel and the user can save an empty
  // value without ever hearing what happens. Matches ApiKeyModal.
  const inputRef = useRef<TextInput>(null);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!visible) return;
    const el = inputRef.current as unknown as HTMLElement | null;
    if (!el) return;
    el.setAttribute(
      "aria-description",
      "Empty value clears the label and falls back to the daemon ID",
    );
  }, [visible]);

  // APG Dialog Pattern §3.2.2 + WCAG 4.1.2: wire the dialog's
  // aria-describedby to the helper text so screen readers announce
  // "Empty value clears the label …" as soon as the dialog opens —
  // not only when the user Tabs onto the input. Mirrors the fix on
  // ConfirmUnpairModal (see app-confirm-unpair-describedby.spec.ts).
  const DESCRIPTION_ID = "rename-pairing-description";

  return (
    <ModalContainer
      visible={visible}
      onClose={onCancel}
      accessibilityLabel="Rename Daemon"
      accessibilityDescribedBy={DESCRIPTION_ID}
    >
      <View className="px-5 pt-5 pb-6">
        <View className="flex-row items-center justify-between pb-3">
          <Pressable
            className={pp.className}
            tabIndex={pp.tabIndex}
            onPress={onCancel}
            accessibilityRole="button"
            accessibilityLabel="Cancel rename"
          >
            <Text className="text-tp-text-secondary text-base">Cancel</Text>
          </Pressable>
          <Text
            className="text-tp-text-primary text-lg font-bold"
            accessibilityRole="header"
            {...ariaLevel(2)}
          >
            Rename Daemon
          </Text>
          <Pressable
            ref={saveRef}
            className={`${pp.className} ${isUnchanged ? "opacity-40" : ""}`}
            tabIndex={pp.tabIndex}
            onPress={handleSave}
            accessibilityRole="button"
            accessibilityLabel="Save pairing label"
            accessibilityState={{ disabled: isUnchanged }}
          >
            <Text className="text-tp-accent text-base font-semibold">Save</Text>
          </Pressable>
        </View>
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={setValue}
          placeholder="Label (leave empty to clear)"
          placeholderTextColor={placeholderColor}
          autoFocus
          autoCorrect={false}
          maxLength={64}
          returnKeyType="done"
          onSubmitEditing={handleSave}
          className="bg-tp-bg-input text-tp-text-primary rounded-btn px-3 py-3 text-[15px]"
          accessibilityLabel={
            daemonId ? `Pairing label for ${daemonId}` : "Pairing label"
          }
        />
        <Text
          nativeID={DESCRIPTION_ID}
          className="text-tp-text-tertiary text-xs mt-2"
        >
          Empty value clears the label and falls back to the daemon ID.
        </Text>
      </View>
    </ModalContainer>
  );
}
