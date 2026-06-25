export const meta = {
  name: 'ts-rust-parity-audit',
  description: 'Cross-implementation parity audit: every TS wire-guard bound (packages/protocol/src/*-guard.ts) vs its Rust counterpart (rust/tp-proto, rust/tp-relay). Finds divergences in BOTH directions (TS stricter than Rust, or Rust stricter than TS), adversarially verified, ranked with autonomousSafe flags.',
  phases: [
    { title: 'Find', detail: 'one finder per guard/decoder pair' },
    { title: 'Verify', detail: 'each divergence refuted by 3 skeptics (real-divergence/reachability/fix-safety)' },
    { title: 'Synthesize', detail: 'rank, dedup, flag autonomous-safe vs decision-gated' },
  ],
}

const CTX = `
You are auditing TS↔Rust WIRE-GUARD PARITY in the teleprompter monorepo.

BACKGROUND (verify against live HEAD — do not trust this paraphrase):
  - The TS protocol package (\`packages/protocol/src/*-guard.ts\`) validates every untrusted
    wire frame before any handler reads a field (fail-closed; returns null on malformed).
  - The Rust crates reimplement the SAME wire protocol byte-exactly, cross-checked by golden
    vectors (\`rust/tp-proto/tests/message_vectors.rs\`, \`rust/tp-core/tests/wire_vectors.rs\`):
      * \`rust/tp-proto/src/relay_client.rs\` — parse_relay_client_message (client→relay control:
        relay.auth/register/kx/pub/sub/unsub/ping/push/push.register). Mirror of TS
        relay-client-guard.ts.
      * \`rust/tp-proto/src/ipc.rs\` — parse_ipc_message (Runner↔Daemon IPC: hello/rec/bye/ack/
        input/resize/pair.*/session.*). Mirror of TS ipc-guard.ts.
      * \`rust/tp-proto/src/control.rs\`, \`label.rs\` — control.unpair/control.rename + Label union.
        Mirror of TS control-guard.ts + types/label.ts.
      * \`rust/tp-core/src/codec.rs\` — framed JSON codec (u32_be length + utf-8 JSON). Mirror of
        TS codec.ts.
      * \`rust/tp-core/src/pairing.rs\` — pairing bundle. Mirror of TS pairing.ts.
  - **\`rust/tp-relay\` IS THE LIVE PRODUCTION RELAY** (deployed to relay.tpmt.dev via
    deploy-relay.yml, ADR-0003). It uses tp-proto's parse_relay_client_message. So a parity gap
    on a relay-decoded message (relay.auth/register/kx/pub/sub/push/push.register) is LIVE in prod.
    The TS relay (packages/relay) is the retired reference.
  - The relay decodes ONLY the client→relay control plane (cleartext). Session-plane messages
    (resize/session.create/session.export — these are E2EE payloads) are NEVER decoded by the
    relay; only the daemon decrypts them. The TS daemon is still the live daemon (Rust daemon path
    not built yet), but \`rust/tp-cli\` (\`ipc_client.rs\`) and any Rust runner path use tp-proto's
    parse_ipc_message.

WHAT COUNTS AS A PARITY FINDING (cite BOTH the TS file:line AND the Rust file:line at live HEAD):
  - A NUMERIC BOUND present on one side but not the other (e.g. TS caps cols/rows at 65535 via
    isTerminalDimension, but Rust ipc.rs uses is_positive_int with no upper bound → the two
    implementations disagree on whether cols=65536 is a valid frame).
  - A STRING LENGTH cap present on one side but not the other (e.g. TS caps push.register token
    per-platform, Rust uses req_string with no cap).
  - A TYPE/SHAPE check present on one side but not the other (e.g. one side rejects __proto__ /
    NaN / Infinity / array-vs-object / negative-where-positive-required, the other doesn't).
  - A FIELD that one side validates and the other passes through unvalidated.
  - An ENUM/discriminant accepted on one side but rejected on the other.
  - Order-of-checks differences ONLY if they change what gets accepted/rejected or what
    expensive work (seal/alloc) runs before a gate.

DIRECTION MATTERS — report BOTH:
  - TS-stricter-than-Rust: the Rust decoder accepts a frame TS now rejects. If the Rust side is
    a live decoder (relay! or rust/tp-cli), this is a real hardening gap — the bound I added to TS
    must be mirrored in Rust. HIGH priority when Rust is the live relay.
  - Rust-stricter-than-TS: the TS guard accepts a frame Rust rejects. This is also a divergence
    (byte-exact contract break) and may indicate TS is missing a guard.

KNOWN CONTEXT (recent TS changes that may have OPENED divergences — verify each against HEAD):
  - PR #769 added to TS: isTerminalDimension/isOptionalTerminalDimension ([1,65535]) for cols/rows
    in relay-guard.ts (resize + session.create) AND ipc-guard.ts (resize); isOptionalPositiveInt
    for session.export limit; platform-aware MAX_PUSH_TOKEN_LEN (ios 128 / android 1024) for
    relay.push.register token in relay-client-guard.ts.
  - PR #767/#768 added to the TS RELAY (packages/relay, retired) and to relay-client-guard.ts:
    push-token identity authority, registration cap, pre-auth throttle, recentFrames cap. Some of
    these are relay-SERVER logic (rust/tp-relay/src/server.rs|conn.rs), not wire-guard — check
    whether the Rust relay has equivalents (registration cap, pre-auth throttle, recentFrames cap).

WHAT IS NOT A FINDING (do not report):
  - A difference in error message text / log strings.
  - A difference that is purely internal representation (u64 vs number) with no accept/reject
    consequence at the same input.
  - The relay legitimately NOT decoding session-plane messages (resize/session.create/export) —
    that is correct (they are E2EE; the relay is ciphertext-only). Only the IPC-plane resize
    (ipc.rs) and the daemon's TS decode are the parity surface for those.
  - Golden-vector tests that only cover VALID round-trips — note if bounds are untested, but the
    absence of a bound test is not itself the bug (the missing Rust bound is).

GROUNDING DISCIPLINE (mandatory): read the ACTUAL TS guard AND the ACTUAL Rust decoder at live
HEAD with Read/Grep, cite file:line on BOTH sides. Do NOT trust this brief, commit messages, or
prior narration. If you can't cite the concrete divergent lines on both sides, it is NOT a finding.
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
        required: ['title', 'tsSite', 'rustSite', 'direction', 'severity', 'liveSurface', 'description', 'divergentInput', 'fix'],
        properties: {
          title: { type: 'string' },
          tsSite: { type: 'string', description: 'TS file:line of the guard' },
          rustSite: { type: 'string', description: 'Rust file:line of the decoder' },
          direction: { type: 'string', enum: ['ts-stricter', 'rust-stricter', 'other'] },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          liveSurface: { type: 'string', description: 'is the divergent Rust decoder live? (rust/tp-relay prod / rust/tp-cli / not-yet-wired)' },
          description: { type: 'string', description: 'the exact bound/check that differs, grounded in both sources' },
          divergentInput: { type: 'string', description: 'a concrete input value accepted by one side and rejected by the other' },
          fix: { type: 'string', description: 'proposed fix (usually: add the missing bound to the side that lacks it)' },
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
    refuted: { type: 'boolean' },
    reason: { type: 'string', description: 'grounded justification citing source read at HEAD on both sides' },
  },
}

const PAIRS = [
  {
    key: 'ipc-resize-dims',
    label: 'IPC resize/hello + terminal dims',
    ts: ['packages/protocol/src/ipc-guard.ts', 'packages/protocol/src/guard-primitives.ts'],
    rust: ['rust/tp-proto/src/ipc.rs'],
    focus: 'resize cols/rows bounds (TS isTerminalDimension [1,65535] vs Rust is_positive_int), hello pid, session.* fields, ack/input. Every numeric/string field: does Rust enforce the same bound as the TS guard at the same field?',
  },
  {
    key: 'relay-client-push',
    label: 'relay-client guard + push.register token',
    ts: ['packages/protocol/src/relay-client-guard.ts'],
    rust: ['rust/tp-proto/src/relay_client.rs'],
    focus: 'push.register token length (TS platform-aware cap 128/1024 vs Rust req_string no cap), relay.pub seq, relay.sub after cursor, relay.push interruptionLevel enum + data shape, relay.auth/register field validation. This is the LIVE relay decoder — divergences here are in production.',
  },
  {
    key: 'relay-control-label',
    label: 'control + label parity',
    ts: ['packages/protocol/src/control-guard.ts', 'packages/protocol/src/types/label.ts'],
    rust: ['rust/tp-proto/src/control.rs', 'rust/tp-proto/src/label.rs'],
    focus: 'control.unpair/control.rename field validation, Label tagged-union decode (set:true/false), cross-version compat. Does Rust accept/reject the same Label shapes as decodeWireLabel?',
  },
  {
    key: 'codec-pairing',
    label: 'codec + pairing parity',
    ts: ['packages/protocol/src/codec.ts', 'packages/protocol/src/pairing.ts'],
    rust: ['rust/tp-core/src/codec.rs', 'rust/tp-core/src/pairing.rs'],
    focus: 'u32 length bounds / max frame size, partial-frame handling, UTF-8 validation; pairing bundle field validation (secret length, relay URL, daemon pubkey). Does Rust enforce the same max-frame / field bounds as TS?',
  },
  {
    key: 'relay-server-caps',
    label: 'relay-server DoS caps (TS retired vs Rust live)',
    ts: ['packages/relay/src/relay-server.ts', 'packages/protocol/src/relay-client-guard.ts'],
    rust: ['rust/tp-relay/src/server.rs', 'rust/tp-relay/src/conn.rs'],
    focus: 'The recently-added TS relay caps — registration cap (MAX_REGISTRATIONS), pre-auth message throttle (MAX_PREAUTH_MSGS), recentFrames per-daemon cap (MAX_RECENT_FRAME_KEYS_PER_DAEMON), push-token identity authority (frontendId from client not msg), and push.register seal-before-daemon-check ordering. Does the LIVE Rust relay (rust/tp-relay) have equivalents, or is it missing these DoS protections? This is the highest-stakes pair — the Rust relay is in production.',
  },
]

phase('Find')
log(`TS↔Rust parity audit: ${PAIRS.length} guard/decoder pairs → adversarial verify → synthesis`)

const verified = await pipeline(
  PAIRS,
  (pair) =>
    agent(
      `${CTX}\n\nYOUR PAIR: ${pair.label}\nTS SIDE: ${pair.ts.join(', ')}\nRUST SIDE: ${pair.rust.join(', ')}\nFOCUS: ${pair.focus}\n\n` +
        `Read BOTH sides at live HEAD (Read/Grep — cite real file:line on each side). For each wire field, compare the TS guard's check against the Rust decoder's check. Report every divergence where one side enforces a bound/type/enum the other doesn't, in EITHER direction. Give a concrete divergentInput that the two sides classify differently. If the two sides are in parity for a field, do NOT report it. If a Rust decoder genuinely doesn't exist for a message (e.g. relay never decodes session-plane), that's correct — not a finding. Quality over quantity; ground every claim in both sources.`,
      { label: `find:${pair.key}`, phase: 'Find', schema: FINDING_SCHEMA, model: 'sonnet', effort: 'high' },
    ),
  (found, pair) =>
    parallel(
      (found?.findings ?? []).map((f) => () =>
        parallel(
          ['real-divergence', 'reachability', 'fix-safety'].map((lens) => () =>
            agent(
              `${CTX}\n\nA finder reported this TS↔Rust parity divergence in ${pair.label}. REFUTE it through the ${lens} lens. Read BOTH cited sources at live HEAD yourself.\n\n` +
                `LENS = ${lens}:\n` +
                (lens === 'real-divergence'
                  ? `Is this an ACTUAL divergence? Re-read both the TS line and the Rust line. Is the finder misreading either side — e.g. does Rust enforce the bound elsewhere (a helper, serde attribute, a u16 type that structurally caps it, an earlier check)? Does TS actually have the bound the finder claims? Could a serde type (u16 vs u64) already enforce what the finder says is missing? If both sides actually agree, REFUTE.`
                  : lens === 'reachability'
                    ? `Is the divergent Rust decoder actually LIVE and reachable with attacker input? rust/tp-relay (relay.tpmt.dev) decoding a client→relay message = live + reachable. rust/tp-cli IPC decode = reachable only via local IPC (lower stakes). A not-yet-wired Rust daemon path = not currently reachable (note but lower severity). If the divergent path is dead/unreachable, REFUTE or downgrade.`
                    : `If the fix (adding the missing bound to the side that lacks it) were applied, would it preserve byte-exact round-trip of VALID messages and the golden vectors? Would adding a Rust bound reject any legitimate value the TS side accepts (so the fix would itself create a NEW divergence)? Confirm the proposed bound exactly matches the other side's bound. If the fix is wrong or would break valid traffic, REFUTE.`) +
                `\n\nDefault to refuted=true when uncertain or when you cannot independently confirm the divergence from BOTH sources. Only refuted=false if you confirm a real, reachable divergence with a correct fix.\n\n` +
                `FINDING:\n${JSON.stringify(f, null, 2)}`,
              { label: `verify:${pair.key}:${lens}`, phase: 'Verify', schema: VERDICT_SCHEMA, model: 'sonnet', effort: 'high' },
            ),
          ),
        ).then((verdicts) => {
          const valid = verdicts.filter(Boolean)
          const refutes = valid.filter((v) => v.refuted).length
          return { finding: f, pair: pair.key, refutes, verdicts: valid, survived: refutes < 2 }
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
    summary: `TS↔Rust parity audit: 0 divergences survived adversarial verification (${refuted.length} candidate(s) refuted). The TS wire guards and their Rust counterparts are in parity on the audited fields.`,
  }
}

const SYNTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ranked', 'decisionGated', 'summary'],
  properties: {
    ranked: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rank', 'title', 'tsSite', 'rustSite', 'direction', 'severity', 'liveSurface', 'autonomousSafe', 'rationale', 'fix'],
        properties: {
          rank: { type: 'integer' },
          title: { type: 'string' },
          tsSite: { type: 'string' },
          rustSite: { type: 'string' },
          direction: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          liveSurface: { type: 'string' },
          autonomousSafe: { type: 'boolean', description: 'true if the fix is mechanical (mirror an exact bound) with no product/threshold decision' },
          rationale: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
    decisionGated: {
      type: 'array',
      items: { type: 'string', description: 'title + the specific decision required' },
    },
    summary: { type: 'string' },
  },
}

const synthesis = await agent(
  `${CTX}\n\nThese TS↔Rust parity divergences SURVIVED adversarial verification (fewer than 2 of 3 skeptics refuted each). ` +
    `Rank by severity × live-reachability (rust/tp-relay prod divergences highest). For EACH, decide autonomousSafe: true if the fix is mechanically mirroring an EXACT bound from the other side (e.g. add the same length cap / uint16 cap to the Rust decoder) with no threshold/product decision; false if it needs a human call (a new cap value not already chosen on either side, a wire-format change, a golden-vector regeneration with risk). The repo rule: Rust changes need fmt+clippy+cargo test and a golden-vector cross-check; note any fix that would require regenerating or adding golden vectors. Dedup divergences that are the same root cause. List decision-gated ones separately.\n\n` +
    `SURVIVING DIVERGENCES:\n${JSON.stringify(survivors.map((s) => ({ ...s.finding, pair: s.pair, refutes: s.refutes })), null, 2)}`,
  { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA, model: 'opus', effort: 'high' },
)

return { ...synthesis, refutedCount: refuted.length, survivorCount: survivors.length }
