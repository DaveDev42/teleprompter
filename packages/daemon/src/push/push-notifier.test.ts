import { describe, expect, it, mock } from "bun:test";
import { PushNotifier } from "./push-notifier";

describe("PushNotifier", () => {
  function makeSendPush() {
    return mock(
      (
        _frontendId: string,
        _token: string,
        _title: string,
        _body: string,
        _data: { sid: string; daemonId?: string; event: string },
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
      { sid: "s1", daemonId: undefined, event: "Elicitation" },
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
      { sid: "s2", daemonId: undefined, event: "PermissionRequest" },
    ]);
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

    notifier.onRecord({ sid: "s1", kind: "event", name: "Elicitation" });

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
