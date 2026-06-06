/**
 * Unit tests for resolveForegroundToast — the pure decision function behind
 * surfacing a foreground Expo push as an in-app toast.
 *
 * Foreground pushes are otherwise silently swallowed: the notification
 * handler hides the OS banner while the app is open, so without an explicit
 * received-listener → toast bridge the user sees nothing. These tests pin the
 * three behaviours that matter:
 *   1. a normal push becomes a toast carrying the navigation payload,
 *   2. a push for the session the user is already viewing is suppressed
 *      (mirrors the relay.notification in-band path in use-relay.ts),
 *   3. missing title/body/data degrade gracefully rather than producing a
 *      blank or unroutable toast.
 */
import { describe, expect, test } from "bun:test";
import { resolveForegroundToast } from "./push-toast";

describe("resolveForegroundToast", () => {
  test("builds a toast with full navigation payload from a daemon push", () => {
    const toast = resolveForegroundToast(
      {
        title: "Permission needed",
        body: "Claude needs your permission to use Bash",
        data: { sid: "s1", daemonId: "d1", event: "Notification" },
      },
      null,
    );
    expect(toast).toEqual({
      title: "Permission needed",
      body: "Claude needs your permission to use Bash",
      data: { sid: "s1", daemonId: "d1", event: "Notification" },
    });
  });

  test("suppresses the toast when the user is viewing the target session", () => {
    const toast = resolveForegroundToast(
      {
        title: "Permission needed",
        body: "…",
        data: { sid: "s1", daemonId: "d1", event: "Notification" },
      },
      "s1",
    );
    expect(toast).toBeNull();
  });

  test("shows the toast when the user is viewing a different session", () => {
    const toast = resolveForegroundToast(
      {
        title: "Permission needed",
        body: "…",
        data: { sid: "s1", daemonId: "d1", event: "Notification" },
      },
      "s2",
    );
    expect(toast).not.toBeNull();
    expect(toast?.data?.sid).toBe("s1");
  });

  test("falls back to generic copy when title/body are absent", () => {
    const toast = resolveForegroundToast({ data: undefined }, null);
    expect(toast).toEqual({
      title: "Claude needs attention",
      body: "Tap to open the session",
      data: undefined,
    });
  });

  test("falls back to generic copy when title/body are null", () => {
    const toast = resolveForegroundToast(
      { title: null, body: null, data: undefined },
      null,
    );
    expect(toast?.title).toBe("Claude needs attention");
    expect(toast?.body).toBe("Tap to open the session");
  });

  test("omits navigation data when the payload is partial (not routable)", () => {
    // daemon's sendPush always fills daemonId; a payload missing it didn't
    // come from our push path, so we surface the toast but drop the
    // unroutable data rather than navigating somewhere wrong on tap.
    const toast = resolveForegroundToast(
      { title: "t", body: "b", data: { sid: "s1", event: "Notification" } },
      null,
    );
    expect(toast?.data).toBeUndefined();
  });

  test("does not suppress when push has no sid even if a session is active", () => {
    const toast = resolveForegroundToast({ title: "t", body: "b" }, "s1");
    expect(toast).not.toBeNull();
  });
});
