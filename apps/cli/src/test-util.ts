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

/**
 * Hard wall-clock cap for a single captured command. Every `capture()` call
 * site expects the spawned CLI to print and then exit on its own; none drive a
 * long-running process. So if a command fails to terminate — e.g. an arg-guard
 * regression lets `tp relay start` fall through and the relay starts listening
 * forever — `execSync`'s default (no timeout) would block the `bun test` worker
 * until the 10-minute GitHub Actions job timeout kills it. Bounding the spawn
 * turns that silent hang into a fast, localized test failure. SIGKILL (not the
 * default SIGTERM) guarantees a wedged relay can't ignore the signal.
 */
const CAPTURE_TIMEOUT_MS = 20000;

/** Capture stdout+stderr from a shell command using file redirect. */
export function capture(cmd: string, env?: Record<string, string>): string {
  const tmp = join(
    tmpdir(),
    `.tp-test-${process.pid}-${Date.now()}-${captureCounter++}`,
  );
  try {
    execSync(`${cmd} > "${tmp}" 2>&1`, {
      stdio: "ignore",
      env: env ? { ...process.env, ...env } : process.env,
      timeout: CAPTURE_TIMEOUT_MS,
      killSignal: "SIGKILL",
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
