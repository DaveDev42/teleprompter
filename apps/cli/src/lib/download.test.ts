import { describe, expect, test } from "bun:test";
import {
  formatBytes,
  formatProgressLine,
  formatSpeed,
  pickRenderMode,
  shouldLogDecile,
} from "./download";

describe("formatBytes", () => {
  test("formats bytes under 1KB as B", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  test("formats KB range with one decimal", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  test("formats MB range with one decimal", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(Math.round(63.2 * 1024 * 1024))).toBe("63.2 MB");
  });

  test("formats GB range", () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
  });

  test("handles negative as 0", () => {
    expect(formatBytes(-5)).toBe("0 B");
  });
});

describe("formatSpeed", () => {
  test("uses bytes-per-second input and returns per-second unit suffix", () => {
    expect(formatSpeed(0)).toBe("0 B/s");
    expect(formatSpeed(1024)).toBe("1.0 KB/s");
    expect(formatSpeed(Math.round(28.3 * 1024 * 1024))).toBe("28.3 MB/s");
  });
});

describe("formatProgressLine", () => {
  test("renders bar with percent, fraction, and speed when total is known", () => {
    const line = formatProgressLine({
      label: "Downloading tp v0.1.13",
      bytesDone: 29_800_000,
      bytesTotal: 66_000_000,
      bytesPerSec: 29_700_000,
      barWidth: 20,
    });
    // sanity: contains label, percent, fraction, and speed
    expect(line).toContain("Downloading tp v0.1.13");
    expect(line).toMatch(/\d+%/);
    expect(line).toMatch(/\(\s*\d+\.\d+ \/ \d+\.\d+ MB\)/);
    expect(line).toMatch(/\d+\.\d+ MB\/s/);
    // sanity: bar uses '=' and ' ' inside '[...]' of exact width
    const m = line.match(/\[(.{20})\]/);
    if (!m) throw new Error(`bar not found in: ${line}`);
    // ~45% filled → roughly 9/20 '=' chars; allow ±1 for rounding
    const filled = m[1].replace(/[^=]/g, "").length;
    expect(filled).toBeGreaterThanOrEqual(8);
    expect(filled).toBeLessThanOrEqual(10);
  });

  test("clamps percent to [0, 100]", () => {
    const over = formatProgressLine({
      label: "x",
      bytesDone: 200,
      bytesTotal: 100,
      bytesPerSec: 0,
      barWidth: 10,
    });
    expect(over).toContain("100%");

    const under = formatProgressLine({
      label: "x",
      bytesDone: -5,
      bytesTotal: 100,
      bytesPerSec: 0,
      barWidth: 10,
    });
    expect(under).toContain("0%");
  });

  test("omits bar and percent when total is unknown", () => {
    const line = formatProgressLine({
      label: "Downloading tp v0.1.13",
      bytesDone: 29_700_000,
      bytesTotal: null,
      bytesPerSec: 47_000_000,
      barWidth: 20,
    });
    expect(line).toContain("Downloading tp v0.1.13");
    expect(line).not.toContain("[");
    expect(line).not.toMatch(/\d+%/);
    expect(line).toMatch(/28\.\d MB/); // received-so-far
    expect(line).toMatch(/44\.\d MB\/s/);
  });

  test("omits speed when bytesPerSec is 0 (first tick)", () => {
    const line = formatProgressLine({
      label: "Downloading tp v0.1.13",
      bytesDone: 0,
      bytesTotal: 66_000_000,
      bytesPerSec: 0,
      barWidth: 20,
    });
    expect(line).not.toContain("/s");
  });
});

describe("shouldLogDecile", () => {
  test("true on first crossing of each 10% decile", () => {
    // crossing 10% for the first time
    expect(shouldLogDecile({ prevPct: 9, curPct: 10 })).toBe(true);
    expect(shouldLogDecile({ prevPct: 19, curPct: 20 })).toBe(true);
  });

  test("false when staying within the same decile", () => {
    expect(shouldLogDecile({ prevPct: 12, curPct: 15 })).toBe(false);
    expect(shouldLogDecile({ prevPct: 20, curPct: 29 })).toBe(false);
  });

  test("returns true once per decile even across multi-decile jumps", () => {
    // If we jump 15 → 35, we only log once (the jump itself).
    expect(shouldLogDecile({ prevPct: 15, curPct: 35 })).toBe(true);
  });

  test("never true for <10% or 100% boundaries on the initial side", () => {
    // 0% → 5% doesn't cross a 10% boundary
    expect(shouldLogDecile({ prevPct: 0, curPct: 5 })).toBe(false);
  });

  test("true when hitting 100%", () => {
    expect(shouldLogDecile({ prevPct: 95, curPct: 100 })).toBe(true);
  });
});

describe("pickRenderMode", () => {
  test("'tty' when stderr is a TTY and NO_COLOR is unset", () => {
    expect(pickRenderMode({ isTTY: true, noColor: false })).toBe("tty");
  });

  test("'tty' still when NO_COLOR is set (progress uses no colors — only reuses line)", () => {
    // The progress line is color-free by construction; NO_COLOR should NOT
    // force us down to the decile logger if the terminal supports `\r`.
    expect(pickRenderMode({ isTTY: true, noColor: true })).toBe("tty");
  });

  test("'log' when stderr is not a TTY", () => {
    expect(pickRenderMode({ isTTY: false, noColor: false })).toBe("log");
  });
});
