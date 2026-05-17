import { Fragment, useEffect, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
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
    } else if (e.key === " ") {
      // APG Single-Select Listbox §3.14: Space on a focused option
      // must commit the selection. The `role="option"` elements are
      // rendered as <div> on web (RN Web's Pressable doesn't emit a
      // native <button>), so the browser's "Space clicks a focused
      // button" shortcut doesn't apply. Enter happens to work because
      // Pressable's synthetic onClick catches it, but Space falls
      // through with no effect — keyboard-only users can navigate
      // with Arrow keys but can't activate the focused font. Forward
      // the keystroke to the underlying Pressable's onClick by
      // click()-ing the active option's DOM node; that path already
      // calls onSelect → setFont → onClose.
      e.preventDefault();
      optionRefs.current[activeIndex]?.click();
    }
  };

  return (
    <ModalContainer
      visible={visible}
      onClose={onClose}
      accessibilityLabel={title}
      accessibilityLabelledBy="font-picker-modal-title"
      initialFocusRef={initialFocusRef}
    >
      <View className="max-h-[60vh]">
        <View className="flex-row items-center justify-between px-5 pt-5 pb-3">
          <Text
            nativeID="font-picker-modal-title"
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
        {/* ScrollView + .map() instead of FlatList: RN Web's FlatList
            wraps each cell in 3 generic <div>s (VirtualizedList outer,
            inner, CellRenderer) between the listbox container and the
            option Pressable. That extra nesting violates ARIA's
            required-context rule (listbox must directly own its
            options). Chromium auto-repairs the ownership tree but
            Firefox/Safari are less forgiving, so the options can drop
            out of the AX tree for NVDA/JAWS/VoiceOver users. Font
            lists are short (≤7), so virtualization isn't worth the
            ownership hole. */}
        <ScrollView
          contentContainerStyle={{ paddingBottom: 40 }}
          {...((Platform.OS === "web"
            ? {
                role: "listbox",
                "aria-label": title,
                onKeyDown: onListboxKeyDown,
              }
            : {}) as object)}
        >
          {fonts.map((item, index) => {
            const isCurrent = item === currentFont;
            const isActive = index === activeIndex;
            // RN Web's accessibilityRole allowlist excludes "option" and
            // doesn't translate accessibilityState.selected into
            // aria-selected, so we spread the raw ARIA attributes on web.
            // Native gets a "button" role with selected state instead.
            // Roving tabindex: only the active option is in tab order, so
            // ArrowDown/Up from the listbox container reaches all
            // options without Tab cycling through each one.
            //
            // `aria-selected` follows keyboard focus (the APG single-
            // select listbox pattern). Without this, ArrowDown moves
            // focus to the next option but its `aria-selected` stays
            // false, and the screen reader announces "<font>, option,
            // 2 of N, not selected" — making the user feel like
            // nothing is being preselected as they navigate. The
            // committed `currentFont` is still surfaced visually via
            // the trailing check mark and remains the source of truth
            // until the user activates an option with Enter / click.
            const webOptionProps =
              Platform.OS === "web"
                ? {
                    role: "option",
                    "aria-selected": isActive,
                    tabIndex: isActive ? 0 : -1,
                    ref: (el: unknown) => {
                      optionRefs.current[index] = el as HTMLElement | null;
                    },
                  }
                : {};
            return (
              <Fragment key={item}>
                {index > 0 && <View className="h-[0.5px] bg-tp-border mx-5" />}
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
              </Fragment>
            );
          })}
        </ScrollView>
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
  const sizeRef = useRef<View>(null);
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

  // aria-atomic on the size live region is set via setAttribute because
  // RN Web 0.21 passes the `aria-atomic` prop through a buggy code path
  // that swaps it with aria-activedescendant on the way to the DOM. The
  // role / aria-live / aria-label pass through fine; only aria-atomic
  // needs the imperative escape hatch.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!visible) return;
    const el = sizeRef.current as unknown as HTMLElement | null;
    if (!el) return;
    el.setAttribute("aria-atomic", "true");
  }, [visible]);

  return (
    <ModalContainer
      visible={visible}
      onClose={onClose}
      accessibilityLabel="Font Size"
      accessibilityLabelledBy="font-size-modal-title"
    >
      <View className="flex-row items-center justify-between px-5 pt-5 pb-3">
        <Text
          nativeID="font-size-modal-title"
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
      {/* role="spinbutton" container exposes the numeric value state to AT
          (APG Spinbutton Pattern, WCAG 4.1.2). The −/+ Pressables stay as
          activatable buttons; this wrapper carries aria-valuenow/min/max
          so a screen reader reads "Font size in pixels, 15 pixels, minimum
          10, maximum 24" when the user enters the group. tabIndex=0 makes
          it focusable for keyboard use, and ArrowUp/Down/Home/End handle
          the canonical APG spinbutton interactions. */}
      <View
        className="flex-row items-center justify-center gap-8 py-8 pb-12"
        {...(Platform.OS === "web"
          ? ({
              role: "spinbutton" as const,
              "aria-label": "Font size in pixels",
              "aria-valuenow": size,
              "aria-valuemin": 10,
              "aria-valuemax": 24,
              "aria-valuetext": `${size} pixels`,
              tabIndex: 0,
              onKeyDown: (e: { key: string; preventDefault: () => void }) => {
                if (e.key === "ArrowUp" || e.key === "ArrowRight") {
                  e.preventDefault();
                  if (!atMax) adjust(1);
                } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
                  e.preventDefault();
                  if (!atMin) adjust(-1);
                } else if (e.key === "Home") {
                  e.preventDefault();
                  if (!atMin) {
                    setSize(10);
                    onChangeSize(10);
                  }
                } else if (e.key === "End") {
                  e.preventDefault();
                  if (!atMax) {
                    setSize(24);
                    onChangeSize(24);
                  }
                }
              },
            } as object)
          : {})}
      >
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
        {/* Wrap the size number in a polite live region so a screen
            reader announces the new value whenever +/- changes it.
            RN Web emits the bare <Text> as a role-less <div>, which
            means an `aria-label` on it is silently ignored by AT (it
            only matters on elements with a role). Move the role to a
            wrapping View on web; aria-atomic is set imperatively in
            the effect above because RN Web 0.21 garbles the
            aria-atomic prop pass-through.

            ARIA live region announcements use the region's TEXT
            CONTENT, not its `aria-label` (the label is the accessible
            name for focus-context; it does not fire on content
            changes). A bare numeral like "16" announced in isolation
            fails WCAG 4.1.3 — the user hears a series of numbers with
            no frame of reference. Put the unit + prefix inside the
            region (visually hidden so the big number stays the only
            visible element). Native gets the same announcement via
            accessibilityLiveRegion + accessibilityLabel. */}
        <View
          ref={sizeRef}
          accessibilityLiveRegion="polite"
          accessibilityLabel={`Font size ${size} pixels`}
          {...(Platform.OS === "web"
            ? {
                role: "status" as const,
                "aria-live": "polite" as const,
              }
            : {})}
          className="w-20 items-center justify-center"
        >
          {Platform.OS === "web" && (
            <Text
              style={{
                position: "absolute",
                width: 1,
                height: 1,
                overflow: "hidden",
                opacity: 0,
              }}
            >
              {"Font size "}
            </Text>
          )}
          <Text className="text-tp-text-primary text-4xl font-bold text-center">
            {size}
          </Text>
          {Platform.OS === "web" && (
            <Text
              style={{
                position: "absolute",
                width: 1,
                height: 1,
                overflow: "hidden",
                opacity: 0,
              }}
            >
              {" pixels"}
            </Text>
          )}
        </View>
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
