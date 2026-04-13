import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { getPlatformProps } from "../lib/get-platform-props";
import { ModalContainer } from "./ModalContainer";

export function RenamePairingModal({
  visible,
  initialValue,
  onCancel,
  onSave,
}: {
  visible: boolean;
  initialValue: string;
  onCancel: () => void;
  onSave: (value: string) => void | Promise<void>;
}) {
  const pp = getPlatformProps();
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (visible) setValue(initialValue);
  }, [visible, initialValue]);

  const handleSave = () => {
    void onSave(value);
  };

  return (
    <ModalContainer visible={visible} onClose={onCancel}>
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
            className={pp.className}
            tabIndex={pp.tabIndex}
            onPress={handleSave}
            accessibilityRole="button"
            accessibilityLabel="Save pairing label"
          >
            <Text className="text-tp-accent text-base font-semibold">Save</Text>
          </Pressable>
        </View>
        <TextInput
          value={value}
          onChangeText={setValue}
          placeholder="Label (leave empty to clear)"
          placeholderTextColor="#888"
          autoFocus
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={handleSave}
          className="bg-tp-bg-input text-tp-text-primary rounded-btn px-3 py-3 text-[15px]"
          accessibilityLabel="Pairing label"
        />
        <Text className="text-tp-text-tertiary text-xs mt-2">
          Empty value clears the label and falls back to the daemon ID.
        </Text>
      </View>
    </ModalContainer>
  );
}
