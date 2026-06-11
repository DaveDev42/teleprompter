/**
 * Pure mapping from standard-layout gamepad snapshots to semantic
 * navigation actions (see hooks/use-gamepad-nav.ts for the DOM side).
 * Kept DOM-free — pads are duck-typed plain data — so the edge-trigger
 * and deadzone rules are unit-testable under bun:test, which has no
 * navigator/Gamepad globals.
 */

/** Digital pad state sampled once per animation frame. */
export interface GamepadSnapshot {
  /** `pressed` per standard-mapping button index (missing index = false). */
  buttons: boolean[];
  /** Analog axes; only 0 (left stick X) and 1 (left stick Y) are read. */
  axes: number[];
}

export type GamepadNavAction =
  | "focus-up"
  | "focus-down"
  | "focus-left"
  | "focus-right"
  | "activate"
  | "back"
  | "tab-prev"
  | "tab-next";

// Standard gamepad mapping (https://w3c.github.io/gamepad/#remapping):
// 0=A, 1=B, 4=LB, 5=RB, 12-15=D-pad up/down/left/right.
export const BUTTON_A = 0;
export const BUTTON_B = 1;
export const BUTTON_LB = 4;
export const BUTTON_RB = 5;
export const BUTTON_DPAD_UP = 12;
export const BUTTON_DPAD_DOWN = 13;
export const BUTTON_DPAD_LEFT = 14;
export const BUTTON_DPAD_RIGHT = 15;

/**
 * The left stick must travel past this fraction of full deflection before
 * it counts as a digital direction press. 0.5 (not the usual 0.1-0.2
 * drift deadzone) because the stick emulates discrete D-pad taps here —
 * a half-press threshold makes accidental focus moves from a resting or
 * grazed stick impossible.
 */
export const AXIS_THRESHOLD = 0.5;

interface DigitalState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  activate: boolean;
  back: boolean;
  tabPrev: boolean;
  tabNext: boolean;
}

/** Collapse buttons + left stick into one digital state per direction. */
function toDigitalState(snap: GamepadSnapshot): DigitalState {
  const b = (i: number) => snap.buttons[i] === true;
  const x = snap.axes[0] ?? 0;
  const y = snap.axes[1] ?? 0;
  return {
    up: b(BUTTON_DPAD_UP) || y < -AXIS_THRESHOLD,
    down: b(BUTTON_DPAD_DOWN) || y > AXIS_THRESHOLD,
    left: b(BUTTON_DPAD_LEFT) || x < -AXIS_THRESHOLD,
    right: b(BUTTON_DPAD_RIGHT) || x > AXIS_THRESHOLD,
    activate: b(BUTTON_A),
    back: b(BUTTON_B),
    tabPrev: b(BUTTON_LB),
    tabNext: b(BUTTON_RB),
  };
}

const ACTION_BY_KEY: Array<[keyof DigitalState, GamepadNavAction]> = [
  ["up", "focus-up"],
  ["down", "focus-down"],
  ["left", "focus-left"],
  ["right", "focus-right"],
  ["activate", "activate"],
  ["back", "back"],
  ["tabPrev", "tab-prev"],
  ["tabNext", "tab-next"],
];

/**
 * Edge-triggered diff: an action fires only on the frame its input goes
 * from released to pressed. Holding a button emits nothing further (no
 * auto-repeat in v1), and `prev === null` (first frame after connect)
 * treats every active input as a fresh press.
 */
export function diffGamepadActions(
  prev: GamepadSnapshot | null,
  next: GamepadSnapshot,
): GamepadNavAction[] {
  const prevState = prev ? toDigitalState(prev) : null;
  const nextState = toDigitalState(next);
  const actions: GamepadNavAction[] = [];
  for (const [key, action] of ACTION_BY_KEY) {
    if (nextState[key] && !prevState?.[key]) actions.push(action);
  }
  return actions;
}

/** The subset of the Gamepad interface the snapshot reader needs. */
export interface GamepadLike {
  buttons: ReadonlyArray<{ pressed: boolean }>;
  axes: ReadonlyArray<number>;
}

/** Copy the live (mutating) Gamepad object into a plain snapshot. */
export function readGamepadSnapshot(pad: GamepadLike): GamepadSnapshot {
  return {
    buttons: pad.buttons.map((b) => b.pressed === true),
    axes: [pad.axes[0] ?? 0, pad.axes[1] ?? 0],
  };
}
