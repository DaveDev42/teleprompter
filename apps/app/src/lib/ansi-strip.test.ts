import { describe, expect, test } from "bun:test";
import { stripAnsi } from "./ansi-strip";

describe("stripAnsi", () => {
  test("removes SGR color sequences", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
    expect(stripAnsi("\x1b[1;32;4mbold underline green\x1b[0m")).toBe(
      "bold underline green",
    );
  });

  test("removes cursor/erase sequences", () => {
    expect(stripAnsi("before\x1b[2Kafter")).toBe("beforeafter");
    expect(stripAnsi("\x1b[10;20Hhi")).toBe("hi");
  });

  test("removes OSC hyperlink / title sequences", () => {
    expect(stripAnsi("\x1b]0;title\x07body")).toBe("body");
    expect(stripAnsi("\x1b]8;;https://x\x07link\x1b]8;;\x07")).toBe("link");
  });

  test("removes charset/designator/keypad mode toggles", () => {
    expect(stripAnsi("\x1b(Bplain")).toBe("plain");
    expect(stripAnsi("\x1b>text\x1b=")).toBe("text");
  });

  test("strips bare C0 control bytes but keeps tab/newline", () => {
    expect(stripAnsi("a\x01b\x02c")).toBe("abc");
    expect(stripAnsi("a\tb\nc")).toBe("a\tb\nc");
  });

  test("normalises CRLF and lone CR to LF", () => {
    expect(stripAnsi("a\r\nb\rc")).toBe("a\nb\nc");
  });

  test("round-trips plain text unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  test("strips CSI sequences with private-use prefixes (>, <, =, ?)", () => {
    // PR #193 regression: claude code's PTY emits `ESC [ > 4 m` (modify
    // keyboard mode) and `ESC [ < u` (mouse-mode query). The original
    // CSI regex `[0-9;?]*` rejected `>`/`<`/`=`, leaving the `>4m` /
    // `<u` characters visible in the chat bubble.
    expect(stripAnsi("\x1b[>4mvisible")).toBe("visible");
    expect(stripAnsi("a\x1b[>4;2mb")).toBe("ab");
    expect(stripAnsi("\x1b[<ucontent")).toBe("content");
    expect(stripAnsi("\x1b[=1htext")).toBe("text");
    expect(stripAnsi("\x1b[?25hcursor")).toBe("cursor");
  });

  test("strips OSC sequences terminated by ST (ESC \\\\)", () => {
    // OSC may end with ST (ESC \) instead of BEL. The original regex only
    // accepted BEL, so an ST-terminated OSC would leak the trailing
    // characters into the chat bubble.
    expect(stripAnsi("\x1b]0;title\x1b\\body")).toBe("body");
    expect(stripAnsi("\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
  });

  test("strips ESC 7 / ESC 8 cursor save/restore", () => {
    expect(stripAnsi("a\x1b7b\x1b8c")).toBe("abc");
  });

  test("handles the v0.1.22 QA reproduction (claude PTY epilogue)", () => {
    // Captured from a passthrough session's Chat-tab streaming bubble during
    // 2026-05-11 QA: claude emits a save+OSC+CSI epilogue that previously
    // leaked `[>4m[<u78]0;` and similar artifacts.
    const captured = "Done.\x1b7\x1b[>4m\x1b[<u\x1b[?78l\x1b]0;claude\x07\x1b8";
    expect(stripAnsi(captured)).toBe("Done.");
  });
});
