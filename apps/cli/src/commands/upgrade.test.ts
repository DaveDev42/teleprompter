import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  backupBinary,
  cleanupBackup,
  computeFileHash,
  getAssetName,
  parseChecksums,
  restoreBinary,
} from "./upgrade";

describe("parseChecksums", () => {
  test("parses sha256sum output format", () => {
    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);
    const text = [`${hashA}  tp-darwin_arm64`, `${hashB}  tp-linux_x64`].join(
      "\n",
    );

    const map = parseChecksums(text);
    expect(map.size).toBe(2);
    expect(map.get("tp-darwin_arm64")).toBe(hashA);
    expect(map.get("tp-linux_x64")).toBe(hashB);
  });

  test("handles trailing newline", () => {
    const hash = "c".repeat(64);
    const text = `${hash}  tp-darwin_arm64\n`;
    const map = parseChecksums(text);
    expect(map.size).toBe(1);
  });

  test("skips invalid lines", () => {
    const hash = "d".repeat(64);
    const text = [
      "not-a-valid-hash  somefile",
      `${hash}  tp-darwin_arm64`,
      "",
      "# comment",
    ].join("\n");

    const map = parseChecksums(text);
    expect(map.size).toBe(1);
    expect(map.get("tp-darwin_arm64")).toBeDefined();
  });

  test("returns empty map for empty input", () => {
    const map = parseChecksums("");
    expect(map.size).toBe(0);
  });
});

describe("computeFileHash", () => {
  const tmpFile = join(tmpdir(), `tp-test-hash-${Date.now()}`);

  afterEach(() => {
    try {
      unlinkSync(tmpFile);
    } catch {}
  });

  test("computes SHA-256 hash of a file", async () => {
    writeFileSync(tmpFile, "hello world\n");
    const hash = await computeFileHash(tmpFile);
    // Known SHA-256 of "hello world\n"
    expect(hash).toBe(
      "a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447",
    );
  });

  test("produces 64-char hex string", async () => {
    writeFileSync(tmpFile, "test content");
    const hash = await computeFileHash(tmpFile);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("different content produces different hash", async () => {
    writeFileSync(tmpFile, "content A");
    const hashA = await computeFileHash(tmpFile);
    writeFileSync(tmpFile, "content B");
    const hashB = await computeFileHash(tmpFile);
    expect(hashA).not.toBe(hashB);
  });
});

describe("getAssetName", () => {
  test("returns platform-specific asset name", () => {
    const name = getAssetName();
    expect(name).toMatch(/^tp-(darwin|linux)_(arm64|x64)$/);
  });
});

describe("backup and rollback", () => {
  const dir = tmpdir();
  let binaryPath: string;
  let bakPath: string;

  beforeEach(() => {
    binaryPath = join(dir, `tp-test-binary-${Date.now()}`);
    bakPath = `${binaryPath}.bak`;
    writeFileSync(binaryPath, "original-binary-content");
  });

  afterEach(() => {
    for (const p of [binaryPath, bakPath]) {
      try {
        unlinkSync(p);
      } catch {}
    }
  });

  test("backupBinary creates .bak copy", () => {
    const result = backupBinary(binaryPath);
    expect(result).toBe(bakPath);
    expect(existsSync(bakPath)).toBe(true);
    expect(Bun.file(bakPath).size).toBeGreaterThan(0);
  });

  test("restoreBinary moves .bak back to original path", async () => {
    backupBinary(binaryPath);
    // Simulate corrupted upgrade
    writeFileSync(binaryPath, "corrupted-new-binary");
    restoreBinary(binaryPath, bakPath);
    const content = await Bun.file(binaryPath).text();
    expect(content).toBe("original-binary-content");
    expect(existsSync(bakPath)).toBe(false);
  });

  test("cleanupBackup removes .bak file", () => {
    backupBinary(binaryPath);
    expect(existsSync(bakPath)).toBe(true);
    cleanupBackup(bakPath);
    expect(existsSync(bakPath)).toBe(false);
  });

  test("cleanupBackup does not throw if .bak missing", () => {
    expect(() => cleanupBackup("/tmp/nonexistent.bak")).not.toThrow();
  });
});
