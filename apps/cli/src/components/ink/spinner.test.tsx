/**
 * Tests for the Spinner component.
 *
 * Uses ink-testing-library for component-level render simulation.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { Spinner } from "./spinner";

afterEach(() => {
  cleanup();
});

describe("Spinner — rendering", () => {
  test("renders the message text", () => {
    const origIsTTY = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = true;

    try {
      const { lastFrame } = render(<Spinner message="Loading..." />);
      expect(lastFrame()).toContain("Loading...");
    } finally {
      (process.stdout as { isTTY?: boolean }).isTTY = origIsTTY;
    }
  });

  test("produces multiple frames over time (animation)", async () => {
    const origIsTTY = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = true;

    try {
      const { frames } = render(<Spinner message="Working" />);

      // Wait for several animation ticks
      await new Promise((r) => setTimeout(r, 200));

      // ink-testing-library records all rendered frames — there should be
      // multiple as the spinner cycles through its animation frames.
      expect(frames.length).toBeGreaterThan(1);
    } finally {
      (process.stdout as { isTTY?: boolean }).isTTY = origIsTTY;
    }
  });

  test("renders nothing (null) when stdout is not a TTY", () => {
    const origIsTTY = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = false;

    try {
      const { lastFrame } = render(<Spinner message="Loading..." />);
      // When Spinner returns null, ink renders an empty string
      const frame = lastFrame() ?? "";
      expect(frame.trim()).toBe("");
    } finally {
      (process.stdout as { isTTY?: boolean }).isTTY = origIsTTY;
    }
  });

  test("accepts 'line' frame type without error", () => {
    const origIsTTY = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = true;

    try {
      const { lastFrame } = render(<Spinner message="Testing" frame="line" />);
      expect(lastFrame()).toContain("Testing");
    } finally {
      (process.stdout as { isTTY?: boolean }).isTTY = origIsTTY;
    }
  });

  test("accepts 'arc' frame type without error", () => {
    const origIsTTY = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = true;

    try {
      const { lastFrame } = render(<Spinner message="Testing" frame="arc" />);
      expect(lastFrame()).toContain("Testing");
    } finally {
      (process.stdout as { isTTY?: boolean }).isTTY = origIsTTY;
    }
  });
});
