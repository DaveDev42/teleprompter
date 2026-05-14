import { useEffect, useRef, useState } from "react";
import { FlatList, Platform, Pressable, Text, View } from "react-native";
import { ariaLevel, getPlatformProps } from "../lib/get-platform-props";
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

  // Roving tabindex for the APG listbox keyboard pattern (web only). The
  // option matching `currentFont` is the initial tab stop; ArrowDown/Up/
  // Home/End on the listbox container move the active option, and the
  // matching DOM node is focused so screen readers re-announce it.
  const initialIndex = Math.max(0, fonts.indexOf(currentFont));
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const optionRefs = useRef<Array<HTMLElement | null>>([]);
  // Bridge ref for ModalContainer's initial-focus override. Without this the
  // first focusable in DOM order (the trailing "Done" button) wins, so a
  // screen reader announces "Done, button" instead of the current font
  // option, and ArrowDown does nothing until the user Shift+Tab's into the
  // listbox first. Sync the bridge on every render so the freshly-rendered
  // DOM node is in scope by the time ModalContainer's 100 ms focus timer
  // fires.
  const initialFocusRef = useRef<unknown>(null);
  useEffect(() => {
    initialFocusRef.current = optionRefs.current[activeIndex] ?? null;
  });

  useEffect(() => {
    if (!visible) return;
    setActiveIndex(Math.max(0, fonts.indexOf(currentFont)));
  }, [visible, currentFont, fonts]);

  const focusOption = (index: number) => {
    if (Platform.OS !== "web") return;
    const el = optionRefs.current[index];
    el?.focus();
  };

  const onListboxKeyDown = (e: { key: string; preventDefault: () => void }) => {
    if (Platform.OS !== "web") return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.min(fonts.length - 1, activeIndex + 1);
      setActiveIndex(next);
      focusOption(next);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = Math.max(0, activeIndex - 1);
      setActiveIndex(prev);
      focusOption(prev);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
      focusOption(0);
    } else if (e.key === "End") {
      e.preventDefault();
      const last = fonts.length - 1;
      setActiveIndex(last);
      focusOption(last);
    }
  };

  return (
    <ModalContainer
      visible={visible}
      onClose={onClose}
      accessibilityLabel={title}
      initialFocusRef={initialFocusRef}
    >
      <View className="max-h-[60vh]">
        <View className="flex-row items-center justify-between px-5 pt-5 pb-3">
          <Text
            className="text-tp-text-primary text-lg font-bold"
            accessibilityRole="header"
            {...ariaLevel(2)}
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
        <View
          {...((Platform.OS === "web"
            ? {
                role: "listbox",
                "aria-label": title,
                onKeyDown: onListboxKeyDown,
              }
            : {}) as object)}
        >
          <FlatList
            data={fonts}
            keyExtractor={(item) => item}
            renderItem={({ item, index }) => {
              const isCurrent = item === currentFont;
              const isActive = index === activeIndex;
              // RN Web's accessibilityRole allowlist excludes "option" and
              // doesn't translate accessibilityState.selected into
              // aria-selected, so we spread the raw ARIA attributes on web.
              // Native gets a "button" role with selected state instead.
              // Roving tabindex: only the active option is in tab order, so
              // ArrowDown/Up from the listbox container reaches all
              // options without Tab cycling through each one.
              const webOptionProps =
                Platform.OS === "web"
                  ? {
                      role: "option",
                      "aria-selected": isCurrent,
                      tabIndex: isActive ? 0 : -1,
                      ref: (el: unknown) => {
                        optionRefs.current[index] = el as HTMLElement | null;
                      },
                    }
                  : {};
              return (
                <Pressable
                  testID={`font-option-${item}`}
                  className={`flex-row items-center justify-between px-5 py-3.5 ${pp.className}`}
                  tabIndex={Platform.OS === "web" ? undefined : pp.tabIndex}
                  onPress={() => {
                    onSelect(item);
                    onClose();
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={item}
                  accessibilityState={{ selected: isCurrent }}
                  {...(webOptionProps as object)}
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

  // Mirror at-boundary state to aria-disabled on web. RN Web's Pressable
  // only emits the native HTML `disabled` attribute, which strips the
  // button from Tab order. Keep both buttons focusable so a keyboard user
  // can still see they exist at the boundary, and announce inertness via
  // aria-disabled. `visible` is in the dep array so the effect fires once
  // the modal mounts the refs — the at-boundary value can be true on the
  // very first render, so without re-firing on mount aria-disabled would
  // be absent from the freshly-mounted DOM node.
  const decRef = useRef<View>(null);
  const incRef = useRef<View>(null);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!visible) return;
    const dec = decRef.current as unknown as HTMLElement | null;
    const inc = incRef.current as unknown as HTMLElement | null;
    if (dec) {
      if (atMin) dec.setAttribute("aria-disabled", "true");
      else dec.removeAttribute("aria-disabled");
    }
    if (inc) {
      if (atMax) inc.setAttribute("aria-disabled", "true");
      else inc.removeAttribute("aria-disabled");
    }
  }, [visible, atMin, atMax]);

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
          {...ariaLevel(2)}
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
          ref={decRef}
          className={`w-12 h-12 rounded-full bg-tp-surface items-center justify-center ${pp.className} ${atMin ? "opacity-30" : ""}`}
          tabIndex={pp.tabIndex}
          onPress={() => {
            if (atMin) return;
            adjust(-1);
          }}
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
          ref={incRef}
          className={`w-12 h-12 rounded-full bg-tp-surface items-center justify-center ${pp.className} ${atMax ? "opacity-30" : ""}`}
          tabIndex={pp.tabIndex}
          onPress={() => {
            if (atMax) return;
            adjust(1);
          }}
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
