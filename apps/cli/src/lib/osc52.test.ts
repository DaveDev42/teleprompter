import { afterEach, describe, expect, test } from "bun:test";
import { copyToClipboard, isClipboardSupportLikely } from "./osc52";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture bytes written to process.stdout.write during the callback. */
function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  // biome-ignore lint/suspicious/noExplicitAny: patching for test
  process.stdout.write = (chunk: any) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join("");
}

// ---------------------------------------------------------------------------
// isClipboardSupportLikely
// ---------------------------------------------------------------------------

describe("isClipboardSupportLikely", () => {
  const origIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const origEnv = { ...process.env };

  afterEach(() => {
    // Restore env vars we touched
    for (const k of ["TERM", "TERM_PROGRAM", "TMUX", "STY"]) {
      if (origEnv[k] === undefined) delete process.env[k];
      else process.env[k] = origEnv[k];
    }
    // Restore isTTY descriptor
    if (origIsTTY) {
      Object.defineProperty(process.stdout, "isTTY", origIsTTY);
    }
  });

  function setTTY(value: boolean) {
    Object.defineProperty(process.stdout, "isTTY", {
      value,
      writable: true,
      configurable: true,
    });
  }

  test("returns false when stdout is not a TTY", () => {
    setTTY(false);
    process.env.TERM = "xterm-256color";
    expect(isClipboardSupportLikely()).toBe(false);
  });

  test("returns false when $TERM is dumb", () => {
    setTTY(true);
    process.env.TERM = "dumb";
    delete process.env.TMUX;
    delete process.env.STY;
    expect(isClipboardSupportLikely()).toBe(false);
  });

  test("returns false when $TERM is empty", () => {
    setTTY(true);
    process.env.TERM = "";
    delete process.env.TMUX;
    delete process.env.STY;
    expect(isClipboardSupportLikely()).toBe(false);
  });

  test("returns true for xterm-256color on a TTY", () => {
    setTTY(true);
    process.env.TERM = "xterm-256color";
    delete process.env.TMUX;
    delete process.env.STY;
    delete process.env.TERM_PROGRAM;
    expect(isClipboardSupportLikely()).toBe(true);
  });

  test("returns true when $TMUX is set (multiplexer passthrough)", () => {
    setTTY(true);
    process.env.TERM = "screen-256color";
    process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
    expect(isClipboardSupportLikely()).toBe(true);
  });

  test("returns true when $STY is set (screen multiplexer)", () => {
    setTTY(true);
    process.env.TERM = "screen";
    process.env.STY = "12345.pts-0.host";
    expect(isClipboardSupportLikely()).toBe(true);
  });

  test("returns true for iTerm.app TERM_PROGRAM", () => {
    setTTY(true);
    process.env.TERM = "xterm-256color";
    process.env.TERM_PROGRAM = "iTerm.app";
    delete process.env.TMUX;
    delete process.env.STY;
    expect(isClipboardSupportLikely()).toBe(true);
  });

  test("returns true for ghostty TERM_PROGRAM", () => {
    setTTY(true);
    process.env.TERM = "xterm-ghostty";
    process.env.TERM_PROGRAM = "ghostty";
    delete process.env.TMUX;
    delete process.env.STY;
    expect(isClipboardSupportLikely()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// copyToClipboard
// ---------------------------------------------------------------------------

describe("copyToClipboard", () => {
  const origIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const origEnv = { ...process.env };

  afterEach(() => {
    for (const k of ["TERM", "TMUX", "STY"]) {
      if (origEnv[k] === undefined) delete process.env[k];
      else process.env[k] = origEnv[k];
    }
    if (origIsTTY) {
      Object.defineProperty(process.stdout, "isTTY", origIsTTY);
    }
  });

  function setTTY(value: boolean) {
    Object.defineProperty(process.stdout, "isTTY", {
      value,
      writable: true,
      configurable: true,
    });
  }

  test("returns ok:false when stdout is not a TTY", () => {
    setTTY(false);
    process.env.TERM = "xterm-256color";
    const result = copyToClipboard("hello");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("TTY");
  });

  test("returns ok:false when $TERM is dumb", () => {
    setTTY(true);
    process.env.TERM = "dumb";
    delete process.env.TMUX;
    delete process.env.STY;
    const result = copyToClipboard("hello");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("dumb");
  });

  test("writes OSC 52 sequence with correct base64 on a TTY", () => {
    setTTY(true);
    process.env.TERM = "xterm-256color";
    delete process.env.TMUX;
    delete process.env.STY;

    const text = "tp://p?d=hello";
    const expected = Buffer.from(text, "utf8").toString("base64");
    let written = "";
    written = captureStdout(() => {
      const result = copyToClipboard(text);
      expect(result.ok).toBe(true);
    });

    expect(written).toContain(`\x1b]52;c;${expected}\x07`);
  });

  test("wraps with tmux passthrough when $TMUX is set", () => {
    setTTY(true);
    process.env.TERM = "screen-256color";
    process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
    delete process.env.STY;

    const text = "hello-tmux";
    let written = "";
    written = captureStdout(() => {
      const result = copyToClipboard(text);
      expect(result.ok).toBe(true);
    });

    // Should start with DCS passthrough ESC P t m u x ;
    expect(written).toMatch(/^\x1bPtmux;/);
    // Should end with ST
    expect(written).toMatch(/\x1b\\$/);
    // Must contain the base64-encoded text
    const b64 = Buffer.from(text, "utf8").toString("base64");
    expect(written).toContain(b64);
  });

  test("wraps with screen DCS passthrough when $STY is set", () => {
    setTTY(true);
    process.env.TERM = "screen";
    process.env.STY = "12345.pts-0.host";
    delete process.env.TMUX;

    const text = "hello-screen";
    let written = "";
    written = captureStdout(() => {
      const result = copyToClipboard(text);
      expect(result.ok).toBe(true);
    });

    // Screen DCS: ESC P + inner OSC 52 + ST
    expect(written).toMatch(/^\x1bP/);
    expect(written).toMatch(/\x1b\\$/);
    const b64 = Buffer.from(text, "utf8").toString("base64");
    expect(written).toContain(b64);
  });

  test("does not write anything to stdout on failure", () => {
    setTTY(false);
    process.env.TERM = "xterm-256color";

    const written = captureStdout(() => {
      copyToClipboard("should not write");
    });
    expect(written).toBe("");
  });
});
