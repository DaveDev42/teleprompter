/**
 * Shared test utilities for CLI tests.
 *
 * WORKAROUND: Bun v1.3.6 test runner intercepts pipe-based child process
 * stdout, causing Bun.$, Bun.spawn, and execSync to return empty strings.
 * Shell redirect to temp file is the only reliable capture method.
 */

import { execSync } from "child_process";
import { readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let captureCounter = 0;

/** Capture stdout+stderr from a shell command using file redirect. */
export function capture(
  cmd: string,
  env?: Record<string, string>,
): string {
  const tmp = join(
    tmpdir(),
    `.tp-test-${process.pid}-${Date.now()}-${captureCounter++}`,
  );
  try {
    execSync(`${cmd} > "${tmp}" 2>&1`, {
      stdio: "ignore",
      env: env ? { ...process.env, ...env } : process.env,
    });
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
