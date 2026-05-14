import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { getPlatformProps } from "../lib/get-platform-props";
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

  return (
    <ModalContainer
      visible={visible}
      onClose={onCancel}
      accessibilityLabel="Rename Daemon"
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
          >
            Rename Daemon
          </Text>
          <Pressable
            className={`${pp.className} ${isUnchanged ? "opacity-40" : ""}`}
            tabIndex={pp.tabIndex}
            onPress={handleSave}
            disabled={isUnchanged}
            accessibilityRole="button"
            accessibilityLabel="Save pairing label"
            accessibilityState={{ disabled: isUnchanged }}
          >
            <Text className="text-tp-accent text-base font-semibold">Save</Text>
          </Pressable>
        </View>
        <TextInput
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
        <Text className="text-tp-text-tertiary text-xs mt-2">
          Empty value clears the label and falls back to the daemon ID.
        </Text>
      </View>
    </ModalContainer>
  );
}
