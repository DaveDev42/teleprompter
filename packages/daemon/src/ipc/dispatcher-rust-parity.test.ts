/**
 * Differential dispatcher-parity gate (ADR-0003 Phase 4, daemon inc5).
 *
 * Drives the REAL Bun `IpcCommandDispatcher` and the REAL Rust
 * `IpcCommandDispatcher` (via the `tp-daemon-probe` binary's `dispatch-*`
 * verbs) with identical inputs and asserts identical observable outputs:
 * reply frames, store side-effects, and guard decisions.
 *
 * HONEST GATE LEVEL: this is a **dispatcher-level** gate, NOT a socket-level
 * one. Both sides exercise the dispatcher seam in-process — the Bun side
 * calls `dispatchIpc`/`dispatchRelayControl` directly with a recording fake
 * relay + fake createSession (exactly like command-dispatcher.test.ts), and
 * the Rust probe builds the real Rust dispatcher with the same recording
 * fakes at the same seams. Everything below those seams is real production
 * code on both sides: the sid guards, the bye truth table + generation
 * guard, the export limit/truncation logic and formatters, and a real
 * SQLite Store. The IPC framing/socket layer has its own coverage
 * (ipc/server tests on both sides); this gate pins the command semantics.
 *
 * Guards pinned here (the brief's load-bearing set):
 *   - rank 3: `session.create` path-traversal sid rejected BEFORE
 *     createSession/subscribe (zero side-effects, byte-identical message)
 *   - rank 4: `session.export` exactly-limit → truncated:false (fetch
 *     limit+1 off-by-one), plus markdown/json format parity
 *   - bye truth table (`reason:"signal"` always → "stopped"; only
 *     exit/absent trusts exitCode) + stale-generation pid guard
 *   - `sanitizeForSid` branch→sid derivation grid
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PROBE CONTRACT (tp-daemon-probe <cmd> ... ; `-` = absent optional)
 *   sanitize-sid        <label>
 *     → {"sid": string}
 *   dispatch-bye        <vault> <sid> <registeredPid|-> <byePid|-> <exitCode> <reason|->
 *     → {"runnerRegistered": bool, "state": string|null}
 *   dispatch-create-sid <vault> <sid>
 *     → {"reply": {frontendId,sid,msg}|null, "createCalls": [...], "subscribes": [...]}
 *   dispatch-export     <vault> <sid> <format> <limit|->
 *     → {"reply": {frontendId,sid,msg}|null}
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Comparison notes:
 *   - Frames are compared as PARSED objects (deep equality), not raw JSON
 *     strings — Rust serde_json::Value maps are BTreeMap (alphabetical key
 *     order) while Bun preserves insertion order, so raw-string equality
 *     would couple the gate to key order, which is not wire-significant
 *     for these control frames. The `d` payload of a markdown export IS
 *     compared byte-exact (it is a formatted string, not JSON).
 *   - The export tests share ONE vault between both dispatchers (read-only
 *     op), so wall-clock createdAt/updatedAt are identical by construction
 *     and no timestamp normalization is needed. The bye tests mutate, so
 *     they use two identically-seeded vaults and compare the resulting
 *     state string (never timestamps).
 *
 * Degrades by SKIP (not FAIL) when the probe binary has not been built —
 * build it with `(cd rust && cargo build --bin tp-daemon-probe)`. Mirrors
 * the store/worktree/relay-client/push-notifier parity gates' precedent.
 */

import { describe, expect, test } from "bun:test";
import type { IpcBye, RelayControlMessage } from "@teleprompter/protocol";
import { sanitizeForSid } from "@teleprompter/protocol";
import { existsSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import type { PushNotifier } from "../push/push-notifier";
import { SessionManager } from "../session/session-manager";
import { Store } from "../store/store";
import type { RelayClient } from "../transport/relay-client";
import { IpcCommandDispatcher } from "./command-dispatcher";
import type { ConnectedRunner, IpcServer } from "./server";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");

/** Prefer the release binary; fall back to debug. Returns null if neither built. */
function findProbe(): string | null {
  for (const profile of ["release", "debug"]) {
    const p = join(REPO_ROOT, "rust", "target", profile, "tp-daemon-probe");
    if (existsSync(p)) return p;
  }
  return null;
}

const probeBin = findProbe();

/** Run the probe synchronously; throw with stderr on non-zero exit. */
function probe(args: string[]): string {
  const proc = Bun.spawnSync([probeBin as string, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `probe ${args.join(" ")} exited ${proc.exitCode}: ${proc.stderr.toString()}`,
    );
  }
  return proc.stdout.toString();
}

function probeJson(args: string[]): Record<string, unknown> {
  return JSON.parse(probe(args)) as Record<string, unknown>;
}

type PeerMsg = { frontendId: string; sid: string; msg: unknown };
type CreateCall = { sid: string; cwd: string; worktreePath: string | null };

/**
 * Real Bun dispatcher over a real Store, with the SAME recording fakes the
 * Rust probe installs at the same seams (`ProbeLink` / recording
 * create_session in rust/tp-daemon/src/bin/probe.rs).
 */
function makeBunDispatcher(vault: string) {
  const store = new Store(vault);
  const sessionManager = new SessionManager();
  const peerMsgs: PeerMsg[] = [];
  const subscribes: string[] = [];
  const createCalls: CreateCall[] = [];

  const relay = {
    publishToPeer: async (frontendId: string, sid: string, msg: unknown) => {
      peerMsgs.push({ frontendId, sid, msg });
    },
    publishState: async () => {},
    publishRemoved: async () => {},
    subscribe: (sid: string) => {
      subscribes.push(sid);
    },
    unsubscribe: () => {},
    peerPctB64: () => undefined,
  } as unknown as RelayClient;

  const dispatcher = new IpcCommandDispatcher({
    ipcServer: {
      send: () => {},
      findRunnerBySid: () => null,
    } as unknown as IpcServer,
    store,
    sessionManager,
    pushNotifier: { onRecord: () => {} } as unknown as PushNotifier,
    getWorktreeManager: () => null,
    createSession: (sid, cwd, opts) => {
      createCalls.push({ sid, cwd, worktreePath: opts?.worktreePath ?? null });
    },
    onPairBegin: () => {},
    onPairCancel: () => {},
    onCliDisconnect: () => {},
    removePairing: async () => 0,
    renamePairing: async () => 0,
    getOnRecord: () => null,
    getRelayClients: () => [relay],
    getRelayHealth: () => [],
  });

  return {
    store,
    sessionManager,
    dispatcher,
    relay,
    peerMsgs,
    subscribes,
    createCalls,
  };
}

const fakeRunner = {} as unknown as ConnectedRunner;

function tmpVault(tag: string): string {
  return join(mkdtempSync(join(tmpdir(), `tp-disp-parity-${tag}-`)), "vault");
}

describe("dispatcher parity (Bun IpcCommandDispatcher vs Rust tp-daemon)", () => {
  const maybe = probeBin ? test : test.skip;

  // ── sanitizeForSid grid ─────────────────────────────────────────────
  // Pins the branch-name → sid derivation both dispatchers use for
  // worktree.create session ids (tp-proto sanitize_for_sid vs
  // packages/protocol sanitizeForSid). Mirrors Bun test coverage in
  // socket-path.test.ts; here proven byte-identical cross-language.
  maybe("sanitizeForSid: Rust and Bun agree over a branch-name grid", () => {
    const labels = [
      "feat/Some_Branch--x",
      "release-1.2",
      "v2.0+hotfix",
      "한글-브랜치",
      "--..--",
      "",
      "a b c",
      "UPPER_case-9",
      "///",
      "..",
      "feat/日本語/x",
      "-leading-and-trailing-",
    ];
    for (const label of labels) {
      const rust = probeJson(["sanitize-sid", label]);
      expect(rust["sid"]).toBe(sanitizeForSid(label));
    }
  });

  // ── bye truth table + stale-generation guard ────────────────────────
  // Mirrors Bun tests "bye with reason:'signal' always resolves to
  // 'stopped' regardless of exitCode", "bye exitCode 0 → stopped /
  // non-zero → error", and "stale bye from the old runner does not
  // corrupt a restarted session" (command-dispatcher.test.ts) — proven
  // here to hold identically in the Rust port, against a real Store.
  maybe(
    "bye: truth table + stale-pid guard produce identical state on both sides",
    () => {
      type ByeCase = {
        name: string;
        registeredPid?: number;
        byePid?: number;
        exitCode: number;
        reason?: "signal" | "exit";
      };
      const cases: ByeCase[] = [
        // Stale generation: bye pid ≠ registered pid → ignored entirely.
        { name: "stale-pid", registeredPid: 111, byePid: 222, exitCode: 0 },
        // Matching pid, clean exit → stopped.
        {
          name: "clean-exit",
          registeredPid: 111,
          byePid: 111,
          exitCode: 0,
          reason: "exit",
        },
        // Matching pid, crash exit → error.
        {
          name: "crash-exit",
          registeredPid: 111,
          byePid: 111,
          exitCode: 1,
          reason: "exit",
        },
        // reason:"signal" ALWAYS → stopped, even with a crash-looking code.
        {
          name: "signal-137",
          registeredPid: 111,
          byePid: 111,
          exitCode: 137,
          reason: "signal",
        },
        // Back-compat: no pid on the bye → generation guard skipped.
        { name: "no-pid-crash", registeredPid: 111, exitCode: 5 },
        // No runner registered at all (already unregistered) → state still applied.
        { name: "unregistered-signal", exitCode: 143, reason: "signal" },
      ];

      for (const c of cases) {
        const sid = `bye-${c.name}`;

        // Bun side: fresh vault, seeded running session.
        const bunVault = tmpVault("bye-bun");
        const bun = makeBunDispatcher(bunVault);
        try {
          bun.store.createSession(sid, "/tmp/project");
          bun.store.updateSessionState(sid, "running");
          if (c.registeredPid !== undefined) {
            bun.sessionManager.registerRunner(
              sid,
              c.registeredPid,
              "/tmp/project",
            );
          }
          const msg: IpcBye = {
            t: "bye",
            sid,
            exitCode: c.exitCode,
            ...(c.byePid !== undefined ? { pid: c.byePid } : {}),
            ...(c.reason !== undefined ? { reason: c.reason } : {}),
          };
          bun.dispatcher.dispatchIpc(fakeRunner, msg);

          const bunState = bun.store.getSession(sid)?.state ?? null;
          const bunRegistered = bun.sessionManager.getRunner(sid) !== undefined;

          // Rust side: separate vault seeded identically via Bun Store
          // (shared-file writer parity is inc1's gate), then the Rust
          // dispatcher consumes the bye.
          const rustVault = tmpVault("bye-rust");
          const seed = new Store(rustVault);
          seed.createSession(sid, "/tmp/project");
          seed.updateSessionState(sid, "running");
          seed.close();

          const rust = probeJson([
            "dispatch-bye",
            rustVault,
            sid,
            c.registeredPid !== undefined ? String(c.registeredPid) : "-",
            c.byePid !== undefined ? String(c.byePid) : "-",
            String(c.exitCode),
            c.reason ?? "-",
          ]);

          expect({
            case: c.name,
            state: rust["state"],
            registered: rust["runnerRegistered"],
          }).toEqual({
            case: c.name,
            state: bunState,
            registered: bunRegistered,
          });
        } finally {
          bun.store.close();
        }
      }
    },
  );

  // ── session.create traversal guard (rank 3) ─────────────────────────
  // Mirrors Bun test "session.create with a path-traversal sid is rejected
  // BEFORE createSession/subscribe (rank 3)" (command-dispatcher.test.ts).
  // Asserts BOTH the byte-identical error frame AND zero side-effects
  // (no createSession call, no relay subscribe) on both sides.
  maybe(
    "session.create: traversal sid rejected identically with zero side-effects",
    async () => {
      const sids = [
        "../../evil",
        "..",
        "has/slash",
        "a b",
        "a..b", // (a NUL-byte sid cannot cross argv - covered by each side's own unit tests)
        // and the happy path, to pin the success frame + subscribe order too:
        "good-sid_1",
      ];

      for (const sid of sids) {
        const vault = tmpVault("create");
        const bun = makeBunDispatcher(vault);
        try {
          bun.dispatcher.dispatchRelayControl(
            bun.relay,
            { t: "session.create", sid, cwd: "/tmp/w" } as RelayControlMessage,
            "probe-fe",
          );
          // publishToPeer is fire-and-forget; settle queued microtasks.
          await Promise.resolve();

          const rust = probeJson(["dispatch-create-sid", vault, sid]);

          const bunReply = bun.peerMsgs[0] ?? null;
          expect(rust["reply"]).toEqual(bunReply as unknown);
          expect(rust["createCalls"]).toEqual(bun.createCalls as unknown[]);
          expect(rust["subscribes"]).toEqual(bun.subscribes as unknown[]);

          if (sid === "good-sid_1") {
            // Sanity: the happy path actually exercised the side-effects.
            expect(bun.createCalls.length).toBe(1);
            expect(bun.subscribes).toEqual([sid]);
          } else {
            // Guard: rejection happened BEFORE createSession/subscribe.
            expect(bun.createCalls.length).toBe(0);
            expect(bun.subscribes.length).toBe(0);
            expect((bunReply?.msg as { e?: string })?.e).toBe("SESSION_ERROR");
          }
        } finally {
          bun.store.close();
        }
      }
    },
  );

  // ── session.export parity (rank 4 off-by-one + formats) ─────────────
  // Mirrors Bun tests "session.export json respects limit and reports
  // truncated" and "export with exactly `limit` records is NOT truncated
  // (rank 4)" (command-dispatcher.test.ts). ONE shared vault: Bun seeds,
  // both dispatchers export the same rows read-only, frames must agree.
  maybe(
    "session.export: shared-vault frames agree (json limits, exact-limit rank 4, markdown byte-exact)",
    async () => {
      const vault = tmpVault("export");
      const sid = "exp-1";
      const seed = new Store(vault);
      const db = seed.createSession(sid, "/tmp/project");
      const enc = new TextEncoder();
      // Fixed timestamps → deterministic markdown; payload shapes cover the
      // JSON-object, empty and binary-io arms of the record serializer.
      db.append(
        "event",
        1700000000001,
        enc.encode(JSON.stringify({ last_assistant_message: "hi" })),
        "claude",
        "Stop",
      );
      db.append(
        "io",
        1700000000002,
        new Uint8Array([0x1b, 0x5b, 0x33, 0x31, 0x6d]),
      );
      db.append(
        "event",
        1700000000003,
        enc.encode(JSON.stringify({ prompt: "do x" })),
        "claude",
        "UserPromptSubmit",
      );
      db.append(
        "event",
        1700000000004,
        enc.encode("{}"),
        "claude",
        "Notification",
      );
      db.append(
        "event",
        1700000000005,
        enc.encode(JSON.stringify({ last_assistant_message: "bye" })),
        "claude",
        "Stop",
      );

      const bun = makeBunDispatcher(vault);

      const exportVia = async (
        format: "json" | "markdown",
        limit: number | null,
        exportSid: string = sid,
      ): Promise<{ bun: PeerMsg | null; rust: unknown }> => {
        bun.peerMsgs.length = 0;
        const msg = {
          t: "session.export",
          sid: exportSid,
          format,
          ...(limit !== null ? { limit } : {}),
        } as RelayControlMessage;
        bun.dispatcher.dispatchRelayControl(bun.relay, msg, "probe-fe");
        await Promise.resolve();
        const rust = probeJson([
          "dispatch-export",
          vault,
          exportSid,
          format,
          limit !== null ? String(limit) : "-",
        ]);
        return { bun: bun.peerMsgs[0] ?? null, rust: rust["reply"] };
      };

      const msgOf = (frame: unknown) =>
        (frame as { msg: Record<string, unknown> }).msg;

      try {
        // json, limit 3 of 5 → truncated:true, 3 records.
        {
          const { bun: b, rust: r } = await exportVia("json", 3);
          expect(b).not.toBeNull();
          // Envelope minus `d` (JSON key order differs — compare parsed).
          const { d: bd, ...bEnv } = msgOf(b) as { d: string };
          const { d: rd, ...rEnv } = msgOf(r) as { d: string };
          expect(rEnv).toEqual(bEnv);
          const bParsed = JSON.parse(bd) as {
            truncated: boolean;
            records: unknown[];
          };
          expect(JSON.parse(rd)).toEqual(bParsed);
          expect(bParsed.truncated).toBe(true);
          expect(bParsed.records.length).toBe(3);
        }

        // json, limit 5 of 5 (EXACT) → truncated:false — the rank-4
        // fetch-limit+1 off-by-one guard, cross-language.
        {
          const { bun: b, rust: r } = await exportVia("json", 5);
          const bParsed = JSON.parse((msgOf(b) as { d: string }).d) as {
            truncated: boolean;
            records: unknown[];
          };
          expect(JSON.parse((msgOf(r) as { d: string }).d)).toEqual(bParsed);
          expect(bParsed.truncated).toBe(false);
          expect(bParsed.records.length).toBe(5);
        }

        // json, no limit → default cap, truncated:false.
        {
          const { bun: b, rust: r } = await exportVia("json", null);
          expect(JSON.parse((msgOf(r) as { d: string }).d)).toEqual(
            JSON.parse((msgOf(b) as { d: string }).d),
          );
        }

        // markdown, limit 2 → the formatted `d` string must be BYTE-EXACT
        // (format_markdown vs export-formatter.ts parity on real rows).
        {
          const { bun: b, rust: r } = await exportVia("markdown", 2);
          expect(msgOf(r)).toEqual(msgOf(b));
          expect((msgOf(b) as { d: string }).d).toBe(
            (msgOf(r) as { d: string }).d,
          );
          expect((msgOf(b) as { format: string }).format).toBe("markdown");
        }

        // Missing session → identical NOT_FOUND error frame.
        {
          const { bun: b, rust: r } = await exportVia(
            "json",
            null,
            "no-such-sid",
          );
          expect(msgOf(r)).toEqual(msgOf(b));
          expect((msgOf(b) as { e: string }).e).toBe("NOT_FOUND");
        }
      } finally {
        bun.store.close();
      }
    },
  );
});
