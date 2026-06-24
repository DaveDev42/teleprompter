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

      test("generatePlist XML-escapes a path containing & < > so the plist stays well-formed", async () => {
        const { generatePlist } = await import("./service-darwin");
        const prevHome = process.env["HOME"];
        process.env["HOME"] = "/Users/a&b<c>";
        try {
          const plist = generatePlist("/opt/a&b/tp", "/tmp/l&d");
          // Raw metacharacters must not survive into the XML body.
          expect(plist).not.toContain("a&b/tp");
          expect(plist).not.toContain("/tmp/l&d/daemon.log");
          expect(plist).not.toContain("/Users/a&b<c>");
          // Their escaped forms must be present instead.
          expect(plist).toContain("<string>/opt/a&amp;b/tp</string>");
          expect(plist).toContain("/tmp/l&amp;d/daemon.log");
          expect(plist).toContain("&lt;c&gt;");
        } finally {
          if (prevHome === undefined) delete process.env["HOME"];
          else process.env["HOME"] = prevHome;
        }
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
        // ExecStart double-quotes the binary path (systemd honors quoted words)
        // so a HOME/install path with spaces is not split into a wrong argv.
        expect(unit).toContain('ExecStart="/usr/local/bin/tp" daemon start');
        expect(unit).toContain("Restart=on-failure");
        expect(unit).toContain("[Install]");
        expect(unit).toContain("WantedBy=default.target");
      });

      test("generateUnit quotes Environment= values so an empty HOME writes '' not 'undefined'", async () => {
        const { generateUnit } = await import("./service-linux");
        const prevHome = process.env["HOME"];
        delete process.env["HOME"];
        try {
          const unit = generateUnit("/usr/local/bin/tp");
          expect(unit).toContain('Environment="HOME="');
          expect(unit).not.toContain("undefined");
        } finally {
          if (prevHome !== undefined) process.env["HOME"] = prevHome;
        }
      });

      test("resolveTpBinary returns a string", async () => {
        const { resolveTpBinary } = await import("./service-linux");
        const binary = resolveTpBinary();
        expect(typeof binary).toBe("string");
        expect(binary.length).toBeGreaterThan(0);
      });
    });
  }

  test("platform dispatcher exports install/uninstall", async () => {
    const { installService, uninstallService } = await import("./service");
    expect(typeof installService).toBe("function");
    expect(typeof uninstallService).toBe("function");
  });
});
