/**
 * Tests for TextPrompt component and promptText helper.
 *
 * Uses ink-testing-library for component-level render/input simulation.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { TextPrompt } from "./text-prompt";

afterEach(() => {
  cleanup();
});

/** Write each character with a small delay so React state settles between events. */
async function typeChars(
  stdin: { write: (data: string) => void },
  chars: string,
  delayMs = 10,
): Promise<void> {
  for (const ch of chars) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

describe("TextPrompt — rendering", () => {
  test("renders question text", () => {
    const { lastFrame } = render(
      <TextPrompt question="Enter name:" onSubmit={() => {}} />,
    );
    expect(lastFrame()).toContain("Enter name:");
  });

  test("renders placeholder when provided and input is empty", () => {
    const { lastFrame } = render(
      <TextPrompt
        question="Label:"
        placeholder="my-label"
        onSubmit={() => {}}
      />,
    );
    expect(lastFrame()).toContain("my-label");
  });
});

describe("TextPrompt — typing", () => {
  test("typing characters updates displayed value", async () => {
    const { lastFrame, stdin } = render(
      <TextPrompt question="Name:" onSubmit={() => {}} />,
    );

    await typeChars(stdin, "hi");
    // Both characters should appear in the frame
    const frame = lastFrame() ?? "";
    expect(frame).toContain("h");
    expect(frame).toContain("i");
  });

  test("Enter submits the typed value", async () => {
    const submitted: string[] = [];
    const onSubmit = mock((val: string) => {
      submitted.push(val);
    });
    const { stdin } = render(
      <TextPrompt question="Name:" onSubmit={onSubmit} />,
    );

    await typeChars(stdin, "abc");
    stdin.write("\r"); // Enter
    await new Promise((r) => setTimeout(r, 30));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(submitted[0]).toBe("abc");
  });

  test("Escape calls onCancel", async () => {
    const onCancel = mock(() => {});
    const onSubmit = mock(() => {});
    const { stdin } = render(
      <TextPrompt question="Name:" onSubmit={onSubmit} onCancel={onCancel} />,
    );

    stdin.write("\x1B"); // ESC — ink needs >20ms to resolve as standalone escape
    await new Promise((r) => setTimeout(r, 60));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("TextPrompt — validation", () => {
  test("validate returning error string prevents submission and shows error", async () => {
    const onSubmit = mock(() => {});
    const validate = (s: string) => (s.length < 3 ? "Too short" : null);
    const { lastFrame, stdin } = render(
      <TextPrompt question="Name:" validate={validate} onSubmit={onSubmit} />,
    );

    await typeChars(stdin, "ab");
    stdin.write("\r"); // Enter — should fail validation
    await new Promise((r) => setTimeout(r, 30));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("Too short");
  });

  test("validation error clears on next keystroke", async () => {
    const onSubmit = mock(() => {});
    const validate = (s: string) => (s.length < 3 ? "Too short" : null);
    const { lastFrame, stdin } = render(
      <TextPrompt question="Name:" validate={validate} onSubmit={onSubmit} />,
    );

    await typeChars(stdin, "ab");
    stdin.write("\r"); // trigger error
    await new Promise((r) => setTimeout(r, 30));
    expect(lastFrame()).toContain("Too short");

    stdin.write("c"); // next keystroke clears error
    await new Promise((r) => setTimeout(r, 30));
    // Error should be gone now
    expect(lastFrame()).not.toContain("Too short");
  });

  test("validate returning null allows submission", async () => {
    const submitted: string[] = [];
    const onSubmit = mock((val: string) => {
      submitted.push(val);
    });
    const validate = (s: string) => (s.length >= 2 ? null : "Too short");
    const { stdin } = render(
      <TextPrompt question="Name:" validate={validate} onSubmit={onSubmit} />,
    );

    await typeChars(stdin, "ab");
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 30));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(submitted[0]).toBe("ab");
  });
});

describe("promptText — non-TTY short-circuit", () => {
  test("returns null immediately when stdin is not a TTY", async () => {
    const origIsTTY = (process.stdin as { isTTY?: boolean }).isTTY;
    (process.stdin as { isTTY?: boolean }).isTTY = false;

    try {
      const { promptText } = await import("./text-prompt");
      const result = await promptText({ question: "Enter name:" });
      expect(result).toBe(null);
    } finally {
      (process.stdin as { isTTY?: boolean }).isTTY = origIsTTY;
    }
  });

  test("returns null immediately when signal is already aborted", async () => {
    const origIsTTY = (process.stdin as { isTTY?: boolean }).isTTY;
    (process.stdin as { isTTY?: boolean }).isTTY = true;

    try {
      const controller = new AbortController();
      controller.abort();
      const { promptText } = await import("./text-prompt");
      const result = await promptText({
        question: "Enter name:",
        signal: controller.signal,
      });
      expect(result).toBe(null);
    } finally {
      (process.stdin as { isTTY?: boolean }).isTTY = origIsTTY;
    }
  });
});
