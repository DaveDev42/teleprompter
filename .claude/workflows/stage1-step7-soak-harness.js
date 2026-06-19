export const meta = {
  name: 'stage1-step7-soak-harness',
  description: 'ADR-0003 Stage 1 Step 7: parameterized 10k concurrent soak/load harness for tp-relay (pub fan-out + resume storm + push-under-load). Heavy full-10k = local; light scaled tier = CI gate.',
  phases: [
    { title: 'Ground', detail: 'reverify serve/handshake/resume/push paths + CI + soak.ts reference at HEAD file:line' },
    { title: 'Implement', detail: 'soak harness (env-parameterized N) + CI light tier + docs' },
    { title: 'Verify', detail: 'adversarial review: honesty of assertions, fd/leak correctness, CI tier wiring, scope truthfulness' },
    { title: 'Gate', detail: 'fmt + clippy + cargo test (normal job, soak #[ignore]d) + run light tier locally to prove it passes' },
  ],
}

const REPO = '/Users/dave/Projects/github.com/teleprompter'

const GROUND = `You are working in the teleprompter monorepo at ${REPO}, on branch
feat/stage1-step7-soak-harness (forked from origin/main @ 8daca45, which has
Step 6 HTTP surface merged).

TASK CONTEXT (ADR-0003 Phase 4 Stage 1 Step 7): build a PARAMETERIZED soak/load
harness for the Rust relay crate \`rust/tp-relay\` that proves the standing
**10k concurrent connection capacity bar** survives the Stage-1 redesign. Per
ADR §6.9, "Claude (this session) builds it as Stage 1 PR scope, PR merge gate.
Soak is a capacity gate, not a parity gate — no redesign lowers the 10k bar."
The harness must exercise THREE load dimensions: **pub fan-out + resume storm +
push-under-load**.

USER DECISION (authoritative, supersedes any earlier note): **heavy = local,
light = CI.** ONE parameterized harness (connection count + duration via env,
e.g. TP_SOAK_CONNS / TP_SOAK_SECS). The FULL 10k run is HEAVY and runs LOCALLY
on-demand (\`#[ignore]\` by default so the normal \`cargo test --workspace\` job
never opens 10k sockets). CI runs a LIGHT scaled-down tier (e.g. ~1–2k conns,
short) as the gate — same code path, smaller N, deterministic + fast. Document
both invocations; CI light tier is wired into .github/workflows/ci.yml.

GROUND-TRUTH DISCIPLINE (non-negotiable):
- The ONLY ground truth is the HEAD working tree. Every file:line below is a
  CLAIM you must re-open and confirm before relying on it. Commit/PR bodies,
  this brief's prose, and "a previous step did X" are all hearsay.
- If a cited line drifted, find the real location and report the correction.

RUST CLAIMS to reverify in rust/tp-relay:
- conn.rs:132 \`pub async fn serve(self, addr: SocketAddr) -> io::Result<()>\`
  binds a real TcpListener via axum::serve. The soak drives a REAL server.
- tests/server_integration.rs:41-72 \`spawn_relay()\` / \`spawn_relay_with(tweak)\`:
  the EXACT foundation to scale — binds 127.0.0.1:0, axum::serve in a tokio task,
  seeds a valid token, returns (ws_url, SharedState). Uses tokio-tungstenite
  \`connect_async\`. Helpers: connect(), send_json(), recv_json(), try_recv_json(),
  auth_daemon(). The soak reuses this pattern (its own copy or shared helper).
- handshake.rs:122 \`signer.issue(&resume_payload, now_ms, None)\` — a resume token
  is returned in relay.auth.ok (\`resume_token: Some(...)\`, handshake.rs:125). The
  RESUME STORM dimension: auth -> capture resumeToken from auth.ok -> drop conn ->
  reconnect -> relay.auth.resume {token} -> assert resumed:true / AuthOk (~100%).
- conn.rs:599-601 \`RelayClientMessage::Push | PushRegister => DispatchOutcome::empty()\`
  — push is NOT in the WS hot path (a WS Push message is a deliberate no-op).
  Therefore PUSH-UNDER-LOAD CANNOT be driven via a WS message. It must be
  exercised at the PushService API level (Step 5: push.rs PushService /
  send_or_deliver) — drive N concurrent deliveries and assert dedup + rate-limit
  + no leak hold under load. Confirm the push.rs public API (PushService::new,
  send_or_deliver signature, FakeClock/Transport injection) at HEAD before using.
- server.rs route_publish (~294): the daemon publish -> fan-out to subscribed
  frontends path. PUB FAN-OUT dimension: 1 daemon + N frontends all subscribed to
  the same sid; daemon publishes M frames; assert every frontend receives them
  (0 dropped), no backpressure 1013 death under the fan-out, /metrics framesOut
  reflects the fan-out.
- Capacity invariants the soak asserts (from .claude/rules/relay-capacity.md):
  2-layer GCRA rate limit holds, slow-consumer 1013 disconnect only when truly
  full, no fd/handle/memory leak across the run, /health + /metrics stay sane.
  Knobs: TP_RELAY_MAX_FRAME_SIZE(1MB), TP_RELAY_RATE_PER_CLIENT(500/s),
  TP_RELAY_RATE_PER_DAEMON(5000/s), TP_RELAY_BACKPRESSURE_BYTES(4MB),
  MAX_SESSIONS_PER_DAEMON(256). NB: at 10k fan-out with default per-client rate
  500/s the publish cadence must stay under the limit, or the soak must raise the
  knob via SharedState tweak — decide and document, do not silently trip it.

TS REFERENCE (for shape, NOT to copy 1:1):
- scripts/soak.ts (547 lines): the existing STABILITY soak (RSS trend, reconnect
  storm, frame RTT p50/p95, idle/wake). It is NOT a 10k-concurrent capacity test.
  Reuse its rigor (non-zero exit on hard failure, JSON output, honest "trend not
  threshold" framing) but the Rust harness is a DIFFERENT thing: concurrency load.
- packages/relay/src/bench.test.ts (85 lines): throughput micro-bench shape.

CI CLAIMS to reverify in .github/workflows/ci.yml:
- The \`rust\` job (~line 95): runs-on ubuntu-latest, working-directory rust,
  dtolnay/rust-toolchain@1.96.0, Swatinem/rust-cache, then \`cargo fmt --all --
  --check\` -> \`cargo clippy --workspace --all-targets\` -> \`cargo test --workspace\`.
  The light soak tier is a NEW step in this job (or a sibling), AFTER the normal
  test, e.g.: raise \`ulimit -n\`, then
  \`TP_SOAK_CONNS=1500 TP_SOAK_SECS=20 cargo test -p tp-relay --test soak_10k -- --ignored --nocapture\`.
  ubuntu-latest default \`ulimit -n\` is ~1024 soft / higher hard — for ~1500+
  conns the step MUST raise it (\`ulimit -n 65535\`). The rust job is NOT a required
  check, so a flaky soak won't block unrelated PRs, but it MUST pass on THIS PR.
- Required CI checks (lint/type-check/test/build-cli) are TS/Bun — a Rust-only
  change does not touch them.

rustup PATH GOTCHA: bare \`cargo\` is a rustup shim that mis-parses --workspace.
Before any cargo cmd run:
  export PATH="$(dirname "$(rustup which cargo)"):$PATH"
then \`cargo <cmd>\`.

MACHINE NOTE: full 10k loopback conns in one process is fine on this MBP16
(64 GB M1 Max). Raise the local \`ulimit -n\` before a full run. Do NOT delegate.`

// ---------------------------------------------------------------------------
// Phase 1 — Ground.
// ---------------------------------------------------------------------------
phase('Ground')

const FACTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['serveEntry', 'integrationHelpers', 'resumeFlow', 'pushApi', 'pubFanout', 'ciJob', 'corrections'],
  properties: {
    serveEntry: { type: 'string', description: 'confirmed serve() signature + how to bind & drive a real server in a test, file:line' },
    integrationHelpers: { type: 'string', description: 'confirmed spawn_relay/connect/send_json/recv_json/auth_daemon helpers reusable by the soak, file:line — and whether they are pub-visible from tests or must be copied' },
    resumeFlow: { type: 'string', description: 'confirmed: where the resume token appears in auth.ok, the exact relay.auth.resume request shape, what AuthOk.resumed signals, file:line' },
    pushApi: { type: 'string', description: 'confirmed PushService public API (constructor, send_or_deliver signature, clock/transport injection) for the push-under-load dimension, file:line. Confirm WS Push is a no-op so the dimension is driven at the API level.' },
    pubFanout: { type: 'string', description: 'confirmed publish/subscribe routing + which rate knob constrains 10k fan-out + the SharedState tweak to raise it, file:line' },
    ciJob: { type: 'string', description: 'confirmed rust job structure + exactly where/how the light soak tier step attaches + ulimit raise needed, file:line' },
    corrections: { type: 'array', items: { type: 'string' }, description: 'any drifted claims corrected, or empty' },
  },
}

const facts = await agent(
  `${GROUND}\n\nYOUR JOB: read rust/tp-relay/src/*.rs, rust/tp-relay/tests/server_integration.rs, push.rs, .github/workflows/ci.yml, and skim scripts/soak.ts at HEAD. CONFIRM or CORRECT every RUST + CI claim above with real file:line. Pin EXACTLY how the soak drives a real server, captures a resume token, and invokes PushService. Report via schema.`,
  { label: 'ground:soak-paths', phase: 'Ground', model: 'sonnet', schema: FACTS_SCHEMA },
)

log(`Ground: corrections=${(facts?.corrections ?? ['<null>']).join('; ') || 'none'}`)

// ---------------------------------------------------------------------------
// Phase 2 — Implement.
// ---------------------------------------------------------------------------
phase('Implement')

const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['filesChanged', 'harnessDesign', 'envKnobs', 'assertions', 'ciTier', 'localFullRun', 'gateResult', 'lightRunResult', 'openIssues'],
  properties: {
    filesChanged: { type: 'array', items: { type: 'string' }, description: 'every file created/edited with a one-line summary' },
    harnessDesign: { type: 'string', description: 'how the harness is structured: test file location, how it scales N conns, how the 3 dimensions are organized, how it reuses/copies the integration helpers' },
    envKnobs: { type: 'string', description: 'the env parameters (TP_SOAK_CONNS / TP_SOAK_SECS / etc.), their defaults, and how heavy(local)/light(CI) tiers differ' },
    assertions: { type: 'array', items: { type: 'string' }, description: 'each concrete capacity assertion the soak makes (pub fan-out 0-drop, resume ~100% accept, push dedup/rate under load, no backpressure death, /metrics sane). Be HONEST about what is and is not asserted.' },
    ciTier: { type: 'string', description: 'the exact ci.yml change: where the light-tier step sits, the ulimit raise, the env values, and why it is fast+deterministic' },
    localFullRun: { type: 'string', description: 'the documented local full-10k command + where it is documented (relay-capacity.md / ios? no — rust/README or a soak doc)' },
    gateResult: { type: 'string', description: 'tail of: cargo fmt --all -- --check && cargo clippy --workspace --all-targets && cargo test --workspace. The soak test must be #[ignore]d so the normal job does NOT open thousands of sockets — confirm that.' },
    lightRunResult: { type: 'string', description: 'tail of ACTUALLY running the light tier locally: ulimit -n 65535; TP_SOAK_CONNS=1500 TP_SOAK_SECS=20 cargo test -p tp-relay --test soak_10k -- --ignored --nocapture. MUST pass.' },
    openIssues: { type: 'array', items: { type: 'string' }, description: 'anything left imperfect (empty if none)' },
  },
}

const impl = await agent(
  `${GROUND}

GROUNDED FACTS (from this run's Ground phase — still verify against HEAD if anything looks off):
${JSON.stringify(facts)}

YOUR JOB — implement Step 7 end to end:

1. Create rust/tp-relay/tests/soak_10k.rs: a parameterized concurrent soak test,
   \`#[ignore]\` by default (so \`cargo test --workspace\` never opens thousands of
   sockets). Read N + duration from env (TP_SOAK_CONNS default e.g. 10_000,
   TP_SOAK_SECS default e.g. 60; the CI tier passes smaller values). Use a
   multi-thread tokio runtime. Reuse the server_integration.rs harness pattern
   (bind a real server via serve()/axum::serve on 127.0.0.1:0, tokio-tungstenite
   clients). If the integration helpers are not pub-visible, factor the shared
   bits into a small \`tests/common/mod.rs\` (or copy minimally) — do not break the
   existing server_integration.rs.

2. THREE load dimensions, each a clear sub-phase of the soak:
   a. PUB FAN-OUT: 1 daemon + N frontends all subscribed to one sid. Daemon
      publishes M frames. Assert EVERY frontend receives all M (count delivered;
      0 dropped beyond what backpressure legitimately sheds — be precise about
      the contract). Raise the per-client/per-daemon rate knob via SharedState
      tweak if the publish cadence would trip GCRA, and DOCUMENT that you did.
   b. RESUME STORM: auth N conns, capture each resumeToken from auth.ok, drop the
      sockets, reconnect, send relay.auth.resume, assert ~100% AuthOk/resumed.
   c. PUSH UNDER LOAD: drive N concurrent PushService deliveries (API level — WS
      Push is a no-op) with an injected fake transport/clock; assert dedup +
      rate-limit + no leak hold under concurrency. If the push.rs API makes a
      true 10k-concurrency push test awkward, scope it HONESTLY (e.g. a few k
      concurrent send_or_deliver calls) and say so in the assertions list — do
      NOT fake coverage.

3. Capacity invariants: across/after the run assert no backpressure 1013 death
   for well-behaved consumers, the server is still serving (/health responds,
   /metrics counters are non-absurd — framesOut reflects the fan-out), and the
   process did not leak (conn table drains back down after clients disconnect).

4. Non-zero exit / test failure on any HARD failure (a frontend that never gets
   a frame, a resume that rejects, a push that leaks). Mirror soak.ts's honesty:
   report trends, fail only on real breakage. Optional JSON summary via env.

5. CI light tier: edit .github/workflows/ci.yml's rust job. AFTER the normal
   \`cargo test --workspace\`, add a step that raises ulimit -n (e.g. 65535) and
   runs the light tier:
     TP_SOAK_CONNS=<~1500> TP_SOAK_SECS=<~20> cargo test -p tp-relay --test soak_10k -- --ignored --nocapture
   Pick conn/sec values that are fast (<~1 min) + deterministic on ubuntu-latest
   yet genuinely exercise all 3 dimensions. Comment WHY heavy=local/light=CI.

6. Docs in the SAME change:
   - .claude/rules/relay-capacity.md: document the soak harness as the capacity
     gate (heavy local full-10k command + light CI tier + the 3 dimensions + the
     rate-knob caveat). This is the capacity SoT.
   - docs/adr/0003-phase4-backend-rust-migration.md: mark Step 7 row ✅ +
     advance the status line to "Step 8 (downtime cutover) 진행 예정".
   - rust/README.md if it documents test commands: add the soak invocations.

7. GATE (rustup PATH first!):
     export PATH="$(dirname "$(rustup which cargo)"):$PATH"; cd ${REPO}/rust
     cargo fmt --all -- --check && cargo clippy --workspace --all-targets && cargo test --workspace
   MUST be green AND the normal test run must NOT open thousands of sockets
   (confirm the soak is #[ignore]d — i.e. it is filtered out of the normal run).
   Then ACTUALLY RUN the light tier locally to prove it passes:
     ulimit -n 65535
     TP_SOAK_CONNS=1500 TP_SOAK_SECS=20 cargo test -p tp-relay --test soak_10k -- --ignored --nocapture
   Paste both tails. Fix every fmt/clippy nit (workspace pedantic=warn, all=deny).

Report via schema. Do not commit — the parent ships the PR.`,
  { label: 'impl:step7', phase: 'Implement', model: 'opus', effort: 'high', schema: IMPL_SCHEMA },
)

log(`Implement: ${impl ? `${(impl.filesChanged ?? []).length} files; light=${(impl.lightRunResult ?? '').slice(-80)}` : 'NULL — implementer died'}`)

// ---------------------------------------------------------------------------
// Phase 3 — Verify (adversarial, default REFUTED, file:line).
// ---------------------------------------------------------------------------
phase('Verify')

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lens', 'verdict', 'findings'],
  properties: {
    lens: { type: 'string' },
    verdict: { type: 'string', enum: ['pass', 'fail'], description: 'fail if ANY real defect; default fail when uncertain' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'file', 'claim', 'evidence'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          file: { type: 'string' },
          claim: { type: 'string' },
          evidence: { type: 'string', description: 'cite the HEAD file:line you read. NOT the implementer report.' },
        },
      },
    },
  },
}

const LENSES = [
  {
    key: 'honesty',
    prompt: `Lens = ASSERTION HONESTY (the highest-risk failure mode for a soak). Re-read
soak_10k.rs at HEAD. REFUTE the claim that it genuinely exercises + asserts all
three dimensions at scale. A soak that opens N sockets but asserts nothing real,
or silently passes when frames are dropped, or scopes push so small it proves
nothing, is WORSE than no soak (false confidence). Check: (a) pub fan-out really
counts delivered frames per frontend and FAILS on a drop; (b) resume storm
captures real tokens and FAILS on reject; (c) push-under-load asserts dedup/rate
under genuine concurrency, and if narrowed, the narrowing is stated; (d) the test
actually waits for completion (no fire-and-forget that exits before frames land).
Cite file:line.`,
  },
  {
    key: 'capacity',
    prompt: `Lens = FD / LEAK / CAPACITY CORRECTNESS. REFUTE the claim that the harness is
sound at scale. Check: (a) does it actually reach N concurrent conns (not open-
then-immediately-close serially)? (b) the rate-knob handling — does the publish
cadence trip GCRA and get silently rate-limited (making "0 drops" a lie)? Confirm
the SharedState tweak is real if claimed. (c) does it assert the conn table
drains after disconnect (leak guard)? (d) the CI light-tier values + ulimit raise
in ci.yml — would ~1500 conns actually fit under the raised limit and finish fast?
(e) is the soak #[ignore]d so \`cargo test --workspace\` does NOT open thousands of
sockets in the normal job? Cite file:line.`,
  },
  {
    key: 'gate',
    prompt: `Lens = GATE + CI WIRING + RUN HONESTY. REFUTE the claim the gate is green and the
light tier passes. (a) Re-read the ci.yml diff: is the light-tier step correctly
placed in the rust job, with the ulimit raise BEFORE it, correct env, correct
\`-- --ignored\`? (b) ACTUALLY RUN it yourself to confirm, do not trust the report:
  export PATH="$(dirname "$(rustup which cargo)"):$PATH"; cd ${REPO}/rust
  cargo fmt --all -- --check && cargo clippy --workspace --all-targets && cargo test --workspace
  (ulimit -n 65535; TP_SOAK_CONNS=1500 TP_SOAK_SECS=20 cargo test -p tp-relay --test soak_10k -- --ignored --nocapture)
Paste tails. Not green / light tier fails = blocker. Cite file:line.`,
  },
]

const verdicts = await parallel(LENSES.map((l) => () =>
  agent(
    `${GROUND}\n\n${l.prompt}\n\nIMPLEMENTER SUMMARY (HEARSAY — verify against HEAD): ${JSON.stringify(impl)}\n\nReport via schema. Default verdict=fail when uncertain.`,
    { label: `verify:${l.key}`, phase: 'Verify', model: 'sonnet', schema: VERDICT_SCHEMA },
  ).then((v) => v ? { ...v, lens: l.key } : null),
))

const live = verdicts.filter(Boolean)
const allFindings = live.flatMap((v) => v.findings.map((f) => ({ ...f, lens: v.lens })))
const blockers = allFindings.filter((f) => f.severity === 'blocker')
const majors = allFindings.filter((f) => f.severity === 'major')

log(`Verify: ${live.map((v) => `${v.lens}=${v.verdict}`).join(' ')} | blockers=${blockers.length} majors=${majors.length} minors=${allFindings.length - blockers.length - majors.length}`)

// ---------------------------------------------------------------------------
// Phase 4 — Gate / repair.
// ---------------------------------------------------------------------------
phase('Gate')

let repair = null
if (blockers.length > 0 || majors.length > 0) {
  const REPAIR_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['fixed', 'gateResult', 'lightRunResult', 'remaining'],
    properties: {
      fixed: { type: 'array', items: { type: 'string' } },
      gateResult: { type: 'string', description: 'tail of re-run fmt+clippy+test; MUST be green' },
      lightRunResult: { type: 'string', description: 'tail of re-run light soak tier; MUST pass' },
      remaining: { type: 'array', items: { type: 'string' }, description: 'findings intentionally left (justified) or empty' },
    },
  }
  repair = await agent(
    `${GROUND}

The Verify phase found defects. FINDINGS (each cites a HEAD file:line — re-read,
confirm real, fix; a finding may be wrong, then justify keeping per KEEP-AS-IS):

BLOCKERS: ${JSON.stringify(blockers)}
MAJORS: ${JSON.stringify(majors)}
MINORS (fix if cheap): ${JSON.stringify(allFindings.filter((f) => f.severity === 'minor'))}

Fix each real defect. Then RE-GATE + RE-RUN the light tier:
  export PATH="$(dirname "$(rustup which cargo)"):$PATH"; cd ${REPO}/rust
  cargo fmt --all -- --check && cargo clippy --workspace --all-targets && cargo test --workspace
  (ulimit -n 65535; TP_SOAK_CONNS=1500 TP_SOAK_SECS=20 cargo test -p tp-relay --test soak_10k -- --ignored --nocapture)
Paste both tails (MUST be green/pass). Report via schema. Do not commit.`,
    { label: 'gate:repair', phase: 'Gate', model: 'opus', effort: 'high', schema: REPAIR_SCHEMA },
  )
  log(`Repair: fixed=${(repair?.fixed ?? []).length} remaining=${(repair?.remaining ?? []).length}`)
}

return {
  step: 7,
  branch: 'feat/stage1-step7-soak-harness',
  facts,
  impl,
  verdicts: live,
  blockers,
  majors,
  repair,
  done: (blockers.length === 0 && majors.length === 0) || (repair && (repair.remaining ?? []).length === 0),
}
