import { useRouter } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";
import { getVisibleFocusables } from "../lib/focusable";
import {
  diffGamepadActions,
  type GamepadNavAction,
  type GamepadSnapshot,
  readGamepadSnapshot,
} from "../lib/gamepad-input-mapper";
import { isAnyModalOpen } from "../lib/modal-open-registry";
import { SHORTCUTS_DISABLED_ATTR } from "../lib/shortcut-guards";
import { useNotificationStore } from "../stores/notification-store";

/**
 * While a controller is connected this class sits on <html>. Programmatic
 * el.focus() from the poll loop does not satisfy Chromium's :focus-visible
 * heuristic, so the per-element `focus-visible:ring-*` classes never show
 * for gamepad moves — global.css renders an outline for plain :focus under
 * this class instead.
 */
export const GAMEPAD_ACTIVE_CLASS = "tp-gamepad-nav";

/**
 * Marks the element the controller focused last, so the global.css ring
 * only renders for gamepad-driven focus — keyboard focus keeps its
 * focus-visible styling and mouse clicks stay ring-free even while a
 * controller is connected.
 */
const GAMEPAD_FOCUS_ATTR = "data-gamepad-focus";

// Same targets and order as the 1/2/3 keyboard shortcuts in _layout.tsx
// and the tab bar render order in (tabs)/_layout.tsx.
const TAB_ROUTES = ["/(tabs)/", "/(tabs)/daemons", "/(tabs)/settings"];
const TAB_TESTIDS = ["tab-sessions", "tab-daemons", "tab-settings"];

/**
 * Widgets that implement their own arrow-key roving focus. A direction
 * press inside one is delegated as a synthetic Arrow keydown so the
 * widget's existing handler moves the right kind of focus (active tab,
 * listbox option, spinbutton value) instead of raw DOM-order traversal.
 */
const ARROW_WIDGET_SELECTOR =
  '[role="tablist"], [role="listbox"], [role="spinbutton"], [role="radiogroup"]';

function isTerminalFocused(): boolean {
  return !!document.activeElement?.closest(`[${SHORTCUTS_DISABLED_ATTR}]`);
}

/**
 * Root to traverse when a ModalContainer dialog is up: the sheet card
 * marked data-gamepad-modal-root (last in DOM order = top-most). Scoping
 * to the card, not the role="dialog" wrapper, keeps the backdrop Pressable
 * (focusable; clicking it closes the dialog) out of D-pad reach — and the
 * attribute exists from first render, unlike role="dialog" which RN Web
 * only sets once the slide-in animation finishes. The registry (not this
 * query) is the open/closed authority; the query only scopes traversal.
 */
function topDialog(): HTMLElement | null {
  const sheets = document.querySelectorAll<HTMLElement>(
    "[data-gamepad-modal-root]",
  );
  return sheets.length > 0 ? (sheets[sheets.length - 1] ?? null) : null;
}

/** Move the gamepad-focus ring marker to `el` (clearing any previous). */
function markGamepadFocus(el: Element | null): void {
  for (const marked of document.querySelectorAll(`[${GAMEPAD_FOCUS_ATTR}]`)) {
    if (marked !== el) marked.removeAttribute(GAMEPAD_FOCUS_ATTR);
  }
  el?.setAttribute(GAMEPAD_FOCUS_ATTR, "");
}

/**
 * Move focus to the previous/next reachable element in DOM order, wrapping
 * at the ends. With nothing focused, "next" starts at the first element and
 * "prev" at the last.
 */
function moveFocus(delta: 1 | -1, root: ParentNode): void {
  const focusables = getVisibleFocusables(root);
  if (focusables.length === 0) return;
  const current = document.activeElement;
  const idx = focusables.indexOf(current as HTMLElement);
  const target =
    idx === -1
      ? delta === 1
        ? focusables[0]
        : focusables[focusables.length - 1]
      : focusables[(idx + delta + focusables.length) % focusables.length];
  if (target) {
    markGamepadFocus(target);
    target.focus();
  }
}

/**
 * Delegate a direction press to the focused arrow-roving widget, if any.
 * Returns true when the widget consumed it — its React onKeyDown handlers
 * all call preventDefault() on handled arrows, which flips dispatchEvent's
 * return value on a cancelable event. Unhandled arrows (e.g. ArrowUp on a
 * horizontal tablist) fall through to linear traversal.
 */
function dispatchArrowToWidget(key: string): boolean {
  const el = document.activeElement;
  if (!el || el === document.body) return false;
  if (!el.closest(ARROW_WIDGET_SELECTOR)) return false;
  return !el.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
}

function moveOrDelegate(
  arrowKey: string,
  delta: 1 | -1,
  root: ParentNode,
): void {
  if (dispatchArrowToWidget(arrowKey)) {
    // The widget's roving handler moved focus synchronously — mark the
    // new target so the gamepad ring follows it.
    markGamepadFocus(document.activeElement);
    return;
  }
  moveFocus(delta, root);
}

function executeAction(
  action: GamepadNavAction,
  navigateToTab: (route: string) => void,
): void {
  const modalOpen = isAnyModalOpen();
  const root: ParentNode = (modalOpen ? topDialog() : null) ?? document;

  // The terminal swallows raw input; only B acts there, releasing focus so
  // the next D-pad press navigates the page instead of being lost.
  if (!modalOpen && isTerminalFocused()) {
    if (action === "back") {
      (document.activeElement as HTMLElement | null)?.blur();
    }
    return;
  }

  switch (action) {
    case "focus-up":
      moveOrDelegate("ArrowUp", -1, root);
      break;
    case "focus-down":
      moveOrDelegate("ArrowDown", 1, root);
      break;
    case "focus-left":
      moveOrDelegate("ArrowLeft", -1, root);
      break;
    case "focus-right":
      moveOrDelegate("ArrowRight", 1, root);
      break;
    case "activate": {
      const el = document.activeElement;
      if (el && el !== document.body && el instanceof HTMLElement) {
        el.click();
      }
      break;
    }
    case "back": {
      if (modalOpen) {
        // ModalContainer's useKeyboard listens for Escape on document
        // (capture phase) — a synthetic Escape closes the top dialog
        // through the exact code path a keyboard user takes.
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
        break;
      }
      // Screen-level back: the session screen renders a back control whose
      // onPress already implements the canGoBack/replace fallback — click
      // it so gamepad Back can never diverge from the visible button.
      document
        .querySelector<HTMLElement>('[data-testid="session-back"]')
        ?.click();
      break;
    }
    case "tab-prev":
    case "tab-next": {
      if (modalOpen) break;
      const selected = document.querySelector(
        '[role="tab"][aria-selected="true"]',
      );
      const idx = TAB_TESTIDS.indexOf(
        selected?.getAttribute("data-testid") ?? "",
      );
      // Not on a bottom-tab screen (e.g. the session screen's Chat/Terminal
      // tablist matches the query but not the testID list) → no-op.
      if (idx === -1) break;
      const next =
        (idx + (action === "tab-next" ? 1 : -1) + TAB_ROUTES.length) %
        TAB_ROUTES.length;
      const route = TAB_ROUTES[next];
      if (route) navigateToTab(route);
      break;
    }
  }
}

/**
 * Web-only gamepad navigation bridge. Maps standard-layout controller
 * input onto the app's existing focus and keyboard semantics:
 *
 * - D-pad / left stick — move focus (DOM order), delegating to arrow-roving
 *   widgets (tablist/listbox/spinbutton) via synthetic Arrow keydowns
 * - A — activate the focused control (el.click(), the same path RN Web
 *   Pressables take for Enter)
 * - B — close the open dialog (synthetic Escape), leave the terminal, or
 *   click the screen's back control
 * - LB/RB — cycle the bottom tabs (same targets as the 1/2/3 shortcuts)
 *
 * Polls via requestAnimationFrame only while at least one pad is connected
 * (the Gamepad API has no input events); rAF also stops in hidden tabs, so
 * a backgrounded app never navigates itself. Edge-triggered with no
 * auto-repeat — see lib/gamepad-input-mapper.ts for the pure input rules.
 */
export function useGamepadNav(): void {
  const router = useRouter();

  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (typeof navigator.getGamepads !== "function") return;

    let rafId: number | null = null;
    let running = false;
    let prev: GamepadSnapshot | null = null;
    // Which physical pad `prev` belongs to. Diffing snapshots from two
    // different controllers (first pad disconnects, the poll silently moves
    // to the next) would fire a phantom edge for every button the new pad
    // happens to hold — on identity change we re-baseline instead.
    let activePadIndex: number | null = null;

    const navigateToTab = (route: string) => {
      // biome-ignore lint/suspicious/noExplicitAny: expo-router's typed routes don't cover dynamically chosen tab hrefs
      router.navigate(route as any);
    };

    const firstConnectedPad = () => {
      for (const pad of navigator.getGamepads()) {
        if (pad?.connected) return pad;
      }
      return null;
    };

    const tick = () => {
      rafId = null;
      if (!running) return;
      const pad = firstConnectedPad();
      if (!pad) {
        // Every pad is gone — stop now rather than spinning no-op frames
        // until the (task-queued) gamepaddisconnected event lands.
        stopPolling();
        return;
      }
      if (pad.index !== activePadIndex) {
        // New or switched controller: make this frame the baseline rather
        // than diffing against the old pad's state (or null). Buttons held
        // at this moment — including the press that woke the pad up in
        // Chromium — must not fire as edges.
        activePadIndex = pad.index;
        prev = null;
      }
      const next = readGamepadSnapshot(pad);
      if (prev) {
        for (const action of diffGamepadActions(prev, next)) {
          executeAction(action, navigateToTab);
        }
      }
      prev = next;
      rafId = requestAnimationFrame(tick);
    };

    const startPolling = () => {
      document.documentElement.classList.add(GAMEPAD_ACTIVE_CLASS);
      if (running) return;
      running = true;
      useNotificationStore.getState().showToast({
        title: "Controller connected",
        body: "D-pad move · A select · B back · LB/RB switch tabs",
      });
      rafId = requestAnimationFrame(tick);
    };

    const stopPolling = () => {
      document.documentElement.classList.remove(GAMEPAD_ACTIVE_CLASS);
      running = false;
      prev = null;
      activePadIndex = null;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    const onConnected = () => startPolling();
    const onDisconnected = () => {
      if (!firstConnectedPad()) stopPolling();
    };

    window.addEventListener("gamepadconnected", onConnected);
    window.addEventListener("gamepaddisconnected", onDisconnected);
    // A pad connected before mount (page reload mid-session) fires no
    // event — getGamepads() is only populated after a button press, so
    // one initial check covers the "already pressing buttons" case.
    if (firstConnectedPad()) startPolling();

    return () => {
      window.removeEventListener("gamepadconnected", onConnected);
      window.removeEventListener("gamepaddisconnected", onDisconnected);
      stopPolling();
    };
  }, [router]);
}
