import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { ariaLevel, getPlatformProps } from "../lib/get-platform-props";
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

  // Reset the local input each time the modal opens so unsaved drafts from
  // the previous open don't leak across closes. `currentKey` alone is
  // insufficient — when the key stays null (most common case), the effect
  // wouldn't re-run and the stale draft would persist.
  useEffect(() => {
    if (visible) setValue(currentKey ?? "");
  }, [visible, currentKey]);

  const canSave = value.trim().length > 0;

  // Mirror disabled state to aria-disabled on web. RN Web's Pressable only
  // emits the native HTML `disabled` attribute, which strips the button from
  // the Tab order. Keep it focusable and announce the disabled state via
  // aria-disabled instead so keyboard users can still discover the Save
  // button and the screen reader announces why it's inert. `visible` is in
  // the dep array so the effect re-fires after the modal mounts the ref —
  // canSave starts false on open, so without this the initial render would
  // never run the effect against the freshly-mounted DOM node.
  const saveRef = useRef<View>(null);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!visible) return;
    const el = saveRef.current as unknown as HTMLElement | null;
    if (!el) return;
    if (!canSave) el.setAttribute("aria-disabled", "true");
    else el.removeAttribute("aria-disabled");
  }, [visible, canSave]);

  // RN Web's createDOMProps doesn't whitelist `aria-description` and
  // doesn't map `accessibilityHint` to any ARIA attribute. Mirror the
  // hint via setAttribute when the modal opens so screen readers on
  // web hear the same context native AT gets from accessibilityHint.
  const inputRef = useRef<TextInput>(null);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!visible) return;
    const el = inputRef.current as unknown as HTMLElement | null;
    if (!el) return;
    el.setAttribute(
      "aria-description",
      "Enter your OpenAI API key for voice input",
    );
  }, [visible]);

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
          {...ariaLevel(2)}
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
          ref={inputRef}
          className={`bg-tp-bg-input text-tp-text-primary text-[15px] rounded-btn px-4 py-3 border border-tp-border ${pp.className}`}
          tabIndex={pp.tabIndex}
          value={value}
          onChangeText={setValue}
          placeholder="sk-..."
          placeholderTextColor={placeholderColor}
          autoCapitalize="none"
          autoCorrect={false}
          // secureTextEntry maps to type=password on web; without explicit
          // autoComplete="off" the browser password manager treats this API
          // key like a saved credential, which is wrong and leaks the key
          // into the OS keychain unprompted.
          autoComplete="off"
          secureTextEntry
          accessibilityLabel="OpenAI API key"
          // accessibilityHint is read by native AT but RN Web drops it.
          // The matching aria-description is set imperatively when the
          // modal opens (see useEffect above).
          accessibilityHint="Enter your OpenAI API key for voice input"
          // WCAG 2.1 SC 1.3.1 / 4.1.2: Save is disabled until a key is
          // entered. Expose the requirement via aria-required so screen
          // readers announce the field as mandatory. RN doesn't bridge
          // accessibilityRequired so spread aria-required raw on web.
          {...(Platform.OS === "web"
            ? ({ "aria-required": "true" } as object)
            : {})}
        />
        <Pressable
          ref={saveRef}
          className={`bg-tp-accent rounded-btn items-center py-3 mt-4 ${pp.className}`}
          tabIndex={pp.tabIndex}
          onPress={() => {
            if (canSave) {
              onSave(value.trim());
              onClose();
            }
          }}
          accessibilityRole="button"
          accessibilityLabel="Save API key"
          accessibilityState={{ disabled: !canSave }}
          style={{ opacity: canSave ? 1 : 0.5 }}
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
