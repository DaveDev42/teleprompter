#!/usr/bin/env bun

/**
 * Real-claude differential wire-parity harness (ADR-0003 Stage 4, increment 4).
 *
 * A committed deterministic gate (`packages/daemon/src/session/runner-parity.test.ts`)
 * once proved the Bun runner and the Rust `tp-runner` emit byte-identical
 * hello/io/bye frames under a fake claude; it was removed in PR4 (#5 Bun-deletion
 * cascade) once the Rust runner became the default. This LOCAL script is the
 * surviving real-world differential check: it drives BOTH runners against the
 * operator's ACTUAL `claude` binary (print mode) and diffs the frames each
 * produces. (Deterministic byte-exactness is now held by `cargo test` +
 * tp-core golden vectors.)
 *
 * What can and cannot be byte-compared with a LIVE model:
 *   - hello: fully deterministic (cwd/sid/protocol fields) → byte-equal mod
 *     {pid, ts}, including JSON key ORDER (the port's raison d'être).
 *   - bye:   reason="exit" + a matching exitCode on both sides → byte-equal mod
 *     {pid, ts}. (Print-mode claude exits 0 on success; both runners must agree.)
 *   - io:    content is model-dependent, so it CANNOT be byte-compared across the
 *     two runs. We assert the STRUCTURAL invariants instead: both runners emit
 *     ≥1 io record, every io record carries its bytes as a binary sidecar
 *     (payload="" && binLen>0 — never base64 in JSON), and both produced a
 *     non-empty joined byte stream. The byte-exact io equality is what the
 *     fake-claude test already locks down deterministically.
 *
 * LOCAL-ONLY — never CI. It spawns the real `claude`, which needs the operator's
 * own auth/credits and is non-deterministic. Gated behind
 * `TP_RUNNER_PARITY_REAL_CLAUDE=1` so an accidental `bun run` is a clean no-op.
 *
 * Usage:
 *   TP_RUNNER_PARITY_REAL_CLAUDE=1 bun run scripts/runner-parity-real-claude.ts
 *
 * Requires the Rust runner to be built:
 *   (cd rust && cargo build --release --bin tp-runner)
 *
 * Exit code: 0 on parity PASS, 1 on any divergence or setup failure.
 */

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FrameDecoder } from "@teleprompter/protocol";

type CapturedFrame = {
  json: Record<string, unknown>;
  binary: Uint8Array | null;
};

const REPO_ROOT = resolve(import.meta.dir, "..");
const RUNNER_ENTRY = join(REPO_ROOT, "packages", "runner", "src", "index.ts");

function die(msg: string): never {
  process.stderr.write(`\n❌ RUNNER PARITY (real claude) FAIL — ${msg}\n`);
  process.exit(1);
}

function log(msg: string): void {
  process.stderr.write(`[runner-parity-real-claude] ${msg}\n`);
}

/** Prefer the release binary; fall back to debug. */
function findRustRunner(): string | null {
  for (const profile of ["release", "debug"]) {
    const p = join(REPO_ROOT, "rust", "target", profile, "tp-runner");
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Spawn one runner against a fresh stub-daemon UnixListener, capture every
 * framed-JSON message it sends until it exits, and return them in order.
 * Drives the REAL claude in print mode (`-p <prompt>`), so the session ends on
 * its own. Mirrors captureRunnerFrames() in runner-parity.test.ts, but passes
 * claude args after `--` instead of a TP_RUNNER_CLAUDE_BIN fake.
 */
async function captureRunnerFrames(
  runnerCmd: string[],
  workDir: string,
  sockName: string,
  prompt: string,
): Promise<CapturedFrame[]> {
  const sock = join(workDir, sockName);
  const frames: CapturedFrame[] = [];
  const decoder = new FrameDecoder();

  const server = Bun.listen({
    unix: sock,
    socket: {
      data(_s, chunk) {
        for (const f of decoder.decode(new Uint8Array(chunk))) {
          frames.push({
            json: f.data as Record<string, unknown>,
            binary: f.binary,
          });
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
      "parity-real-sess",
      "--cwd",
      workDir,
      "--socket-path",
      sock,
      "--",
      "-p",
      prompt,
    ],
    {
      cwd: workDir,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      // No TP_RUNNER_CLAUDE_BIN → the runner spawns the operator's real `claude`.
      env: { ...process.env },
    },
  );

  // Real claude in print mode returns in a few seconds; bound the wait generously.
  const exit = await Promise.race([
    proc.exited,
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 120_000)),
  ]);
  if (exit === "timeout") {
    proc.kill();
    server.stop();
    die(`runner did not exit within 120s: ${runnerCmd.join(" ")}`);
  }

  // Give the listener a tick to drain the final (bye) frame before stopping.
  await new Promise((r) => setTimeout(r, 200));
  server.stop();
  return frames;
}

function stripNonDeterministic(
  json: Record<string, unknown>,
): Record<string, unknown> {
  const { pid: _pid, ts: _ts, ...rest } = json;
  return rest;
}

/** Re-serialize with pid/ts zeroed IN PLACE — catches a key-ORDER divergence. */
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

function only(frames: CapturedFrame[], label: string): CapturedFrame {
  const f = frames[0];
  if (f === undefined) die(`expected a ${label} frame, got none`);
  if (frames.length > 1)
    log(`WARN — ${frames.length} ${label} frames; using #0`);
  return f;
}

function ioRecords(frames: CapturedFrame[]): CapturedFrame[] {
  return frames.filter((f) => f.json["t"] === "rec" && f.json["kind"] === "io");
}

function joinedIoBytes(frames: CapturedFrame[]): Uint8Array {
  const ios = ioRecords(frames);
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

/** Deep-equal two plain JSON objects via canonical JSON of sorted keys. */
function sortedJson(o: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(o).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}

async function main(): Promise<void> {
  if (process.env["TP_RUNNER_PARITY_REAL_CLAUDE"] !== "1") {
    log(
      "TP_RUNNER_PARITY_REAL_CLAUDE != 1 — this LOCAL-ONLY real-claude harness is a no-op. " +
        "Run: TP_RUNNER_PARITY_REAL_CLAUDE=1 bun run scripts/runner-parity-real-claude.ts",
    );
    process.exit(0);
  }

  const rustBin = findRustRunner();
  if (!rustBin) {
    die(
      "Rust tp-runner not built. Build it: (cd rust && cargo build --release --bin tp-runner)",
    );
  }
  log(`using Rust runner: ${rustBin}`);

  // A fixed, low-variance prompt keeps the model reply short and cheap. io
  // content is not byte-compared, so exact text does not matter.
  const prompt = "Reply with exactly: PONG";

  // One SHARED work dir → both runners emit the same deterministic `cwd` field.
  // Separate socket names isolate the two stub daemons; the socket path never
  // appears in any frame JSON, so sharing the dir is safe.
  const dir = mkdtempSync(join(tmpdir(), "tp-parity-real-"));
  log(`work dir: ${dir}`);

  log("driving the BUN runner against real claude…");
  const bunFrames = await captureRunnerFrames(
    ["bun", "run", RUNNER_ENTRY],
    dir,
    "bun-daemon.sock",
    prompt,
  );
  log(`bun runner emitted ${bunFrames.length} frames`);

  log("driving the RUST tp-runner against real claude…");
  const rustFrames = await captureRunnerFrames(
    [rustBin],
    dir,
    "rust-daemon.sock",
    prompt,
  );
  log(`rust runner emitted ${rustFrames.length} frames`);

  // ── hello ─────────────────────────────────────────────────────────────────
  const bunHello = only(byType(bunFrames, "hello"), "bun hello");
  const rustHello = only(byType(rustFrames, "hello"), "rust hello");
  if (
    typeof bunHello.json["pid"] !== "number" ||
    (bunHello.json["pid"] as number) <= 0
  ) {
    die("bun hello pid is not a positive number");
  }
  if (
    typeof rustHello.json["pid"] !== "number" ||
    (rustHello.json["pid"] as number) <= 0
  ) {
    die("rust hello pid is not a positive number");
  }
  if (
    sortedJson(stripNonDeterministic(rustHello.json)) !==
    sortedJson(stripNonDeterministic(bunHello.json))
  ) {
    die(
      `hello frames differ (mod pid/ts):\n  bun:  ${sortedJson(stripNonDeterministic(bunHello.json))}\n  rust: ${sortedJson(stripNonDeterministic(rustHello.json))}`,
    );
  }
  if (placeholderJson(rustHello.json) !== placeholderJson(bunHello.json)) {
    die(
      `hello frame key ORDER differs:\n  bun:  ${placeholderJson(bunHello.json)}\n  rust: ${placeholderJson(rustHello.json)}`,
    );
  }
  log("✅ hello — byte-identical modulo pid/ts (including key order)");

  // ── bye ───────────────────────────────────────────────────────────────────
  const bunBye = only(byType(bunFrames, "bye"), "bun bye");
  const rustBye = only(byType(rustFrames, "bye"), "rust bye");
  if (bunBye.json["reason"] !== "exit" || rustBye.json["reason"] !== "exit") {
    die(
      `bye reason must be "exit" on both (bun=${String(bunBye.json["reason"])}, rust=${String(rustBye.json["reason"])})`,
    );
  }
  if (bunBye.json["exitCode"] !== rustBye.json["exitCode"]) {
    die(
      `bye exitCode differs (bun=${String(bunBye.json["exitCode"])}, rust=${String(rustBye.json["exitCode"])})`,
    );
  }
  if (
    sortedJson(stripNonDeterministic(rustBye.json)) !==
    sortedJson(stripNonDeterministic(bunBye.json))
  ) {
    die(
      `bye frames differ (mod pid/ts):\n  bun:  ${sortedJson(stripNonDeterministic(bunBye.json))}\n  rust: ${sortedJson(stripNonDeterministic(rustBye.json))}`,
    );
  }
  if (placeholderJson(rustBye.json) !== placeholderJson(bunBye.json)) {
    die(
      `bye frame key ORDER differs:\n  bun:  ${placeholderJson(bunBye.json)}\n  rust: ${placeholderJson(rustBye.json)}`,
    );
  }
  log(
    `✅ bye — byte-identical modulo pid/ts (reason=exit, exitCode=${String(bunBye.json["exitCode"])})`,
  );

  // ── io (structural, not byte-compared — model output is non-deterministic) ──
  const bunIo = ioRecords(bunFrames);
  const rustIo = ioRecords(rustFrames);
  if (bunIo.length === 0) die("bun runner emitted no io records");
  if (rustIo.length === 0) die("rust runner emitted no io records");
  for (const f of [...bunIo, ...rustIo]) {
    if (f.json["payload"] !== "") {
      die(
        "io record violates the binary-sidecar invariant (payload must be '')",
      );
    }
    if (!f.binary || f.binary.byteLength === 0) {
      die("io record has no binary sidecar bytes");
    }
  }
  const bunBytes = joinedIoBytes(bunIo);
  const rustBytes = joinedIoBytes(rustIo);
  if (bunBytes.byteLength === 0)
    die("bun runner produced an empty io byte stream");
  if (rustBytes.byteLength === 0)
    die("rust runner produced an empty io byte stream");
  log(
    `✅ io — structural parity: bun ${bunIo.length} recs/${bunBytes.byteLength}B, rust ${rustIo.length} recs/${rustBytes.byteLength}B (both binary-sidecar, both non-empty)`,
  );

  process.stderr.write(
    "\n✅ RUNNER PARITY (real claude) PASS — the Rust tp-runner and the Bun runner produced " +
      "byte-identical hello/bye frames (mod pid/ts, key order preserved) driving the SAME real claude, " +
      "and both emitted well-formed binary-sidecar io records. (io content is model-dependent, so its " +
      "byte-exactness is locked by cargo test + the tp-core golden vectors.)\n",
  );
  process.exit(0);
}

void main().catch((err: unknown) => {
  die(String(err));
});
