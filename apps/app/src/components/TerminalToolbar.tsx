import { useCallback, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";

/**
 * Mobile software keyboard toolbar for terminal.
 * Provides Esc, Tab, Ctrl, Alt, arrow keys, and common symbols.
 * Termux-inspired 2-row layout with sticky modifiers.
 */

interface ToolbarKey {
  label: string;
  /** Raw data to send (ANSI escape sequences, etc.) */
  data?: string;
  /** This is a modifier key (Ctrl/Alt) */
  modifier?: "ctrl" | "alt";
}

const ROW_1: ToolbarKey[] = [
  { label: "ESC", data: "\x1b" },
  { label: "/", data: "/" },
  { label: "-", data: "-" },
  { label: "~", data: "~" },
  { label: "|", data: "|" },
  { label: "HOME", data: "\x1b[H" },
  { label: "\u2191", data: "\x1b[A" },
  { label: "END", data: "\x1b[F" },
  { label: "PgUp", data: "\x1b[5~" },
];

const ROW_2: ToolbarKey[] = [
  { label: "TAB", data: "\t" },
  { label: "CTRL", modifier: "ctrl" },
  { label: "ALT", modifier: "alt" },
  { label: "`", data: "`" },
  { label: "_", data: "_" },
  { label: "\u2190", data: "\x1b[D" },
  { label: "\u2193", data: "\x1b[B" },
  { label: "\u2192", data: "\x1b[C" },
  { label: "PgDn", data: "\x1b[6~" },
];

export function TerminalToolbar({
  onData,
}: {
  onData: (data: string) => void;
}) {
  const [ctrlActive, setCtrlActive] = useState(false);
  const [ctrlLocked, setCtrlLocked] = useState(false);
  const [altActive, setAltActive] = useState(false);
  const [altLocked, setAltLocked] = useState(false);
  const ctrlLastTap = useRef(0);
  const altLastTap = useRef(0);

  const handleKey = useCallback(
    (key: ToolbarKey) => {
      if (key.modifier === "ctrl") {
        const now = Date.now();
        if (now - ctrlLastTap.current < 300) {
          // Double-tap: lock
          setCtrlLocked(true);
          setCtrlActive(true);
        } else {
          if (ctrlLocked) {
            // Unlock
            setCtrlLocked(false);
            setCtrlActive(false);
          } else {
            setCtrlActive((v) => !v);
          }
        }
        ctrlLastTap.current = now;
        return;
      }

      if (key.modifier === "alt") {
        const now = Date.now();
        if (now - altLastTap.current < 300) {
          setAltLocked(true);
          setAltActive(true);
        } else {
          if (altLocked) {
            setAltLocked(false);
            setAltActive(false);
          } else {
            setAltActive((v) => !v);
          }
        }
        altLastTap.current = now;
        return;
      }

      let data = key.data ?? key.label;

      if (ctrlActive && data.length === 1) {
        // Ctrl+key: ASCII code - 64 (A=0x01, C=0x03, etc.)
        const code = data.toUpperCase().charCodeAt(0);
        if (code >= 0x40 && code <= 0x5f) {
          data = String.fromCharCode(code - 0x40);
        }
        if (!ctrlLocked) setCtrlActive(false);
      }

      if (altActive) {
        // Alt = ESC prefix
        data = `\x1b${data}`;
        if (!altLocked) setAltActive(false);
      }

      onData(data);
    },
    [onData, ctrlActive, ctrlLocked, altActive, altLocked],
  );

  if (Platform.OS === "web") return null;

  return (
    <View className="bg-zinc-900 border-t border-zinc-700 pb-1">
      <ToolbarRow
        keys={ROW_1}
        onKey={handleKey}
        ctrlActive={ctrlActive}
        ctrlLocked={ctrlLocked}
        altActive={altActive}
        altLocked={altLocked}
      />
      <ToolbarRow
        keys={ROW_2}
        onKey={handleKey}
        ctrlActive={ctrlActive}
        ctrlLocked={ctrlLocked}
        altActive={altActive}
        altLocked={altLocked}
      />
    </View>
  );
}

function ToolbarRow({
  keys,
  onKey,
  ctrlActive,
  ctrlLocked,
  altActive,
  altLocked,
}: {
  keys: ToolbarKey[];
  onKey: (key: ToolbarKey) => void;
  ctrlActive: boolean;
  ctrlLocked: boolean;
  altActive: boolean;
  altLocked: boolean;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="always"
      className="flex-row py-0.5 px-1"
    >
      {keys.map((key) => {
        const isActive =
          (key.modifier === "ctrl" && ctrlActive) ||
          (key.modifier === "alt" && altActive);
        const isLocked =
          (key.modifier === "ctrl" && ctrlLocked) ||
          (key.modifier === "alt" && altLocked);

        return (
          <Pressable
            key={key.label}
            onPress={() => onKey(key)}
            className={`min-w-[44px] h-[36px] items-center justify-center rounded mx-0.5 px-2 ${
              isLocked
                ? "bg-blue-600"
                : isActive
                  ? "bg-zinc-600"
                  : "bg-zinc-800"
            }`}
          >
            <Text
              className={`text-xs font-medium ${
                isActive ? "text-white" : "text-gray-300"
              }`}
            >
              {key.label}
              {isLocked ? " \u25CF" : ""}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
