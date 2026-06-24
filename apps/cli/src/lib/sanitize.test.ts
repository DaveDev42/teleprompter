import { describe, expect, test } from "bun:test";
import { escapeXml, stripAnsi, stripDangerousOsc } from "./sanitize";

describe("stripAnsi", () => {
  test("removes CSI color/cursor sequences", () => {
    expect(stripAnsi("\x1b[2J\x1b[Hhello\x1b[0m")).toBe("hello");
    expect(stripAnsi("\x1b[31mred\x1b[39m")).toBe("red");
  });

  test("removes OSC sequences (BEL- and ST-terminated)", () => {
    expect(stripAnsi("\x1b]0;evil title\x07keep")).toBe("keep");
    expect(stripAnsi("\x1b]52;c;ZXZpbA==\x1b\\keep")).toBe("keep");
  });

  test("removes stray C0/C1 control bytes but keeps newline and tab", () => {
    expect(stripAnsi("a\x00b\x7fc")).toBe("abc");
    expect(stripAnsi("line1\nline2\tcol")).toBe("line1\nline2\tcol");
  });

  test("leaves ordinary text untouched", () => {
    expect(stripAnsi("session-1700000000000")).toBe("session-1700000000000");
    expect(stripAnsi("wss://relay.tpmt.dev")).toBe("wss://relay.tpmt.dev");
  });
});

describe("stripDangerousOsc", () => {
  test("removes OSC 52 (clipboard) and OSC 8 (hyperlink)", () => {
    expect(stripDangerousOsc("a\x1b]52;c;ZA==\x07b")).toBe("ab");
    expect(stripDangerousOsc("\x1b]8;;http://evil\x07click\x1b]8;;\x07")).toBe(
      "click",
    );
  });

  test("preserves benign color/cursor ANSI (readability)", () => {
    // Unlike stripAnsi, the dangerous-OSC filter keeps SGR/CSI so tailed PTY
    // output stays colored/readable.
    expect(stripDangerousOsc("\x1b[31mred\x1b[0m")).toBe("\x1b[31mred\x1b[0m");
  });

  test("preserves a non-dangerous OSC (e.g. OSC 0 title) — only 8/52 stripped", () => {
    const s = "\x1b]0;title\x07text";
    expect(stripDangerousOsc(s)).toBe(s);
  });
});

describe("escapeXml", () => {
  test("escapes all five XML predefined entities", () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;f");
  });

  test("a path with & cannot break out of an XML <string>", () => {
    const path = "/Users/a&b/.local/share";
    const xml = `<string>${escapeXml(path)}</string>`;
    expect(xml).toBe("<string>/Users/a&amp;b/.local/share</string>");
    expect(xml).not.toContain("a&b"); // raw ampersand gone
  });

  test("leaves an ordinary path untouched", () => {
    expect(escapeXml("/Users/dave/.local/bin/tp")).toBe(
      "/Users/dave/.local/bin/tp",
    );
  });
});
