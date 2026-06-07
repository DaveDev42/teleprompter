import { describe, expect, test } from "bun:test";
import type { SessionMeta, SessionState } from "@teleprompter/protocol/client";
import {
  deriveInputGates,
  formatCwd,
  isSessionRunning,
  isSessionStopped,
} from "./session-ux";

// Accept the SessionState union plus arbitrary test-only values (e.g. "crashed",
// "idle") to document that the helpers handle unknown states gracefully.
function makeSession(state: SessionState | (string & {})): SessionMeta {
  return {
    sid: "s1",
    state,
    cwd: "/tmp",
    createdAt: 0,
    updatedAt: 0,
    lastSeq: 0,
  };
}

describe("isSessionStopped", () => {
  test("undefined session is not considered stopped", () => {
    expect(isSessionStopped(undefined)).toBe(false);
  });

  test("running session is not stopped", () => {
    expect(isSessionStopped(makeSession("running"))).toBe(false);
  });

  test("stopped session is stopped", () => {
    expect(isSessionStopped(makeSession("stopped"))).toBe(true);
  });

  test("any non-running state is treated as stopped", () => {
    expect(isSessionStopped(makeSession("crashed"))).toBe(true);
    expect(isSessionStopped(makeSession("idle"))).toBe(true);
  });
});

describe("isSessionRunning", () => {
  test("undefined session is not running", () => {
    expect(isSessionRunning(undefined)).toBe(false);
  });

  test("running session is running", () => {
    expect(isSessionRunning(makeSession("running"))).toBe(true);
  });

  test("stopped session is not running", () => {
    expect(isSessionRunning(makeSession("stopped"))).toBe(false);
  });

  test("any non-running state is treated as not running", () => {
    expect(isSessionRunning(makeSession("crashed"))).toBe(false);
    expect(isSessionRunning(makeSession("idle"))).toBe(false);
  });
});

describe("deriveInputGates", () => {
  const running = makeSession("running");
  const stopped = makeSession("stopped");

  test("running + connected + sid → editable and can send", () => {
    expect(deriveInputGates(running, true, "s1")).toEqual({
      isEditable: true,
      canSend: true,
    });
  });

  test("running + disconnected + sid → editable, cannot send", () => {
    expect(deriveInputGates(running, false, "s1")).toEqual({
      isEditable: true,
      canSend: false,
    });
  });

  test("running + connected + null sid → editable, cannot send", () => {
    expect(deriveInputGates(running, true, null)).toEqual({
      isEditable: true,
      canSend: false,
    });
  });

  test("stopped + connected + sid → not editable, cannot send", () => {
    expect(deriveInputGates(stopped, true, "s1")).toEqual({
      isEditable: false,
      canSend: false,
    });
  });

  test("stopped + disconnected + sid → not editable, cannot send", () => {
    expect(deriveInputGates(stopped, false, "s1")).toEqual({
      isEditable: false,
      canSend: false,
    });
  });

  test("undefined session (unknown) treated as not stopped", () => {
    expect(deriveInputGates(undefined, true, "s1")).toEqual({
      isEditable: true,
      canSend: true,
    });
  });
});

describe("formatCwd", () => {
  test("macOS home subpath is abbreviated with ~", () => {
    expect(formatCwd("/Users/dave/Projects/teleprompter")).toBe(
      "~/Projects/teleprompter",
    );
  });

  test("macOS home root itself collapses to ~", () => {
    expect(formatCwd("/Users/dave")).toBe("~");
  });

  test("trailing slash on home root still collapses to ~", () => {
    expect(formatCwd("/Users/dave/")).toBe("~");
  });

  test("Linux /home subpath is abbreviated with ~", () => {
    expect(formatCwd("/home/alice/code/app")).toBe("~/code/app");
  });

  test("Linux root user /root is abbreviated with ~", () => {
    expect(formatCwd("/root/work")).toBe("~/work");
    expect(formatCwd("/root")).toBe("~");
  });

  test("non-home absolute paths are shown verbatim", () => {
    expect(formatCwd("/tmp")).toBe("/tmp");
    expect(formatCwd("/tmp/dogfood-offline")).toBe("/tmp/dogfood-offline");
    expect(formatCwd("/var/folders/xyz")).toBe("/var/folders/xyz");
  });

  test("a path that merely contains /Users/ mid-string is not abbreviated", () => {
    // The prefix must anchor at the start — a worktree mount under /mnt must
    // not be falsely collapsed.
    expect(formatCwd("/mnt/Users/dave/proj")).toBe("/mnt/Users/dave/proj");
  });

  test("prefix-only false match is rejected (/Usersfoo is not /Users/<name>)", () => {
    expect(formatCwd("/Usersfoo/bar")).toBe("/Usersfoo/bar");
    expect(formatCwd("/homer/simpson")).toBe("/homer/simpson");
  });

  test("trailing slash on a non-home path is stripped", () => {
    expect(formatCwd("/tmp/x/")).toBe("/tmp/x");
  });

  test("bare root slash is preserved", () => {
    expect(formatCwd("/")).toBe("/");
  });

  test("empty cwd falls back to sid then 'Session'", () => {
    expect(formatCwd("", "abc123")).toBe("abc123");
    expect(formatCwd(undefined, "abc123")).toBe("abc123");
    expect(formatCwd("   ", "abc123")).toBe("abc123");
    expect(formatCwd("")).toBe("Session");
    expect(formatCwd(undefined)).toBe("Session");
  });

  test("whitespace-only cwd is treated as empty", () => {
    expect(formatCwd("  /Users/dave/x  ")).toBe("~/x");
  });
});
