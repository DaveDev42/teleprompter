import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { setLogLevel } from "@teleprompter/protocol";
import { buildPushMessage, PushNotifier } from "./push-notifier";

beforeAll(() => setLogLevel("silent"));
afterAll(() => setLogLevel("info"));

describe("PushNotifier", () => {
  function makeSendPush() {
    return mock(
      (
        _frontendId: string,
        _token: string,
        _title: string,
        _body: string,
        _data: { sid: string; event: string },
      ) => {},
    );
  }

  it("triggers push for Elicitation event", () => {
    const sendPush = makeSendPush();
    const notifier = new PushNotifier({ sendPush });
    notifier.registerToken("fe-1", "ExponentPushToken[abc]", "ios");

    notifier.onRecord({ sid: "s1", kind: "event", name: "Elicitation" });

    expect(sendPush).toHaveBeenCalledTimes(1);
    expect(sendPush.mock.calls[0]).toEqual([
      "fe-1",
      "ExponentPushToken[abc]",
      "Response needed",
      "Claude is waiting for your answer",
      { sid: "s1", event: "Elicitation" },
    ]);
  });

  it("triggers push for PermissionRequest event", () => {
    const sendPush = makeSendPush();
    const notifier = new PushNotifier({ sendPush });
    notifier.registerToken("fe-1", "ExponentPushToken[xyz]", "android");

    notifier.onRecord({ sid: "s2", kind: "event", name: "PermissionRequest" });

    expect(sendPush).toHaveBeenCalledTimes(1);
    expect(sendPush.mock.calls[0]).toEqual([
      "fe-1",
      "ExponentPushToken[xyz]",
      "Permission needed",
      "Tool permission approval required",
      { sid: "s2", event: "PermissionRequest" },
    ]);
  });

  it("uses tool_name in PermissionRequest body when provided", () => {
    const sendPush = makeSendPush();
    const notifier = new PushNotifier({ sendPush });
    notifier.registerToken("fe-1", "tok", "ios");

    notifier.onRecord({
      sid: "s1",
      kind: "event",
      name: "PermissionRequest",
      payload: { tool_name: "Bash" },
    });

    expect(sendPush.mock.calls[0][3]).toBe("Approve Bash to continue");
  });

  it("triggers push for Notification event", () => {
    const sendPush = makeSendPush();
    const notifier = new PushNotifier({ sendPush });
    notifier.registerToken("fe-1", "tok", "ios");

    notifier.onRecord({
      sid: "s1",
      kind: "event",
      name: "Notification",
      payload: { message: "Claude needs your permission to use Bash" },
    });

    expect(sendPush).toHaveBeenCalledTimes(1);
    expect(sendPush.mock.calls[0][2]).toBe("Permission needed");
    expect(sendPush.mock.calls[0][3]).toBe(
      "Claude needs your permission to use Bash",
    );
  });

  it("falls back to generic Notification copy when message is missing", () => {
    const sendPush = makeSendPush();
    const notifier = new PushNotifier({ sendPush });
    notifier.registerToken("fe-1", "tok", "ios");

    notifier.onRecord({ sid: "s1", kind: "event", name: "Notification" });

    expect(sendPush.mock.calls[0][2]).toBe("Claude needs attention");
    expect(sendPush.mock.calls[0][3]).toBe("Tap to open the session");
  });

  it("does NOT trigger for Stop event", () => {
    const sendPush = makeSendPush();
    const notifier = new PushNotifier({ sendPush });
    notifier.registerToken("fe-1", "ExponentPushToken[abc]", "ios");

    notifier.onRecord({ sid: "s1", kind: "event", name: "Stop" });

    expect(sendPush).not.toHaveBeenCalled();
  });

  it("does NOT trigger for io records", () => {
    const sendPush = makeSendPush();
    const notifier = new PushNotifier({ sendPush });
    notifier.registerToken("fe-1", "ExponentPushToken[abc]", "ios");

    notifier.onRecord({ sid: "s1", kind: "io" });

    expect(sendPush).not.toHaveBeenCalled();
  });

  it("does NOT trigger for PostToolUse event", () => {
    const sendPush = makeSendPush();
    const notifier = new PushNotifier({ sendPush });
    notifier.registerToken("fe-1", "ExponentPushToken[abc]", "ios");

    notifier.onRecord({ sid: "s1", kind: "event", name: "PostToolUse" });

    expect(sendPush).not.toHaveBeenCalled();
  });

  it("does NOT trigger when no tokens are registered", () => {
    const sendPush = makeSendPush();
    const notifier = new PushNotifier({ sendPush });

    notifier.onRecord({ sid: "s1", kind: "event", name: "Notification" });

    expect(sendPush).not.toHaveBeenCalled();
  });

  it("sends to ALL registered frontends", () => {
    const sendPush = makeSendPush();
    const notifier = new PushNotifier({ sendPush });
    notifier.registerToken("fe-1", "token-1", "ios");
    notifier.registerToken("fe-2", "token-2", "android");
    notifier.registerToken("fe-3", "token-3", "ios");

    notifier.onRecord({ sid: "s1", kind: "event", name: "Elicitation" });

    expect(sendPush).toHaveBeenCalledTimes(3);
    const frontendIds = sendPush.mock.calls.map((c) => c[0]);
    expect(frontendIds).toContain("fe-1");
    expect(frontendIds).toContain("fe-2");
    expect(frontendIds).toContain("fe-3");
  });

  it("updates token on re-register with same frontendId", () => {
    const sendPush = makeSendPush();
    const notifier = new PushNotifier({ sendPush });
    notifier.registerToken("fe-1", "old-token", "ios");
    notifier.registerToken("fe-1", "new-token", "android");

    notifier.onRecord({ sid: "s1", kind: "event", name: "Elicitation" });

    expect(sendPush).toHaveBeenCalledTimes(1);
    expect(sendPush.mock.calls[0][1]).toBe("new-token");
    expect(sendPush.mock.calls[0][0]).toBe("fe-1");
  });

  it("unregisterToken removes frontend from receiving pushes", () => {
    const sendPush = makeSendPush();
    const notifier = new PushNotifier({ sendPush });
    notifier.registerToken("fe-1", "token-1", "ios");
    notifier.registerToken("fe-2", "token-2", "android");
    notifier.unregisterToken("fe-1");

    notifier.onRecord({ sid: "s1", kind: "event", name: "Elicitation" });

    expect(sendPush).toHaveBeenCalledTimes(1);
    expect(sendPush.mock.calls[0][0]).toBe("fe-2");
  });
});

describe("buildPushMessage", () => {
  it("Notification with idle/wait phrasing maps to Waiting title", () => {
    const m = buildPushMessage("Notification", {
      message: "Claude is waiting for your input",
    });
    expect(m.title).toBe("Waiting for input");
    expect(m.body).toBe("Claude is waiting for your input");
  });

  it("Notification with permission phrasing maps to Permission title", () => {
    const m = buildPushMessage("Notification", {
      message: "Permission required to run Bash",
    });
    expect(m.title).toBe("Permission needed");
  });

  it("truncates long Notification messages with ellipsis", () => {
    const long = "a".repeat(300);
    const m = buildPushMessage("Notification", { message: long });
    expect(m.body.endsWith("…")).toBe(true);
    expect(m.body.length).toBeLessThanOrEqual(178);
  });

  it("Elicitation prefers `message` field, falls back to `question`", () => {
    expect(buildPushMessage("Elicitation", { message: "What now?" }).body).toBe(
      "What now?",
    );
    expect(buildPushMessage("Elicitation", { question: "Pick one" }).body).toBe(
      "Pick one",
    );
  });

  it("unknown event name returns safe default", () => {
    const m = buildPushMessage("ZZZ");
    expect(m.title).toBe("Claude needs attention");
  });
});
