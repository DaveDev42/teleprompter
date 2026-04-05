import { useEffect, useState } from "react";
import { Modal, Pressable, Text, TextInput, View } from "react-native";

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
  const [value, setValue] = useState(currentKey ?? "");

  useEffect(() => {
    setValue(currentKey ?? "");
  }, [currentKey]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable className="flex-1 bg-tp-overlay" onPress={onClose}>
        <View className="flex-1" />
        <Pressable
          className="bg-tp-bg-elevated rounded-t-2xl"
          onPress={() => {}}
        >
          <View className="flex-row items-center justify-between px-5 pt-5 pb-3">
            <Text
              className="text-tp-text-primary text-lg font-bold"
              accessibilityRole="header"
            >
              OpenAI API Key
            </Text>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Done"
            >
              <Text className="text-tp-accent text-base">Done</Text>
            </Pressable>
          </View>
          <View className="px-5 pb-8">
            <Text className="text-tp-text-secondary text-[13px] mb-3">
              Required for voice input. Your key is stored locally on this
              device.
            </Text>
            <TextInput
              className="bg-tp-bg-input text-tp-text-primary text-[15px] rounded-btn px-4 py-3 border border-tp-border"
              value={value}
              onChangeText={setValue}
              placeholder="sk-..."
              placeholderTextColor="var(--tp-text-tertiary)"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              accessibilityLabel="OpenAI API key"
              accessibilityHint="Enter your OpenAI API key for voice input"
            />
            <Pressable
              className="bg-tp-accent rounded-btn items-center py-3 mt-4"
              onPress={() => {
                if (value.trim()) {
                  onSave(value.trim());
                }
                onClose();
              }}
              accessibilityRole="button"
              accessibilityLabel="Save API key"
            >
              <Text className="text-white text-[15px] font-semibold">Save</Text>
            </Pressable>
            {currentKey && (
              <Pressable
                className="items-center py-3 mt-2"
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
        </Pressable>
      </Pressable>
    </Modal>
  );
}
