export const meta = {
  name: 'protocol-audit',
  description: 'Fact-grounded hardening audit of packages/protocol (wire codec + E2EE crypto + input-validation guards + pairing). File-sharded finders → adversarial refute-verify → ranked synthesis with autonomousSafe flags.',
  phases: [
    { title: 'Find', detail: 'one finder per cohesive protocol file cluster' },
    { title: 'Verify', detail: 'each finding refuted by 3 skeptics (correctness/reachability/invariant-safety)' },
    { title: 'Synthesize', detail: 'rank survivors, flag autonomous-safe vs decision-gated' },
  ],
}

// Shared context: protocol architecture + invariants + known-good (do NOT re-report).
const CTX = `
You are auditing \`packages/protocol\` of the teleprompter monorepo — a Bun/TypeScript
package that is THE most security-critical code in the repo. It contains:
  - the framed-JSON wire codec (\`codec.ts\`: u32_be length prefix + utf-8 JSON),
  - the E2EE crypto layer (\`crypto.ts\` + \`crypto-provider*.ts\`: X25519 crypto_kx,
    XChaCha20-Poly1305 AEAD, KDF, ratchet, kxKey + registrationProof derivation),
  - the QR pairing bundle (\`pairing.ts\`),
  - ALL input-validation guards (\`*-guard.ts\` + \`guard-primitives.ts\`): every wire
    frame from an untrusted peer is validated by these before use,
  - the type definitions / tagged unions (\`types/*.ts\`),
  - the backpressure queue (\`queued-writer.ts\`), logger, socket-path helper, compat shims.

CRITICAL property: \`tp-core\` (Rust) is a BYTE-EXACT reimplementation of the wire codec
and crypto, cross-checked against this TS code via golden vectors. A wire-format or
crypto bug here is a bug in BOTH implementations and affects EVERY component
(daemon, runner, relay, CLI, Swift app).

ARCHITECTURE INVARIANTS (a finding that breaks one of these is HIGH severity):
  - Relay is zero-trust ciphertext-only: it never sees plaintext. The crypto layer is
    what makes that true — any nonce reuse, key-derivation flaw, or AEAD misuse breaks it.
  - Every untrusted wire frame MUST pass a guard before any field is read. A guard that
    accepts a malformed/oversized/type-confused frame is a real finding.
  - Pairing secret + daemon pubkey travel via QR (offline); frontend pubkey via in-band
    relay.kx encrypted with kxKey. A pairing-bundle parse flaw or kxKey derivation flaw
    is HIGH severity.
  - Wire values (e.g. relay URL in the pairing bundle) must be carried VERBATIM —
    sanitization/normalization of wire values is a correctness bug (the peer must get
    the exact bytes).

WHAT COUNTS AS A FINDING (be concrete, cite file:line at LIVE HEAD):
  - crypto: nonce reuse/predictability, missing AEAD verification, key reuse across
    contexts, ratchet desync/replay, non-constant-time compares of secrets, weak KDF
    inputs, RNG misuse, missing length/domain separation.
  - codec/wire: integer overflow/underflow on the u32 length, unbounded allocation from
    an attacker-controlled length, partial-frame state confusion, UTF-8 / surrogate
    handling, throw-on-malformed that the caller doesn't catch (teardown invariant).
  - guards: a guard that passes a frame it should reject (type confusion, missing field
    check, prototype-pollution via __proto__, NaN/Infinity numeric fields, array vs
    object confusion, missing bounds on string/array length → DoS amplification).
  - pairing: bundle parse accepting malformed input, secret length not validated,
    relay URL scheme not constrained where it should be.
  - queued-writer: unbounded queue growth, lost-write on error, ordering violation.
  - resource: unbounded growth, missing cap, leak.

KNOWN-GOOD — these are INTENTIONAL, do NOT report them as findings:
  - codec.ts throws on oversized (H1) / malformed-JSON (M1) frames BY DESIGN — callers
    (IpcClient runner+CLi side) are REQUIRED to wrap decode() in try/catch for teardown.
    That is the documented contract, not a bug. (Only report if you find a NEW caller
    that fails to wrap it — but callers are OUTSIDE this package, so out of scope here.)
  - guards intentionally reject unknown frame types by returning null / a drop — that is
    correct fail-closed behavior, not a finding.
  - the relay URL in the pairing bundle is carried verbatim (NOT sanitized) on purpose —
    do NOT report "missing sanitization of relay URL" as a finding.
  - logger redacts/masks at call sites, not in the logger itself — out of scope.
  - test-utils.ts (rmRetry etc.) is test-only — out of scope.

GROUNDING DISCIPLINE (mandatory): read the ACTUAL file at live HEAD with Read/Grep and
cite file:line. Do NOT trust commit messages, prior-session narration, or this brief's
paraphrases as ground truth — verify against the real current source. If you cannot
cite a concrete file:line that exhibits the problem, it is NOT a finding.
`

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'file', 'line', 'severity', 'category', 'description', 'attack', 'fix'],
        properties: {
          title: { type: 'string', description: 'one-line summary' },
          file: { type: 'string', description: 'path:line at live HEAD' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          category: { type: 'string', enum: ['crypto', 'codec', 'guard', 'pairing', 'resource', 'correctness'] },
          description: { type: 'string', description: 'what is wrong, grounded in cited source' },
          attack: { type: 'string', description: 'concrete reachability: who can trigger it and how' },
          fix: { type: 'string', description: 'proposed fix' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['refuted', 'reason'],
  properties: {
    refuted: { type: 'boolean', description: 'true if the finding is NOT a real, reachable problem' },
    reason: { type: 'string', description: 'grounded justification citing source read at HEAD' },
  },
}

// 6 cohesive clusters by concern.
const CLUSTERS = [
  {
    key: 'codec-queue',
    label: 'codec + queued-writer + socket-path',
    files: ['packages/protocol/src/codec.ts', 'packages/protocol/src/queued-writer.ts', 'packages/protocol/src/socket-path.ts'],
    focus: 'u32 length integer handling, unbounded allocation from attacker length, partial-frame state, UTF-8 boundaries, queue growth/ordering/lost-writes, socket path length/traversal.',
  },
  {
    key: 'crypto-core',
    label: 'crypto.ts',
    files: ['packages/protocol/src/crypto.ts'],
    focus: 'nonce generation/uniqueness, AEAD verify, key derivation (kxKey, registrationProof), ratchet state, domain separation, constant-time compares, RNG.',
  },
  {
    key: 'crypto-provider',
    label: 'crypto-provider + libsodium',
    files: ['packages/protocol/src/crypto-provider.ts', 'packages/protocol/src/crypto-provider-libsodium.ts'],
    focus: 'sodium init race, primitive selection, buffer reuse/aliasing, error swallowing that yields silent plaintext, length assumptions.',
  },
  {
    key: 'guards-wire',
    label: 'relay/relay-client/relay-server/session-server guards',
    files: ['packages/protocol/src/relay-guard.ts', 'packages/protocol/src/relay-client-guard.ts', 'packages/protocol/src/relay-server-guard.ts', 'packages/protocol/src/session-server-guard.ts'],
    focus: 'frames accepted that should be rejected: type confusion, missing field checks, __proto__ pollution, NaN/Infinity numerics, unbounded string/array length, daemonId/sid format not validated.',
  },
  {
    key: 'guards-base',
    label: 'guard-primitives + control/hook/ipc guards + compat',
    files: ['packages/protocol/src/guard-primitives.ts', 'packages/protocol/src/control-guard.ts', 'packages/protocol/src/hook-guard.ts', 'packages/protocol/src/ipc-guard.ts', 'packages/protocol/src/compat.ts'],
    focus: 'base validation helpers correctness (isString/isFiniteNumber/bounds), prototype pollution, IPC frame validation, compat version-gating bypass, control/hook payload bounds.',
  },
  {
    key: 'pairing-types',
    label: 'pairing.ts + types/* + client.ts',
    files: ['packages/protocol/src/pairing.ts', 'packages/protocol/src/client.ts', 'packages/protocol/src/types/label.ts', 'packages/protocol/src/types/relay.ts', 'packages/protocol/src/types/ipc.ts', 'packages/protocol/src/types/session-proto.ts'],
    focus: 'pairing bundle encode/decode round-trip integrity, secret/pubkey length validation, relay URL scheme constraints, tagged-union discriminant confusion, label encode/decode cross-version.',
  },
]

phase('Find')
log(`protocol audit: ${CLUSTERS.length} clusters → adversarial refute-verify → synthesis`)

const verified = await pipeline(
  CLUSTERS,
  // Stage 1: finder reads the cluster's files at HEAD and reports findings.
  (cluster) =>
    agent(
      `${CTX}\n\nYOUR CLUSTER: ${cluster.label}\nFILES: ${cluster.files.join(', ')}\nFOCUS: ${cluster.focus}\n\n` +
        `Read each file at live HEAD (use Read/Grep — cite real file:line). Audit ONLY these files for the focus concerns plus anything else in WHAT COUNTS AS A FINDING. ` +
        `Skip everything in KNOWN-GOOD. For each genuine finding give a concrete attack/reachability and a fix. If a file is clean, report no findings for it — do NOT manufacture findings. Quality over quantity.`,
      { label: `find:${cluster.key}`, phase: 'Find', schema: FINDING_SCHEMA, model: 'sonnet', effort: 'high' },
    ),
  // Stage 2: each finding refuted by 3 skeptics with distinct lenses.
  (found, cluster) =>
    parallel(
      (found?.findings ?? []).map((f) => () =>
        parallel(
          ['correctness', 'reachability', 'invariant-safety'].map((lens) => () =>
            agent(
              `${CTX}\n\nA finder reported this potential issue in ${cluster.label}. Your job is to REFUTE it through the ${lens} lens. ` +
                `Read the cited source at live HEAD yourself and decide whether this is a REAL, reachable problem.\n\n` +
                `LENS = ${lens}:\n` +
                (lens === 'correctness'
                  ? `Is the described behavior actually what the code does? Re-read the exact lines. Is the finder misreading control flow, a guard that already covers this, or a type that prevents it? Is it actually KNOWN-GOOD / by-design?`
                  : lens === 'reachability'
                    ? `Can an untrusted peer actually reach this code path with attacker-controlled input? Is the input already constrained upstream (another guard, a type, a length cap)? Is the "attack" realistic or does it require already-privileged access?`
                    : `If the fix were applied, does it preserve the wire format / tp-core byte-exactness / E2EE invariants / verbatim-wire-value rule? Conversely, is the "bug" actually load-bearing intentional behavior whose removal would break an invariant?`) +
                `\n\nDefault to refuted=true when uncertain or when you cannot independently confirm the problem from the source. Only refuted=false if you can confirm a real, reachable issue.\n\n` +
                `FINDING:\n${JSON.stringify(f, null, 2)}`,
              { label: `verify:${cluster.key}:${lens}`, phase: 'Verify', schema: VERDICT_SCHEMA, model: 'sonnet', effort: 'high' },
            ),
          ),
        ).then((verdicts) => {
          const valid = verdicts.filter(Boolean)
          const refutes = valid.filter((v) => v.refuted).length
          // Survives if FEWER than 2 of 3 refute it.
          return { finding: f, cluster: cluster.key, refutes, verdicts: valid, survived: refutes < 2 }
        }),
      ),
    ),
)

phase('Synthesize')
const survivors = verified.flat().filter(Boolean).filter((r) => r.survived)
const refuted = verified.flat().filter(Boolean).filter((r) => !r.survived)
log(`survivors: ${survivors.length} | refuted: ${refuted.length}`)

if (survivors.length === 0) {
  return {
    ranked: [],
    decisionGated: [],
    summary: `protocol audit: 0 findings survived adversarial verification (${refuted.length} candidate(s) refuted). The wire codec, crypto layer, and input-validation guards held up under correctness/reachability/invariant-safety scrutiny.`,
  }
}

const SYNTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ranked', 'decisionGated', 'summary'],
  properties: {
    ranked: {
      type: 'array',
      description: 'all surviving findings, ranked by severity*reachability, with an autonomousSafe flag',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rank', 'title', 'file', 'severity', 'category', 'autonomousSafe', 'rationale', 'fix'],
        properties: {
          rank: { type: 'integer' },
          title: { type: 'string' },
          file: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          category: { type: 'string' },
          autonomousSafe: { type: 'boolean', description: 'true if the fix is mechanical/low-risk and needs no product/threshold decision' },
          rationale: { type: 'string', description: 'why this rank and why autonomousSafe or not' },
          fix: { type: 'string' },
        },
      },
    },
    decisionGated: {
      type: 'array',
      description: 'subset needing a human cap/threshold/product decision before fixing',
      items: { type: 'string', description: 'title + the specific decision required' },
    },
    summary: { type: 'string' },
  },
}

const synthesis = await agent(
  `${CTX}\n\nThe following findings SURVIVED adversarial verification (fewer than 2 of 3 skeptics refuted each). ` +
    `Rank them by severity × reachability. For EACH, decide autonomousSafe: true if the fix is mechanical and low-risk ` +
    `(add a missing bounds check, a missing field validation, a constant-time compare, a length cap with an obvious value) ` +
    `with NO product/threshold/cap-value decision required; false if it needs a human to choose a cap value, change wire format, ` +
    `or make a product call. List the decision-gated ones separately with the specific decision needed. ` +
    `Be honest: if something is borderline, explain the tradeoff. Deduplicate findings that are the same root cause across files.\n\n` +
    `SURVIVING FINDINGS:\n${JSON.stringify(survivors.map((s) => ({ ...s.finding, cluster: s.cluster, refutes: s.refutes })), null, 2)}`,
  { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA, model: 'opus', effort: 'high' },
)

return { ...synthesis, refutedCount: refuted.length, survivorCount: survivors.length }
