import { useEffect, useMemo, useRef } from "react";
import { Modal, Platform, Pressable, View } from "react-native";
import { useKeyboard } from "../hooks/use-keyboard";

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function ModalContainer({
  visible,
  onClose,
  children,
  accessibilityLabel,
  accessibilityDescribedBy,
  initialFocusRef,
}: {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** Accessible name for the dialog (announced by screen readers when opened). */
  accessibilityLabel?: string;
  /**
   * Web-only: id of an element inside the dialog whose text should be
   * announced as the dialog's description (after the label) when a
   * screen reader enters the dialog. Per APG Dialog Pattern, destructive
   * confirmation dialogs MUST expose their warning text via
   * `aria-describedby` — otherwise only the dialog name is announced and
   * the user has to Tab through the content to discover the consequences.
   */
  accessibilityDescribedBy?: string;
  /**
   * Web-only opt-in: this element receives initial focus instead of the
   * first focusable in DOM order. Use when the dialog has a meaningful
   * "primary" target that isn't the first focusable — e.g. the currently
   * selected option of a listbox should get focus over the trailing "Done"
   * button so a screen reader announces the current value on open and the
   * arrow keys are immediately useful.
   */
  initialFocusRef?: React.RefObject<unknown>;
}) {
  const containerRef = useRef<View>(null);
  const dialogRef = useRef<View>(null);
  const previousFocusRef = useRef<Element | null>(null);

  const keyMap = useMemo<Record<string, () => void>>(
    () => (visible ? { Escape: onClose } : ({} as Record<string, () => void>)),
    [visible, onClose],
  );
  useKeyboard(keyMap);

  // Focus trap (Web only). initialFocusRef is a ref whose .current is read
  // inside the timer at call-time, so it doesn't belong in the dep array
  // (refs never re-trigger effects). biome-ignore must be the last comment
  // line directly above the hook for the suppression to apply.
  // biome-ignore lint/correctness/useExhaustiveDependencies: initialFocusRef is a ref read at timer fire-time, not a state dep
  useEffect(() => {
    if (Platform.OS !== "web" || !visible) return;

    // Save previous focus
    previousFocusRef.current = document.activeElement;

    // Mark every sibling of the dialog's ancestor chain as inert so screen
    // readers cannot virtual-cursor into background content and Tab cannot
    // escape into it. RN Web's <Modal> renders inline (not into a portal),
    // so we walk from the dialog up to <body> and inert the off-path
    // siblings at each level. Restore previous values on unmount.
    const dialogEl = dialogRef.current as unknown as HTMLElement | null;
    const inertRestores: Array<() => void> = [];
    let node: HTMLElement | null = dialogEl;
    while (node && node !== document.body) {
      const parent: HTMLElement | null = node.parentElement;
      if (!parent) break;
      for (const sib of Array.from(parent.children)) {
        if (sib === node) continue;
        const el = sib as HTMLElement;
        const hadInert = el.hasAttribute("inert");
        const hadAriaHidden = el.getAttribute("aria-hidden");
        el.setAttribute("inert", "");
        el.setAttribute("aria-hidden", "true");
        inertRestores.push(() => {
          if (!hadInert) el.removeAttribute("inert");
          if (hadAriaHidden === null) el.removeAttribute("aria-hidden");
          else el.setAttribute("aria-hidden", hadAriaHidden);
        });
      }
      node = parent;
    }

    // Wait for Modal's slide animation to mount DOM before focusing
    const timer = setTimeout(() => {
      // Caller-provided primary target wins over the heuristic search.
      const explicit = initialFocusRef?.current as unknown as
        | HTMLElement
        | null
        | undefined;
      if (explicit?.focus) {
        explicit.focus();
        return;
      }
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
      // Filter out disabled controls — the browser skips them in Tab order,
      // so if the trailing focusable in DOM order is disabled, the trap
      // never sees focus reach `last` and Tab escapes the modal to <body>.
      // Compute first/last from the same set the browser actually uses.
      const focusable = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => !(el as HTMLButtonElement).disabled);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

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

    document.addEventListener("keydown", trapHandler, true);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", trapHandler, true);
      for (const restore of inertRestores) restore();
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
      // RN Web's <Modal> hard-codes role="dialog" + aria-modal=true on its
      // outer wrapper. Spreading aria-label here gives that single dialog a
      // name so screen readers don't announce an unnamed dialog. We do NOT
      // add a second role=dialog on the inner card — duplicating the role
      // produces two dialogs in the a11y tree.
      // aria-describedby is the APG-canonical way to attach the dialog's
      // body text to its accessible name. RN Web's createDOMProps doesn't
      // forward `accessibilityDescribedBy` as `aria-describedby` on a
      // <Modal>, so spread the raw aria attribute on web.
      {...(Platform.OS === "web" && accessibilityLabel
        ? ({ "aria-label": accessibilityLabel } as object)
        : {})}
      {...(Platform.OS === "web" && accessibilityDescribedBy
        ? ({ "aria-describedby": accessibilityDescribedBy } as object)
        : {})}
    >
      <Pressable className="flex-1 bg-tp-overlay" onPress={onClose}>
        <View className="flex-1" />
        <View
          ref={dialogRef}
          className="bg-tp-bg-elevated rounded-t-2xl w-full max-w-[540px] mx-auto"
          accessibilityLabel={accessibilityLabel}
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
