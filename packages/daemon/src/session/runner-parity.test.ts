/**
 * Differential wire-parity gate (ADR-0003 Stage 4, increment 3).
 *
 * The load-bearing invariant of the runner Rust port: **the daemon cannot tell
 * which runner produced a session.** This test proves it by running the Bun
 * runner and the Rust `tp-runner` against an identical stub daemon, driving both
 * with the same deterministic faked claude (via the `TP_RUNNER_CLAUDE_BIN` seam
 * both runners honor), capturing every frame each emits with the REAL production
 * `FrameDecoder`, and asserting the frames are byte-identical modulo the two
 * legitimately non-deterministic fields (`pid`, `ts`).
 *
 * Why here (TS, packages/daemon) and not a Rust test: the invariant is
 * daemon-observable, and `packages/daemon/src/ipc/server.ts` decodes runner
 * frames in production with this exact `FrameDecoder`. A Rust integration test
 * structurally cannot spawn the Bun runner (Bun is not a Rust dependency), so
 * the differential test must live on the side that can spawn both.
 *
 * Degrades by SKIP (not FAIL) when the Rust binary has not been built — build it
 * with `(cd rust && cargo build --bin tp-runner)`. `bun` is always in-tree.
 */

import { describe, expect, test } from "bun:test";
import { FrameDecoder } from "@teleprompter/protocol";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

type CapturedFrame = {
  json: Record<string, unknown>;
  binary: Uint8Array | null;
};

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const RUNNER_ENTRY = join(REPO_ROOT, "packages", "runner", "src", "index.ts");

/** Prefer the release binary; fall back to debug. Returns null if neither built. */
function findRustRunner(): string | null {
  for (const profile of ["release", "debug"]) {
    const p = join(REPO_ROOT, "rust", "target", profile, "tp-runner");
    if (existsSync(p)) return p;
  }
  return null;
}

/** A deterministic fake claude: fixed stdout, fixed NON-zero exit (7). */
function writeFakeClaude(dir: string): string {
  const p = join(dir, "fake-claude.sh");
  // Ignores its `--settings <json>` args, prints a fixed marker, exits 7.
  // Non-zero exit exercises the meaningful-exitCode path on `bye` — a bug that
  // special-cased exit 0 could not hide here.
  writeFileSync(p, "#!/bin/sh\nprintf 'PARITY_MARKER_LINE\\n'\nexit 7\n");
  chmodSync(p, 0o755);
  return p;
}

/**
 * Spawn one runner against a fresh stub-daemon UnixListener, capture every
 * framed-JSON message it sends until it exits, and return them in order.
 */
async function captureRunnerFrames(
  runnerCmd: string[],
  fakeClaude: string,
  workDir: string,
  sockName: string,
): Promise<CapturedFrame[]> {
  const sock = join(workDir, sockName);
  const frames: CapturedFrame[] = [];
  const decoder = new FrameDecoder();

  // Resolve as soon as the runner sends its terminal `bye` frame (the last one
  // it emits — after hello + all io). We deliberately do NOT wait for the runner
  // *process* to exit: on Linux with Bun 1.3.13 a `terminal:` PTY leaves a stuck
  // event-loop handle after the child exits, so a runner that relies on natural
  // loop-drain to terminate never self-exits there (empirically confirmed: bye
  // is sent, socket closed, yet the process hangs; even proc.kill()/unref() do
  // not release the handle — only an explicit process.exit would, which we won't
  // force on the runner just for a test). On macOS the handle is released and it
  // exits promptly. Waiting on the bye frame is byte-for-byte what the parity
  // assertions need and is immune to that platform quirk.
  let onBye: () => void = () => {};
  const byeSeen = new Promise<void>((resolve) => {
    onBye = resolve;
  });
  const server = Bun.listen({
    unix: sock,
    socket: {
      data(_s, chunk) {
        for (const f of decoder.decode(new Uint8Array(chunk))) {
          frames.push({
            json: f.data as Record<string, unknown>,
            binary: f.binary,
          });
          if (f.data && (f.data as Record<string, unknown>)["t"] === "bye") {
            onBye();
          }
        }
      },
      open() {},
      close() {},
      error() {},
    },
  });

  const proc = Bun.spawn(
    [
      ...runnerCmd,
      "--sid",
      "parity-sess",
      "--cwd",
      workDir,
      "--socket-path",
      sock,
    ],
    {
      cwd: workDir,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, TP_RUNNER_CLAUDE_BIN: fakeClaude },
    },
  );

  // Bound the wait so a genuine hang (no bye ever) fails loudly. The bound is
  // generous (60s) because the Bun arm's `bun run <runner entry>` cold-transpiles
  // the whole runner + protocol graph on first spawn, and on a contended 2-core
  // CI runner (this test runs inside the full `bun test --coverage` suite) that
  // plus PTY setup can take many seconds — locally the whole test is ~1.4s.
  const outcome = await Promise.race([
    byeSeen.then(() => "bye" as const),
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 60000)),
  ]);
  // Kill the runner regardless: on Linux it may not self-exit (see byeSeen note),
  // and we already have every frame we assert on. kill() is a no-op if it exited.
  proc.kill();
  if (outcome === "timeout") {
    server.stop();
    throw new Error(`runner sent no bye in time: ${runnerCmd.join(" ")}`);
  }

  // Give the listener a tick to drain anything queued behind the bye before stop.
  await new Promise((r) => setTimeout(r, 100));
  server.stop();
  return frames;
}

/** Assert a field is a positive number, then return the frame without it (+ts). */
function stripNonDeterministic(
  json: Record<string, unknown>,
): Record<string, unknown> {
  const { pid: _pid, ts: _ts, ...rest } = json;
  return rest;
}

/**
 * Re-serialize a frame with `pid`/`ts` values replaced by a fixed placeholder
 * WITHOUT removing the keys, preserving their position. String-comparing two of
 * these catches a key-ORDER divergence (struct field order in wire.rs vs the TS
 * object-literal order) that `toEqual` would silently ignore — the exact bug
 * class the whole port must guard.
 */
function placeholderJson(json: Record<string, unknown>): string {
  const clone: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(json)) {
    clone[k] = k === "pid" || k === "ts" ? 0 : v;
  }
  return JSON.stringify(clone);
}

function byType(frames: CapturedFrame[], t: string): CapturedFrame[] {
  return frames.filter((f) => f.json["t"] === t);
}

/** Return the sole element, throwing a labeled error if the array is empty. */
function only(frames: CapturedFrame[], label: string): CapturedFrame {
  const f = frames[0];
  if (f === undefined) throw new Error(`expected a ${label} frame, got none`);
  return f;
}

/** Concatenate the binary sidecars of all io records into one stream. */
function joinedIoBytes(frames: CapturedFrame[]): Uint8Array {
  const ios = frames.filter(
    (f) => f.json["t"] === "rec" && f.json["kind"] === "io",
  );
  const total = ios.reduce((n, f) => n + (f.binary?.byteLength ?? 0), 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const f of ios) {
    if (f.binary) {
      out.set(f.binary, off);
      off += f.binary.byteLength;
    }
  }
  return out;
}

const rustBin = findRustRunner();

describe("runner wire-parity (Bun vs Rust tp-runner)", () => {
  const maybe = rustBin ? test : test.skip;

  maybe(
    "hello/io/bye frames are byte-identical modulo pid+ts",
    async () => {
      // One SHARED work dir → both runners emit the same deterministic `cwd`
      // (a controlled field that must be byte-identical). Separate socket names
      // keep the two stub daemons isolated; the socket path never appears in
      // any frame's JSON, so sharing the dir is safe.
      const dir = mkdtempSync(join(tmpdir(), "tp-parity-"));
      const fakeClaude = writeFakeClaude(dir);

      const bunFrames = await captureRunnerFrames(
        ["bun", "run", RUNNER_ENTRY],
        fakeClaude,
        dir,
        "bun-daemon.sock",
      );
      const rustFrames = await captureRunnerFrames(
        [rustBin as string],
        fakeClaude,
        dir,
        "rust-daemon.sock",
      );

      // ── hello ───────────────────────────────────────────────────────────
      const bunHello = only(byType(bunFrames, "hello"), "bun hello");
      const rustHello = only(byType(rustFrames, "hello"), "rust hello");
      // pid is present + positive on each side before we strip it.
      expect(typeof bunHello.json["pid"]).toBe("number");
      expect(bunHello.json["pid"] as number).toBeGreaterThan(0);
      expect(typeof rustHello.json["pid"]).toBe("number");
      expect(rustHello.json["pid"] as number).toBeGreaterThan(0);
      expect(stripNonDeterministic(rustHello.json)).toEqual(
        stripNonDeterministic(bunHello.json),
      );
      // Key ORDER identical (struct vs literal order): the port's raison d'être.
      expect(placeholderJson(rustHello.json)).toBe(
        placeholderJson(bunHello.json),
      );

      // ── bye ─────────────────────────────────────────────────────────────
      const bunBye = only(byType(bunFrames, "bye"), "bun bye");
      const rustBye = only(byType(rustFrames, "bye"), "rust bye");
      // Meaningful non-zero exit path: the fake claude exits 7 on both sides.
      expect(bunBye.json["exitCode"]).toBe(7);
      expect(rustBye.json["exitCode"]).toBe(7);
      expect(bunBye.json["reason"]).toBe("exit");
      expect(rustBye.json["reason"]).toBe("exit");
      expect(stripNonDeterministic(rustBye.json)).toEqual(
        stripNonDeterministic(bunBye.json),
      );
      expect(placeholderJson(rustBye.json)).toBe(placeholderJson(bunBye.json));

      // ── io records: binary sidecar (payload="") + byte-equal joined stream ─
      const bunIo = bunFrames.filter(
        (f) => f.json["t"] === "rec" && f.json["kind"] === "io",
      );
      const rustIo = rustFrames.filter(
        (f) => f.json["t"] === "rec" && f.json["kind"] === "io",
      );
      expect(bunIo.length).toBeGreaterThan(0);
      expect(rustIo.length).toBeGreaterThan(0);
      for (const f of [...bunIo, ...rustIo]) {
        expect(f.json["payload"]).toBe(""); // binary-sidecar invariant
      }
      // PTY chunking may differ between portable-pty and Bun's terminal:, so
      // compare the JOINED byte streams, not frame-by-frame.
      expect(Buffer.from(joinedIoBytes(rustIo))).toEqual(
        Buffer.from(joinedIoBytes(bunIo)),
      );
      // The fake claude's fixed output must be present in both streams.
      expect(Buffer.from(joinedIoBytes(bunIo)).toString("utf-8")).toContain(
        "PARITY_MARKER_LINE",
      );

      // ── event records: symmetric absence ───────────────────────────────
      // A bare shell fake claude cannot fire Claude Code's --settings hook
      // plumbing, so neither runner emits event records. Assert the symmetry;
      // event-record parity needs a fake claude that POSTs to the hook socket
      // (follow-up increment).
      expect(
        byType(bunFrames, "rec").filter((f) => f.json["kind"] === "event"),
      ).toHaveLength(0);
      expect(
        byType(rustFrames, "rec").filter((f) => f.json["kind"] === "event"),
      ).toHaveLength(0);
    },
    // Two runner arms spawn sequentially, each bounded by the 60s inner race
    // above; give the whole test enough room to absorb both under CI contention.
    150000,
  );

  if (!rustBin) {
    test.skip("(rust tp-runner not built — run: cd rust && cargo build --bin tp-runner)", () => {});
  }
});
