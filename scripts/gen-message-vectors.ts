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
  parseCase(parseRelayClientMessage, "sub-no-after", { t: "relay.sub", sid: "s1" }),
  parseCase(parseRelayClientMessage, "unsub", { t: "relay.unsub", sid: "s1" }),
  parseCase(parseRelayClientMessage, "unsub-extra-field-dropped", {
    t: "relay.unsub",
    sid: "s1",
    evil: "x",
  }),
  parseCase(parseRelayClientMessage, "ping-no-ts", { t: "relay.ping" }),
  parseCase(parseRelayClientMessage, "ping-with-ts", { t: "relay.ping", ts: 12.5 }),
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
  parseCase(parseRelayClientMessage, "ping-null-ts", { t: "relay.ping", ts: null }),
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
];

// ── IPC (parseIpcMessage) ──────────────────────────────────────────────────
const ipc: ParseCase[] = [
  // accepts
  parseCase(parseIpcMessage, "hello-min", { t: "hello", sid: "s", cwd: "/x", pid: 42 }),
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
  parseCase(parseIpcMessage, "bye-nonzero-float", { t: "bye", sid: "s", exitCode: -1 }),
  parseCase(parseIpcMessage, "ack", { t: "ack", sid: "s", seq: 0 }),
  parseCase(parseIpcMessage, "input", { t: "input", sid: "s", data: "AAAA" }),
  parseCase(parseIpcMessage, "resize", { t: "resize", sid: "s", cols: 80, rows: 24 }),
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
  parseCase(parseIpcMessage, "pair-cancel", { t: "pair.cancel", pairingId: "p" }),
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
  parseCase(parseIpcMessage, "pair-cancelled", { t: "pair.cancelled", pairingId: "p" }),
  parseCase(parseIpcMessage, "pair-error", {
    t: "pair.error",
    pairingId: "p",
    reason: "kx-decrypt-failed",
  }),
  parseCase(parseIpcMessage, "pair-remove", { t: "pair.remove", daemonId: "d" }),
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
  parseCase(parseIpcMessage, "session-delete", { t: "session.delete", sid: "s" }),
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
  parseCase(parseIpcMessage, "hello-pid-zero", { t: "hello", sid: "s", cwd: "/x", pid: 0 }),
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
  parseCase(parseIpcMessage, "ack-negative-seq", { t: "ack", sid: "s", seq: -1 }),
  parseCase(parseIpcMessage, "resize-zero-cols", {
    t: "resize",
    sid: "s",
    cols: 0,
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

const fixture = { relayClient, ipc, control, label };

const outPath = new URL(
  "../rust/tp-proto/tests/fixtures/message-vectors.json",
  import.meta.url,
);
const json = `${JSON.stringify(fixture, null, 2)}\n`;
await Bun.write(outPath, json);

const counts = {
  relayClient: relayClient.length,
  ipc: ipc.length,
  control: control.length,
  label: label.length,
};
console.error(
  `wrote ${outPath.pathname} (relayClient=${counts.relayClient}, ipc=${counts.ipc}, control=${counts.control}, label=${counts.label})`,
);
