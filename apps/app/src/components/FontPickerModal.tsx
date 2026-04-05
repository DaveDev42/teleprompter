import { useEffect, useState } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  Text,
  View,
} from "react-native";

const SANS_FONTS = [
  "Inter",
  "System",
  "SF Pro",
  "Helvetica Neue",
  "Roboto",
  "Arial",
];

const MONO_FONTS = [
  "JetBrains Mono",
  "Menlo",
  "Monaco",
  "Fira Code",
  "SF Mono",
  "Courier New",
  "Consolas",
];

export type FontPickerMode = "chat" | "code" | "terminal";

export function FontPickerModal({
  visible,
  mode,
  currentFont,
  onSelect,
  onClose,
}: {
  visible: boolean;
  mode: FontPickerMode;
  currentFont: string;
  onSelect: (font: string) => void;
  onClose: () => void;
}) {
  const fonts = mode === "chat" ? SANS_FONTS : MONO_FONTS;
  const title =
    mode === "chat"
      ? "Chat Font"
      : mode === "code"
        ? "Code Font"
        : "Terminal Font";

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
          className="bg-tp-bg-elevated rounded-t-2xl max-h-[60%]"
          onPress={() => {}}
        >
          <View className="flex-row items-center justify-between px-5 pt-5 pb-3">
            <Text className="text-tp-text-primary text-lg font-bold">
              {title}
            </Text>
            <Pressable onPress={onClose}>
              <Text className="text-tp-accent text-base">Done</Text>
            </Pressable>
          </View>
          <FlatList
            data={fonts}
            keyExtractor={(item) => item}
            renderItem={({ item }) => (
              <Pressable
                className="flex-row items-center justify-between px-5 py-3.5"
                onPress={() => {
                  onSelect(item);
                  onClose();
                }}
              >
                <Text
                  className="text-tp-text-primary text-[15px]"
                  style={{ fontFamily: item }}
                >
                  {item}
                </Text>
                {item === currentFont && (
                  <Text className="text-tp-accent text-base">✓</Text>
                )}
              </Pressable>
            )}
            ItemSeparatorComponent={() => (
              <View className="h-[0.5px] bg-tp-border mx-5" />
            )}
            contentContainerStyle={{ paddingBottom: 40 }}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export function FontSizeModal({
  visible,
  currentSize,
  onChangeSize,
  onClose,
}: {
  visible: boolean;
  currentSize: number;
  onChangeSize: (size: number) => void;
  onClose: () => void;
}) {
  const [size, setSize] = useState(currentSize);

  useEffect(() => {
    setSize(currentSize);
  }, [currentSize]);

  const adjust = (delta: number) => {
    const next = Math.min(24, Math.max(10, size + delta));
    setSize(next);
    onChangeSize(next);
  };

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
            <Text className="text-tp-text-primary text-lg font-bold">
              Font Size
            </Text>
            <Pressable onPress={onClose}>
              <Text className="text-tp-accent text-base">Done</Text>
            </Pressable>
          </View>
          <View className="flex-row items-center justify-center gap-8 py-8 pb-12">
            <Pressable
              className="w-12 h-12 rounded-full bg-tp-surface items-center justify-center"
              onPress={() => adjust(-1)}
            >
              <Text className="text-tp-text-primary text-2xl font-bold">−</Text>
            </Pressable>
            <Text className="text-tp-text-primary text-4xl font-bold w-20 text-center">
              {size}
            </Text>
            <Pressable
              className="w-12 h-12 rounded-full bg-tp-surface items-center justify-center"
              onPress={() => adjust(1)}
            >
              <Text className="text-tp-text-primary text-2xl font-bold">+</Text>
            </Pressable>
          </View>
          <Text className="text-tp-text-tertiary text-xs text-center pb-8">
            Range: 10–24px
          </Text>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
