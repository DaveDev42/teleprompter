import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getSocketPath } from "@teleprompter/protocol";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { PassThrough } from "stream";
import {
  decideInstallPromptMode,
  isDaemonRunning,
  parseYesNoAnswer,
  readYesNoLine,
} from "./ensure-daemon";

// Unix-only: Windows named pipes take a different path in isDaemonRunning.
describe.skipIf(process.platform === "win32")("isDaemonRunning", () => {
  let runtime: string;
  let sockPath: string;
  const origRuntime = process.env.XDG_RUNTIME_DIR;

  beforeEach(() => {
    runtime = mkdtempSync(join(tmpdir(), "tp-ensure-daemon-"));
    process.env.XDG_RUNTIME_DIR = runtime;
    sockPath = join(runtime, "daemon.sock");
    // Guard against platform-specific socket-path resolution (e.g. macOS
    // falling back to TMPDIR). If this fails the other assertions would
    // silently test the developer's real daemon socket.
    if (getSocketPath() !== sockPath) {
      throw new Error(
        `getSocketPath() did not honor XDG_RUNTIME_DIR (got ${getSocketPath()})`,
      );
    }
  });

  afterEach(() => {
    if (origRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = origRuntime;
    rmSync(runtime, { recursive: true, force: true });
  });

  test("returns false when socket file does not exist", async () => {
    expect(await isDaemonRunning()).toBe(false);
  });

  test("removes stale regular file masquerading as socket", async () => {
    writeFileSync(sockPath, "");
    expect(await isDaemonRunning()).toBe(false);
    expect(existsSync(sockPath)).toBe(false);
  });

  test("returns true against a real listening socket", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    try {
      expect(await isDaemonRunning()).toBe(true);
      // File should still exist — live socket must not be unlinked.
      expect(existsSync(sockPath)).toBe(true);
    } finally {
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    }
  });
});

describe("parseYesNoAnswer", () => {
  test("empty input uses the provided default", () => {
    expect(parseYesNoAnswer("", true)).toBe(true);
    expect(parseYesNoAnswer("", false)).toBe(false);
    expect(parseYesNoAnswer("   ", true)).toBe(true);
  });

  test("yes variants are accepted", () => {
    expect(parseYesNoAnswer("y", false)).toBe(true);
    expect(parseYesNoAnswer("Y", false)).toBe(true);
    expect(parseYesNoAnswer("yes", false)).toBe(true);
    expect(parseYesNoAnswer("  YES  ", false)).toBe(true);
    // starts-with: typo-ish accept should still install
    expect(parseYesNoAnswer("yep", false)).toBe(true);
  });

  test("no variants are accepted", () => {
    expect(parseYesNoAnswer("n", true)).toBe(false);
    expect(parseYesNoAnswer("N", true)).toBe(false);
    expect(parseYesNoAnswer("no", true)).toBe(false);
    expect(parseYesNoAnswer("  NO  ", true)).toBe(false);
    // starts-with: "nah", "nope" should decline even with defaultYes=true
    expect(parseYesNoAnswer("nah", true)).toBe(false);
    expect(parseYesNoAnswer("nope", true)).toBe(false);
  });

  test("ambiguous input falls back to the default", () => {
    expect(parseYesNoAnswer("maybe", true)).toBe(true);
    expect(parseYesNoAnswer("maybe", false)).toBe(false);
    expect(parseYesNoAnswer("?", true)).toBe(true);
  });

  test("starts-with is deliberately broad (typo-tolerance over whitelist)", () => {
    // Documenting intentional over-matching: typing anything starting with n
    // declines, and anything starting with y accepts, even if the word is not
    // a canonical yes/no. Narrowing this back to a whitelist would break the
    // typo-tolerant property called out in the docstring.
    expect(parseYesNoAnswer("yikes", false)).toBe(true);
    expect(parseYesNoAnswer("yolo", false)).toBe(true);
    expect(parseYesNoAnswer("nil", true)).toBe(false);
    expect(parseYesNoAnswer("nvm", true)).toBe(false);
  });

  test("leading/trailing space around the token still resolves", () => {
    // trim() strips outer whitespace before the startsWith check, so these
    // behave identically to their unpadded counterparts.
    expect(parseYesNoAnswer("  y please  ", false)).toBe(true);
    expect(parseYesNoAnswer("  n please  ", true)).toBe(false);
  });

  test("non-ASCII responses fall back to the default", () => {
    // Documented contract: prompt string is English-only, so non-ASCII
    // negatives/positives take the default path rather than overreaching.
    expect(parseYesNoAnswer("아니요", true)).toBe(true);
    expect(parseYesNoAnswer("いいえ", true)).toBe(true);
    expect(parseYesNoAnswer("нет", true)).toBe(true);
  });
});

describe("decideInstallPromptMode", () => {
  const base = {
    hintFileExists: false,
    serviceInstalled: false,
    stdinIsTTY: true,
    stderrIsTTY: true,
    noAutoInstallEnv: false,
  };

  test("skips when the hint file already exists", () => {
    expect(decideInstallPromptMode({ ...base, hintFileExists: true })).toBe(
      "skip",
    );
  });

  test("skips when the service is already installed", () => {
    expect(decideInstallPromptMode({ ...base, serviceInstalled: true })).toBe(
      "skip",
    );
  });

  test("prompts on a full TTY with the opt-out flag unset", () => {
    expect(decideInstallPromptMode(base)).toBe("prompt");
  });

  test("falls back to hint when stdin is not a TTY (e.g. piped)", () => {
    expect(decideInstallPromptMode({ ...base, stdinIsTTY: false })).toBe(
      "hint",
    );
  });

  test("falls back to hint when stderr is not a TTY (e.g. captured)", () => {
    expect(decideInstallPromptMode({ ...base, stderrIsTTY: false })).toBe(
      "hint",
    );
  });

  test("falls back to hint when TP_NO_AUTO_INSTALL=1 is set", () => {
    expect(decideInstallPromptMode({ ...base, noAutoInstallEnv: true })).toBe(
      "hint",
    );
  });

  test("skip short-circuits ahead of TTY/env checks", () => {
    // Even on a full TTY, a stamped hint file wins.
    expect(
      decideInstallPromptMode({
        ...base,
        hintFileExists: true,
        stdinIsTTY: true,
        stderrIsTTY: true,
      }),
    ).toBe("skip");
  });
});

describe("readYesNoLine", () => {
  test("resolves true on `y\\n`", async () => {
    const s = new PassThrough();
    const p = readYesNoLine(s);
    s.write("y\n");
    expect(await p).toBe(true);
  });

  test("resolves false on `n\\n`", async () => {
    const s = new PassThrough();
    const p = readYesNoLine(s);
    s.write("no\n");
    expect(await p).toBe(false);
  });

  test("empty newline uses defaultYes=true", async () => {
    const s = new PassThrough();
    const p = readYesNoLine(s);
    s.write("\n");
    expect(await p).toBe(true);
  });

  test("resolves false on stream end without input (Ctrl+D)", async () => {
    const s = new PassThrough();
    const p = readYesNoLine(s);
    s.end();
    expect(await p).toBe(false);
  });

  test("resolves false on close before newline", async () => {
    const s = new PassThrough();
    const p = readYesNoLine(s);
    s.write("partial");
    s.destroy();
    expect(await p).toBe(false);
  });

  test("assembles multi-chunk input before newline", async () => {
    const s = new PassThrough();
    const p = readYesNoLine(s);
    s.write("ye");
    s.write("s\n");
    expect(await p).toBe(true);
  });

  test("does not leak listeners after resolving", async () => {
    const s = new PassThrough();
    const p = readYesNoLine(s);
    s.write("y\n");
    await p;
    expect(s.listenerCount("data")).toBe(0);
    expect(s.listenerCount("end")).toBe(0);
    expect(s.listenerCount("close")).toBe(0);
  });
});
