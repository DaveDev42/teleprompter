import { describe, expect, test } from "bun:test";
import { platform } from "os";

describe("service", () => {
  if (platform() === "darwin") {
    describe("darwin", () => {
      test("generatePlist produces valid XML with expected fields", async () => {
        const { generatePlist } = await import("./service-darwin");
        const plist = generatePlist("/usr/local/bin/tp", "/tmp/logs");

        expect(plist).toContain('<?xml version="1.0"');
        expect(plist).toContain('<plist version="1.0">');
        expect(plist).toContain("<string>dev.tpmt.daemon</string>");
        expect(plist).toContain("<string>/usr/local/bin/tp</string>");
        expect(plist).toContain("<string>daemon</string>");
        expect(plist).toContain("<string>start</string>");
        expect(plist).toContain("<key>RunAtLoad</key>");
        expect(plist).toContain("<true/>");
        expect(plist).toContain("<key>KeepAlive</key>");
        expect(plist).toContain("/tmp/logs/daemon.log");
        expect(plist).toContain("<key>HOME</key>");
        expect(plist).toContain("<key>PATH</key>");
      });

      test("resolveTpBinary returns a string", async () => {
        const { resolveTpBinary } = await import("./service-darwin");
        const binary = resolveTpBinary();
        expect(typeof binary).toBe("string");
        expect(binary.length).toBeGreaterThan(0);
      });
    });
  }

  if (platform() === "linux") {
    describe("linux", () => {
      test("generateUnit produces valid systemd unit with expected fields", async () => {
        const { generateUnit } = await import("./service-linux");
        const unit = generateUnit("/usr/local/bin/tp");

        expect(unit).toContain("[Unit]");
        expect(unit).toContain("Description=Teleprompter Daemon");
        expect(unit).toContain("[Service]");
        expect(unit).toContain("ExecStart=/usr/local/bin/tp daemon start");
        expect(unit).toContain("Restart=on-failure");
        expect(unit).toContain("[Install]");
        expect(unit).toContain("WantedBy=default.target");
      });

      test("resolveTpBinary returns a string", async () => {
        const { resolveTpBinary } = await import("./service-linux");
        const binary = resolveTpBinary();
        expect(typeof binary).toBe("string");
        expect(binary.length).toBeGreaterThan(0);
      });
    });
  }

  describe("windows", () => {
    test("generateSchtasksArgs produces correct arguments", async () => {
      const { generateSchtasksArgs } = await import("./service-windows");
      const args = generateSchtasksArgs(
        "C:\\Users\\Test\\.local\\bin\\tp.exe",
        "C:\\Users\\Test\\AppData\\Local\\teleprompter\\logs",
      );

      expect(args).toContain("/Create");
      expect(args).toContain("/TN");
      expect(args).toContain("TeleprompterDaemon");
      expect(args).toContain("/SC");
      expect(args).toContain("ONLOGON");
      expect(args).toContain("/RL");
      expect(args).toContain("LIMITED");
      expect(args).toContain("/F");

      const trIndex = args.indexOf("/TR");
      const trValue = args[trIndex + 1];
      expect(trValue).toContain("tp.exe");
      expect(trValue).toContain("daemon start");
      expect(trValue).toContain("daemon.log");
    });

    test("resolveTpBinary returns a string", async () => {
      const { resolveTpBinary } = await import("./service-windows");
      const binary = resolveTpBinary();
      expect(typeof binary).toBe("string");
      expect(binary.length).toBeGreaterThan(0);
    });

    test("getLogDir returns path containing teleprompter and logs", async () => {
      const { getLogDir } = await import("./service-windows");
      const dir = getLogDir();
      expect(dir).toContain("teleprompter");
      expect(dir).toContain("logs");
    });
  });

  test("platform dispatcher exports install/uninstall", async () => {
    const { installService, uninstallService } = await import("./service");
    expect(typeof installService).toBe("function");
    expect(typeof uninstallService).toBe("function");
  });
});
