import { Pressable, Text, View } from "react-native";
import { ariaLevel, getPlatformProps } from "../lib/get-platform-props";
import { ModalContainer } from "./ModalContainer";

const HEADING_ID = "shortcut-help-heading";

interface ShortcutItem {
  keys: string[];
  description: string;
}

const SECTIONS: { title: string; items: ShortcutItem[] }[] = [
  {
    title: "Anywhere",
    items: [
      { keys: ["?"], description: "Show keyboard shortcuts" },
      { keys: ["1"], description: "Go to Sessions" },
      { keys: ["2"], description: "Go to Daemons" },
      { keys: ["3"], description: "Go to Settings" },
    ],
  },
  {
    title: "Session screen",
    items: [
      { keys: ["c"], description: "Chat tab" },
      { keys: ["t"], description: "Terminal tab" },
      { keys: ["["], description: "Previous session" },
      { keys: ["]"], description: "Next session" },
    ],
  },
  {
    title: "Game controller",
    items: [
      { keys: ["D-pad"], description: "Move focus" },
      { keys: ["A"], description: "Select" },
      { keys: ["B"], description: "Back / close dialog" },
      { keys: ["LB", "RB"], description: "Previous / next tab" },
    ],
  },
];

function KeyChip({ label }: { label: string }) {
  return (
    <View className="bg-tp-surface border border-tp-border rounded-badge px-2 py-0.5 min-w-[28px] items-center">
      <Text className="text-tp-text-secondary text-[13px] font-mono">
        {label}
      </Text>
    </View>
  );
}

/**
 * Cheat-sheet for the web-only global single-key shortcuts registered via
 * useGlobalShortcuts. Opened with "?" from the root layout; closes via
 * Escape / Done / overlay tap like every other ModalContainer dialog.
 * Shortcuts never fire while typing or while the terminal has focus — the
 * trailing hint says so because that guard is otherwise invisible.
 */
export function ShortcutHelpModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const pp = getPlatformProps();
  return (
    <ModalContainer
      visible={visible}
      onClose={onClose}
      accessibilityLabel="Keyboard shortcuts"
      accessibilityLabelledBy={HEADING_ID}
    >
      <View testID="shortcut-help-modal">
        <View className="flex-row items-center justify-between px-5 pt-5 pb-3">
          <Text
            nativeID={HEADING_ID}
            className="text-tp-text-primary text-lg font-bold"
            accessibilityRole="header"
            {...ariaLevel(2)}
          >
            Keyboard Shortcuts
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
          {SECTIONS.map((section) => (
            <View key={section.title} className="mb-4">
              <Text className="text-tp-text-tertiary text-[12px] font-semibold uppercase mb-2">
                {section.title}
              </Text>
              {section.items.map((item) => (
                <View
                  key={item.description}
                  className="flex-row items-center justify-between py-1.5"
                >
                  <Text className="text-tp-text-primary text-[14px]">
                    {item.description}
                  </Text>
                  <View className="flex-row gap-1">
                    {item.keys.map((key) => (
                      <KeyChip key={key} label={key} />
                    ))}
                  </View>
                </View>
              ))}
            </View>
          ))}
          <Text className="text-tp-text-tertiary text-[12px]">
            Shortcuts pause while you are typing or the terminal has focus.
          </Text>
        </View>
      </View>
    </ModalContainer>
  );
}
