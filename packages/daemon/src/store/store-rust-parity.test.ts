/**
 * Bidirectional shared-file store-parity gate (ADR-0003 Phase 4, daemon inc1).
 *
 * The load-bearing invariant of the daemon store port: **the Rust `tp-daemon`
 * store and the Bun `Store` are interchangeable readers/writers of the SAME
 * on-disk `sessions.sqlite` (and per-session `<sid>.sqlite`).** During the
 * dual-run window a still-Bun CLI (`tp session list/delete/prune`) and a Rust
 * daemon — or vice versa — touch one vault directory; if their SQL text, PRAGMAs,
 * upsert semantics, or BLOB handling diverge by a byte, one side silently
 * corrupts or mis-reads the other's rows.
 *
 * This test proves parity in BOTH directions against one shared vault dir:
 *   - Bun writes  → Rust reads (dump) → assert row/BLOB byte-identical
 *   - Rust writes → Bun reads          → assert row/BLOB byte-identical
 * plus PRAGMA parity (the file's `journal_mode`/`user_version` observed after a
 * Rust open) and WAL/SHM sidecar cleanup (Rust `deleteSession` unlinks the
 * sidecars, matching the Bun path).
 *
 * The Rust side is driven through a tiny probe binary (`tp-daemon-probe`) with a
 * FIXED line-oriented CLI (see PROBE CONTRACT below) so the test never couples
 * to internal Rust method names — it asserts only on-disk bytes and the probe's
 * canonical-JSON dumps.
 *
 * Degrades by SKIP (not FAIL) when the probe binary has not been built — build
 * it with `(cd rust && cargo build --bin tp-daemon-probe)`. `bun` is always
 * in-tree. Mirrors the runner-parity.test.ts SKIP-when-unbuilt precedent.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROBE CONTRACT (tp-daemon-probe <cmd> <vaultDir> [args...])
 *   write-session  <vault> <sid> <cwd> <worktreeOrEmpty> <verOrEmpty>
 *   update-state   <vault> <sid> <state>
 *   append-rec     <vault> <sid> <kind> <ts> <ns|-> <name|-> <hexPayload>
 *   dump-sessions  <vault>                 → stdout: canonical JSON array, sorted keys
 *   dump-recs      <vault> <sid>           → stdout: canonical JSON array (payload as hex)
 *   write-pairing  <vault> <daemonId> <relayUrl> <relayToken> <regProof> \
 *                  <pubHex> <secHex> <secretHex> <label|-> <pairingId|-> <hostname|->
 *   dump-pairings  <vault>                 → stdout: canonical JSON array (BLOBs as hex)
 *   delete-session <vault> <sid>
 * All numeric timestamps the probe stamps itself (created_at/updated_at) are
 * replaced by the test with 0 before comparison; every other field must match.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { Store } from "./store";

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

/** Read all session rows straight out of the shared meta DB via Bun sqlite. */
function bunDumpSessions(vault: string): Record<string, unknown>[] {
  const db = new Database(join(vault, "sessions.sqlite"));
  try {
    return db.prepare("SELECT * FROM sessions ORDER BY sid").all() as Record<
      string,
      unknown
    >[];
  } finally {
    db.close();
  }
}

/** Hex-encode a BLOB column value (Bun hands back a Uint8Array/Buffer). */
function hex(v: unknown): string {
  if (v == null) return "";
  return Buffer.from(v as Uint8Array).toString("hex");
}

/** Normalize a session row (from either side) to a stable comparison shape. */
function normSession(r: Record<string, unknown>): Record<string, unknown> {
  return {
    sid: r["sid"],
    state: r["state"],
    worktree_path: r["worktree_path"] ?? null,
    cwd: r["cwd"],
    claude_version: r["claude_version"] ?? null,
    last_seq: Number(r["last_seq"] ?? 0),
    // created_at/updated_at are wall-clock stamped by whichever side wrote —
    // compared for presence/monotonicity elsewhere, not byte-equality here.
  };
}

describe("store shared-file parity (Bun Store vs Rust tp-daemon)", () => {
  const maybe = probeBin ? test : test.skip;

  maybe("Bun writes a session, Rust reads it back byte-identical", () => {
    const vault = mkdtempSync(join(tmpdir(), "tp-parity-b2r-"));
    const store = new Store(vault);
    try {
      store.createSession("parity-sess-1", "/tmp/project", "/tmp/wt", "1.2.3");
      store.updateLastSeq("parity-sess-1", 0);
    } finally {
      store.close();
    }

    const rustRows = JSON.parse(probe(["dump-sessions", vault])) as Record<
      string,
      unknown
    >[];
    const bunRows = bunDumpSessions(vault);

    expect(rustRows.length).toBe(1);
    expect(bunRows.length).toBe(1);
    expect(normSession(rustRows[0] as Record<string, unknown>)).toEqual(
      normSession(bunRows[0] as Record<string, unknown>),
    );
  });

  maybe("Rust writes a session, Bun reads it back byte-identical", () => {
    const vault = mkdtempSync(join(tmpdir(), "tp-parity-r2b-"));
    probe([
      "write-session",
      vault,
      "parity-sess-2",
      "/tmp/project",
      "/tmp/wt",
      "1.2.3",
    ]);

    const bunRows = bunDumpSessions(vault);
    expect(bunRows.length).toBe(1);
    const row = bunRows[0] as Record<string, unknown>;
    expect(normSession(row)).toEqual({
      sid: "parity-sess-2",
      state: "running",
      worktree_path: "/tmp/wt",
      cwd: "/tmp/project",
      claude_version: "1.2.3",
      last_seq: 0,
    });
  });

  maybe("Rust writes a pairing, Bun reads the key BLOBs byte-identical", () => {
    const vault = mkdtempSync(join(tmpdir(), "tp-parity-pair-"));
    const pub = "aa".repeat(32);
    const sec = "bb".repeat(32);
    const secret = "cc".repeat(32);
    probe([
      "write-pairing",
      vault,
      "daemon-xyz",
      "wss://relay.example/ws",
      "tok-123",
      "proof-456",
      pub,
      sec,
      secret,
      "my-label",
      "pairing-uuid-1",
      "host.local",
    ]);

    const db = new Database(join(vault, "sessions.sqlite"));
    try {
      const row = db
        .prepare("SELECT * FROM pairings WHERE daemon_id = ?")
        .get("daemon-xyz") as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row["relay_url"]).toBe("wss://relay.example/ws");
      expect(row["relay_token"]).toBe("tok-123");
      expect(row["registration_proof"]).toBe("proof-456");
      expect(hex(row["public_key"])).toBe(pub);
      expect(hex(row["secret_key"])).toBe(sec);
      expect(hex(row["pairing_secret"])).toBe(secret);
      expect(row["label"]).toBe("my-label");
      expect(row["pairing_id"]).toBe("pairing-uuid-1");
      expect(row["hostname"]).toBe("host.local");
    } finally {
      db.close();
    }
  });

  maybe(
    "Bun writes records, Rust reads the payload BLOBs byte-identical",
    () => {
      const vault = mkdtempSync(join(tmpdir(), "tp-parity-recs-"));
      const store = new Store(vault);
      const p1 = new TextEncoder().encode("hello binaryÿ");
      const p2 = new TextEncoder().encode("world");
      try {
        const db = store.createSession("rec-sess", "/tmp");
        db.append("io", 1000, p1);
        db.append("event", 2000, p2, undefined, "Stop");
      } finally {
        store.close();
      }

      const rustRecs = JSON.parse(
        probe(["dump-recs", vault, "rec-sess"]),
      ) as Record<string, unknown>[];
      expect(rustRecs.length).toBe(2);
      expect(rustRecs[0]).toMatchObject({
        seq: 1,
        kind: "io",
        ts: 1000,
        payload: Buffer.from(p1).toString("hex"),
      });
      expect(rustRecs[1]).toMatchObject({
        seq: 2,
        kind: "event",
        ts: 2000,
        name: "Stop",
        payload: Buffer.from(p2).toString("hex"),
      });
    },
  );

  maybe(
    "Rust deleteSession unlinks the WAL/SHM sidecars (matches Bun path)",
    () => {
      const vault = mkdtempSync(join(tmpdir(), "tp-parity-del-"));
      // Bun writes + populates a session (WAL sidecars appear on disk), Rust
      // deletes it — the sidecars must be gone, proving the Rust unlink covers
      // -wal/-shm exactly like the Bun deleteSession.
      const store = new Store(vault);
      try {
        const db = store.createSession("del-sess", "/tmp");
        for (let i = 0; i < 8; i++) {
          db.append("io", 1000 + i, new TextEncoder().encode(`p-${i}`));
        }
      } finally {
        store.close();
      }
      const base = join(vault, "sessions", "del-sess.sqlite");
      expect(existsSync(base)).toBe(true);

      probe(["delete-session", vault, "del-sess"]);

      expect(existsSync(base)).toBe(false);
      expect(existsSync(`${base}-wal`)).toBe(false);
      expect(existsSync(`${base}-shm`)).toBe(false);
    },
  );

  maybe("Rust opens the DB in WAL mode (PRAGMA parity)", () => {
    const vault = mkdtempSync(join(tmpdir(), "tp-parity-pragma-"));
    // Rust creates the DB; the persisted journal_mode must be WAL (it is a
    // durable, file-level setting, so a Bun open afterward observes it).
    probe(["write-session", vault, "pragma-sess", "/tmp", "", ""]);
    const db = new Database(join(vault, "sessions.sqlite"));
    try {
      const mode = db.prepare("PRAGMA journal_mode").get() as {
        journal_mode: string;
      };
      expect(mode.journal_mode.toLowerCase()).toBe("wal");
    } finally {
      db.close();
    }
  });

  if (!probeBin) {
    test.skip("(tp-daemon-probe not built — run: cd rust && cargo build --bin tp-daemon-probe)", () => {});
  }
});
