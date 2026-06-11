/**
 * Unit tests for the pure global-shortcut guard rules. The guards are
 * DOM-free by design (duck-typed targets), so these tests run under plain
 * bun:test with no document and no mock.module.
 *
 * Run with:
 *   bun test apps/app/src/lib/shortcut-guards.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  isShortcutEligible,
  isShortcutOptOutTarget,
  SHORTCUTS_DISABLED_ATTR,
  type ShortcutKeyEvent,
} from "./shortcut-guards";

function makeEvent(
  overrides: Partial<ShortcutKeyEvent> = {},
): ShortcutKeyEvent {
  return {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    repeat: false,
    defaultPrevented: false,
    target: { tagName: "DIV", closest: () => null },
    ...overrides,
  };
}

describe("isShortcutOptOutTarget", () => {
  test("text inputs are opted out", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(isShortcutOptOutTarget({ tagName })).toBe(true);
    }
  });

  test("contenteditable surfaces are opted out", () => {
    expect(
      isShortcutOptOutTarget({ tagName: "DIV", isContentEditable: true }),
    ).toBe(true);
  });

  test("elements inside a data-shortcuts-disabled container are opted out", () => {
    const seen: string[] = [];
    const target = {
      tagName: "DIV",
      closest: (sel: string) => {
        seen.push(sel);
        return { tagName: "DIV" };
      },
    };
    expect(isShortcutOptOutTarget(target)).toBe(true);
    expect(seen).toEqual([`[${SHORTCUTS_DISABLED_ATTR}]`]);
  });

  test("plain elements are not opted out", () => {
    expect(
      isShortcutOptOutTarget({ tagName: "DIV", closest: () => null }),
    ).toBe(false);
    expect(isShortcutOptOutTarget({ tagName: "BUTTON" })).toBe(false);
  });

  test("null / non-object targets are not opted out", () => {
    expect(isShortcutOptOutTarget(null)).toBe(false);
    expect(isShortcutOptOutTarget(undefined)).toBe(false);
    expect(isShortcutOptOutTarget("body")).toBe(false);
  });
});

describe("isShortcutEligible", () => {
  test("plain keydown on a non-editable target is eligible", () => {
    expect(isShortcutEligible(makeEvent())).toBe(true);
  });

  test("shift does not disqualify — '?' needs it", () => {
    // ShortcutKeyEvent has no shiftKey field on purpose; a shifted event
    // differs only in fields the guard ignores.
    expect(
      isShortcutEligible({
        ...makeEvent(),
        shiftKey: true,
      } as ShortcutKeyEvent),
    ).toBe(true);
  });

  test("modifier chords are never eligible", () => {
    expect(isShortcutEligible(makeEvent({ ctrlKey: true }))).toBe(false);
    expect(isShortcutEligible(makeEvent({ metaKey: true }))).toBe(false);
    expect(isShortcutEligible(makeEvent({ altKey: true }))).toBe(false);
  });

  test("auto-repeat is not eligible", () => {
    expect(isShortcutEligible(makeEvent({ repeat: true }))).toBe(false);
  });

  test("already-handled events are not eligible", () => {
    expect(isShortcutEligible(makeEvent({ defaultPrevented: true }))).toBe(
      false,
    );
  });

  test("editable targets are not eligible", () => {
    expect(
      isShortcutEligible(makeEvent({ target: { tagName: "TEXTAREA" } })),
    ).toBe(false);
  });
});
