import { describe, expect, test } from "bun:test";
import { detectShell } from "./shell-detect";

describe("detectShell", () => {
  test("detects bash from $SHELL on darwin", () => {
    expect(detectShell({ SHELL: "/bin/bash" }, "darwin")).toBe("bash");
  });

  test("detects zsh from $SHELL on linux", () => {
    expect(detectShell({ SHELL: "/usr/bin/zsh" }, "linux")).toBe("zsh");
  });

  test("detects fish from $SHELL on darwin", () => {
    expect(detectShell({ SHELL: "/opt/homebrew/bin/fish" }, "darwin")).toBe(
      "fish",
    );
  });

  test("detects powershell from $PSModulePath on win32", () => {
    expect(
      detectShell(
        { PSModulePath: "C:\\Program Files\\PowerShell\\Modules" },
        "win32",
      ),
    ).toBe("powershell");
  });

  test("returns null for unknown shell on posix", () => {
    expect(detectShell({ SHELL: "/bin/sh" }, "linux")).toBeNull();
  });

  test("returns null for empty $SHELL on posix", () => {
    expect(detectShell({ SHELL: "" }, "linux")).toBeNull();
    expect(detectShell({}, "linux")).toBeNull();
  });

  test("returns null on win32 without $PSModulePath", () => {
    expect(detectShell({}, "win32")).toBeNull();
  });
});
