export const meta = {
  name: 'stage1-step3-handshake-resume-registry',
  description: 'Stage 1 Step 3: tp-relay handshake + binary resume-token + 2-struct registry (relay.hello merge)',
  phases: [
    { title: 'Survey' },
    { title: 'Implement' },
    { title: 'Goldens' },
    { title: 'Verify' },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 1 Step 3 (ADR-0003 A1.5 row 3):
//   "handshake + resume + registry: 2-struct DaemonState, binary versioned
//    resume-token, v<2 reject + version metric, relay.hello merge.
//    Gate: parity hello→kx→pub/sub→resume accept/reject; nested-map eviction;
//    timing-safe HMAC."
//
// SCOPE BOUNDARY (critical): Step 3 builds the Rust relay's PURE LOGIC only —
// resume-token codec, the in-memory registry state machine, and the
// hello/auth/register/resume HANDLERS that consume a parsed RelayClientMessage
// and produce a RelayServerMessage + mutate registry state. It does NOT build
// the live WS transport (axum/tokio/tungstenite = Step 4+). Verify via Rust
// unit tests + golden vectors, NOT a running server. No live TS daemon change:
// the resume token is wire-opaque ({token:string}); relay.hello is a relay-side
// handler the TS daemon won't emit until Step 8 cutover.
//
// GROUND TRUTH (verified live at HEAD by the parent; agents MUST re-read, never
// trust this recollection — CLAUDE.md / workflow-authoring.md discipline):
//  - TS reference: packages/relay/src/resume-token.ts (145 lines, FULL binary
//    format reference) + packages/relay/src/relay-server.ts (1620 lines;
//    handleRegister ~760, handleAuth ~806, handleAuthResume ~715 dispatch,
//    DaemonState interface ~222, registrations map ~256-264, MAX_SESSIONS_PER_DAEMON
//    =256 at ~127).
//  - tp-relay crate exists (Step 2): RelayServerMessage in src/messages.rs;
//    parse side (RelayClientMessage) lives in tp-proto/src/relay_client.rs.
//  - tp-core provides BLAKE2b (crypto_generichash) + AEAD — REUSE for the
//    resume-token MAC; do NOT add a new hmac/sha2 dependency. Read tp-core's
//    public API first to find the BLAKE2b keyed-hash fn.
//
// THE TWO CORRECTNESS-CRITICAL INVARIANTS (regression risk — guard with tests):
//  1. proof sentinel is `null`, NOT `""`. registrations records proof=null when
//     seeded by a token-only relay.auth; a later proof-carrying relay.register
//     is blocked ONLY by a *different non-null* proof. An empty-string sentinel
//     collides with a real proof="" and bypasses the different-credentials
//     guard (relay-server.ts:256-264, 760-794). In Rust: Option<String>, None =
//     no-proof-recorded.
//  2. resume-token redesign: TS = HMAC-SHA256 over dot-delimited text
//     `<role>.<daemonId>.<frontendId|"">.<expiresAtMs>` → `b64url(body).b64url(sig)`.
//     Rust = tp-core BLAKE2b keyed-hash over a BINARY 5-part payload
//     (v.role.did.fid.exp) per ADR A1.3#2 — adds the missing payload-version
//     discriminant + removes the dot-delimiter collision footgun. This is
//     relay-internal + wire-opaque, so it need NOT match the TS bytes; it must
//     be self-consistent (issue→verify round-trips, expiry honored, tamper
//     rejected, timing-safe compare) and carry its own golden vectors.
//
// Rust invocation gotcha: bare `cargo` is the rustup shim that mis-parses
// --all/--workspace. Use PATH="$(dirname "$(rustup which cargo)"):$PATH" cargo …
// (the lefthook rust hook already bakes this in, but agents running cargo
// directly must do it too). clippy: workspace lints SoT (clippy::all=deny,
// pedantic=warn) — NEVER pass -D warnings.
// ─────────────────────────────────────────────────────────────────────────────

const REPO = '/Users/dave/Projects/github.com/teleprompter'

phase('Survey')

// Three independent read-only surveys (no file conflict; barrier so Implement
// gets all three together). Each reads the LIVE TS reference and reports the
// exact behavior the Rust port must reproduce, with file:line citations.
const surveyResults = await parallel([
  () =>
    agent(
      `Survey the TS resume-token implementation so a Rust binary+versioned redesign can replace it (relay-internal, wire-opaque — need NOT match bytes, must match SEMANTICS).

Root: ${REPO}. Read packages/relay/src/resume-token.ts IN FULL (it is 145 lines) and any test packages/relay/src/resume-token.test.ts. Cite file:line.

Report (as prose, thorough): the ResumeTokenPayload shapes (daemon vs frontend), issue() semantics (expiresAt default = now+ttlMs, ttl default 1h), verify() semantics IN ORDER (every reject branch: bad dot split, b64 decode fail, sig length mismatch, timingSafeEqual, 4-part split, role whitelist, finite expiresAt, expiresAt<=now reject, non-empty daemonId, frontend frontendId-non-empty), the secret loading (TP_RELAY_RESUME_SECRET, >=32 bytes else random ephemeral), and the wire format. Then list, as a checklist, the exact invariants a Rust reimplementation MUST preserve (round-trip, expiry, tamper-reject, role/frontendId rules, timing-safe compare) — these become the unit tests. Note what the ADR A1.3#2 binary redesign ADDS (payload-version discriminant; binary 5-part v.role.did.fid.exp; tp-core BLAKE2b keyed-hash instead of HMAC-SHA256).`,
      { label: 'survey:resume-token', phase: 'Survey', model: 'sonnet' },
    ),
  () =>
    agent(
      `Survey the TS relay registry + DaemonState so a Rust 2-struct port reproduces it exactly.

Root: ${REPO}. Read packages/relay/src/relay-server.ts — the DaemonState interface (~222), the registrations map (~256-264, READ THE COMMENT about proof null-vs-empty-string), MAX_SESSIONS_PER_DAEMON (~127), recentFrames map (~251), and every place that mutates online/lastSeen/sessions (search lastSeen, .sessions, .online). Cite file:line.

Report: the exact fields of DaemonState and their lifecycle; the registrations map value shape ({token, proof: string|null}) and WHY proof is null not "" (the different-credentials-guard bypass — quote the comment); the MAX_SESSIONS_PER_DAEMON=256 cap and its oldest-sid-drop eviction (insertion order); the lastSeen refresh rule (daemon-own-traffic-only — role=daemon gate on handlePing/handlePublish; frontend publishing to a dead daemon must NOT reset the offline-eviction clock); the nested-map / offline eviction path. Produce a checklist of registry invariants for the Rust port + its tests.`,
      { label: 'survey:registry', phase: 'Survey', model: 'sonnet' },
    ),
  () =>
    agent(
      `Survey the TS relay handshake handlers (register/auth/resume) so a Rust port + the new relay.hello merge reproduce their decision logic.

Root: ${REPO}. Read packages/relay/src/relay-server.ts handleRegister (~760), handleAuth (~806), handleAuthResume (~715 dispatch + its handler), and the message dispatch switch (~700-760). Read packages/protocol/src/relay-server-guard.ts + types/relay.ts for the response message shapes (relay.register.ok/err, relay.auth.ok/err). Cite file:line.

Report, predicate-by-predicate IN ORDER for each handler: every accept/reject branch, every state mutation, every response message emitted (and its fields — e.g. auth.ok carries the issued resume token + expiresAt). For relay.hello (ADR A1.3#4, register+auth 2-RTT merge): describe how a single hello with {proof?, token, ...} should fold the register-then-auth sequence into one handler, and EXACTLY where the proof-sentinel null-vs-"" different-credentials guard must be preserved (the regression risk the ADR flags). Also note v<2 rejection (the version field gate) + that a version metric is incremented. Produce a parity checklist: hello→kx→pub/sub→resume accept/reject.`,
      { label: 'survey:handshake', phase: 'Survey', model: 'sonnet' },
    ),
])

const [resumeSurvey, registrySurvey, handshakeSurvey] = surveyResults
if (!resumeSurvey || !registrySurvey || !handshakeSurvey) {
  log('A survey agent died — aborting Step 3; parent should investigate.')
  return { aborted: 'survey-failed', got: surveyResults.map(Boolean) }
}
log('Surveyed resume-token + registry + handshake. Implementing the Rust port.')

phase('Implement')

const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['filesWritten', 'buildPassed', 'testPassed', 'invariantsCovered', 'summary'],
  properties: {
    filesWritten: { type: 'array', items: { type: 'string' } },
    buildPassed: { type: 'boolean' },
    testPassed: { type: 'boolean' },
    invariantsCovered: {
      type: 'array',
      items: { type: 'string' },
      description: 'each correctness invariant + the test name that guards it (proof-sentinel null, resume round-trip/expiry/tamper, lastSeen daemon-only, sessions cap eviction, v<2 reject)',
    },
    summary: { type: 'string', description: 'modules added, how tp-core BLAKE2b was reused, any deviation from the surveys, exact cargo invocation' },
  },
}

const impl = await agent(
  `Implement Stage 1 Step 3 in the EXISTING tp-relay crate (${REPO}/rust/tp-relay). Pure logic only — NO axum/tokio (Step 4+).

Read live HEAD before editing. The three surveys (authoritative behavior to reproduce; still re-verify against the cited TS file:line):

=== RESUME-TOKEN SURVEY ===
${resumeSurvey}

=== REGISTRY SURVEY ===
${registrySurvey}

=== HANDSHAKE SURVEY ===
${handshakeSurvey}

DELIVERABLES (separate modules under rust/tp-relay/src/, declared in lib.rs):
1. resume_token.rs — a ResumeTokenSigner equivalent. Binary 5-part payload (version, role, daemonId, frontendId|"", expiresAtMs) keyed-MAC'd with tp-core's BLAKE2b keyed hash (READ tp-core's public API first; reuse — do NOT add hmac/sha2 deps). issue()/verify() with EVERY reject branch from the survey, expiry honored, constant-time MAC compare (use a constant-time compare — tp-core may expose one, else subtle/ct via a tiny manual loop is acceptable since this is MAC bytes). Secret from TP_RELAY_RESUME_SECRET (>=32 bytes) else ephemeral random. Document that bytes need NOT match TS (wire-opaque) but semantics must.
2. registry.rs — the 2-struct DaemonState + registrations registry. proof as Option<String> (None = the null sentinel; preserve the different-credentials guard EXACTLY: a None recorded proof never blocks a later proof-carrying register; only a different Some(proof) does). sessions Set capped at MAX_SESSIONS_PER_DAEMON (256) with oldest-insertion-order drop. lastSeen refresh gated to daemon-own traffic only. online/offline + eviction.
3. handshake.rs — pure handler fns that take a parsed RelayClientMessage (from tp_proto::relay_client) + &mut registry and return a RelayServerMessage (from crate::messages) + state effect. Cover register, auth (issues a resume token in auth.ok), auth.resume (verify → ok/err), and the NEW relay.hello merge (register+auth in one, preserving the proof-sentinel guard). v<2 rejection + a version-mismatch counter (a simple AtomicU64 or a returned enum the caller will meter — keep it testable).

Add thorough #[cfg(test)] unit tests for every invariant in invariantsCovered. Match tp-proto/messages.rs doc-density + serde style. English comments. edition 2021, max_width 100, unsafe forbidden.

BUILD+TEST (rustup-shim-safe):
  cd ${REPO}/rust && export PATH="$(dirname "$(rustup which cargo)"):$PATH" && cargo build -p tp-relay && cargo test -p tp-relay && cargo fmt --all -- --check && cargo clippy -p tp-relay --all-targets
(run cargo fmt --all first if --check reports diffs). Return structured result; honest pass/fail from real exit codes.`,
  { label: 'impl:handshake-resume-registry', phase: 'Implement', model: 'sonnet', schema: IMPL_SCHEMA },
)

if (!impl) {
  log('Implementation agent died — aborting.')
  return { aborted: 'impl-failed', surveys: { resumeSurvey, registrySurvey, handshakeSurvey } }
}
log(`Implement: build=${impl.buildPassed} test=${impl.testPassed}; invariants: ${(impl.invariantsCovered || []).length}`)

phase('Goldens')

const GOLDEN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['resumeVectorsAdded', 'roundTripPassed', 'gateGreen', 'summary'],
  properties: {
    resumeVectorsAdded: { type: 'number' },
    roundTripPassed: { type: 'boolean' },
    gateGreen: { type: 'boolean', description: 'cargo test -p tp-relay + fmt --check + biome ci . all green' },
    summary: { type: 'string' },
  },
}

const golden = await agent(
  `Add relay-internal golden vectors for the binary resume-token (ADR: "resume-token binary 는 relay-internal 자체 골든") + a round-trip test, then run the full Step 3 gate.

Root: ${REPO}. Read live HEAD. The resume-token module just built:
${JSON.stringify({ files: impl.filesWritten, summary: impl.summary }, null, 2)}

DO:
1. The binary resume-token is relay-internal (NOT in the cross-impl message-vectors.json — that fixture is TS↔Rust wire parity, and this token is wire-opaque). Create a SELF-CONTAINED golden fixture for it, e.g. rust/tp-relay/tests/fixtures/resume-token-vectors.json OR an inline test table in rust/tp-relay/tests/resume_token_vectors.rs, with cases: daemon-token round-trip, frontend-token round-trip, expired-token reject, tampered-MAC reject, wrong-version reject, empty-daemonId reject, frontend-empty-frontendId reject, daemon-token-used-as-frontend cross-role reject. Since the token format is the Rust impl's own (no TS oracle), the vectors assert issue()→verify() round-trips + each reject branch via the public API. Use a FIXED secret + FIXED expiresAt passed in (Date.now() is unavailable in tests anyway — pass explicit timestamps).
2. If you add a JSON fixture, do NOT run it through gen-message-vectors.ts (that generator is for the cross-impl message vectors only). Keep this token fixture separate.
3. Run the gate (rustup-shim-safe):
   cd ${REPO}/rust && export PATH="$(dirname "$(rustup which cargo)"):$PATH" && cargo test -p tp-relay && cargo test --workspace && cargo fmt --all -- --check && cargo clippy --workspace --all-targets
   cd ${REPO} && pnpm exec biome ci .   (must be 0 — if you touched any .ts/.json biome scans)
Return structured result, honest pass/fail.`,
  { label: 'golden:resume-token-vectors', phase: 'Goldens', model: 'sonnet', schema: GOLDEN_SCHEMA },
)

if (!golden) {
  log('Golden agent died — aborting.')
  return { aborted: 'golden-failed', impl }
}
log(`Goldens: +${golden.resumeVectorsAdded} resume cases; gate green=${golden.gateGreen}`)

phase('Verify')

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['gatePassed', 'proofSentinelCorrect', 'resumeSemanticsCorrect', 'registryInvariantsCorrect', 'issues', 'verdict'],
  properties: {
    gatePassed: { type: 'boolean', description: 'fmt --check + clippy --workspace + cargo test --workspace + biome ci . all green when YOU re-ran them' },
    proofSentinelCorrect: { type: 'boolean', description: 'the Option<String> None sentinel preserves the different-credentials guard exactly (None never blocks; only a different Some does)' },
    resumeSemanticsCorrect: { type: 'boolean', description: 'every TS verify() reject branch has a Rust equivalent; round-trip + expiry + tamper + timing-safe hold' },
    registryInvariantsCorrect: { type: 'boolean', description: 'lastSeen daemon-traffic-only; sessions cap 256 oldest-drop; offline eviction' },
    issues: { type: 'array', items: { type: 'string' }, description: 'concrete defects with file:line (Rust side AND the TS line it diverges from); empty if none' },
    verdict: { type: 'string', enum: ['SHIP', 'FIX'], description: 'FIX if any gate fails or any invariant diverges or you are uncertain' },
  },
}

const verdict = await agent(
  `Adversarially verify Stage 1 Step 3. Assume WRONG until proven; default verdict=FIX on any uncertainty. Cite file:line on BOTH the Rust side and the TS line it must match — NEVER trust a commit/PR body or a prior agent's claim.

Root: ${REPO}. What was built: ${JSON.stringify({ files: impl.filesWritten, invariants: impl.invariantsCovered }, null, 2)}

Re-run the FULL gate yourself (rustup-shim-safe):
  cd ${REPO}/rust && export PATH="$(dirname "$(rustup which cargo)"):$PATH" \\
    && cargo fmt --all -- --check && cargo clippy --workspace --all-targets && cargo test --workspace
  cd ${REPO} && pnpm exec biome ci .

Then ADVERSARIALLY attack the two correctness-critical invariants:
1. proof sentinel: read the Rust registry register/hello handler AND relay-server.ts:760-794 + the registrations comment (256-264). Construct the bypass scenario: token-only auth seeds proof=None, then a proof-carrying register with proof="" arrives. TS: None recorded → NOT blocked (correct — "" is a real proof now owning the slot). A *different* non-null proof later IS blocked. Confirm the Rust logic matches branch-for-branch; if Rust used "" or a wrong Option check, that's a security regression → FIX.
2. resume-token: read resume-token.ts verify() (the 11-ish reject branches) AND the Rust verify(). Confirm EVERY reject branch is present (expiry, tamper, role whitelist, empty daemonId, frontend empty frontendId, version). Confirm the MAC compare is constant-time. Confirm issue→verify round-trips for both roles. Confirm a daemon token cannot verify as frontend and vice-versa.
3. registry: confirm lastSeen refresh is daemon-traffic-only (a frontend publish must not reset it), sessions cap = 256 with oldest-insertion-order drop, offline eviction present.
4. Confirm NO axum/tokio/tungstenite in tp-relay (Step 3 is still pure logic).

Report concrete issues with file:line on both sides. verdict=SHIP only if gate green AND all three invariant classes hold. Else FIX.`,
  { label: 'verify:adversarial', phase: 'Verify', model: 'opus', schema: VERDICT_SCHEMA },
)

return {
  step: 'stage1-step3-handshake-resume-registry',
  impl: { files: impl.filesWritten, build: impl.buildPassed, test: impl.testPassed, invariants: impl.invariantsCovered },
  golden: { resumeVectors: golden.resumeVectorsAdded, roundtrip: golden.roundTripPassed, gate: golden.gateGreen },
  verdict,
}
