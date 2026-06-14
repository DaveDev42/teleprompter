import { describe, expect, test } from "bun:test";
import { splitArgs } from "../args";

describe("passthrough cleanup idempotency guard (idx 18)", () => {
  // Verifies the cleanedUp flag is present so double-call of cleanup()
  // (e.g., from SIGINT + normal exit path) is a no-op.
  test("passthrough.ts wires a cleanedUp idempotency guard", async () => {
    const src = await Bun.file(
      new URL("./passthrough.ts", import.meta.url).pathname,
    ).text();
    expect(src).toMatch(/let cleanedUp = false;/);
    expect(src).toMatch(/if \(cleanedUp\) return;/);
    expect(src).toMatch(/cleanedUp = true;/);
  });
});

describe("passthrough arg splitting", () => {
  test("passes all non-tp args to claude", () => {
    const { tpArgs, claudeArgs } = splitArgs([
      "-p",
      "explain this code",
      "--model",
      "opus",
    ]);
    expect(tpArgs).toEqual({});
    expect(claudeArgs).toEqual(["-p", "explain this code", "--model", "opus"]);
  });

  test("extracts tp-sid and forwards rest", () => {
    const { tpArgs, claudeArgs } = splitArgs([
      "--tp-sid",
      "my-session",
      "-p",
      "hello",
    ]);
    expect(tpArgs.sid).toBe("my-session");
    expect(claudeArgs).toEqual(["-p", "hello"]);
  });

  test("extracts all tp flags from mixed args", () => {
    const { tpArgs, claudeArgs } = splitArgs([
      "--tp-sid",
      "s1",
      "--tp-cwd",
      "/tmp",
      "-p",
      "fix bug",
      "--model",
      "sonnet",
    ]);
    expect(tpArgs).toEqual({ sid: "s1", cwd: "/tmp" });
    expect(claudeArgs).toEqual(["-p", "fix bug", "--model", "sonnet"]);
  });

  test("defaults are applied correctly", () => {
    const { tpArgs } = splitArgs(["-p", "hello"]);
    expect(tpArgs.sid).toBeUndefined();
    expect(tpArgs.cwd).toBeUndefined();
  });
});

describe("passthrough source routing assertions", () => {
  // Verifies the key structural guarantees of the two-path design:
  // 1. When service daemon is running, passthrough must NOT create a new
  //    Daemon (which would have an empty peers map and cause broadcastEncrypted
  //    to no-op — the blank-phone bug).
  // 2. The service-daemon path must route via isDaemonRunning().
  // 3. The ephemeral path preserves the original single-daemon + onRecord flow.
  test("passthrough.ts checks isDaemonRunning before deciding path", async () => {
    const src = await Bun.file(
      new URL("./passthrough.ts", import.meta.url).pathname,
    ).text();
    expect(src).toContain("isDaemonRunning");
    expect(src).toContain("passthroughViaServiceDaemon");
    expect(src).toContain("passthroughViaEphemeralDaemon");
  });

  test("service-daemon path uses getSocketPath and does not create new Daemon", async () => {
    const src = await Bun.file(
      new URL("./passthrough.ts", import.meta.url).pathname,
    ).text();
    // Extract just the service-daemon function body for assertion.
    const svcFnStart = src.indexOf(
      "async function passthroughViaServiceDaemon(",
    );
    const svcFnEnd = src.indexOf(
      "\nasync function passthroughViaEphemeralDaemon(",
    );
    expect(svcFnStart).toBeGreaterThan(-1);
    expect(svcFnEnd).toBeGreaterThan(svcFnStart);
    const svcFn = src.slice(svcFnStart, svcFnEnd);

    // Service-daemon path must use the canonical socket path.
    expect(svcFn).toContain("getSocketPath()");
    // Service-daemon path must NOT create a new Daemon (that's the bug).
    expect(svcFn).not.toContain("new Daemon()");
    // Service-daemon path must poll the Store for local stdout.
    expect(svcFn).toContain("new Store()");
    // Service-daemon path must forward stdin via IPC.
    expect(svcFn).toContain("connectIpcAsClient");
    expect(svcFn).toContain('"input"');
    expect(svcFn).toContain('"resize"');
  });

  test("ephemeral-daemon path still uses in-process Daemon + onRecord for stdout", async () => {
    const src = await Bun.file(
      new URL("./passthrough.ts", import.meta.url).pathname,
    ).text();
    // Extract the ephemeral-daemon function body.
    const ephFnStart = src.indexOf(
      "async function passthroughViaEphemeralDaemon(",
    );
    expect(ephFnStart).toBeGreaterThan(-1);
    const ephFn = src.slice(ephFnStart);

    expect(ephFn).toContain("new Daemon()");
    expect(ephFn).toContain("daemon.onRecord");
    expect(ephFn).toContain("reconnectSavedRelays");
  });
});
