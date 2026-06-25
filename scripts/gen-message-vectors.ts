#!/usr/bin/env bun
/**
 * Generate the Stage 0 message-type parity fixture
 * (`rust/tp-proto/tests/fixtures/message-vectors.json`).
 *
 * This script imports the LIVE `@teleprompter/protocol` parse guards
 * (`parseRelayClientMessage` / `parseIpcMessage` / `parseControlMessage` /
 * `decodeWireLabel` / `decodeKxLabelOrKeep`) and, for a curated set of raw
 * inputs, records each guard's verdict:
 *   - ACCEPT cases: the guard returned a typed object → we re-serialize it
 *     (`JSON.parse(JSON.stringify(...))`) and store that as the canonical
 *     `json`. The Rust parser must produce a byte-identical value.
 *   - REJECT cases: the guard returned `null` → the Rust parser must too.
 *
 * The `label` section drives `decodeWireLabel` / `decodeKxLabelOrKeep` directly
 * (these are total / keep-current decoders, not fallible message parsers).
 *
 * Run:  bun scripts/gen-message-vectors.ts
 * The output is checked in and `rust/tp-proto/tests/message_vectors.rs`
 * `include_str!`s it. Regenerate whenever a guard's acceptance changes; the
 * Rust test then fails loudly if the port diverges.
 *
 * NOTE: This is a HOST-ONLY parity fixture. It exercises no runtime path and
 * mutates no TS source — Stage 0 is a zero-cutover gate (ADR-0003).
 */

import {
  decodeKxLabelOrKeep,
  decodeWireLabel,
  parseControlMessage,
  parseIpcMessage,
  parseRelayClientMessage,
  parseRelayServerMessage,
} from "@teleprompter/protocol";

type Guard = (raw: unknown) => unknown;

interface ParseCase {
  name: string;
  raw: unknown;
  accept: boolean;
  /** Present iff accept: the guard's parsed object re-serialized through JSON. */
  json?: unknown;
}

interface LabelCase {
  name: string;
  raw: unknown;
  /** `decodeWireLabel(raw)` serialized — always an object (total decoder). */
  wire: unknown;
  /** `decodeKxLabelOrKeep(raw)` serialized, or null for keep-current. */
  kxOrKeep: unknown | null;
}

/** Run a fallible guard and capture accept/reject + the canonical JSON. */
function parseCase(guard: Guard, name: string, raw: unknown): ParseCase {
  const out = guard(raw);
  if (out === null || out === undefined) {
    return { name, raw, accept: false };
  }
  // Round-trip through JSON so `undefined`-valued optional fields are dropped
  // exactly as they would be on the wire — this is the canonical shape the
  // Rust `serde_json::to_value(parsed)` must match.
  return { name, raw, accept: true, json: JSON.parse(JSON.stringify(out)) };
}

function labelCase(name: string, raw: unknown): LabelCase {
  const wire = JSON.parse(JSON.stringify(decodeWireLabel(raw)));
  const kx = decodeKxLabelOrKeep(raw);
  return {
    name,
    raw,
    wire,
    kxOrKeep: kx === null ? null : JSON.parse(JSON.stringify(kx)),
  };
}

// ── relay.* (parseRelayClientMessage) ──────────────────────────────────────
const relayClient: ParseCase[] = [
  // accepts
  parseCase(parseRelayClientMessage, "auth-daemon", {
    t: "relay.auth",
    role: "daemon",
    daemonId: "d1",
    token: "tok",
    v: 2,
  }),
  parseCase(parseRelayClientMessage, "auth-frontend-with-fid", {
    t: "relay.auth",
    role: "frontend",
    daemonId: "d1",
    token: "tok",
    v: 2,
    frontendId: "f1",
  }),
  parseCase(parseRelayClientMessage, "auth-resume", {
    t: "relay.auth.resume",
    token: "signed.tok",
    v: 2,
  }),
  parseCase(parseRelayClientMessage, "register", {
    t: "relay.register",
    daemonId: "d1",
    proof: "pf",
    token: "tok",
    v: 2,
  }),
  parseCase(parseRelayClientMessage, "kx", {
    t: "relay.kx",
    ct: "ciphertext",
    role: "frontend",
  }),
  parseCase(parseRelayClientMessage, "pub", {
    t: "relay.pub",
    sid: "s1",
    ct: "ct",
    seq: 7,
  }),
  parseCase(parseRelayClientMessage, "pub-seq-integer-float", {
    t: "relay.pub",
    sid: "s1",
    ct: "ct",
    seq: 2.0,
  }),
  parseCase(parseRelayClientMessage, "sub-with-after", {
    t: "relay.sub",
    sid: "s1",
    after: 3,
  }),
  parseCase(parseRelayClientMessage, "sub-no-after", {
    t: "relay.sub",
    sid: "s1",
  }),
  parseCase(parseRelayClientMessage, "unsub", { t: "relay.unsub", sid: "s1" }),
  parseCase(parseRelayClientMessage, "unsub-extra-field-dropped", {
    t: "relay.unsub",
    sid: "s1",
    evil: "x",
  }),
  parseCase(parseRelayClientMessage, "ping-no-ts", { t: "relay.ping" }),
  parseCase(parseRelayClientMessage, "ping-with-ts", {
    t: "relay.ping",
    ts: 12.5,
  }),
  parseCase(parseRelayClientMessage, "push-full", {
    t: "relay.push",
    frontendId: "f1",
    sealed: "tpps1.1.AAAA",
    title: "T",
    body: "B",
    interruptionLevel: "time-sensitive",
    data: { sid: "s1", daemonId: "d1", event: "Stop" },
  }),
  parseCase(parseRelayClientMessage, "push-minimal", {
    t: "relay.push",
    frontendId: "f1",
    sealed: "tpps1.1.AAAA",
    title: "T",
    body: "B",
  }),
  parseCase(parseRelayClientMessage, "push-register", {
    t: "relay.push.register",
    frontendId: "f1",
    token: "deadbeef",
    platform: "ios",
  }),
  // rejects
  parseCase(parseRelayClientMessage, "unknown-type", { t: "relay.bogus" }),
  parseCase(parseRelayClientMessage, "auth-bad-role", {
    t: "relay.auth",
    role: "admin",
    daemonId: "d",
    token: "t",
    v: 2,
  }),
  parseCase(parseRelayClientMessage, "auth-null-fid", {
    t: "relay.auth",
    role: "daemon",
    daemonId: "d",
    token: "t",
    v: 2,
    frontendId: null,
  }),
  parseCase(parseRelayClientMessage, "pub-seq-noninteger", {
    t: "relay.pub",
    sid: "s",
    ct: "c",
    seq: 1.5,
  }),
  parseCase(parseRelayClientMessage, "ping-null-ts", {
    t: "relay.ping",
    ts: null,
  }),
  // hardening (audit wq3kcwnks): null-valued optionals must REJECT on both sides.
  parseCase(parseRelayClientMessage, "sub-null-after", {
    t: "relay.sub",
    sid: "s",
    after: null,
  }),
  parseCase(parseRelayClientMessage, "push-null-interruption", {
    t: "relay.push",
    frontendId: "f",
    sealed: "s",
    title: "T",
    body: "B",
    interruptionLevel: null,
  }),
  parseCase(parseRelayClientMessage, "push-null-data", {
    t: "relay.push",
    frontendId: "f",
    sealed: "s",
    title: "T",
    body: "B",
    data: null,
  }),
  parseCase(parseRelayClientMessage, "push-missing-sealed", {
    t: "relay.push",
    frontendId: "f",
    title: "T",
    body: "B",
  }),
  parseCase(parseRelayClientMessage, "push-critical-level", {
    t: "relay.push",
    frontendId: "f",
    sealed: "s",
    title: "T",
    body: "B",
    interruptionLevel: "critical",
  }),
  parseCase(parseRelayClientMessage, "push-bad-data", {
    t: "relay.push",
    frontendId: "f",
    sealed: "s",
    title: "T",
    body: "B",
    data: { sid: "s" },
  }),
  parseCase(parseRelayClientMessage, "push-register-bad-platform", {
    t: "relay.push.register",
    frontendId: "f",
    token: "t",
    platform: "web",
  }),
  // Wire-boundary guard: platform-aware token length cap (PR #769 / Fix 1).
  // iOS token length 129 → TS rejects (MAX_PUSH_TOKEN_LEN.ios = 128).
  parseCase(parseRelayClientMessage, "push-register-token-too-long-ios", {
    t: "relay.push.register",
    frontendId: "f",
    token: "a".repeat(129),
    platform: "ios",
  }),
  // Android token length ~200 → TS ACCEPTS (MAX_PUSH_TOKEN_LEN.android = 1024).
  // This case proves platform-awareness: a flat 128-byte cap would wrongly reject.
  parseCase(parseRelayClientMessage, "push-register-token-ok-android", {
    t: "relay.push.register",
    frontendId: "f",
    token: "a".repeat(200),
    platform: "android",
  }),
];

// ── relay.* server→client (parseRelayServerMessage) ───────────────────────
const relayServer: ParseCase[] = [
  // ── relay.auth.ok ─────────────────────────────────────────────────────────
  // Minimal: only required daemonId.
  parseCase(parseRelayServerMessage, "auth-ok-minimal", {
    t: "relay.auth.ok",
    daemonId: "d1",
  }),
  // With resumed=false (tokens optional).
  parseCase(parseRelayServerMessage, "auth-ok-resumed-false", {
    t: "relay.auth.ok",
    daemonId: "d1",
    resumed: false,
  }),
  // Resumed=true with both token fields present — accepted.
  parseCase(parseRelayServerMessage, "auth-ok-resumed-full", {
    t: "relay.auth.ok",
    daemonId: "d1",
    resumed: true,
    resumeToken: "tok.signed",
    resumeExpiresAt: 9999000,
  }),
  // Extra unknown field silently dropped.
  parseCase(parseRelayServerMessage, "auth-ok-extra-field-dropped", {
    t: "relay.auth.ok",
    daemonId: "d1",
    evil: "x",
  }),
  // resumed=true without resumeToken → reject (guard lines 90-93).
  parseCase(parseRelayServerMessage, "auth-ok-resumed-missing-token", {
    t: "relay.auth.ok",
    daemonId: "d1",
    resumed: true,
    resumeExpiresAt: 9999,
  }),
  // resumed=true without resumeExpiresAt → reject.
  parseCase(parseRelayServerMessage, "auth-ok-resumed-missing-expires", {
    t: "relay.auth.ok",
    daemonId: "d1",
    resumed: true,
    resumeToken: "tok",
  }),
  // resumeToken: null → isOptionalString rejects.
  parseCase(parseRelayServerMessage, "auth-ok-null-resume-token", {
    t: "relay.auth.ok",
    daemonId: "d1",
    resumeToken: null,
  }),
  // resumed: null → isOptionalBoolean rejects.
  parseCase(parseRelayServerMessage, "auth-ok-null-resumed", {
    t: "relay.auth.ok",
    daemonId: "d1",
    resumed: null,
  }),
  // ── relay.auth.err ────────────────────────────────────────────────────────
  parseCase(parseRelayServerMessage, "auth-err", {
    t: "relay.auth.err",
    e: "UNAUTHORIZED",
  }),
  // Missing e → reject.
  parseCase(parseRelayServerMessage, "auth-err-missing-e", {
    t: "relay.auth.err",
  }),
  // ── relay.register.ok ─────────────────────────────────────────────────────
  parseCase(parseRelayServerMessage, "register-ok", {
    t: "relay.register.ok",
    daemonId: "d2",
  }),
  // ── relay.register.err ────────────────────────────────────────────────────
  parseCase(parseRelayServerMessage, "register-err", {
    t: "relay.register.err",
    e: "BAD_PROOF",
  }),
  // ── relay.frame ───────────────────────────────────────────────────────────
  // Full with optional frontendId.
  parseCase(parseRelayServerMessage, "frame-with-frontend-id", {
    t: "relay.frame",
    sid: "s1",
    ct: "AAAA==",
    seq: 3,
    from: "daemon",
    frontendId: "f1",
  }),
  // Without optional frontendId.
  parseCase(parseRelayServerMessage, "frame-no-frontend-id", {
    t: "relay.frame",
    sid: "s1",
    ct: "AAAA==",
    seq: 0,
    from: "frontend",
  }),
  // seq as integer-valued float (isNonNegativeInt accepts).
  parseCase(parseRelayServerMessage, "frame-seq-integer-float", {
    t: "relay.frame",
    sid: "s",
    ct: "c",
    seq: 2.0,
    from: "daemon",
  }),
  // Non-integer seq → reject.
  parseCase(parseRelayServerMessage, "frame-seq-noninteger", {
    t: "relay.frame",
    sid: "s",
    ct: "c",
    seq: 1.5,
    from: "daemon",
  }),
  // Bad from value → reject.
  parseCase(parseRelayServerMessage, "frame-bad-from", {
    t: "relay.frame",
    sid: "s",
    ct: "c",
    seq: 0,
    from: "relay",
  }),
  // ── relay.kx.frame ────────────────────────────────────────────────────────
  parseCase(parseRelayServerMessage, "kx-frame-daemon", {
    t: "relay.kx.frame",
    ct: "kxblob==",
    from: "daemon",
  }),
  parseCase(parseRelayServerMessage, "kx-frame-frontend", {
    t: "relay.kx.frame",
    ct: "kxblob==",
    from: "frontend",
  }),
  // Missing ct → reject.
  parseCase(parseRelayServerMessage, "kx-frame-missing-ct", {
    t: "relay.kx.frame",
    from: "daemon",
  }),
  // ── relay.presence ────────────────────────────────────────────────────────
  // Online with sessions.
  parseCase(parseRelayServerMessage, "presence-online", {
    t: "relay.presence",
    daemonId: "d1",
    online: true,
    sessions: ["s1", "s2"],
    lastSeen: 1700000000.5,
  }),
  // Offline with empty sessions array.
  parseCase(parseRelayServerMessage, "presence-offline-empty-sessions", {
    t: "relay.presence",
    daemonId: "d1",
    online: false,
    sessions: [],
    lastSeen: 0,
  }),
  // Missing sessions → reject.
  parseCase(parseRelayServerMessage, "presence-missing-sessions", {
    t: "relay.presence",
    daemonId: "d1",
    online: true,
    lastSeen: 0,
  }),
  // ── relay.pong ────────────────────────────────────────────────────────────
  parseCase(parseRelayServerMessage, "pong-with-ts", {
    t: "relay.pong",
    ts: 1234.5,
  }),
  parseCase(parseRelayServerMessage, "pong-no-ts", { t: "relay.pong" }),
  // ts: null → isOptionalNumber rejects.
  parseCase(parseRelayServerMessage, "pong-null-ts", {
    t: "relay.pong",
    ts: null,
  }),
  // Extra field dropped (guard is lenient).
  parseCase(parseRelayServerMessage, "pong-extra-field-dropped", {
    t: "relay.pong",
    ts: 1,
    evil: "x",
  }),
  // ── relay.err ─────────────────────────────────────────────────────────────
  parseCase(parseRelayServerMessage, "err-with-message", {
    t: "relay.err",
    e: "PUSH_UNSEAL_FAILED",
    m: "bad key",
  }),
  parseCase(parseRelayServerMessage, "err-no-message", {
    t: "relay.err",
    e: "UNKNOWN_TYPE",
  }),
  // m: null → isOptionalString rejects.
  parseCase(parseRelayServerMessage, "err-null-m", {
    t: "relay.err",
    e: "SOME_ERR",
    m: null,
  }),
  // ── relay.notification ────────────────────────────────────────────────────
  // With full data sub-object.
  parseCase(parseRelayServerMessage, "notification-with-data", {
    t: "relay.notification",
    title: "Claude finished",
    body: "Session done",
    data: { sid: "s1", daemonId: "d1", event: "Stop" },
  }),
  // Without optional data.
  parseCase(parseRelayServerMessage, "notification-no-data", {
    t: "relay.notification",
    title: "T",
    body: "B",
  }),
  // data: null → isOptionalNotifData rejects (null is not an object).
  parseCase(parseRelayServerMessage, "notification-null-data", {
    t: "relay.notification",
    title: "T",
    body: "B",
    data: null,
  }),
  // data missing a required field (event) → reject.
  parseCase(parseRelayServerMessage, "notification-data-missing-event", {
    t: "relay.notification",
    title: "T",
    body: "B",
    data: { sid: "s1", daemonId: "d1" },
  }),
  // ── relay.push.token ──────────────────────────────────────────────────────
  parseCase(parseRelayServerMessage, "push-token-ios", {
    t: "relay.push.token",
    frontendId: "f1",
    sealed: "tpps1.1.AAAA",
    platform: "ios",
  }),
  parseCase(parseRelayServerMessage, "push-token-android", {
    t: "relay.push.token",
    frontendId: "f1",
    sealed: "tpps1.1.BBBB",
    platform: "android",
  }),
  // Bad platform → reject.
  parseCase(parseRelayServerMessage, "push-token-bad-platform", {
    t: "relay.push.token",
    frontendId: "f1",
    sealed: "s",
    platform: "web",
  }),
  // Missing sealed → reject.
  parseCase(parseRelayServerMessage, "push-token-missing-sealed", {
    t: "relay.push.token",
    frontendId: "f1",
    platform: "ios",
  }),
  // ── unknown type ──────────────────────────────────────────────────────────
  parseCase(parseRelayServerMessage, "unknown-type", { t: "relay.bogus" }),
  parseCase(parseRelayServerMessage, "unknown-type-v3", {
    t: "relay.frame.v3",
  }),
];

// ── IPC (parseIpcMessage) ──────────────────────────────────────────────────
const ipc: ParseCase[] = [
  // accepts
  parseCase(parseIpcMessage, "hello-min", {
    t: "hello",
    sid: "s",
    cwd: "/x",
    pid: 42,
  }),
  parseCase(parseIpcMessage, "hello-full", {
    t: "hello",
    sid: "s",
    cwd: "/x",
    pid: 42,
    worktreePath: "/wt",
    claudeVersion: "1.2.3",
  }),
  parseCase(parseIpcMessage, "rec-min", {
    t: "rec",
    sid: "s",
    kind: "io",
    ts: 1,
    payload: "AAAA",
  }),
  parseCase(parseIpcMessage, "rec-full", {
    t: "rec",
    sid: "s",
    kind: "event",
    ts: 1.5,
    payload: "AAAA",
    ns: "claude",
    name: "Stop",
  }),
  parseCase(parseIpcMessage, "bye", { t: "bye", sid: "s", exitCode: 0 }),
  parseCase(parseIpcMessage, "bye-nonzero-float", {
    t: "bye",
    sid: "s",
    exitCode: -1,
  }),
  parseCase(parseIpcMessage, "ack", { t: "ack", sid: "s", seq: 0 }),
  parseCase(parseIpcMessage, "input", { t: "input", sid: "s", data: "AAAA" }),
  parseCase(parseIpcMessage, "resize", {
    t: "resize",
    sid: "s",
    cols: 80,
    rows: 24,
  }),
  parseCase(parseIpcMessage, "pair-begin-min", {
    t: "pair.begin",
    relayUrl: "wss://r",
  }),
  parseCase(parseIpcMessage, "pair-begin-full", {
    t: "pair.begin",
    relayUrl: "wss://r",
    daemonId: "d",
    label: { set: true, value: "Mac" },
  }),
  parseCase(parseIpcMessage, "pair-begin-string-label", {
    t: "pair.begin",
    relayUrl: "wss://r",
    label: "Office",
  }),
  parseCase(parseIpcMessage, "pair-begin-ok", {
    t: "pair.begin.ok",
    pairingId: "p",
    qrString: "tp://...",
    daemonId: "d",
  }),
  parseCase(parseIpcMessage, "pair-begin-err", {
    t: "pair.begin.err",
    reason: "daemon-id-taken",
    message: "taken",
  }),
  parseCase(parseIpcMessage, "pair-begin-err-no-msg", {
    t: "pair.begin.err",
    reason: "internal",
  }),
  parseCase(parseIpcMessage, "pair-cancel", {
    t: "pair.cancel",
    pairingId: "p",
  }),
  parseCase(parseIpcMessage, "pair-completed", {
    t: "pair.completed",
    pairingId: "p",
    daemonId: "d",
    label: { set: false },
  }),
  parseCase(parseIpcMessage, "pair-completed-absent-label", {
    t: "pair.completed",
    pairingId: "p",
    daemonId: "d",
  }),
  parseCase(parseIpcMessage, "pair-cancelled", {
    t: "pair.cancelled",
    pairingId: "p",
  }),
  parseCase(parseIpcMessage, "pair-error", {
    t: "pair.error",
    pairingId: "p",
    reason: "kx-decrypt-failed",
  }),
  parseCase(parseIpcMessage, "pair-remove", {
    t: "pair.remove",
    daemonId: "d",
  }),
  parseCase(parseIpcMessage, "pair-remove-ok", {
    t: "pair.remove.ok",
    daemonId: "d",
    notifiedPeers: 1,
  }),
  parseCase(parseIpcMessage, "pair-remove-err", {
    t: "pair.remove.err",
    daemonId: "d",
    reason: "not-found",
  }),
  parseCase(parseIpcMessage, "pair-rename", {
    t: "pair.rename",
    daemonId: "d",
    label: { set: true, value: "New" },
  }),
  parseCase(parseIpcMessage, "pair-rename-string-clear", {
    t: "pair.rename",
    daemonId: "d",
    label: "",
  }),
  parseCase(parseIpcMessage, "pair-rename-absent-label", {
    t: "pair.rename",
    daemonId: "d",
  }),
  parseCase(parseIpcMessage, "pair-rename-ok", {
    t: "pair.rename.ok",
    daemonId: "d",
    label: { set: true, value: "New" },
    notifiedPeers: 2,
  }),
  parseCase(parseIpcMessage, "pair-rename-err", {
    t: "pair.rename.err",
    daemonId: "d",
    reason: "internal",
    message: "boom",
  }),
  parseCase(parseIpcMessage, "session-delete", {
    t: "session.delete",
    sid: "s",
  }),
  parseCase(parseIpcMessage, "session-delete-ok", {
    t: "session.delete.ok",
    sid: "s",
    wasRunning: true,
  }),
  parseCase(parseIpcMessage, "session-delete-err", {
    t: "session.delete.err",
    sid: "s",
    reason: "not-found",
  }),
  parseCase(parseIpcMessage, "session-prune-all", {
    t: "session.prune",
    age: { kind: "all" },
    includeRunning: false,
    dryRun: true,
  }),
  parseCase(parseIpcMessage, "session-prune-older", {
    t: "session.prune",
    age: { kind: "olderThan", ms: 86400000 },
    includeRunning: true,
    dryRun: false,
  }),
  parseCase(parseIpcMessage, "session-prune-ok", {
    t: "session.prune.ok",
    sids: ["a", "b"],
    runningKilled: 1,
    dryRun: false,
  }),
  parseCase(parseIpcMessage, "session-prune-err", {
    t: "session.prune.err",
    reason: "internal",
    partialSids: ["a"],
    partialRunningKilled: 0,
  }),
  parseCase(parseIpcMessage, "doctor-probe", { t: "doctor.probe" }),
  parseCase(parseIpcMessage, "doctor-probe-ok", {
    t: "doctor.probe.ok",
    relays: [
      { daemonId: "d", relayUrl: "wss://r", connected: true, peerCount: 2 },
    ],
  }),
  parseCase(parseIpcMessage, "doctor-probe-ok-empty", {
    t: "doctor.probe.ok",
    relays: [],
  }),
  // rejects
  parseCase(parseIpcMessage, "unknown", { t: "nope" }),
  parseCase(parseIpcMessage, "hello-pid-zero", {
    t: "hello",
    sid: "s",
    cwd: "/x",
    pid: 0,
  }),
  parseCase(parseIpcMessage, "hello-null-worktree", {
    t: "hello",
    sid: "s",
    cwd: "/x",
    pid: 1,
    worktreePath: null,
  }),
  parseCase(parseIpcMessage, "rec-bad-ns", {
    t: "rec",
    sid: "s",
    kind: "io",
    ts: 1,
    payload: "x",
    ns: "bogus",
  }),
  parseCase(parseIpcMessage, "rec-null-ns", {
    t: "rec",
    sid: "s",
    kind: "io",
    ts: 1,
    payload: "x",
    ns: null,
  }),
  parseCase(parseIpcMessage, "rec-bad-kind", {
    t: "rec",
    sid: "s",
    kind: "nope",
    ts: 1,
    payload: "x",
  }),
  parseCase(parseIpcMessage, "ack-negative-seq", {
    t: "ack",
    sid: "s",
    seq: -1,
  }),
  parseCase(parseIpcMessage, "resize-zero-cols", {
    t: "resize",
    sid: "s",
    cols: 0,
    rows: 24,
  }),
  // Wire-boundary guard: terminal dimension uint16 cap (PR #769 / Fix 2).
  // cols=65535 (MAX_TERMINAL_DIMENSION) → TS accepts.
  parseCase(parseIpcMessage, "resize-cols-max", {
    t: "resize",
    sid: "s",
    cols: 65535,
    rows: 24,
  }),
  // cols=65536 → TS rejects (truncates to 0 in kernel uint16 ws_col).
  parseCase(parseIpcMessage, "resize-cols-too-big", {
    t: "resize",
    sid: "s",
    cols: 65536,
    rows: 24,
  }),
  parseCase(parseIpcMessage, "pair-rename-number-label", {
    t: "pair.rename",
    daemonId: "d",
    label: 42,
  }),
  parseCase(parseIpcMessage, "pair-rename-obj-without-set", {
    t: "pair.rename",
    daemonId: "d",
    label: { name: "x" },
  }),
  parseCase(parseIpcMessage, "pair-rename-array-label", {
    t: "pair.rename",
    daemonId: "d",
    label: ["x"],
  }),
  parseCase(parseIpcMessage, "pair-begin-number-label", {
    t: "pair.begin",
    relayUrl: "wss://r",
    label: 5,
  }),
  parseCase(parseIpcMessage, "session-prune-older-no-ms", {
    t: "session.prune",
    age: { kind: "olderThan" },
    includeRunning: false,
    dryRun: false,
  }),
  parseCase(parseIpcMessage, "session-prune-truthy-include", {
    t: "session.prune",
    age: { kind: "all" },
    includeRunning: 1,
    dryRun: false,
  }),
  parseCase(parseIpcMessage, "session-delete-ok-truthy-running", {
    t: "session.delete.ok",
    sid: "s",
    wasRunning: 1,
  }),
  parseCase(parseIpcMessage, "doctor-probe-ok-relay-missing-peer", {
    t: "doctor.probe.ok",
    relays: [{ daemonId: "d", relayUrl: "r", connected: false }],
  }),
  // hardening (audit wq3kcwnks): label-field null/boolean edge axes. null is
  // accepted (decodes to Unset); boolean is rejected by parseLabelField. The
  // generator records whatever the live guard does — these lock the verdict in.
  parseCase(parseIpcMessage, "pair-begin-null-label", {
    t: "pair.begin",
    relayUrl: "wss://r",
    label: null,
  }),
  parseCase(parseIpcMessage, "pair-begin-bool-label", {
    t: "pair.begin",
    relayUrl: "wss://r",
    label: true,
  }),
  parseCase(parseIpcMessage, "pair-completed-null-label", {
    t: "pair.completed",
    pairingId: "p",
    daemonId: "d",
    label: null,
  }),
  parseCase(parseIpcMessage, "pair-rename-ok-absent-label", {
    t: "pair.rename.ok",
    daemonId: "d",
    notifiedPeers: 1,
  }),
];

// ── control.* (parseControlMessage) ────────────────────────────────────────
const control: ParseCase[] = [
  parseCase(parseControlMessage, "unpair", {
    t: "control.unpair",
    daemonId: "d",
    frontendId: "f",
    reason: "rotated",
    ts: 123,
  }),
  parseCase(parseControlMessage, "rename-union", {
    t: "control.rename",
    daemonId: "d",
    frontendId: "f",
    label: { set: true, value: "X" },
    ts: 1,
  }),
  parseCase(parseControlMessage, "rename-legacy-string", {
    t: "control.rename",
    daemonId: "d",
    frontendId: "f",
    label: "Office Mac",
    ts: 1,
  }),
  parseCase(parseControlMessage, "rename-absent-label", {
    t: "control.rename",
    daemonId: "d",
    frontendId: "f",
    ts: 1,
  }),
  parseCase(parseControlMessage, "rename-garbage-label-tolerated", {
    t: "control.rename",
    daemonId: "d",
    frontendId: "f",
    label: 42,
    ts: 1,
  }),
  // rejects
  parseCase(parseControlMessage, "unknown", { t: "control.bogus" }),
  parseCase(parseControlMessage, "unpair-bad-reason", {
    t: "control.unpair",
    daemonId: "d",
    frontendId: "f",
    reason: "nope",
    ts: 1,
  }),
  parseCase(parseControlMessage, "unpair-missing-ts", {
    t: "control.unpair",
    daemonId: "d",
    frontendId: "f",
    reason: "rotated",
  }),
  parseCase(parseControlMessage, "rename-missing-daemonid", {
    t: "control.rename",
    frontendId: "f",
    label: "x",
    ts: 1,
  }),
  // hardening (audit wq3kcwnks): ts semantics on the control plane.
  parseCase(parseControlMessage, "unpair-noninteger-ts", {
    t: "control.unpair",
    daemonId: "d",
    frontendId: "f",
    reason: "rotated",
    ts: 1.5,
  }),
  parseCase(parseControlMessage, "rename-null-ts", {
    t: "control.rename",
    daemonId: "d",
    frontendId: "f",
    label: "x",
    ts: null,
  }),
  parseCase(parseControlMessage, "rename-absent-ts", {
    t: "control.rename",
    daemonId: "d",
    frontendId: "f",
    label: "x",
  }),
  parseCase(parseControlMessage, "unpair-absent-reason", {
    t: "control.unpair",
    daemonId: "d",
    frontendId: "f",
    ts: 1,
  }),
];

// ── Label decoders (decodeWireLabel / decodeKxLabelOrKeep) ──────────────────
const label: LabelCase[] = [
  labelCase("null", null),
  labelCase("string", "Office Mac"),
  labelCase("string-padded", "  Office Mac  "),
  labelCase("string-empty", ""),
  labelCase("string-whitespace", "   "),
  labelCase("union-set", { set: true, value: "x" }),
  labelCase("union-set-padded", { set: true, value: "  x  " }),
  labelCase("union-set-empty-value", { set: true, value: "" }),
  labelCase("union-set-nonstring-value", { set: true, value: 42 }),
  labelCase("union-set-missing-value", { set: true }),
  labelCase("union-unset", { set: false }),
  labelCase("union-unset-stray-value", { set: false, value: "x" }),
  labelCase("set-non-bool", { set: 1 }),
  labelCase("set-string-true", { set: "true" }),
  labelCase("object-without-set", { name: "x" }),
  labelCase("number", 42),
  labelCase("array", ["x"]),
  labelCase("bool", true),
];

// ── LabelUpdate contract (ADR-0003 Amendment 1, A1.3#1) ───────────────────
// Exactly the golden cases from the new unified contract.
//
//   wire     — decodeWireLabel(raw)          (total; authoritative surfaces)
//   kxOrKeep — decodeKxLabelOrKeep(raw) | null
//              null signals keep-current: Unset (including empty/null) AND absent
//              both map to null here, because decodeKxLabelOrKeep collapses Unset→null.
//              The "absent = keep-current" distinction is captured by the absent-keep
//              case whose `raw` field is absent from the JSON object entirely — the
//              Rust test drives decode_label_opt_field(None) for that case only.
const labelUpdate: LabelCase[] = [
  // Set — non-empty value
  labelCase("set-nonempty", { set: true, value: "Office Mac" }),
  // Set — trimmed (leading/trailing whitespace stripped)
  labelCase("set-trimmed", { set: true, value: "  x  " }),
  // Set with empty value → collapses to Unset via makeLabel("" after trim)
  labelCase("set-empty-unset", { set: true, value: "" }),
  // Clear — {set:false} authoritative Unset on ControlRename/IPC surfaces
  labelCase("clear", { set: false }),
  // Absent field — undefined serialises to absent JSON key; Rust drives
  // decode_label_opt_field(None) and asserts None (keep-current).
  labelCase("absent-keep", undefined),
  // Legacy back-compat (lenient read — SQLite / old daemon)
  labelCase("legacy-string", "x"),
  labelCase("legacy-empty", ""),
  labelCase("legacy-null", null),
];

const fixture = { relayClient, relayServer, ipc, control, label, labelUpdate };

const outPath = new URL(
  "../rust/tp-proto/tests/fixtures/message-vectors.json",
  import.meta.url,
);
const json = `${JSON.stringify(fixture, null, 2)}\n`;
await Bun.write(outPath, json);

// `JSON.stringify(..., 2)` puts short arrays on multiple lines, but the
// committed fixture is Biome-formatted (collapsed short arrays). Re-format the
// written file so regeneration stays byte-identical to what `biome ci` expects
// — otherwise the next regen silently re-breaks the CI format gate. The bytes
// are JSON-whitespace only, so the Rust golden-vector parser is unaffected.
const fmt = Bun.spawnSync(
  ["pnpm", "exec", "biome", "format", "--write", outPath.pathname],
  { cwd: new URL("..", import.meta.url).pathname, stderr: "inherit" },
);
if (fmt.exitCode !== 0) {
  throw new Error(`biome format failed on ${outPath.pathname}`);
}

const counts = {
  relayClient: relayClient.length,
  relayServer: relayServer.length,
  ipc: ipc.length,
  control: control.length,
  label: label.length,
  labelUpdate: labelUpdate.length,
};
console.error(
  `wrote ${outPath.pathname} (relayClient=${counts.relayClient}, relayServer=${counts.relayServer}, ipc=${counts.ipc}, control=${counts.control}, label=${counts.label}, labelUpdate=${counts.labelUpdate})`,
);
