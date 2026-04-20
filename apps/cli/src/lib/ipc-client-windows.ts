import type { IpcClient } from "./ipc-client";

/**
 * Windows Named Pipe client for the CLI → daemon `tp pair new` flow.
 *
 * ## Why this is still a stub
 *
 * The unified `connectIpcAsClient` entry point in `./ipc-client.ts` routes to
 * this module whenever `process.platform === "win32"`, because on Windows the
 * daemon's IPC transport is a Named Pipe
 * (`\\\\.\\pipe\\teleprompter-<user>-daemon`, see `getWindowsSocketPath` in
 * `@teleprompter/protocol/socket-path`) rather than a Unix domain socket. A
 * working CLI-side client is genuinely required here — the `pair new` command
 * in `commands/pair.ts` is the only caller and has no alternative code path
 * on Windows.
 *
 * ## Reachability
 *
 * This function IS reachable in production on Windows:
 *   1. User runs `tp pair new` (or `tp pair`, which aliases to `pair new`).
 *   2. `pairNew()` calls `ensureDaemon()` → daemon process is spawned /
 *      kickstarted via Task Scheduler, listens on the Named Pipe.
 *   3. `pairNew()` calls `connectIpcAsClient(getSocketPath())`.
 *   4. `ipc-client.ts` sees `win32` and imports THIS file.
 *   5. `connectWindowsIpc` throws, aborting the entire pair flow.
 *
 * Hitting this `throw` is therefore a user-visible bug on Windows, not a
 * defensive guard for an impossible state.
 *
 * ## How to implement this when needed
 *
 * Mirror `packages/runner/src/ipc/client-windows.ts` (`connectWindows`), which
 * already solves the same problem for the Runner → Daemon path:
 *   - Try `Bun.connect({ unix: path })` first — recent Bun builds accept
 *     Windows Named Pipe paths through the same `unix` option.
 *   - Fall back to `node:net` `createConnection(path)` if Bun's native pipe
 *     client rejects the path.
 *   - Wire up `FrameDecoder` for incoming data, `encodeFrame` for outgoing,
 *     and surface `close` / `error` through the `IpcClient` handlers.
 *
 * Do NOT import from `packages/runner` directly — the CLI and runner are
 * separate entry points and must not share runtime state. Copy the shape of
 * `connectWindows` into this file and return an `IpcClient` surface.
 *
 * ## Tests
 *
 * `apps/cli/src/lib/ipc-client.test.ts` skips on Windows
 * (`if (process.platform === "win32") return;`). `pair-blocking.test.ts` and
 * `commands/pair.test.ts`'s `tp pair list/delete` suite are both wrapped in
 * `describe.skipIf(process.platform === "win32")`. When implementing the real
 * client, drop those skips and add Windows-specific coverage.
 */
export async function connectWindowsIpc(_path: string): Promise<IpcClient> {
  throw new Error(
    "CLI pair flow over Windows Named Pipes is not yet implemented. " +
      "See apps/cli/src/lib/ipc-client-windows.ts for the design sketch " +
      "(mirror packages/runner/src/ipc/client-windows.ts). " +
      "Until this lands, `tp pair new` does not work on Windows.",
  );
}
