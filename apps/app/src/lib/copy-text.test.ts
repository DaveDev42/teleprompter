/**
 * Unit tests for copyText — the clipboard helper that emits a toast
 * so screen readers can hear the status change (WCAG 2.1 SC 4.1.3
 * Status Messages, AA). Without the toast call, the copy action is
 * silent to AT users — they have no way to confirm success or
 * failure.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const showToastMock = mock(() => {});

mock.module("../stores/notification-store", () => ({
  useNotificationStore: {
    getState: () => ({ showToast: showToastMock }),
  },
}));

mock.module("react-native", () => ({
  Platform: { OS: "web" },
}));

// `import` after mock.module so the helper picks up the mocked deps.
const { copyText } = await import("./copy-text");

describe("copyText", () => {
  beforeEach(() => {
    showToastMock.mockClear();
  });
  afterEach(() => {
    // @ts-expect-error — test cleanup
    delete (globalThis as { navigator?: unknown }).navigator;
  });

  test("announces success via toast on writeText resolve", async () => {
    const writeText = mock((_text: string) => Promise.resolve());
    (globalThis as { navigator?: unknown }).navigator = {
      clipboard: { writeText },
    };

    await copyText("hello");

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(showToastMock).toHaveBeenCalledWith({
      title: "Copied",
      body: "Text copied to clipboard",
    });
  });

  test("announces failure via toast on writeText reject", async () => {
    const writeText = mock((_text: string) =>
      Promise.reject(new Error("denied")),
    );
    (globalThis as { navigator?: unknown }).navigator = {
      clipboard: { writeText },
    };

    await copyText("hello");

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(showToastMock).toHaveBeenCalledWith({
      title: "Copy failed",
      body: "Could not copy text to clipboard",
    });
  });

  test("no-op (no toast) when navigator.clipboard is unavailable", async () => {
    (globalThis as { navigator?: unknown }).navigator = {};

    await copyText("hello");

    expect(showToastMock).not.toHaveBeenCalled();
  });
});
