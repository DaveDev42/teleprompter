import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createLogger } from "@teleprompter/protocol";

const log = createLogger("PtyHostInstaller");

/**
 * The host script content is embedded inline so that it remains available
 * in a `bun build --compile` binary where __dirname / file paths don't resolve
 * to the original source tree.
 */
const PTY_HOST_SCRIPT = `"use strict";

const pty = require("@aspect-build/node-pty");
const readline = require("readline");

let ptyProcess = null;

const rl = readline.createInterface({ input: process.stdin });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ type: "error", message: "invalid JSON" });
    return;
  }

  switch (msg.type) {
    case "spawn": {
      if (ptyProcess) {
        send({ type: "error", message: "already spawned" });
        return;
      }
      try {
        const cmd = msg.command[0];
        const args = msg.command.slice(1);
        ptyProcess = pty.spawn(cmd, args, {
          name: "xterm-256color",
          cols: msg.cols || 120,
          rows: msg.rows || 40,
          cwd: msg.cwd,
        });

        send({ type: "pid", pid: ptyProcess.pid });

        ptyProcess.onData((data) => {
          send({ type: "data", data: Buffer.from(data).toString("base64") });
        });

        ptyProcess.onExit(({ exitCode }) => {
          send({ type: "exit", code: exitCode ?? 1 });
          ptyProcess = null;
        });
      } catch (err) {
        send({ type: "error", message: err.message });
      }
      break;
    }

    case "write": {
      if (!ptyProcess) return;
      const buf = Buffer.from(msg.data, "base64");
      ptyProcess.write(buf.toString());
      break;
    }

    case "resize": {
      if (!ptyProcess) return;
      ptyProcess.resize(msg.cols, msg.rows);
      break;
    }

    case "kill": {
      if (!ptyProcess) return;
      ptyProcess.kill(msg.signal);
      break;
    }

    default:
      send({ type: "error", message: "unknown type: " + msg.type });
  }
});

rl.on("close", () => {
  if (ptyProcess) {
    ptyProcess.kill();
  }
  process.exit(0);
});
`;

export function getPtyHostDir(): string {
  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA ??
      join(process.env.USERPROFILE ?? "C:\\Users\\Default", "AppData", "Local");
    return join(localAppData, "teleprompter", "pty-host");
  }
  const dataDir =
    process.env.XDG_DATA_HOME ??
    join(process.env.HOME ?? "/tmp", ".local", "share");
  return join(dataDir, "teleprompter", "pty-host");
}

export function needsInstall(dir: string, currentVersion: string): boolean {
  if (!existsSync(dir)) return true;
  const versionFile = join(dir, ".version");
  if (!existsSync(versionFile)) return true;
  const installed = readFileSync(versionFile, "utf-8").trim();
  return installed !== currentVersion;
}

export function writeHostFiles(dir: string, version: string): void {
  mkdirSync(dir, { recursive: true });

  const pkg = {
    name: "teleprompter-pty-host",
    private: true,
    dependencies: {
      "@aspect-build/node-pty": "*",
    },
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  writeFileSync(join(dir, ".version"), version);

  // Write the host script inline — avoids __dirname / file copy issues
  // in compiled binaries where the original .cjs file is not on disk.
  writeFileSync(join(dir, "pty-windows-host.cjs"), PTY_HOST_SCRIPT);
}

export function ensurePtyHost(currentVersion: string): string {
  const dir = getPtyHostDir();

  if (!needsInstall(dir, currentVersion)) {
    log.info("pty-host up to date");
    return dir;
  }

  log.info("installing pty-host dependencies...");

  writeHostFiles(dir, currentVersion);

  try {
    execSync("npm install --production", {
      cwd: dir,
      stdio: "pipe",
      timeout: 60_000,
    });
    log.info("pty-host installed successfully");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`pty-host install failed: ${msg}`);
    throw new Error(
      `Failed to install PTY host dependencies. ` +
        `Ensure Node.js is installed and in PATH. ` +
        `Run 'tp doctor' for diagnostics.`,
    );
  }

  return dir;
}
