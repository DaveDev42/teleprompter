/**
 * Shared test utilities for CLI tests.
 *
 * WORKAROUND: Bun v1.3.6 test runner intercepts pipe-based child process
 * stdout, causing Bun.$, Bun.spawn, and execSync to return empty strings.
 * Shell redirect to temp file is the only reliable capture method.
 */

import { execSync } from "child_process";
import { readFileSync, unlinkSync } from "fs";

/** Capture stdout+stderr from a shell command using file redirect. */
export function capture(cmd: string): string {
  const tmp = `/tmp/.tp-test-${process.pid}-${Date.now()}`;
  try {
    execSync(`${cmd} > '${tmp}' 2>&1`, { stdio: "ignore" });
    return readFileSync(tmp, "utf-8");
  } catch {
    try {
      return readFileSync(tmp, "utf-8");
    } catch {
      return "";
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}
