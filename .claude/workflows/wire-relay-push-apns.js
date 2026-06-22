export const meta = {
  name: 'wire-relay-push-apns',
  description: 'B2: wire relay.push dispatch → APNs async delivery in the Rust relay (conn.rs Push stub → PushService spawn)',
  phases: [
    { title: 'Ground', detail: 'reverify the exact stub + Action/DispatchOutcome/SharedState/PushService surfaces at HEAD' },
    { title: 'Design', detail: 'lock-discipline-preserving spawn design (sync unseal+gate under lock, async send after)' },
    { title: 'Verify', detail: 'adversarial review: lock invariant, role gate, DeliveryResult→reply mapping vs TS handlePush, env-init graceful-none' },
  ],
}

// B2 is the final keystone of the push chain. The app (PR #742) now sends
// relay.push.register; the relay seals+routes (PR #741); the daemon stores the
// sealed token and emits relay.push { frontendId, sealed, title, body, data? }.
// THIS step makes the relay actually deliver that push to APNs.
//
// Hard constraints (from .claude/rules + the live code, NOT hearsay — agents must
// re-read HEAD file:line):
//   - dispatch_locked is SYNCHRONOUS, holds the RelayCore mutex, NO .await. APNs
//     HTTP/2 is async → it CANNOT run in dispatch_locked. The async send must run
//     in handle_inbound AFTER the lock guard drops (where deliver_actions is awaited).
//   - global_push_sealer().unseal(sealed) is SYNC, in-memory → safe under the lock.
//   - PushService + ApnsClient + ApnsSigner already EXIST and are fully tested in
//     rust/tp-relay/src/{push,apns,apns_jwt}.rs. The gap is pure WIRING: no
//     global/SharedState PushService, and the Push arm is a DispatchOutcome::empty() stub.
//   - The TS reference is the PROVEN implementation: packages/relay/src/relay-server.ts
//     handlePush. Match its role gate (daemon-only) + DeliveryResult→reply mapping
//     (ws→relay.notification, rate_limited/error/dead_token→relay.err, push/deduped→noop).
//   - Merging rust/tp-relay FLIP-LIVE deploys to relay.tpmt.dev (deploy-relay.yml).
//     So: graceful no-op when APNs env creds are absent (Option<Arc<PushService>> = None)
//     is mandatory — the relay must not panic/regress when unconfigured (it is currently
//     unconfigured-tolerant; the stub is a silent no-op).
//   - Lints: rust/Cargo.toml [workspace.lints] is SoT (clippy::all=deny, pedantic=warn,
//     unsafe_code=forbid). Do NOT add `-- -D warnings`. Code must be clean under that table.
//   - This is a CODE-AUTHORING workflow: agents EDIT files in the main worktree (no
//     isolation — single writer, sequential phases). Verify compiles with
//     `cargo build -p tp-relay` and tests with `cargo test -p tp-relay`.

const ROOT = '/Users/dave/Projects/github.com/teleprompter'

// ───────────────────────── Phase 1: Ground ─────────────────────────
phase('Ground')

const GROUND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['stub', 'dispatchOutcome', 'action', 'sharedState', 'pushService', 'sealer', 'tsHandlePush', 'env', 'notes'],
  properties: {
    stub: { type: 'string', description: 'conn.rs file:line of the RelayClientMessage::Push arm to replace + verbatim snippet' },
    dispatchOutcome: { type: 'string', description: 'DispatchOutcome struct file:line + fields (actions, close). Can a 3rd field be added cleanly?' },
    action: { type: 'string', description: 'Action enum file:line + variants. handle_inbound spawn site file:line (where lock drops + deliver_actions awaited)' },
    sharedState: { type: 'string', description: 'SharedState struct + from_env file:line. Exact fields. Where to add Option<Arc<PushService>>; what test constructors (with_signer etc.) must keep compiling' },
    pushService: { type: 'string', description: 'PushService::start + send_or_deliver + PushServiceConfig + PushRequest exact signatures (file:line). ApnsClient::new + ApnsClientConfig::from_env + ApnsSigner::new + ApnsKey exact signatures. DeliveryResult variants' },
    sealer: { type: 'string', description: 'PushSealer::unseal signature + UnsealResult variants (Ok/Legacy/ParseError/UnsealFailed) file:line. global_push_sealer() file:line' },
    tsHandlePush: { type: 'string', description: 'packages/relay/src/relay-server.ts handlePush full logic file:line: role gate, unseal branch (ok/legacy/fail), sendOrDeliver call, DeliveryResult→reply mapping (each variant → which relay.notification/relay.err/noop)' },
    env: { type: 'string', description: 'Exact APNs env var names the Rust types read + which are read by from_env vs must be read manually (APNS_KEY/KEY_ID/TEAM_ID/BUNDLE_ID/ENV/MAX_RETRIES/RETRY_BASE_MS). Is there a PushServiceConfig::from_env or must it be hand-assembled?' },
    notes: { type: 'string', description: 'Any surprise: existing Push tests, role-gate helpers (authed_state/not_authenticated/route_push_register pattern), RelayNotification/RelayErr server message constructors, PushData type reuse' },
  },
}

const ground = await agent(
  `Re-read the LIVE HEAD working tree under ${ROOT} (open the actual .rs/.ts files; ignore commit messages). Produce an EXACT file:line map for wiring the Rust relay's relay.push dispatch to APNs delivery. This is ground truth for a code change — every claim must cite file:line from a file you actually opened this turn.

Read at minimum:
- rust/tp-relay/src/conn.rs (the Push stub arm; dispatch_locked; DispatchOutcome; handle_inbound + deliver_actions; the route_push_register pattern + its role-gate helpers like authed_state/not_authenticated; existing push tests)
- rust/tp-relay/src/server.rs (Action enum; SharedState struct + from_env + with_signer + from_env_with_max_frame_size)
- rust/tp-relay/src/push.rs (PushService::start, send_or_deliver, PushServiceConfig, PushRequest, DeliveryResult)
- rust/tp-relay/src/apns.rs (ApnsClient::new, ApnsClientConfig::from_env, resolve_apns_host)
- rust/tp-relay/src/apns_jwt.rs (ApnsSigner::new, ApnsKey)
- rust/tp-relay/src/push_seal.rs (PushSealer::unseal + UnsealResult; global_push_sealer)
- rust/tp-proto/src/relay_client.rs (RelayClientMessage::Push variant fields + parse)
- rust/tp-relay/src/messages.rs (RelayServerMessage::Notification/Err constructors; Notification + PushData shape)
- packages/relay/src/relay-server.ts (handlePush — the PROVEN reference; quote the full logic)
- main.rs / wherever SharedState::from_env is called at relay startup (to know where a PushService would be constructed)

Fill the schema exhaustively. For tsHandlePush, give the COMPLETE DeliveryResult→reply mapping (every variant). For env, state definitively whether a PushServiceConfig::from_env exists or the config must be hand-assembled from individual env reads.`,
  { label: 'ground:push-map', phase: 'Ground', schema: GROUND_SCHEMA, effort: 'high' },
)

log('Ground map complete — designing the lock-safe spawn wiring.')

// ───────────────────────── Phase 2: Design ─────────────────────────
phase('Design')

const DESIGN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['approach', 'sharedStateChange', 'dispatchChange', 'spawnChange', 'replyMapping', 'envInit', 'gracefulNone', 'risks'],
  properties: {
    approach: { type: 'string', description: '2-4 sentence overview of the chosen wiring' },
    sharedStateChange: { type: 'string', description: 'Exact change to SharedState + from_env (+ keeping with_signer/from_env_with_max_frame_size compiling). Field type, init from env, None when unconfigured' },
    dispatchChange: { type: 'string', description: 'Exact Push arm impl in dispatch_locked: role gate (Role::Daemon else relay.err UNAUTHORIZED), find target frontend conn in group, sync unseal, build the data to hand off. What DispatchOutcome change carries it out (new field vs new Action variant) + why that keeps the no-await invariant' },
    spawnChange: { type: 'string', description: 'Exact handle_inbound change: after lock drops, tokio::spawn the async send_or_deliver, then map result to a follow-up Send. How the spawned task gets a SharedState/outbox handle to send the reply (must not re-enter the lock across await)' },
    replyMapping: { type: 'string', description: 'DeliveryResult→reply table, byte-matching TS handlePush (ws→relay.notification{title,body,data}, rate_limited→relay.err PUSH_RATE_LIMITED, error→PUSH_DELIVERY_ERROR, dead_token→PUSH_TOKEN_DEAD, push/deduped→noop, unseal_failed→PUSH_UNSEAL_FAILED, legacy→use sealed verbatim)' },
    envInit: { type: 'string', description: 'Exact env reads to build PushService (APNS_KEY/KEY_ID/TEAM_ID/BUNDLE_ID/ENV + retry knobs), the ApnsSigner+ApnsClient+PushService::start assembly, where it runs (from_env)' },
    gracefulNone: { type: 'string', description: 'How absence of APNs creds yields None → the Push arm becomes a clean no-op (NOT a panic/error) so the flip-live deploy on an unconfigured-then-configured relay is safe. Test for this' },
    risks: { type: 'string', description: 'Top correctness risks (lock-across-await, double-send, role-gate bypass, isFrontendConnected detection) + how the impl avoids each' },
  },
}

const design = await agent(
  `You are designing (NOT yet writing) the B2 wiring. Use this ground-truth map:

${JSON.stringify(ground, null, 2)}

Design the minimal, correct change to wire rust/tp-relay relay.push → APNs delivery. Absolute constraints:
- dispatch_locked stays sync, NO .await added. The sync parts (role gate, find target conn, global_push_sealer().unseal) run there; the async send_or_deliver().await runs in handle_inbound AFTER the lock drops (a tokio::spawn), exactly mirroring how deliver_actions is awaited post-lock.
- Match the TS handlePush role gate + FULL DeliveryResult→reply mapping byte-for-byte.
- Graceful no-op when APNs env creds absent (Option<Arc<PushService>> = None) — flip-live-on-merge means an unconfigured relay must not regress.
- The spawned task must send its reply (relay.notification / relay.err) WITHOUT holding the RelayCore lock across .await. Decide how it reaches the target conn's outbox (clone the SharedState handle into the task; take the lock briefly AFTER the await only to resolve the outbox, or capture the outbox sender before spawning).
- Keep SharedState's test constructors (with_signer, from_env_with_max_frame_size) compiling.
- Clean under [workspace.lints] (clippy::all=deny, pedantic=warn). No unsafe.

Produce a concrete, implementable design filling every schema field. Prefer the simplest shape that satisfies the lock invariant. If extending DispatchOutcome with a push side-payload is cleaner than a new Action variant, say so and justify; if a new Action::SpawnPush variant handled in deliver_actions is cleaner, justify that instead — pick ONE and be decisive.`,
  { label: 'design:spawn-wiring', phase: 'Design', schema: DESIGN_SCHEMA, effort: 'high' },
)

log(`Design chosen: ${design.approach.slice(0, 160)}`)

// ───────────────── Phase 3: Implement (single writer, in main worktree) ─────────────────
phase('Implement')

const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['filesChanged', 'buildOk', 'testOk', 'clippyOk', 'testsAdded', 'summary', 'deviations'],
  properties: {
    filesChanged: { type: 'array', items: { type: 'string' }, description: 'each changed/added file with a one-line description' },
    buildOk: { type: 'boolean', description: 'cargo build -p tp-relay succeeded' },
    testOk: { type: 'boolean', description: 'cargo test -p tp-relay succeeded (all tests pass)' },
    clippyOk: { type: 'boolean', description: 'cargo clippy -p tp-relay --all-targets clean under [workspace.lints]' },
    testsAdded: { type: 'array', items: { type: 'string' }, description: 'new test fn names + what each asserts' },
    summary: { type: 'string', description: 'what was implemented, file:line of the key changes' },
    deviations: { type: 'string', description: 'any deviation from the design + why; or "none"' },
  },
}

const impl = await agent(
  `Implement the B2 wiring per this design. EDIT files directly in the main worktree at ${ROOT}.

DESIGN:
${JSON.stringify(design, null, 2)}

GROUND MAP (for exact file:line + signatures):
${JSON.stringify(ground, null, 2)}

Rules:
- Re-read each file you edit at HEAD before editing (the maps above are guidance, but YOU verify the exact current text — do not blind-apply).
- Preserve the no-await-under-lock invariant absolutely. The sync unseal + role gate + conn lookup go in dispatch_locked; the async APNs send goes in a tokio::spawn in handle_inbound after the lock drops.
- Match the TS handlePush DeliveryResult→reply mapping exactly.
- Graceful None when APNs creds absent.
- Add Rust unit tests mirroring the existing push_register tests' style (in conn.rs #[cfg(test)]): at minimum (a) Push from a non-daemon role → relay.err UNAUTHORIZED, (b) Push when PushService is None → clean no-op (no panic, no spurious send), (c) the unseal-failure path → relay.err PUSH_UNSEAL_FAILED, (d) if feasible with a fake/None service, the role+lookup path produces the expected handoff. Use the existing insert_authed test helper + FakeApnsTransport patterns where they fit.
- Do NOT add \`-- -D warnings\` anywhere. Rely on [workspace.lints].
- Do NOT bump versions. Do NOT touch packages/ or ios/. This is rust/tp-relay (+ maybe rust/tp-proto if a server-message constructor is missing).

After editing, RUN and report real results (do not claim success without running):
  cd ${ROOT}/rust && cargo build -p tp-relay 2>&1 | tail -20
  cd ${ROOT}/rust && cargo test -p tp-relay 2>&1 | tail -30
  cd ${ROOT}/rust && cargo clippy -p tp-relay --all-targets 2>&1 | tail -20
Set buildOk/testOk/clippyOk to the TRUE observed outcome. If something fails and you cannot fix it cleanly, leave the boolean false and explain in deviations — do NOT fake green.`,
  { label: 'impl:wire-push', phase: 'Implement', schema: IMPL_SCHEMA, effort: 'high' },
)

log(`Implement: build=${impl.buildOk} test=${impl.testOk} clippy=${impl.clippyOk}, ${impl.filesChanged.length} files`)

// ───────────────────────── Phase 4: Verify (adversarial) ─────────────────────────
phase('Verify')

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lockInvariantHeld', 'roleGateCorrect', 'replyMappingMatchesTS', 'gracefulNoneCorrect', 'noDoubleSend', 'testsHonest', 'defects', 'verdict'],
  properties: {
    lockInvariantHeld: { type: 'string', description: 'Confirm (file:line) NO .await is added inside dispatch_locked / under the RelayCore guard, and the spawned task never holds the lock across .await. Quote the spawn site' },
    roleGateCorrect: { type: 'string', description: 'Confirm the Push arm rejects non-daemon senders with relay.err UNAUTHORIZED, matching TS handlePush + the route_push_register pattern' },
    replyMappingMatchesTS: { type: 'string', description: 'Diff the Rust DeliveryResult→reply mapping against TS handlePush. Every variant accounted for? Any mismatch in err codes or notification shape?' },
    gracefulNoneCorrect: { type: 'string', description: 'Confirm None PushService → clean no-op (no panic, no send), with a test proving it. Quote it' },
    noDoubleSend: { type: 'string', description: 'Confirm a push never both deliver to APNs AND emit relay.notification for the same message (the ws vs push branches are exclusive), and no spurious extra Send is queued' },
    testsHonest: { type: 'string', description: 'Re-run cargo test -p tp-relay yourself; confirm the reported pass count is real and the new tests actually exercise the claimed paths (not vacuous). Quote the test output tail' },
    defects: { type: 'array', items: { type: 'string' }, description: 'real defects with file:line + failure scenario; empty if none' },
    verdict: { type: 'string', enum: ['SHIP', 'BLOCK'], description: 'SHIP only if zero blocking defects AND build/test/clippy all green' },
  },
}

const verify = await agent(
  `Adversarially verify the B2 implementation just made in the main worktree at ${ROOT}. Be a skeptic hunting real bugs. Read the LIVE edited files + re-run the gates yourself (do not trust the implementer's claims).

Implementer's report:
${JSON.stringify(impl, null, 2)}

TS reference for the mapping (the proven impl): packages/relay/src/relay-server.ts handlePush.

Do all of:
1. Open the edited rust/tp-relay files. Verify NO .await was introduced inside dispatch_locked or under the RelayCore mutex guard. Verify the spawned APNs task does not hold the lock across .await.
2. Verify the daemon-role gate on the Push arm (non-daemon → relay.err UNAUTHORIZED).
3. Diff the DeliveryResult→reply mapping line-by-line against TS handlePush — flag ANY missing variant or wrong err code / notification shape.
4. Verify graceful-None (unconfigured APNs → no-op, no panic) with the test that proves it.
5. Verify no double-send / no spurious Send.
6. Re-run: \`cd ${ROOT}/rust && cargo test -p tp-relay 2>&1 | tail -30\` and \`cargo clippy -p tp-relay --all-targets 2>&1 | tail -15\`. Confirm green AND that the new tests are non-vacuous (they would fail if the wiring were reverted).

Report each schema field with file:line evidence. verdict=SHIP only if zero blocking defects and build/test/clippy are genuinely green when YOU run them. Otherwise BLOCK with the specific defect.`,
  { label: 'verify:adversarial', phase: 'Verify', schema: VERIFY_SCHEMA, effort: 'high' },
)

return {
  ground: { stub: ground.stub },
  design: { approach: design.approach },
  impl: { buildOk: impl.buildOk, testOk: impl.testOk, clippyOk: impl.clippyOk, filesChanged: impl.filesChanged, testsAdded: impl.testsAdded, deviations: impl.deviations },
  verify,
  shippable: verify.verdict === 'SHIP' && impl.buildOk && impl.testOk && impl.clippyOk,
}
