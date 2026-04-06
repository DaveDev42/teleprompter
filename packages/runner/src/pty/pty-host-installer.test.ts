import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("pty-host-installer", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `tp-pty-host-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("getPtyHostDir returns path containing teleprompter and pty-host", async () => {
    const { getPtyHostDir } = await import("./pty-host-installer");
    const dir = getPtyHostDir();
    expect(dir).toContain("teleprompter");
    expect(dir).toContain("pty-host");
  });

  test("needsInstall returns true when dir missing", async () => {
    const { needsInstall } = await import("./pty-host-installer");
    const missingDir = join(testDir, "nonexistent");
    expect(needsInstall(missingDir, "0.0.1")).toBe(true);
  });

  test("needsInstall returns true when version mismatch", async () => {
    const { needsInstall } = await import("./pty-host-installer");
    const dir = join(testDir, "pty-host");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".version"), "0.0.1");
    expect(needsInstall(dir, "0.0.2")).toBe(true);
  });

  test("needsInstall returns false when version matches", async () => {
    const { needsInstall } = await import("./pty-host-installer");
    const dir = join(testDir, "pty-host");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".version"), "0.0.5");
    expect(needsInstall(dir, "0.0.5")).toBe(false);
  });

  test("writeHostFiles creates package.json and version file", async () => {
    const { writeHostFiles } = await import("./pty-host-installer");
    const dir = join(testDir, "pty-host");
    mkdirSync(dir, { recursive: true });
    writeHostFiles(dir, "0.0.5");

    expect(existsSync(join(dir, "package.json"))).toBe(true);
    expect(existsSync(join(dir, ".version"))).toBe(true);

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    expect(pkg.dependencies["@aspect-build/node-pty"]).toBeDefined();

    const version = readFileSync(join(dir, ".version"), "utf-8");
    expect(version).toBe("0.0.5");

    // writeHostFiles also embeds the host script
    expect(existsSync(join(dir, "pty-windows-host.cjs"))).toBe(true);
    const script = readFileSync(join(dir, "pty-windows-host.cjs"), "utf-8");
    expect(script).toContain("@aspect-build/node-pty");
  });
});
