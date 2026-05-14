import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { getPlatformProps } from "../lib/get-platform-props";
import { useThemeStore } from "../stores/theme-store";
import { ModalContainer } from "./ModalContainer";

// React Native's TextInput placeholderTextColor needs a plain color literal —
// passing a CSS variable string falls back to the platform default on
// iOS/Android. Mirror the values from app/session/[sid].tsx so the chat
// composer and this modal stay in sync if the palette is retuned.
const PLACEHOLDER_LIGHT = "#a1a1aa";
const PLACEHOLDER_DARK = "#71717a";

export function ApiKeyModal({
  visible,
  currentKey,
  onSave,
  onClose,
}: {
  visible: boolean;
  currentKey: string | null;
  onSave: (key: string) => void;
  onClose: () => void;
}) {
  const pp = getPlatformProps();
  const isDark = useThemeStore((s) => s.isDark);
  const placeholderColor = isDark ? PLACEHOLDER_DARK : PLACEHOLDER_LIGHT;
  const [value, setValue] = useState(currentKey ?? "");

  useEffect(() => {
    setValue(currentKey ?? "");
  }, [currentKey]);

  return (
    <ModalContainer
      visible={visible}
      onClose={onClose}
      accessibilityLabel="OpenAI API Key"
    >
      <View className="flex-row items-center justify-between px-5 pt-5 pb-3">
        <Text
          className="text-tp-text-primary text-lg font-bold"
          accessibilityRole="header"
        >
          OpenAI API Key
        </Text>
        <Pressable
          className={pp.className}
          tabIndex={pp.tabIndex}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Done"
        >
          <Text className="text-tp-accent text-base">Done</Text>
        </Pressable>
      </View>
      <View className="px-5 pb-8">
        <Text className="text-tp-text-secondary text-[13px] mb-3">
          Required for voice input. Your key is stored locally on this device.
        </Text>
        <TextInput
          className={`bg-tp-bg-input text-tp-text-primary text-[15px] rounded-btn px-4 py-3 border border-tp-border ${pp.className}`}
          tabIndex={pp.tabIndex}
          value={value}
          onChangeText={setValue}
          placeholder="sk-..."
          placeholderTextColor={placeholderColor}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          accessibilityLabel="OpenAI API key"
          accessibilityHint="Enter your OpenAI API key for voice input"
        />
        <Pressable
          className={`bg-tp-accent rounded-btn items-center py-3 mt-4 ${pp.className}`}
          tabIndex={pp.tabIndex}
          onPress={() => {
            if (value.trim()) {
              onSave(value.trim());
            }
            onClose();
          }}
          accessibilityRole="button"
          accessibilityLabel="Save API key"
        >
          <Text className="text-tp-text-on-color text-[15px] font-semibold">
            Save
          </Text>
        </Pressable>
        {currentKey && (
          <Pressable
            className={`items-center py-3 mt-2 ${pp.className}`}
            tabIndex={pp.tabIndex}
            onPress={() => {
              onSave("");
              setValue("");
              onClose();
            }}
            accessibilityRole="button"
            accessibilityLabel="Remove API key"
          >
            <Text className="text-tp-error text-[14px]">Remove Key</Text>
          </Pressable>
        )}
      </View>
    </ModalContainer>
  );
}
