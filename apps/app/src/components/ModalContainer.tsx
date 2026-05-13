import { useEffect, useMemo, useRef } from "react";
import { Modal, Platform, Pressable, View } from "react-native";
import { useKeyboard } from "../hooks/use-keyboard";

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function ModalContainer({
  visible,
  onClose,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const containerRef = useRef<View>(null);
  const previousFocusRef = useRef<Element | null>(null);

  const keyMap = useMemo<Record<string, () => void>>(
    () => (visible ? { Escape: onClose } : ({} as Record<string, () => void>)),
    [visible, onClose],
  );
  useKeyboard(keyMap);

  // Focus trap (Web only)
  useEffect(() => {
    if (Platform.OS !== "web" || !visible) return;

    // Save previous focus
    previousFocusRef.current = document.activeElement;

    // Wait for Modal's slide animation to mount DOM before focusing
    const timer = setTimeout(() => {
      const container = containerRef.current as unknown as HTMLElement;
      if (!container) return;
      const focusable = container.querySelectorAll(FOCUSABLE_SELECTOR);
      if (focusable.length > 0) {
        // Prefer a text input over decorative "Done" headers so users can
        // type immediately on open (e.g. ApiKeyModal).
        const primary =
          Array.from(focusable).find(
            (el) => el.tagName === "INPUT" || el.tagName === "TEXTAREA",
          ) ?? focusable[0];
        (primary as HTMLElement).focus();
      }
    }, 100);

    // Tab trap
    const trapHandler = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const container = containerRef.current as unknown as HTMLElement;
      if (!container) return;
      const focusable = container.querySelectorAll(FOCUSABLE_SELECTOR);
      if (focusable.length === 0) return;

      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", trapHandler);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", trapHandler);
      // Restore focus
      if (previousFocusRef.current instanceof HTMLElement) {
        previousFocusRef.current.focus();
      }
    };
  }, [visible]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable className="flex-1 bg-tp-overlay" onPress={onClose}>
        <View className="flex-1" />
        <View
          className="bg-tp-bg-elevated rounded-t-2xl"
          {...(Platform.OS === "web"
            ? {
                onClick: (e: { stopPropagation: () => void }) =>
                  e.stopPropagation(),
              }
            : {})}
        >
          <View ref={containerRef}>{children}</View>
        </View>
      </Pressable>
    </Modal>
  );
}
