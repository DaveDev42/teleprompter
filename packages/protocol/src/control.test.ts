import { describe, expect, test } from "bun:test";
import type {
  ControlMessage,
  ControlRename,
  ControlUnpair,
} from "./types/control";
import { CONTROL_RENAME, CONTROL_UNPAIR } from "./types/control";

describe("control types", () => {
  test("CONTROL_UNPAIR constant is stable", () => {
    expect(CONTROL_UNPAIR).toBe("control.unpair");
  });

  test("ControlUnpair has expected shape", () => {
    const msg: ControlUnpair = {
      t: "control.unpair",
      daemonId: "daemon-abc",
      frontendId: "frontend-xyz",
      reason: "user-initiated",
      ts: 123,
    };
    expect(msg.t).toBe("control.unpair");
    expect(msg.reason).toBe("user-initiated");
  });

  test("ControlMessage discriminated union accepts unpair", () => {
    const msg: ControlMessage = {
      t: "control.unpair",
      daemonId: "d",
      frontendId: "f",
      reason: "user-initiated",
      ts: 1,
    };
    expect(msg.t).toBe("control.unpair");
  });

  test("CONTROL_RENAME constant is stable", () => {
    expect(CONTROL_RENAME).toBe("control.rename");
  });

  test("ControlRename has expected shape (Label union)", () => {
    const msg: ControlRename = {
      t: "control.rename",
      daemonId: "daemon-abc",
      frontendId: "frontend-xyz",
      label: { set: true, value: "Dave's iPhone" },
      ts: 1,
    };
    expect(msg.label).toEqual({ set: true, value: "Dave's iPhone" });
  });

  test("ControlRename label can be unset (clear)", () => {
    const msg: ControlRename = {
      t: "control.rename",
      daemonId: "daemon-abc",
      frontendId: "frontend-xyz",
      label: { set: false },
      ts: 1,
    };
    expect(msg.label).toEqual({ set: false });
  });

  test("ControlMessage union accepts rename", () => {
    const msg: ControlMessage = {
      t: "control.rename",
      daemonId: "d",
      frontendId: "f",
      label: { set: true, value: "x" },
      ts: 0,
    };
    expect(msg.t).toBe("control.rename");
  });
});
