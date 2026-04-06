export interface PtyOptions {
  command: string[];
  cwd: string;
  cols?: number;
  rows?: number;
  onData: (data: Uint8Array) => void;
  onExit: (exitCode: number) => void;
}

export interface PtyManager {
  spawn(opts: PtyOptions): void;
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  kill(signal?: number): void;
  readonly pid: number | undefined;
}

export function createPtyManager(): PtyManager {
  if (process.platform === "win32") {
    const { PtyWindows } = require("./pty-windows") as typeof import("./pty-windows");
    return new PtyWindows();
  }
  const { PtyBun } = require("./pty-bun") as typeof import("./pty-bun");
  return new PtyBun();
}
