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
});
