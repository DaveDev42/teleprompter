import { describe, expect, test } from "bun:test";
import {
  AXIS_THRESHOLD,
  BUTTON_A,
  BUTTON_B,
  BUTTON_DPAD_DOWN,
  BUTTON_DPAD_LEFT,
  BUTTON_DPAD_RIGHT,
  BUTTON_DPAD_UP,
  BUTTON_LB,
  BUTTON_RB,
  diffGamepadActions,
  type GamepadSnapshot,
  readGamepadSnapshot,
} from "./gamepad-input-mapper";

function snap(
  pressed: number[] = [],
  axes: number[] = [0, 0],
): GamepadSnapshot {
  const buttons: boolean[] = [];
  for (const i of pressed) buttons[i] = true;
  return { buttons, axes };
}

describe("diffGamepadActions", () => {
  test("button press edges map to their semantic actions", () => {
    const idle = snap();
    expect(diffGamepadActions(idle, snap([BUTTON_A]))).toEqual(["activate"]);
    expect(diffGamepadActions(idle, snap([BUTTON_B]))).toEqual(["back"]);
    expect(diffGamepadActions(idle, snap([BUTTON_LB]))).toEqual(["tab-prev"]);
    expect(diffGamepadActions(idle, snap([BUTTON_RB]))).toEqual(["tab-next"]);
    expect(diffGamepadActions(idle, snap([BUTTON_DPAD_UP]))).toEqual([
      "focus-up",
    ]);
    expect(diffGamepadActions(idle, snap([BUTTON_DPAD_DOWN]))).toEqual([
      "focus-down",
    ]);
    expect(diffGamepadActions(idle, snap([BUTTON_DPAD_LEFT]))).toEqual([
      "focus-left",
    ]);
    expect(diffGamepadActions(idle, snap([BUTTON_DPAD_RIGHT]))).toEqual([
      "focus-right",
    ]);
  });

  test("a held button does not re-fire (edge-triggered, no auto-repeat)", () => {
    const held = snap([BUTTON_A]);
    expect(diffGamepadActions(held, held)).toEqual([]);
    expect(diffGamepadActions(held, snap([BUTTON_A, BUTTON_RB]))).toEqual([
      "tab-next",
    ]);
  });

  test("releasing a button emits nothing", () => {
    expect(diffGamepadActions(snap([BUTTON_B]), snap())).toEqual([]);
  });

  test("null prev (first frame after connect) treats active inputs as fresh presses", () => {
    expect(diffGamepadActions(null, snap([BUTTON_A]))).toEqual(["activate"]);
    expect(diffGamepadActions(null, snap())).toEqual([]);
  });

  test("simultaneous presses emit all actions in a deterministic order", () => {
    expect(
      diffGamepadActions(snap(), snap([BUTTON_A, BUTTON_DPAD_DOWN])),
    ).toEqual(["focus-down", "activate"]);
  });

  test("left stick past the threshold acts as a D-pad press", () => {
    const idle = snap();
    expect(diffGamepadActions(idle, snap([], [0, -1]))).toEqual(["focus-up"]);
    expect(diffGamepadActions(idle, snap([], [0, 1]))).toEqual(["focus-down"]);
    expect(diffGamepadActions(idle, snap([], [-1, 0]))).toEqual(["focus-left"]);
    expect(diffGamepadActions(idle, snap([], [1, 0]))).toEqual(["focus-right"]);
  });

  test("stick deflection inside the threshold is ignored", () => {
    const idle = snap();
    expect(
      diffGamepadActions(idle, snap([], [AXIS_THRESHOLD, -AXIS_THRESHOLD])),
    ).toEqual([]);
    expect(diffGamepadActions(idle, snap([], [0.3, -0.3]))).toEqual([]);
  });

  test("a held stick deflection does not re-fire until it recenters", () => {
    const deflected = snap([], [0, 1]);
    expect(diffGamepadActions(deflected, deflected)).toEqual([]);
    expect(diffGamepadActions(deflected, snap([], [0, 0.9]))).toEqual([]);
    // Recenter, then deflect again → fresh edge.
    const centered = snap();
    expect(diffGamepadActions(deflected, centered)).toEqual([]);
    expect(diffGamepadActions(centered, snap([], [0, 1]))).toEqual([
      "focus-down",
    ]);
  });

  test("D-pad button and stick map to the same digital direction (no double fire)", () => {
    // Stick already holds "down"; pressing the D-pad down button is not a
    // new edge because the merged digital state was already active.
    expect(
      diffGamepadActions(snap([], [0, 1]), snap([BUTTON_DPAD_DOWN], [0, 1])),
    ).toEqual([]);
  });

  test("missing button indices and short axes arrays read as released", () => {
    expect(
      diffGamepadActions({ buttons: [], axes: [] }, { buttons: [], axes: [] }),
    ).toEqual([]);
    expect(diffGamepadActions(null, { buttons: [true], axes: [] })).toEqual([
      "activate",
    ]);
  });
});

describe("readGamepadSnapshot", () => {
  test("copies pressed flags and the first two axes into plain data", () => {
    const pad = {
      buttons: [{ pressed: true }, { pressed: false }, { pressed: true }],
      axes: [0.25, -0.75, 0.9],
    };
    expect(readGamepadSnapshot(pad)).toEqual({
      buttons: [true, false, true],
      axes: [0.25, -0.75],
    });
  });

  test("defaults absent axes to 0", () => {
    expect(readGamepadSnapshot({ buttons: [], axes: [] })).toEqual({
      buttons: [],
      axes: [0, 0],
    });
  });
});
