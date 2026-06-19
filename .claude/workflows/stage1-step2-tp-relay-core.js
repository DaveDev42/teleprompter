export const meta = {
  name: 'stage1-step2-tp-relay-core',
  description: 'Stage 1 Step 2: scaffold tp-relay crate + RelayServerMessage serde core + golden vectors',
  phases: [
    { title: 'Survey' },
    { title: 'Implement' },
    { title: 'Goldens' },
    { title: 'Verify' },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 1 Step 2 (ADR-0003 A1.5 row 2): "Rust relay core: framing + serde
// structs/enums (no guard layer), reuse tp-core codec/E2EE; drop dead Envelope.
// Gate: cargo test round-trip vs golden; deny_unknown_fields parity."
//
// GROUND TRUTH (verified live at HEAD by the parent before authoring):
//  - tp-proto ALREADY has the client→relay parse side: `RelayClientMessage`
//    enum + manual `parse_relay_client_message(&Value)` (relay_client.rs, 379
//    lines, 28 golden cases in the `relayClient` fixture group). These parsers
//    are MANUAL Option-extraction, NOT serde-derive (deny_unknown_fields count
//    = 0 across tp-proto). DO NOT rewrite them.
//  - MISSING and in-scope for Step 2:
//     (a) the `tp-relay` crate itself (new workspace member, deps tp-proto +
//         tp-core; rust/Cargo.toml members = ["tp-core","tp-proto"] today).
//     (b) the server→peer direction `RelayServerMessage` (NOT present anywhere
//         in Rust): relay.auth.ok, relay.auth.err, relay.register.ok,
//         relay.register.err, relay.frame, relay.kx.frame, relay.presence,
//         relay.pong, relay.err, relay.notification, relay.push.token.
//         TS SoT = packages/protocol/src/types/relay.ts (RelayServerMessage
//         union, lines ~173-300) + relay-server-guard.ts (parse predicates).
//     (c) golden vectors for the server direction + round-trip tests.
//  - Framing: reuse tp-core codec (u32_be length + utf-8 JSON). The relay
//    forwards ciphertext only — Step 2 is message (de)serialization, not WS.
//  - Wire field names are intentionally abbreviated; serde rename must be
//    byte-exact with the TS JSON. Reuse tp-proto helpers (Role, Platform,
//    InterruptionLevel, PushData) where the server messages share them.
//
// Every agent MUST read the live HEAD working-tree files it cites (file:line),
// never trust this brief's recollection as ground truth (CLAUDE.md discipline).
// Rust invocation gotcha: bare `cargo` is the rustup shim that mis-parses
// `--all`/`--workspace`; use
//   PATH="$(dirname "$(rustup which cargo)"):$PATH" cargo <cmd>
// or the explicit toolchain bin
//   $HOME/.rustup/toolchains/1.96.0-aarch64-apple-darwin/bin/cargo
// ─────────────────────────────────────────────────────────────────────────────

const REPO = '/Users/dave/Projects/github.com/teleprompter'

phase('Survey')

const SURVEY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['messages', 'sharedTypes', 'notes'],
  properties: {
    messages: {
      type: 'array',
      description: 'One entry per RelayServerMessage variant',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['t', 'tsInterface', 'tsFile', 'fields', 'denyUnknown'],
        properties: {
          t: { type: 'string', description: 'the wire "t" discriminant, e.g. relay.auth.ok' },
          tsInterface: { type: 'string', description: 'TS interface name in relay.ts' },
          tsFile: { type: 'string', description: 'file:line where the interface is defined' },
          fields: {
            type: 'array',
            description: 'every field on the wire object including t',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'tsType', 'optional', 'wireName'],
              properties: {
                name: { type: 'string' },
                tsType: { type: 'string', description: 'the TS type as written' },
                optional: { type: 'boolean', description: 'true if the field may be absent on the wire' },
                wireName: { type: 'string', description: 'exact JSON key on the wire (== name unless aliased)' },
              },
            },
          },
          denyUnknown: {
            type: 'boolean',
            description: 'does the TS guard reject unknown extra fields for this message? (check relay-server-guard.ts)',
          },
        },
      },
    },
    sharedTypes: {
      type: 'array',
      description: 'tp-proto types reusable for server messages (Role/Platform/InterruptionLevel/PushData/etc) with their rust path',
      items: { type: 'string' },
    },
    notes: {
      type: 'string',
      description: 'parity subtleties: optional-vs-present, presence.sessions handling, error code/category enums, any field that needs a custom serde attr',
    },
  },
}

const survey = await agent(
  `Survey the relay SERVER→peer message surface so a Rust serde port can mirror it byte-exactly.

Working tree root: ${REPO} (read live HEAD files; cite file:line; do NOT trust any second-hand description).

Primary SoT files to read fully:
- packages/protocol/src/types/relay.ts — the RelayServerMessage tagged union and every interface it references (RelayAuthOk, RelayAuthErr, RelayRegisterOk, RelayRegisterErr, RelayFrame, RelayKeyExchangeFrame, RelayPresence, RelayPong, RelayError, RelayNotification, RelayPushTokenSealed).
- packages/protocol/src/relay-server-guard.ts — parseRelayServerMessage and its per-message predicates (this is the authority on which fields are required/optional and whether unknown fields are rejected).
- rust/tp-proto/src/relay_client.rs — to learn the EXISTING serde conventions/helpers (Role, Platform, InterruptionLevel, PushData, #[serde(rename=...)], the manual parse style) so the new server enum is consistent and reuses shared types.
- rust/tp-proto/src/lib.rs — current module exports + any shared helpers (opt_string, req_string, is_number).

For EVERY variant of RelayServerMessage, record: the "t" discriminant, the TS interface name + file:line, every wire field (name, TS type, optional?, exact JSON key), and whether the guard denies unknown fields.

Pay special attention to parity subtleties and put them in notes: the presence message's sessions field (ADR says app discards it → server emits []), the error message's code/category shape, interruptionLevel reuse, any camelCase wire keys (frontendId, daemonId) that need #[serde(rename)]. Return ONLY the structured object.`,
  { label: 'survey:server-messages', phase: 'Survey', model: 'sonnet', schema: SURVEY_SCHEMA },
)

if (!survey) {
  log('Survey agent died — aborting; parent should fall back to manual implementation.')
  return { aborted: 'survey-failed' }
}
log(`Surveyed ${survey.messages?.length ?? 0} server-message variants; ${survey.sharedTypes?.length ?? 0} reusable tp-proto types.`)

phase('Implement')

const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['filesWritten', 'buildPassed', 'testPassed', 'summary', 'denyUnknownApproach'],
  properties: {
    filesWritten: { type: 'array', items: { type: 'string' } },
    buildPassed: { type: 'boolean' },
    testPassed: { type: 'boolean' },
    denyUnknownApproach: {
      type: 'string',
      description: 'how deny_unknown_fields parity was achieved (serde attr vs manual) and on which structs',
    },
    summary: { type: 'string', description: 'what was implemented + any deviation from the survey + exact cargo invocation used' },
  },
}

const impl = await agent(
  `Implement Stage 1 Step 2: scaffold the \`tp-relay\` crate and add the RelayServerMessage serde core.

Working tree root: ${REPO}. Read live HEAD before editing.

SURVEYED SERVER-MESSAGE SURFACE (authoritative for field shapes; still verify against relay.ts/relay-server-guard.ts at HEAD):
${JSON.stringify(survey, null, 2)}

DO:
1. Create the crate \`rust/tp-relay\` as a NEW workspace member:
   - Add "tp-relay" to rust/Cargo.toml [workspace] members (keep alpha/logical order).
   - rust/tp-relay/Cargo.toml: package name tp-relay, edition/rust-version/license/repository via workspace inheritance ([package] ... .workspace = true as the other crates do — read tp-proto/Cargo.toml for the exact pattern), [lints] workspace = true, deps: tp-proto (path), tp-core (path), serde (workspace or with derive feature — match how tp-proto declares it), serde_json. NO axum/tokio yet (that's Step 3+). This step is pure message (de)serialization.
   - rust/tp-relay/src/lib.rs with a \`messages\` module.
2. In rust/tp-relay/src/messages.rs (or similar), define \`RelayServerMessage\` as a serde-derive tagged enum (#[serde(tag = "t")]) with one variant per surveyed message, wire-exact #[serde(rename = "relay.xxx")] discriminants and #[serde(rename = "...")] for camelCase keys. REUSE tp-proto shared types (Role, Platform, InterruptionLevel, PushData, the Label union from tp-proto::label) by importing them — do NOT duplicate. Optional fields → Option<T> with #[serde(skip_serializing_if = "Option::is_none")] so serialized JSON omits absent keys (byte-exact with TS).
3. deny_unknown_fields parity: Step 2's gate calls for it. Add #[serde(deny_unknown_fields)] to the inner structs/variants WHERE the TS guard rejects unknown fields (per the survey's denyUnknown flags). Document in denyUnknownApproach which structs got it and why any did not.
4. Framing: add a thin re-export or helper so the crate exposes encode/decode via tp-core's codec (read tp-core for the codec fn names; reuse, don't reimplement). If tp-core's codec is generic over a serializable payload, just document the intended usage in a doc-comment — do not build the WS layer.
5. Do NOT port the dead catch-all Envelope (ADR: "dead Envelope drop"). Per-variant enum only.

BUILD + TEST with the rustup-shim-safe invocation (bare cargo mis-parses --workspace):
  cd ${REPO}/rust && export PATH="$(dirname "$(rustup which cargo)"):$PATH" && cargo build -p tp-relay && cargo test -p tp-relay
Then fmt + clippy the new crate:
  cargo fmt --all -- --check    (run cargo fmt --all first if it reports diffs)
  cargo clippy -p tp-relay --all-targets   (workspace lints: clippy::all=deny, pedantic=warn; do NOT pass -D warnings)

Conventions: edition 2021, max_width 100 (rustfmt.toml), unsafe forbidden, all-safe-code. Match tp-proto's doc-comment density and #[serde] style exactly. Comments/docs in English.

Return the structured result. Set buildPassed/testPassed honestly from the actual cargo exit codes.`,
  { label: 'impl:tp-relay-crate', phase: 'Implement', model: 'sonnet', schema: IMPL_SCHEMA },
)

if (!impl) {
  log('Implementation agent died — aborting.')
  return { aborted: 'impl-failed', survey }
}
log(`Implement: build=${impl.buildPassed} test=${impl.testPassed}; files: ${(impl.filesWritten || []).join(', ')}`)

phase('Goldens')

const GOLDEN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['vectorsAdded', 'fixtureRegenerated', 'roundTripTestPassed', 'biomeClean', 'summary'],
  properties: {
    vectorsAdded: { type: 'number', description: 'count of new server-message golden cases' },
    fixtureRegenerated: { type: 'boolean' },
    roundTripTestPassed: { type: 'boolean' },
    biomeClean: { type: 'boolean', description: 'biome ci . exit 0 after fixture regen (the generator self-formats; verify)' },
    summary: { type: 'string' },
  },
}

const golden = await agent(
  `Add golden vectors for the RelayServerMessage direction and a Rust round-trip test that drives them.

Working tree root: ${REPO}. Read live HEAD before editing.

The implemented crate + surveyed messages:
${JSON.stringify({ impl: impl.summary, denyUnknown: impl.denyUnknownApproach, messages: survey.messages.map((m) => m.t) }, null, 2)}

DO:
1. Read scripts/gen-message-vectors.ts to learn the existing generator structure (groups: relayClient, ipc, control, label, labelUpdate; the parseCase/labelCase helpers; how it sources the oracle from the TS guards). Read the existing relayClient group as the template.
2. Add a \`relayServer\` group: for each RelayServerMessage variant, at least one representative case (and Set/absent/optional edge cases where a field is optional — e.g. presence with sessions=[], error with/without optional category, push.token sealed blob, frame, kx.frame). Source the oracle from packages/protocol/src/relay-server-guard.ts's parseRelayServerMessage where possible (accept cases) plus a couple of reject cases (unknown field, missing required) to exercise deny_unknown_fields. Mirror the EXACT case shape the existing groups use.
3. Regenerate the fixture: \`cd ${REPO} && bun scripts/gen-message-vectors.ts\`. The generator self-formats its JSON output with biome (added in Step 1) — confirm the fixture is biome-clean after.
4. Add a Rust round-trip test in tp-relay (e.g. rust/tp-relay/tests/server_message_vectors.rs) that loads the relayServer group from rust/tp-proto/tests/fixtures/message-vectors.json, deserializes each accept case into RelayServerMessage, re-serializes, and asserts serde round-trip equality + that the serialized JSON matches the fixture's canonical json bytes. For reject cases, assert deserialization fails (deny_unknown_fields / missing required). Mirror how tp-proto/tests/message_vectors.rs drives the existing groups (read it first; reuse its fixture-loading helper pattern).
5. Run the gate (rustup-shim-safe):
   cd ${REPO}/rust && export PATH="$(dirname "$(rustup which cargo)"):$PATH" && cargo test -p tp-relay && cargo test -p tp-proto
   cd ${REPO} && pnpm exec biome ci .   (must exit 0 — the relayServer fixture is generated output)
   cd ${REPO} && pnpm exec tsc --noEmit -p packages/protocol/tsconfig.json   (the generator imports the guards)

Return the structured result with honest pass/fail from real exit codes.`,
  { label: 'golden:relay-server-vectors', phase: 'Goldens', model: 'sonnet', schema: GOLDEN_SCHEMA },
)

if (!golden) {
  log('Golden agent died — aborting.')
  return { aborted: 'golden-failed', survey, impl }
}
log(`Goldens: +${golden.vectorsAdded} cases; roundtrip=${golden.roundTripTestPassed} biome=${golden.biomeClean}`)

phase('Verify')

// Adversarial parity check: an independent skeptic re-runs the full gate from a
// clean read and tries to find a byte-parity or deny_unknown_fields gap between
// the Rust serde core and the TS guards. Default to FAIL on any uncertainty.
const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['gatePassed', 'parityHolds', 'denyUnknownParityHolds', 'issues', 'verdict'],
  properties: {
    gatePassed: {
      type: 'boolean',
      description: 'cargo test -p tp-relay AND -p tp-proto AND biome ci . AND type-check all green when YOU re-ran them',
    },
    parityHolds: {
      type: 'boolean',
      description: 'for a sample of server messages, the Rust-serialized JSON is byte-identical to what the TS encoder/guard expects',
    },
    denyUnknownParityHolds: {
      type: 'boolean',
      description: 'every message the TS guard rejects-on-unknown-field is rejected by the Rust deserializer too (and vice versa)',
    },
    issues: {
      type: 'array',
      items: { type: 'string' },
      description: 'concrete defects with file:line; empty if none',
    },
    verdict: { type: 'string', enum: ['SHIP', 'FIX'], description: 'FIX if any gate fails or any parity gap exists or you are uncertain' },
  },
}

const verdict = await agent(
  `Adversarially verify Stage 1 Step 2 (tp-relay serde core). Assume it is WRONG until you prove otherwise; default verdict=FIX on any uncertainty.

Working tree root: ${REPO}. Read live HEAD; re-run every gate yourself — do not trust prior agents' claimed pass.

What was built:
${JSON.stringify({ files: impl.filesWritten, denyUnknown: impl.denyUnknownApproach, vectors: golden.vectorsAdded }, null, 2)}

Re-run (rustup-shim-safe — bare cargo mis-parses --workspace; use the toolchain bin):
  cd ${REPO}/rust && export PATH="$(dirname "$(rustup which cargo)"):$PATH" \\
    && cargo fmt --all -- --check \\
    && cargo clippy --workspace --all-targets \\
    && cargo test --workspace
  cd ${REPO} && pnpm exec biome ci .
  cd ${REPO} && pnpm exec tsc --noEmit -p packages/protocol/tsconfig.json

Then ADVERSARIALLY check parity (the real risk):
- Pick 3-4 RelayServerMessage variants. For each, read the TS interface in packages/protocol/src/types/relay.ts AND the Rust variant. Confirm: identical wire "t", identical JSON keys (camelCase via serde rename), optional fields omitted-when-None on BOTH sides (skip_serializing_if), no extra/missing field. Cite file:line on both sides.
- deny_unknown_fields parity: find a message the TS guard (relay-server-guard.ts) rejects when an unknown field is present. Construct that JSON and confirm the Rust deserializer ALSO rejects it (the golden reject case should cover this — verify it actually exercises deny_unknown_fields, not just a missing-required failure).
- Confirm the dead catch-all Envelope was NOT ported (ADR: "dead Envelope drop").
- Confirm tp-relay declares NO axum/tokio (Step 2 is serde-only; those are Step 3+).

Report concrete issues with file:line. verdict=SHIP only if every gate is green AND parity holds on your sample AND deny_unknown_fields parity holds. Otherwise FIX.`,
  { label: 'verify:adversarial-parity', phase: 'Verify', model: 'opus', schema: VERDICT_SCHEMA },
)

return {
  step: 'stage1-step2-tp-relay-core',
  survey: { variants: survey.messages?.length, sharedTypes: survey.sharedTypes },
  impl: { files: impl.filesWritten, build: impl.buildPassed, test: impl.testPassed, denyUnknown: impl.denyUnknownApproach },
  golden: { vectorsAdded: golden.vectorsAdded, roundtrip: golden.roundTripTestPassed, biome: golden.biomeClean },
  verdict,
}
