import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  analyzeVerificationOutput,
  backupBinary,
  checkForUpdates,
  cleanupBackup,
  computeFileHash,
  getAssetName,
  isOlderVersion,
  parseChecksums,
  parseVersion,
  resolveCurrentBinaryPath,
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

  test("handles CRLF line endings", () => {
    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);
    const text = `${hashA}  tp-windows_x64.exe\r\n${hashB}  tp-windows_arm64.exe\r\n`;
    const map = parseChecksums(text);
    expect(map.size).toBe(2);
    expect(map.get("tp-windows_x64.exe")).toBe(hashA);
    expect(map.get("tp-windows_arm64.exe")).toBe(hashB);
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
    expect(name).toMatch(/^tp-(darwin|linux|windows)_(arm64|x64)(\.exe)?$/);
  });

  test("returns .exe on Windows x64", () => {
    const origPlatform = process.platform;
    const origArch = process.arch;
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    Object.defineProperty(process, "arch", {
      value: "x64",
      configurable: true,
    });
    try {
      expect(getAssetName()).toBe("tp-windows_x64.exe");
    } finally {
      Object.defineProperty(process, "platform", {
        value: origPlatform,
        configurable: true,
      });
      Object.defineProperty(process, "arch", {
        value: origArch,
        configurable: true,
      });
    }
  });

  test("returns .exe on Windows arm64", () => {
    const origPlatform = process.platform;
    const origArch = process.arch;
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    Object.defineProperty(process, "arch", {
      value: "arm64",
      configurable: true,
    });
    try {
      expect(getAssetName()).toBe("tp-windows_arm64.exe");
    } finally {
      Object.defineProperty(process, "platform", {
        value: origPlatform,
        configurable: true,
      });
      Object.defineProperty(process, "arch", {
        value: origArch,
        configurable: true,
      });
    }
  });

  test("returns plain name on darwin arm64", () => {
    const origPlatform = process.platform;
    const origArch = process.arch;
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
    Object.defineProperty(process, "arch", {
      value: "arm64",
      configurable: true,
    });
    try {
      expect(getAssetName()).toBe("tp-darwin_arm64");
    } finally {
      Object.defineProperty(process, "platform", {
        value: origPlatform,
        configurable: true,
      });
      Object.defineProperty(process, "arch", {
        value: origArch,
        configurable: true,
      });
    }
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

describe("version comparison", () => {
  test("parseVersion strips leading v", () => {
    expect(parseVersion("v0.1.5")).toEqual({
      major: 0,
      minor: 1,
      patch: 5,
      prerelease: false,
    });
    expect(parseVersion("0.1.5")).toEqual({
      major: 0,
      minor: 1,
      patch: 5,
      prerelease: false,
    });
  });

  test("parseVersion captures prerelease marker", () => {
    const parsed = parseVersion("0.1.5-rc.1");
    expect(parsed?.prerelease).toBe(true);
    expect(parsed?.patch).toBe(5);
  });

  test("parseVersion returns null for garbage", () => {
    expect(parseVersion("not-a-version")).toBeNull();
  });

  test("isOlderVersion recognises strict order", () => {
    expect(isOlderVersion("0.1.4", "v0.1.5")).toBe(true);
    expect(isOlderVersion("0.1.5", "v0.1.5")).toBe(false);
    expect(isOlderVersion("0.2.0", "v0.1.9")).toBe(false);
    expect(isOlderVersion("1.0.0", "v0.9.9")).toBe(false);
  });

  test("prerelease sorts before same-numbered stable", () => {
    expect(isOlderVersion("0.1.5-rc.1", "v0.1.5")).toBe(true);
    expect(isOlderVersion("0.1.5", "v0.1.5-rc.1")).toBe(false);
    expect(isOlderVersion("0.1.5-rc.1", "v0.1.5-rc.1")).toBe(false);
  });
});

describe("backupBinary and restoreBinary cross-platform round-trip", () => {
  test("round-trips without shelling out (fs only)", () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-test-"));
    const bin = join(dir, "tp");
    writeFileSync(bin, "v1");
    const bak = backupBinary(bin);
    expect(existsSync(bak)).toBe(true);
    writeFileSync(bin, "v2");
    restoreBinary(bin, bak);
    expect(readFileSync(bin, "utf8")).toBe("v1");
    expect(existsSync(bak)).toBe(false);
    rmSync(dir, { recursive: true });
  });
});

describe("resolveCurrentBinaryPath", () => {
  test("returns execPath when not running via bun", async () => {
    const origExecPath = process.execPath;
    Object.defineProperty(process, "execPath", {
      value: "/usr/local/bin/tp",
      configurable: true,
    });
    try {
      const result = await resolveCurrentBinaryPath();
      expect(result).toBe("/usr/local/bin/tp");
    } finally {
      Object.defineProperty(process, "execPath", {
        value: origExecPath,
        configurable: true,
      });
    }
  });

  test("returns execPath on Windows (compiled tp.exe)", async () => {
    const origExecPath = process.execPath;
    const origPlatform = process.platform;
    Object.defineProperty(process, "execPath", {
      value: "C:\\Users\\x\\tp.exe",
      configurable: true,
    });
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    try {
      const result = await resolveCurrentBinaryPath();
      expect(result).toBe("C:\\Users\\x\\tp.exe");
    } finally {
      Object.defineProperty(process, "execPath", {
        value: origExecPath,
        configurable: true,
      });
      Object.defineProperty(process, "platform", {
        value: origPlatform,
        configurable: true,
      });
    }
  });
});

describe("checkForUpdates", () => {
  let cacheDir: string;
  let cachePath: string;
  const origNoCheck = process.env.TP_NO_UPDATE_CHECK;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "tp-upgrade-cache-"));
    cachePath = join(cacheDir, "upgrade-check.json");
    delete process.env.TP_NO_UPDATE_CHECK;
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
    if (origNoCheck === undefined) delete process.env.TP_NO_UPDATE_CHECK;
    else process.env.TP_NO_UPDATE_CHECK = origNoCheck;
  });

  test("returns null when env var suppresses check", async () => {
    process.env.TP_NO_UPDATE_CHECK = "1";
    const result = await checkForUpdates({ cachePath });
    expect(result).toBeNull();
    expect(existsSync(cachePath)).toBe(false);
  });

  test("returns null when cache is fresh (<24h)", async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({ version: 1, lastCheck: Date.now() }),
    );
    const result = await checkForUpdates({ cachePath });
    expect(result).toBeNull();
  });

  test("uses cache window relative to provided now", async () => {
    const t0 = 1_700_000_000_000;
    writeFileSync(cachePath, JSON.stringify({ version: 1, lastCheck: t0 }));
    // 1 hour later — still fresh
    const result = await checkForUpdates({
      cachePath,
      now: t0 + 60 * 60 * 1000,
    });
    expect(result).toBeNull();
  });

  test("fresh-cache short-circuit does not slide the window", async () => {
    const t0 = 1_700_000_000_000;
    writeFileSync(cachePath, JSON.stringify({ version: 1, lastCheck: t0 }));
    await checkForUpdates({ cachePath, now: t0 + 60 * 60 * 1000 });
    const cached = JSON.parse(readFileSync(cachePath, "utf-8"));
    // lastCheck must remain pinned to the original t0 — a sliding window
    // would silence the notice indefinitely on repeated invocations.
    expect(cached.lastCheck).toBe(t0);
  });

  test("treats unknown schema version as cache miss", async () => {
    // Future schema bump → reader must refuse old shape. Inject a stub fetcher
    // so the test never touches the network — the GitHub API/`gh` shell-out
    // path is exercised in integration, and on Windows CI it can exceed the
    // 5s test budget when fs.writeFile jitter compounds with subprocess spawn.
    writeFileSync(
      cachePath,
      JSON.stringify({ version: 99, lastCheck: Date.now() }),
    );
    await checkForUpdates({
      cachePath,
      now: 1_700_000_000_000,
      fetchLatest: async () => null,
    });
    const cached = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(cached.version).toBe(1);
    expect(cached.lastCheck).toBe(1_700_000_000_000);
  });

  test("writes cache after running so failed network calls still rate-limit", async () => {
    // Stub fetcher simulating a failed network call. We only assert that the
    // cache file is written so the next call short-circuits — same Windows
    // flake mitigation as above.
    await checkForUpdates({
      cachePath,
      now: 1_700_000_000_000,
      fetchLatest: async () => null,
    });
    expect(existsSync(cachePath)).toBe(true);
    const cached = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(cached.lastCheck).toBe(1_700_000_000_000);
  });
});

// Tests target the pure decision function `analyzeVerificationOutput` rather
// than spawning fake binaries. Subprocess-based tests are unreliable here
// because bun:test (1.3.x) intercepts child stdio pipes when run from the
// workspace root, returning empty output. `verifyNewBinary` itself is just a
// thin spawn wrapper that calls into this function — the spawn path is
// exercised in production.
describe("analyzeVerificationOutput", () => {
  test("accepts `tp v0.1.9` output", () => {
    const r = analyzeVerificationOutput({
      exitCode: 0,
      signal: null,
      stdout: "tp v0.1.9\n",
      stderr: "",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.version).toBe("tp v0.1.9");
  });

  test("returns only the tp line when stdout has multiple lines", () => {
    const r = analyzeVerificationOutput({
      exitCode: 0,
      signal: null,
      stdout: "tp v0.1.9\nclaude 1.2.3\n",
      stderr: "",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.version).toBe("tp v0.1.9");
  });

  test("rejects empty stdout", () => {
    const r = analyzeVerificationOutput({
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no output/);
  });

  test("rejects non-tp output", () => {
    const r = analyzeVerificationOutput({
      exitCode: 0,
      signal: null,
      stdout: "hello\n",
      stderr: "",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unexpected output/);
  });

  test("rejects non-zero exit and surfaces stderr", () => {
    const r = analyzeVerificationOutput({
      exitCode: 2,
      signal: null,
      stdout: "",
      stderr: "oops\n",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/exit 2: oops/);
  });

  test("falls back to stdout when stderr is empty on non-zero exit", () => {
    const r = analyzeVerificationOutput({
      exitCode: 1,
      signal: null,
      stdout: "panic: bad\n",
      stderr: "",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("exit 1: panic: bad");
  });

  test("reports `no output` on non-zero exit with empty streams", () => {
    const r = analyzeVerificationOutput({
      exitCode: 1,
      signal: null,
      stdout: "",
      stderr: "",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("exit 1: no output");
  });

  test("rejects SIGKILL with Gatekeeper hint", () => {
    const r = analyzeVerificationOutput({
      exitCode: 137,
      signal: "SIGKILL",
      stdout: "",
      stderr: "",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/signal SIGKILL|killed by signal/);
  });
});
