/**
 * KeyHandler — ink component for declarative keyboard binding.
 *
 * Maps key names to callbacks without consuming events itself; multiple
 * `<KeyHandler>` instances can be active simultaneously (each uses its own
 * `useInput` listener). The component never exits ink — that is always the
 * responsibility of the binding callback (e.g. call `useApp().exit()` inside
 * your callback).
 *
 * Usage:
 *   <KeyHandler
 *     bindings={{
 *       c: () => { copyToClipboard(url); },
 *       "ctrl+c": () => { app.exit(); },
 *     }}
 *   >
 *     <Text color="gray">Press c to copy · Ctrl+C to cancel</Text>
 *   </KeyHandler>
 *
 * Recognized key names:
 *   Single chars: "a"-"z", "0"-"9", " " (space)
 *   Special: "space", "escape", "enter", "return", "backspace", "delete",
 *            "up", "down", "left", "right"
 *   Modifiers: "ctrl+<char>", "meta+<char>"
 */

import { Box, useInput } from "ink";
import type React from "react";

// ─── Component ────────────────────────────────────────────────────────────────

/** Map of key name → callback. See module JSDoc for recognized key names. */
export type KeyBindings = Record<string, () => void>;

export interface KeyHandlerProps {
  /**
   * Keyboard bindings. Each key maps a key-name string to a callback.
   * Multiple active `<KeyHandler>` instances all fire independently.
   */
  bindings: KeyBindings;
  /** Optional child elements displayed alongside the hint text. */
  children?: React.ReactNode;
}

/**
 * Pure event component that fires registered callbacks on matching keypresses.
 * Does not render any UI beyond the optional `children`.
 */
export function KeyHandler({
  bindings,
  children,
}: KeyHandlerProps): React.ReactElement {
  useInput((input, key) => {
    // Build a normalized key descriptor from the ink key object + input char.
    const descriptors: string[] = [];

    // Ctrl modifier
    if (key.ctrl && input) {
      descriptors.push(`ctrl+${input}`);
    }

    // Meta modifier
    if (key.meta && input) {
      descriptors.push(`meta+${input}`);
    }

    // Named keys (no modifier)
    if (key.escape) descriptors.push("escape");
    if (key.return) {
      descriptors.push("enter");
      descriptors.push("return");
    }
    if (key.backspace) descriptors.push("backspace");
    if (key.delete) descriptors.push("delete");
    if (key.upArrow) descriptors.push("up");
    if (key.downArrow) descriptors.push("down");
    if (key.leftArrow) descriptors.push("left");
    if (key.rightArrow) descriptors.push("right");
    if (key.tab) descriptors.push("tab");

    // Raw input character (covers single letters, digits, space, etc.)
    if (input && !key.ctrl && !key.meta) {
      descriptors.push(input);
      if (input === " ") descriptors.push("space");
    }

    // Fire the first matching binding found (order: descriptors array).
    for (const desc of descriptors) {
      if (Object.hasOwn(bindings, desc)) {
        bindings[desc]?.();
        break;
      }
    }
  });

  return <Box>{children}</Box>;
}
