import { useEffect, useState } from "react";
import { FlatList, Platform, Pressable, Text, View } from "react-native";
import { getPlatformProps } from "../lib/get-platform-props";
import { ModalContainer } from "./ModalContainer";

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
  const pp = getPlatformProps();
  const fonts = mode === "chat" ? SANS_FONTS : MONO_FONTS;
  const title =
    mode === "chat"
      ? "Chat Font"
      : mode === "code"
        ? "Code Font"
        : "Terminal Font";

  return (
    <ModalContainer
      visible={visible}
      onClose={onClose}
      accessibilityLabel={title}
    >
      <View className="max-h-[60vh]">
        <View className="flex-row items-center justify-between px-5 pt-5 pb-3">
          <Text
            className="text-tp-text-primary text-lg font-bold"
            accessibilityRole="header"
          >
            {title}
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
        <FlatList
          data={fonts}
          keyExtractor={(item) => item}
          renderItem={({ item }) => {
            const isCurrent = item === currentFont;
            // RN Web doesn't translate accessibilityState.selected into
            // aria-selected, so screen readers can't tell which font is
            // active. Pass the raw ARIA attribute via a web-only spread
            // (native ignores it). Matches the SegmentedControl pattern in
            // app/session/[sid].tsx.
            const ariaSelected =
              Platform.OS === "web" ? { "aria-selected": isCurrent } : {};
            return (
              <Pressable
                className={`flex-row items-center justify-between px-5 py-3.5 ${pp.className}`}
                tabIndex={pp.tabIndex}
                onPress={() => {
                  onSelect(item);
                  onClose();
                }}
                accessibilityRole="button"
                accessibilityLabel={item}
                accessibilityState={{ selected: isCurrent }}
                {...(ariaSelected as object)}
              >
                <Text
                  className="text-tp-text-primary text-[15px]"
                  style={{ fontFamily: item }}
                >
                  {item}
                </Text>
                {isCurrent && (
                  <Text className="text-tp-accent text-base">✓</Text>
                )}
              </Pressable>
            );
          }}
          ItemSeparatorComponent={() => (
            <View className="h-[0.5px] bg-tp-border mx-5" />
          )}
          contentContainerStyle={{ paddingBottom: 40 }}
        />
      </View>
    </ModalContainer>
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
  const pp = getPlatformProps();
  const [size, setSize] = useState(currentSize);

  useEffect(() => {
    setSize(currentSize);
  }, [currentSize]);

  const adjust = (delta: number) => {
    const next = Math.min(24, Math.max(10, size + delta));
    setSize(next);
    onChangeSize(next);
  };
  const atMin = size <= 10;
  const atMax = size >= 24;

  return (
    <ModalContainer
      visible={visible}
      onClose={onClose}
      accessibilityLabel="Font Size"
    >
      <View className="flex-row items-center justify-between px-5 pt-5 pb-3">
        <Text
          className="text-tp-text-primary text-lg font-bold"
          accessibilityRole="header"
        >
          Font Size
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
      <View className="flex-row items-center justify-center gap-8 py-8 pb-12">
        <Pressable
          className={`w-12 h-12 rounded-full bg-tp-surface items-center justify-center ${pp.className} ${atMin ? "opacity-30" : ""}`}
          tabIndex={pp.tabIndex}
          onPress={() => adjust(-1)}
          disabled={atMin}
          accessibilityRole="button"
          accessibilityLabel="Decrease font size"
          accessibilityState={{ disabled: atMin }}
        >
          <Text className="text-tp-text-primary text-2xl font-bold">−</Text>
        </Pressable>
        <Text
          className="text-tp-text-primary text-4xl font-bold w-20 text-center"
          accessibilityLabel={`Font size ${size} pixels`}
          accessibilityRole="text"
        >
          {size}
        </Text>
        <Pressable
          className={`w-12 h-12 rounded-full bg-tp-surface items-center justify-center ${pp.className} ${atMax ? "opacity-30" : ""}`}
          tabIndex={pp.tabIndex}
          onPress={() => adjust(1)}
          disabled={atMax}
          accessibilityRole="button"
          accessibilityLabel="Increase font size"
          accessibilityState={{ disabled: atMax }}
        >
          <Text className="text-tp-text-primary text-2xl font-bold">+</Text>
        </Pressable>
      </View>
      <Text className="text-tp-text-tertiary text-xs text-center pb-8">
        Range: 10–24px
      </Text>
    </ModalContainer>
  );
}
