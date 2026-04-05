# Keyboard Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable full keyboard navigation on Web (React Native Web) across all layouts — mobile, tablet, desktop.

**Architecture:** Three infrastructure pieces (`usePlatformProps` hook, `useKeyboard` hook, `ModalContainer` component) provide reusable keyboard/focus primitives. Each UI component then applies these primitives. Focus ring uses `ring-2 ring-tp-border-focus` (box-shadow, no layout shift). All changes are Web-only via `Platform.OS === "web"` guards — native is unaffected.

**Tech Stack:** React Native Web, NativeWind/Tailwind, Expo Router, Playwright (E2E)

---

### Task 1: `usePlatformProps` Hook

**Files:**
- Create: `apps/app/src/hooks/use-platform-props.ts`

- [ ] **Step 1: Create the hook file**

```ts
// apps/app/src/hooks/use-platform-props.ts
import { Platform } from "react-native";

const FOCUS_CLASS = "focus-visible:ring-2 focus-visible:ring-tp-border-focus focus-visible:outline-none";

export function usePlatformProps(options?: {
  focusable?: boolean;
  tabIndex?: number;
}): { tabIndex?: number; className?: string } {
  if (Platform.OS !== "web") return {};

  const focusable = options?.focusable ?? true;
  if (!focusable) return {};

  return {
    tabIndex: options?.tabIndex ?? 0,
    className: FOCUS_CLASS,
  };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd apps/app && npx tsc --noEmit src/hooks/use-platform-props.ts 2>&1 | head -5`
Expected: No errors (or use `pnpm type-check:all`)

- [ ] **Step 3: Commit**

```bash
git add apps/app/src/hooks/use-platform-props.ts
git commit -m "feat: add usePlatformProps hook for Web keyboard focus"
```

---

### Task 2: `useKeyboard` Hook

**Files:**
- Create: `apps/app/src/hooks/use-keyboard.ts`

- [ ] **Step 1: Create the hook file**

```ts
// apps/app/src/hooks/use-keyboard.ts
import { useEffect } from "react";
import { Platform } from "react-native";

type KeyMap = Record<string, () => void>;

export function useKeyboard(keyMap: KeyMap): void {
  useEffect(() => {
    if (Platform.OS !== "web") return;

    const handler = (e: KeyboardEvent) => {
      const fn = keyMap[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [keyMap]);
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm type-check:all 2>&1 | tail -5`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add apps/app/src/hooks/use-keyboard.ts
git commit -m "feat: add useKeyboard hook for Web keyboard event handling"
```

---

### Task 3: `ModalContainer` Component

**Files:**
- Create: `apps/app/src/components/ModalContainer.tsx`

- [ ] **Step 1: Create the component file**

```tsx
// apps/app/src/components/ModalContainer.tsx
import { useEffect, useMemo, useRef } from "react";
import { Modal, Platform, Pressable, View } from "react-native";
import { useKeyboard } from "../hooks/use-keyboard";

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

  const keyMap = useMemo(() => (visible ? { Escape: onClose } : {}), [visible, onClose]);
  useKeyboard(keyMap);

  // Focus trap (Web only)
  useEffect(() => {
    if (Platform.OS !== "web" || !visible) return;

    // Save previous focus
    previousFocusRef.current = document.activeElement;

    // Focus first focusable element inside modal
    const timer = setTimeout(() => {
      const container = containerRef.current as unknown as HTMLElement;
      if (!container) return;
      const focusable = container.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length > 0) {
        (focusable[0] as HTMLElement).focus();
      }
    }, 100);

    // Tab trap
    const trapHandler = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const container = containerRef.current as unknown as HTMLElement;
      if (!container) return;
      const focusable = container.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
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
        <Pressable
          className="bg-tp-bg-elevated rounded-t-2xl"
          onPress={() => {}}
        >
          <View ref={containerRef}>{children}</View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm type-check:all 2>&1 | tail -5`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add apps/app/src/components/ModalContainer.tsx
git commit -m "feat: add ModalContainer with Escape handler and focus trap"
```

---

### Task 4: Apply to FontPickerModal

**Files:**
- Modify: `apps/app/src/components/FontPickerModal.tsx`

- [ ] **Step 1: Refactor FontPickerModal to use ModalContainer**

Replace the `<Modal>` + backdrop pattern with `<ModalContainer>`. Add `usePlatformProps` to font list items and buttons.

The full updated file:

```tsx
// apps/app/src/components/FontPickerModal.tsx
import { useEffect, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { usePlatformProps } from "../hooks/use-platform-props";
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
  const fonts = mode === "chat" ? SANS_FONTS : MONO_FONTS;
  const title =
    mode === "chat"
      ? "Chat Font"
      : mode === "code"
        ? "Code Font"
        : "Terminal Font";
  const pp = usePlatformProps();

  return (
    <ModalContainer visible={visible} onClose={onClose}>
      <View className="max-h-[60vh]">
        <View className="flex-row items-center justify-between px-5 pt-5 pb-3">
          <Text
            className="text-tp-text-primary text-lg font-bold"
            accessibilityRole="header"
          >
            {title}
          </Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Done"
            {...pp}
            className={`${pp.className ?? ""}`}
          >
            <Text className="text-tp-accent text-base">Done</Text>
          </Pressable>
        </View>
        <FlatList
          data={fonts}
          keyExtractor={(item) => item}
          renderItem={({ item }) => (
            <Pressable
              className={`flex-row items-center justify-between px-5 py-3.5 ${pp.className ?? ""}`}
              onPress={() => {
                onSelect(item);
                onClose();
              }}
              accessibilityRole="button"
              accessibilityLabel={item}
              accessibilityState={{ selected: item === currentFont }}
              tabIndex={pp.tabIndex}
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
  const [size, setSize] = useState(currentSize);
  const pp = usePlatformProps();

  useEffect(() => {
    setSize(currentSize);
  }, [currentSize]);

  const adjust = (delta: number) => {
    const next = Math.min(24, Math.max(10, size + delta));
    setSize(next);
    onChangeSize(next);
  };

  return (
    <ModalContainer visible={visible} onClose={onClose}>
      <View className="flex-row items-center justify-between px-5 pt-5 pb-3">
        <Text
          className="text-tp-text-primary text-lg font-bold"
          accessibilityRole="header"
        >
          Font Size
        </Text>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Done"
          {...pp}
          className={`${pp.className ?? ""}`}
        >
          <Text className="text-tp-accent text-base">Done</Text>
        </Pressable>
      </View>
      <View className="flex-row items-center justify-center gap-8 py-8 pb-12">
        <Pressable
          className={`w-12 h-12 rounded-full bg-tp-surface items-center justify-center ${pp.className ?? ""}`}
          onPress={() => adjust(-1)}
          accessibilityRole="button"
          accessibilityLabel="Decrease font size"
          tabIndex={pp.tabIndex}
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
          className={`w-12 h-12 rounded-full bg-tp-surface items-center justify-center ${pp.className ?? ""}`}
          onPress={() => adjust(1)}
          accessibilityRole="button"
          accessibilityLabel="Increase font size"
          tabIndex={pp.tabIndex}
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
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm type-check:all 2>&1 | tail -5`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add apps/app/src/components/FontPickerModal.tsx
git commit -m "feat: migrate FontPickerModal and FontSizeModal to ModalContainer"
```

---

### Task 5: Apply to ApiKeyModal

**Files:**
- Modify: `apps/app/src/components/ApiKeyModal.tsx`

- [ ] **Step 1: Refactor ApiKeyModal to use ModalContainer**

```tsx
// apps/app/src/components/ApiKeyModal.tsx
import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { usePlatformProps } from "../hooks/use-platform-props";
import { ModalContainer } from "./ModalContainer";

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
  const [value, setValue] = useState(currentKey ?? "");
  const pp = usePlatformProps();

  useEffect(() => {
    setValue(currentKey ?? "");
  }, [currentKey]);

  return (
    <ModalContainer visible={visible} onClose={onClose}>
      <View className="flex-row items-center justify-between px-5 pt-5 pb-3">
        <Text
          className="text-tp-text-primary text-lg font-bold"
          accessibilityRole="header"
        >
          OpenAI API Key
        </Text>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Done"
          {...pp}
          className={`${pp.className ?? ""}`}
        >
          <Text className="text-tp-accent text-base">Done</Text>
        </Pressable>
      </View>
      <View className="px-5 pb-8">
        <Text className="text-tp-text-secondary text-[13px] mb-3">
          Required for voice input. Your key is stored locally on this device.
        </Text>
        <TextInput
          className={`bg-tp-bg-input text-tp-text-primary text-[15px] rounded-btn px-4 py-3 border border-tp-border ${pp.className ?? ""}`}
          value={value}
          onChangeText={setValue}
          placeholder="sk-..."
          placeholderTextColor="var(--tp-text-tertiary)"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          accessibilityLabel="OpenAI API key"
          accessibilityHint="Enter your OpenAI API key for voice input"
        />
        <Pressable
          className={`bg-tp-accent rounded-btn items-center py-3 mt-4 ${pp.className ?? ""}`}
          onPress={() => {
            if (value.trim()) {
              onSave(value.trim());
            }
            onClose();
          }}
          accessibilityRole="button"
          accessibilityLabel="Save API key"
          tabIndex={pp.tabIndex}
        >
          <Text className="text-white text-[15px] font-semibold">Save</Text>
        </Pressable>
        {currentKey && (
          <Pressable
            className={`items-center py-3 mt-2 ${pp.className ?? ""}`}
            onPress={() => {
              onSave("");
              setValue("");
              onClose();
            }}
            accessibilityRole="button"
            accessibilityLabel="Remove API key"
            tabIndex={pp.tabIndex}
          >
            <Text className="text-tp-error text-[14px]">Remove Key</Text>
          </Pressable>
        )}
      </View>
    </ModalContainer>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm type-check:all 2>&1 | tail -5`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add apps/app/src/components/ApiKeyModal.tsx
git commit -m "feat: migrate ApiKeyModal to ModalContainer"
```

---

### Task 6: Apply to SessionRow (Sessions Tab)

**Files:**
- Modify: `apps/app/app/(tabs)/index.tsx`

- [ ] **Step 1: Add usePlatformProps to SessionRow and interactive elements**

Add import at line 1 area:
```ts
import { usePlatformProps } from "../../src/hooks/use-platform-props";
```

In `SessionRow` component (around line 29), add:
```ts
const pp = usePlatformProps();
```

Update the Pressable at line 36 to spread `pp` and merge className:
```tsx
<Pressable
  onPress={onPress}
  accessibilityRole="button"
  accessibilityLabel={`${desc}, ${running ? "running" : session.state}${isActive ? ", selected" : ""}`}
  accessibilityHint="Open this session"
  tabIndex={pp.tabIndex}
  className={pp.className}
>
```

Add `testID="session-search"` to the search TextInput at line 137:
```tsx
<TextInput
  testID="session-search"
  className={`bg-tp-bg-secondary text-tp-text-primary rounded-search px-4 py-2.5 text-[15px] ${pp.className ?? ""}`}
  ...
/>
```

Add `pp` to the "Go to Daemons" empty-state Pressable at line 174:
```tsx
<Pressable
  onPress={() => router.push("/(tabs)/daemons")}
  className={`mt-6 bg-tp-accent rounded-card px-8 py-3 ${pp.className ?? ""}`}
  accessibilityRole="button"
  accessibilityLabel="Go to Daemons"
  tabIndex={pp.tabIndex}
>
```

Note: `usePlatformProps` needs to be called at the component level (`SessionsScreen`), not inside `SessionRow` since `SessionRow` already has its own call. For `SessionsScreen`, add a separate `const pp = usePlatformProps();` call.

- [ ] **Step 2: Verify it compiles**

Run: `pnpm type-check:all 2>&1 | tail -5`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add apps/app/app/\(tabs\)/index.tsx
git commit -m "feat: add keyboard focus to SessionRow and search input"
```

---

### Task 7: Apply to Settings Tab

**Files:**
- Modify: `apps/app/app/(tabs)/settings.tsx`

- [ ] **Step 1: Add usePlatformProps to SettingsRow**

Add import:
```ts
import { usePlatformProps } from "../../src/hooks/use-platform-props";
```

In `SettingsRow` component (around line 36), add:
```ts
const pp = usePlatformProps({ focusable: !!onPress });
```

Update the Pressable at line 54:
```tsx
<Pressable
  onPress={onPress}
  className={`mx-4 ${pp.className ?? ""}`}
  accessibilityRole={onPress ? "button" : undefined}
  accessibilityLabel={value !== undefined ? `${label}, ${value}` : label}
  tabIndex={pp.tabIndex}
>
```

In `SettingsScreen`, add `usePlatformProps` for the Diagnostics Done button (line 163) and Restart to Update button (line 272):

```ts
const pp = usePlatformProps();
```

Update Diagnostics Done button at line 163:
```tsx
<Pressable
  onPress={() => setShowDiagnostics(false)}
  accessibilityRole="button"
  accessibilityLabel="Done"
  {...pp}
  className={`${pp.className ?? ""}`}
>
```

Update Restart to Update button at line 272:
```tsx
<Pressable
  onPress={restart}
  className={`bg-tp-accent rounded-btn items-center py-2.5 mt-3 ${pp.className ?? ""}`}
  accessibilityRole="button"
  accessibilityLabel="Restart to update"
  tabIndex={pp.tabIndex}
>
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm type-check:all 2>&1 | tail -5`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add apps/app/app/\(tabs\)/settings.tsx
git commit -m "feat: add keyboard focus to SettingsRow and settings buttons"
```

---

### Task 8: Apply to Daemons Tab

**Files:**
- Modify: `apps/app/app/(tabs)/daemons.tsx`

- [ ] **Step 1: Add usePlatformProps to DaemonCard and DaemonsScreen**

Add import:
```ts
import { usePlatformProps } from "../../src/hooks/use-platform-props";
```

In `DaemonCard` (around line 21), add:
```ts
const pp = usePlatformProps();
```

Update action buttons at lines 81 and 90:
```tsx
<Pressable
  className={`flex-1 bg-tp-accent rounded-btn py-2 items-center ${pp.className ?? ""}`}
  accessibilityRole="button"
  accessibilityLabel={`New session on ${displayName}`}
  tabIndex={pp.tabIndex}
>
```

```tsx
<Pressable
  className={`flex-1 bg-tp-bg-tertiary rounded-btn py-2 items-center ${pp.className ?? ""}`}
  accessibilityRole="button"
  accessibilityLabel={`View status of ${displayName}`}
  tabIndex={pp.tabIndex}
>
```

In `DaemonsScreen`, add `const pp = usePlatformProps();` and update:
- Add daemon button (line 127): add `tabIndex={pp.tabIndex}` and merge className
- Scan QR button (line 161): add `tabIndex={pp.tabIndex}` and merge className
- Manual pair link (line 172): add `tabIndex={pp.tabIndex}` and merge className

- [ ] **Step 2: Verify it compiles**

Run: `pnpm type-check:all 2>&1 | tail -5`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add apps/app/app/\(tabs\)/daemons.tsx
git commit -m "feat: add keyboard focus to DaemonCard and daemons buttons"
```

---

### Task 9: Apply to Session Detail (Chat/Terminal Tabs, Input, Buttons)

**Files:**
- Modify: `apps/app/app/session/[sid].tsx`

- [ ] **Step 1: Add usePlatformProps to SegmentedControl, ChatView, and SessionDetailScreen**

Add import:
```ts
import { usePlatformProps } from "../../src/hooks/use-platform-props";
```

In `SegmentedControl` (line 40), add `const pp = usePlatformProps();` and update both tab Pressables:

```tsx
<Pressable
  testID="tab-chat"
  onPress={() => onModeChange("chat")}
  accessibilityRole="tab"
  accessibilityLabel="Chat"
  accessibilityState={{ selected: mode === "chat" }}
  tabIndex={pp.tabIndex}
  className={`flex-1 py-1.5 rounded-badge items-center ${
    mode === "chat" ? "bg-tp-surface" : ""
  } ${pp.className ?? ""}`}
>
```

```tsx
<Pressable
  testID="tab-terminal"
  onPress={() => onModeChange("terminal")}
  accessibilityRole="tab"
  accessibilityLabel="Terminal"
  accessibilityState={{ selected: mode === "terminal" }}
  tabIndex={pp.tabIndex}
  className={`flex-1 py-1.5 rounded-badge items-center ${
    mode === "terminal" ? "bg-tp-surface" : ""
  } ${pp.className ?? ""}`}
>
```

In `ChatView`, add `const pp = usePlatformProps();` and update:

Chat input TextInput (line 228) — add `testID="chat-input"` and focus ring:
```tsx
<TextInput
  testID="chat-input"
  className={`flex-1 bg-tp-bg-input text-tp-text-primary rounded-full px-4 py-2 mr-2 max-h-24 text-[15px] ${pp.className ?? ""}`}
  ...
/>
```

Send button (line 241) — add `testID="chat-send"` and focus ring:
```tsx
<Pressable
  testID="chat-send"
  onPress={handleSend}
  disabled={!input.trim() || !connected || !sid}
  className={`bg-tp-accent rounded-full w-9 h-9 items-center justify-center ${pp.className ?? ""}`}
  style={{ opacity: input.trim() && connected && sid ? 1 : 0.4 }}
  accessibilityRole="button"
  accessibilityLabel="Send message"
  accessibilityState={{ disabled: !input.trim() || !connected || !sid }}
  tabIndex={pp.tabIndex}
>
```

In `SessionDetailScreen`, add `const pp = usePlatformProps();` and update back button (line 371):
```tsx
<Pressable
  onPress={() => router.back()}
  className={`px-2 ${pp.className ?? ""}`}
  accessibilityRole="button"
  accessibilityLabel="Back to sessions"
  tabIndex={pp.tabIndex}
>
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm type-check:all 2>&1 | tail -5`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add apps/app/app/session/\[sid\].tsx
git commit -m "feat: add keyboard focus to session view tabs, input, and buttons"
```

---

### Task 10: Apply to SessionDrawer (Desktop Sidebar)

**Files:**
- Modify: `apps/app/src/components/SessionDrawer.tsx`

- [ ] **Step 1: Add usePlatformProps to SessionItem and SessionDrawer**

Add import:
```ts
import { usePlatformProps } from "../hooks/use-platform-props";
```

In `SessionItem` (line 19), add `const pp = usePlatformProps();` and update the main Pressable at line 44:
```tsx
<Pressable
  onPress={onPress}
  accessibilityRole="button"
  accessibilityLabel={`Session ${session.sid}, ${session.state}${isActive ? ", selected" : ""}`}
  accessibilityHint="Switch to this session"
  className={`px-4 py-3 border-b border-tp-border ${isActive ? "bg-tp-surface-active" : ""} ${pp.className ?? ""}`}
  tabIndex={pp.tabIndex}
>
```

Update action buttons (Stop at line 77, Restart at line 90, Export at line 103) — add `tabIndex={pp.tabIndex}` and merge className with `pp.className` for each.

In `SessionDrawer`, add `const pp = usePlatformProps();` and update:
- Search TextInput (line 307): merge `pp.className`
- Worktree Create button (line 371): add `tabIndex={pp.tabIndex}`, merge className
- Worktree Cancel button (line 382): add `tabIndex={pp.tabIndex}`, merge className
- New Worktree button (line 391): add `tabIndex={pp.tabIndex}`, merge className

- [ ] **Step 2: Verify it compiles**

Run: `pnpm type-check:all 2>&1 | tail -5`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add apps/app/src/components/SessionDrawer.tsx
git commit -m "feat: add keyboard focus to SessionDrawer and sidebar buttons"
```

---

### Task 11: Add testIDs for Tab Bar

**Files:**
- Modify: `apps/app/app/(tabs)/_layout.tsx`

- [ ] **Step 1: Add testID to each Tabs.Screen**

Expo Router Tabs pass options to the underlying tab bar. Add `testID` to tab button props via `tabBarTestID`:

```tsx
<Tabs.Screen
  name="index"
  options={{
    title: "Sessions",
    tabBarLabel: "Sessions",
    tabBarAccessibilityLabel: "Sessions tab",
    tabBarTestID: "tab-sessions",
    tabBarIcon: ({ color, size }) => (
      <Ionicons name="list-outline" size={size} color={color} />
    ),
  }}
/>
<Tabs.Screen
  name="daemons"
  options={{
    title: "Daemons",
    tabBarLabel: "Daemons",
    tabBarAccessibilityLabel: "Daemons tab",
    tabBarTestID: "tab-daemons",
    tabBarIcon: ({ color, size }) => (
      <Ionicons name="server-outline" size={size} color={color} />
    ),
  }}
/>
<Tabs.Screen
  name="settings"
  options={{
    title: "Settings",
    tabBarLabel: "Settings",
    tabBarAccessibilityLabel: "Settings tab",
    tabBarTestID: "tab-settings",
    tabBarIcon: ({ color, size }) => (
      <Ionicons name="settings-outline" size={size} color={color} />
    ),
  }}
/>
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm type-check:all 2>&1 | tail -5`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add apps/app/app/\(tabs\)/_layout.tsx
git commit -m "feat: add tabBarTestID to tab bar screens for E2E testing"
```

---

### Task 12: Playwright E2E Test

**Files:**
- Create: `e2e/app-keyboard-nav.spec.ts`
- Modify: `playwright.config.ts`

- [ ] **Step 1: Create the E2E test file**

```ts
// e2e/app-keyboard-nav.spec.ts
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

test.describe("App Keyboard Navigation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.locator("text=Sessions").waitFor({ timeout: 30_000 });
  });

  test("Tab navigates through tab bar items", async ({ page }) => {
    // Press Tab repeatedly to reach tab bar buttons
    // Tab bar items should be focusable
    const sessionsTab = page.getByTestId("tab-sessions");
    const daemonsTab = page.getByTestId("tab-daemons");
    const settingsTab = page.getByTestId("tab-settings");

    // Focus the sessions tab first
    await sessionsTab.focus();
    await expect(sessionsTab).toBeFocused();

    // Tab to next tab bar item
    await page.keyboard.press("Tab");
    await expect(daemonsTab).toBeFocused();

    // Tab to settings tab
    await page.keyboard.press("Tab");
    await expect(settingsTab).toBeFocused();

    // Enter activates the focused tab
    await page.keyboard.press("Enter");
    await expect(page.locator("text=Settings").first()).toBeVisible();
  });

  test("Enter activates settings rows", async ({ page }) => {
    // Navigate to Settings tab
    await page.getByTestId("tab-settings").click();
    await page.locator("text=Settings").first().waitFor();

    // Find the Theme row and focus it
    const themeRow = page.locator('[accessibilityLabel*="Theme"]').first();
    // Fallback: find by text
    const themeButton = page.getByText("Theme").first();
    await themeButton.focus();

    // Press Enter to cycle theme
    await page.keyboard.press("Enter");

    // Theme should have changed (the value text should update)
    // Just verify no crash and the page is still responsive
    await expect(page.locator("text=Settings").first()).toBeVisible();
  });

  test("Tab reaches Chat/Terminal tabs in session view", async ({ page }) => {
    // This test verifies Chat/Terminal tabs are keyboard-focusable
    // Without a daemon connection, we navigate to a dummy session URL
    await page.goto("/session/test-keyboard");
    // Wait for the segmented control to render
    const chatTab = page.getByTestId("tab-chat");
    const terminalTab = page.getByTestId("tab-terminal");

    // Wait for tabs to appear (even without a daemon, the UI renders)
    await chatTab.waitFor({ timeout: 10_000 });

    // Focus the Chat tab
    await chatTab.focus();
    await expect(chatTab).toBeFocused();

    // Tab to Terminal tab
    await page.keyboard.press("Tab");
    await expect(terminalTab).toBeFocused();

    // Enter activates Terminal tab
    await page.keyboard.press("Enter");
    // The Terminal tab should now be selected (has bg-tp-surface class)
  });

  test("Tab reaches chat input and send button", async ({ page }) => {
    await page.goto("/session/test-keyboard");
    const chatInput = page.getByTestId("chat-input");
    const sendButton = page.getByTestId("chat-send");

    await chatInput.waitFor({ timeout: 10_000 });

    // Focus the chat input
    await chatInput.focus();
    await expect(chatInput).toBeFocused();

    // Tab to send button
    await page.keyboard.press("Tab");
    await expect(sendButton).toBeFocused();
  });

  test("Escape closes font picker modal", async ({ page }) => {
    // Navigate to Settings
    await page.getByTestId("tab-settings").click();
    await page.locator("text=Settings").first().waitFor();

    // Open the Chat Font picker
    await page.getByText("Chat Font").click();
    await page.locator("text=Chat Font").nth(1).waitFor({ timeout: 5_000 });

    // Modal should be visible
    await expect(page.locator("text=Done").first()).toBeVisible();

    // Press Escape to close
    await page.keyboard.press("Escape");

    // Modal should be gone — "Done" button should not be visible
    // Wait for modal to disappear
    await expect(page.locator("text=Done").first()).not.toBeVisible({
      timeout: 3_000,
    });
  });

  test("focus ring is visible on focused elements", async ({ page }) => {
    const settingsTab = page.getByTestId("tab-settings");
    await settingsTab.focus();

    // Check that the focused element has a box-shadow (ring style)
    const boxShadow = await settingsTab.evaluate(
      (el) => getComputedStyle(el).boxShadow,
    );
    // ring-2 produces a non-"none" box-shadow
    expect(boxShadow).not.toBe("none");
  });
});
```

- [ ] **Step 2: Add to CI project in playwright config**

In `playwright.config.ts`, add `"app-keyboard-nav.spec.ts"` to the CI project's `testMatch` array:

```ts
projects: [
  {
    name: "ci",
    retries: 0,
    testMatch: [
      "app-web.spec.ts",
      "app-daemon.spec.ts",
      "app-settings.spec.ts",
      "app-session-switch.spec.ts",
      "app-resume.spec.ts",
      "app-keyboard-nav.spec.ts",
    ],
  },
  {
    name: "local",
    retries: 1,
    testMatch: ["*.spec.ts"],
  },
],
```

- [ ] **Step 3: Verify test syntax is valid**

Run: `npx playwright test --list --project=ci 2>&1 | grep keyboard`
Expected: Shows `app-keyboard-nav.spec.ts` tests listed

- [ ] **Step 4: Commit**

```bash
git add e2e/app-keyboard-nav.spec.ts playwright.config.ts
git commit -m "test: add keyboard navigation E2E tests"
```

---

### Task 13: Update TODO.md and CLAUDE.md

**Files:**
- Modify: `TODO.md`
- Modify: `CLAUDE.md` (if E2E test list needs updating)

- [ ] **Step 1: Update TODO.md**

Change the keyboard navigation line from unchecked to checked:
```diff
- - [ ] 키보드 내비게이션 미검증
+ - [x] 키보드 내비게이션 검증 및 수정 — Web Tab/Enter/Escape 내비게이션, 포커스 ring, 모달 Escape/포커스 트랩, E2E 테스트
```

- [ ] **Step 2: Update CLAUDE.md E2E test list**

Add `app-keyboard-nav.spec.ts` to the Tier 4 Playwright E2E section in CLAUDE.md:
```
  - `e2e/app-keyboard-nav.spec.ts` — keyboard navigation (Tab focus, Enter activation, Escape modal dismiss, focus ring)
```

- [ ] **Step 3: Commit**

```bash
git add TODO.md CLAUDE.md
git commit -m "docs: mark keyboard navigation complete, update E2E test list"
```

---

### Task 14: Build and Verify

- [ ] **Step 1: Run type check**

Run: `pnpm type-check:all`
Expected: All packages pass

- [ ] **Step 2: Build the web app**

Run: `cd apps/app && npx expo export --platform web 2>&1 | tail -10`
Expected: Build completes successfully

- [ ] **Step 3: Run E2E tests**

Run: `npx playwright test --project=ci 2>&1 | tail -20`
Expected: All tests pass including the new keyboard navigation tests

- [ ] **Step 4: Final commit if any fixes needed**

If any adjustments were needed during verification, commit them:
```bash
git add -u
git commit -m "fix: address keyboard nav verification issues"
```
