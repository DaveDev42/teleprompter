export const meta = {
  name: 'stage1-step8a-relay-binary',
  description: 'ADR-0003 Stage 1 Step 8a: tp-relay binary entry (main.rs) + local Rust-relay E2E gate (real tp daemon pairs to a locally-run Rust relay, no production touch).',
  phases: [
    { title: 'Ground', detail: 'reverify serve/from_env/CLI-config/deploy-arch + the real-daemon E2E harness at HEAD file:line' },
    { title: 'Implement', detail: 'main.rs binary + [[bin]] + local Rust-relay E2E script + docs' },
    { title: 'Verify', detail: 'adversarial: binary parity vs TS relay config, E2E honesty, no production touch, arch/cross-compile correctness' },
    { title: 'Gate', detail: 'fmt + clippy + cargo test + cargo build --release + RUN the local Rust-relay E2E to prove pair→auth works' },
  ],
}

const REPO = '/Users/dave/Projects/github.com/teleprompter'

const GROUND = `You are working in the teleprompter monorepo at ${REPO}, on branch
feat/stage1-step8a-relay-binary (forked from origin/main @ 6c745dd — Steps 1-7
of ADR-0003 Stage 1 are merged: tp-relay is a complete axum relay LIBRARY with
handshake/resume/registry/hot-path/push/HTTP-surface/soak, but NO binary entry).

TASK CONTEXT (ADR-0003 Phase 4 Stage 1 Step 8a — the FIRST half of Step 8, the
local-gate half): give \`rust/tp-relay\` a runnable BINARY entry, then prove a
real \`tp\` daemon can pair to a LOCALLY-RUN Rust relay and complete the
frontend-auth handshake. This is the safe, fully-local prerequisite to the
production cutover (8b deploy pipeline + 8c live flip come AFTER this).

SCOPE BOUNDARY (critical): 8a touches NOTHING in production. It does NOT modify
relay.tpmt.dev, does NOT change deploy-relay.yml, does NOT reissue any real
secret, does NOT repoint the user's dogfood daemon. It ONLY: adds main.rs +
[[bin]] to tp-relay, and adds a LOCAL E2E that runs the Rust relay on a loopback
port against an ISOLATED test daemon (its own XDG/HOME under mktemp — never the
dogfood store). All architecture invariants hold (app→relay only, daemon
outbound-WS only via relay.register, relay ciphertext-only).

GROUND-TRUTH DISCIPLINE (non-negotiable): the ONLY ground truth is the HEAD
working tree. Every file:line below is a CLAIM to re-open and confirm. Commit/PR
bodies and this brief's prose are hearsay.

RUST CLAIMS to reverify in rust/tp-relay:
- conn.rs:132 \`pub async fn serve(self, addr: SocketAddr) -> io::Result<()>\`:
  binds TcpListener, spawns stale-check, axum::serve. This is what main.rs calls.
- server.rs:243 \`SharedState::from_env()\` already reads ALL relay config from env:
  TP_RELAY_RESUME_SECRET (resume_token.rs:124 from_env), rate knobs
  (rate.rs:78/85 TP_RELAY_RATE_PER_CLIENT / _PER_DAEMON), max-frame-size
  (conn.rs max_frame_size_from_env, TP_RELAY_MAX_FRAME_SIZE), recent-frames cache
  (TP_RELAY_CACHE_SIZE), push-seal (push_seal.rs:127/141
  TP_RELAY_PUSH_SEAL_SECRET[_PREV]). So main.rs is THIN — build SharedState via
  from_env(), construct RelayServer::with_state, call serve(). Confirm exactly
  which knobs from_env covers vs which the binary must surface as flags.
- Cargo.toml: tp-relay is currently \`[lib]\` only (name tp_relay). 8a adds a
  \`[[bin]]\` (name e.g. "tp-relay") with src/main.rs. Confirm no [[bin]] exists yet.
- http.rs: /health reports buildSha from env!("TP_BUILD_SHA") (build.rs). The
  binary inherits this automatically — confirm the binary's /health works.
- The library is \`#![forbid(unsafe_code)]\` and workspace lints (clippy::all=deny,
  pedantic=warn). main.rs must be clean under the same lints.

TS REFERENCE (config parity, NOT 1:1 port):
- apps/cli/src/commands/relay.ts: \`tp relay start\` flags = --port (default 7090),
  --cache-size (TP_RELAY_CACHE_SIZE), --max-frame-size (TP_RELAY_MAX_FRAME_SIZE).
  The Rust binary should accept --port (default 7090) at minimum; other knobs come
  from env via from_env(). Mirror the port default + a clean --help/usage.
- The systemd unit (deploy-relay.yml:65) runs \`/usr/local/bin/tp relay start\` with
  \`Environment=RELAY_PORT=7090\`. NOTE: the TS path uses --port flag, the unit sets
  RELAY_PORT env but the TS relay.ts does NOT read RELAY_PORT (it defaults to 7090
  and the unit's env is currently inert — confirm this). For the Rust binary, read
  the port from BOTH a --port flag AND a RELAY_PORT env (flag wins) so the existing
  unit's Environment=RELAY_PORT works when 8b repoints it. Confirm/decide and doc.

LOCAL E2E HARNESS (reuse, do not reinvent):
- scripts/real-daemon-pair.ts EXISTS (built in the 5-platform harness work, task
  T5). Read it: it spins an in-process RealayServer (TS) on a free port + an
  ISOLATED tp daemon (mktemp XDG/HOME) + does pair.begin → emits REAL_PAIR_URL.
  scripts/ios.sh start_real_daemon_relay() drives it (TP_E2E_REAL=1). For 8a we
  need the ANALOG against the RUST relay: run the Rust relay BINARY on a loopback
  port, then point an isolated tp daemon's pairing at ws://localhost:PORT and
  confirm the daemon→relay register + a frontend-role auth handshake succeed.
  DECIDE the cleanest form: (a) extend real-daemon-pair.ts with a flag to NOT
  start the TS relay and instead expect an external relay URL (so it pairs to the
  already-running Rust binary), plus a tiny driver script that boots the Rust
  binary + runs a frontend-auth probe; OR (b) a self-contained shell/TS script
  scripts/rust-relay-e2e.sh that: cargo build --release the tp-relay bin, run it
  on a free port, run an isolated \`tp daemon\` paired to it, assert daemon
  registers (relay /health shows daemons>=1 or /metrics relay_daemons_online>=1),
  and a tokio-tungstenite or bun WS frontend-auth probe gets relay.auth.ok.
  Prefer the form that genuinely proves "real tp daemon + real Rust relay +
  frontend auth", honestly scoped (M0-M2-ish: register + auth; full kx/session
  needs a spawned session, out of 8a scope — say so).

DEPLOY/ARCH CONTEXT (for the doc + 8b handoff, do NOT change deploy yet):
- .github/workflows/deploy-relay.yml builds the TS tp binary, SCPs to the Vultr
  host (relay.tpmt.dev), installs /usr/local/bin/tp, systemd tp-relay restart,
  asserts /health.buildSha == github.sha. Arch auto-detect maps x86_64→linux-x64.
- The Rust cross target x86_64-unknown-linux-gnu is installed locally. 8a should
  CONFIRM \`cargo build --release --bin tp-relay\` works for the host, and DOCUMENT
  (in the ADR / a runbook) the cross-compile target the 8b deploy will use — but
  8a does NOT cross-compile or deploy.

rustup PATH GOTCHA: bare cargo is a rustup shim mis-parsing --workspace. Before
any cargo cmd: export PATH="$(dirname "$(rustup which cargo)"):$PATH" then cargo.

DOGFOOD SAFETY: the user's dogfood daemon (~/.local/bin/tp, paired to
wss://relay.tpmt.dev) must NEVER be touched by the E2E. Use a fully isolated
daemon (own XDG_RUNTIME_DIR/XDG_DATA_HOME/XDG_CONFIG_HOME/HOME under mktemp -d),
exactly as scripts/real-daemon-pair.ts already does. Verify that isolation.`

// ---------------------------------------------------------------------------
// Phase 1 — Ground.
// ---------------------------------------------------------------------------
phase('Ground')

const FACTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['serveAndFromEnv', 'binTarget', 'portConfig', 'e2eHarness', 'isolation', 'deployArch', 'corrections'],
  properties: {
    serveAndFromEnv: { type: 'string', description: 'confirmed serve() signature + EXACTLY which config from_env() already covers vs what main.rs must surface, file:line' },
    binTarget: { type: 'string', description: 'confirmed tp-relay is lib-only (no [[bin]] yet); the [[bin]] stanza + src/main.rs to add, file:line' },
    portConfig: { type: 'string', description: 'confirmed: does TS relay.ts read RELAY_PORT? does the systemd unit set it? the decided port-resolution for the Rust bin (flag + env precedence), file:line' },
    e2eHarness: { type: 'string', description: 'confirmed shape of scripts/real-daemon-pair.ts + ios.sh start_real_daemon_relay; the cleanest way to drive a real tp daemon against the running Rust relay binary + a frontend-auth probe, file:line' },
    isolation: { type: 'string', description: 'confirmed how real-daemon-pair.ts isolates the daemon (mktemp XDG/HOME) so the dogfood daemon is never touched, file:line' },
    deployArch: { type: 'string', description: 'confirmed deploy-relay.yml arch-detect + the cross target 8b will need (x86_64-unknown-linux-gnu) — for the runbook only, file:line' },
    corrections: { type: 'array', items: { type: 'string' }, description: 'drifted claims corrected, or empty' },
  },
}

const facts = await agent(
  `${GROUND}\n\nYOUR JOB: read rust/tp-relay/src/conn.rs + server.rs + Cargo.toml + http.rs, apps/cli/src/commands/relay.ts, scripts/real-daemon-pair.ts, scripts/ios.sh (start_real_daemon_relay), .github/workflows/deploy-relay.yml at HEAD. CONFIRM or CORRECT every claim with real file:line. Pin EXACTLY how main.rs should be structured and how the local Rust-relay E2E should drive a real isolated daemon against the binary. Report via schema.`,
  { label: 'ground:binary-e2e', phase: 'Ground', model: 'sonnet', schema: FACTS_SCHEMA },
)

log(`Ground: corrections=${(facts?.corrections ?? ['<null>']).join('; ') || 'none'}`)

// ---------------------------------------------------------------------------
// Phase 2 — Implement.
// ---------------------------------------------------------------------------
phase('Implement')

const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['filesChanged', 'mainRs', 'binStanza', 'e2eScript', 'e2eResult', 'gateResult', 'buildResult', 'openIssues'],
  properties: {
    filesChanged: { type: 'array', items: { type: 'string' } },
    mainRs: { type: 'string', description: 'main.rs design: arg/env parse, SharedState::from_env, serve(), logging, SIGINT/SIGTERM graceful, startup log line' },
    binStanza: { type: 'string', description: 'the [[bin]] addition + how lib+bin coexist' },
    e2eScript: { type: 'string', description: 'the local Rust-relay E2E: what it boots, how it isolates the daemon, what it asserts (register + frontend-auth), honest scope' },
    e2eResult: { type: 'string', description: 'tail of ACTUALLY RUNNING the E2E: real isolated tp daemon pairs to the running Rust relay binary, daemon registers, frontend-auth gets relay.auth.ok. MUST pass. Confirm the dogfood daemon was untouched.' },
    gateResult: { type: 'string', description: 'tail of: cargo fmt --all -- --check && cargo clippy --workspace --all-targets && cargo test --workspace. MUST be green.' },
    buildResult: { type: 'string', description: 'tail of: cargo build --release --bin tp-relay. MUST succeed; note the binary path + that /health on it reports a buildSha.' },
    openIssues: { type: 'array', items: { type: 'string' } },
  },
}

const impl = await agent(
  `${GROUND}

GROUNDED FACTS (from this run's Ground phase — verify against HEAD if anything looks off):
${JSON.stringify(facts)}

YOUR JOB — implement Step 8a end to end:

1. rust/tp-relay/src/main.rs + a [[bin]] stanza in Cargo.toml (bin name "tp-relay",
   lib stays "tp_relay"). main.rs is THIN: a #[tokio::main] that parses --port
   (default 7090) and RELAY_PORT env (flag wins), builds SharedState::from_env()
   (which already reads resume-secret/rate/push-seal/cache/max-frame), constructs
   RelayServer::with_state, logs a startup line (port + buildSha from
   env!("TP_BUILD_SHA")), installs SIGINT/SIGTERM graceful shutdown, and calls
   serve(addr).await. Clean --help/usage. Must satisfy #![forbid(unsafe_code)] +
   workspace clippy (all=deny, pedantic=warn) — fix every nit, no allow.

2. A local Rust-relay E2E (the form the Ground phase judged cleanest — extend
   scripts/real-daemon-pair.ts or add scripts/rust-relay-e2e.sh). It MUST:
   - cargo build --release --bin tp-relay (or reuse a prebuilt path), run it on a
     FREE loopback port with a fresh TP_RELAY_RESUME_SECRET (ephemeral is fine for
     the test).
   - Start a FULLY ISOLATED tp daemon (own mktemp XDG_RUNTIME_DIR/XDG_DATA_HOME/
     XDG_CONFIG_HOME/HOME) and pair it to ws://localhost:PORT (NOT the dogfood
     daemon, NOT relay.tpmt.dev). Reuse real-daemon-pair.ts's isolation verbatim.
   - Assert the daemon REGISTERS with the Rust relay: GET /health (or /metrics)
     on the relay shows daemons>=1 / relay_daemons_online>=1.
   - Run a frontend-role auth probe (tokio-tungstenite or bun WS) that completes
     relay.auth and gets relay.auth.ok — proving the genuine daemon→relay→app auth
     pipeline against the RUST relay. Honest scope: register + frontend-auth
     (M0-M2). Full kx/session/input needs a spawned claude session — OUT of 8a;
     say so in output + docs.
   - Tear everything down; leave NO orphan processes; confirm (and assert) the
     dogfood daemon + its store were never touched (e.g. the isolated HOME is
     under /tmp and removed).

3. Docs in the SAME change:
   - docs/adr/0003-phase4-backend-rust-migration.md: Step 8 row — split into 8a
     (binary + local E2E ✅) done, 8b (deploy pipeline) + 8c (live cutover) still
     pending; advance the status line accordingly. Add a short CUTOVER RUNBOOK
     stub (the ordered live steps for 8c: stop TS relay, reissue
     TP_RELAY_RESUME_SECRET + push-seal, deploy Rust bin, verify /health.buildSha,
     dogfood re-pair, push re-register) so 8c is a checklist, not improvisation.
   - rust/README.md: document the tp-relay binary (run command, env knobs) + the
     local Rust-relay E2E invocation.
   - .claude/rules/relay-capacity.md or release-deploy.md if they need the Rust
     binary run command.

4. GATE (rustup PATH first!):
     export PATH="$(dirname "$(rustup which cargo)"):$PATH"; cd ${REPO}/rust
     cargo fmt --all -- --check && cargo clippy --workspace --all-targets && cargo test --workspace
     cargo build --release --bin tp-relay
   All green. Then ACTUALLY RUN the local Rust-relay E2E and paste its tail —
   it MUST show a real isolated daemon registering with the Rust relay binary +
   a frontend-auth ok. Confirm no orphan processes and the dogfood daemon
   (~/.local/bin/tp, paired to wss://relay.tpmt.dev) is untouched.

Report via schema. Do not commit — the parent ships the PR.`,
  { label: 'impl:step8a', phase: 'Implement', model: 'opus', effort: 'high', schema: IMPL_SCHEMA },
)

log(`Implement: ${impl ? `${(impl.filesChanged ?? []).length} files; e2e=${(impl.e2eResult ?? '').slice(-90)}` : 'NULL — implementer died'}`)

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
    verdict: { type: 'string', enum: ['pass', 'fail'] },
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
          evidence: { type: 'string', description: 'cite HEAD file:line. NOT the implementer report.' },
        },
      },
    },
  },
}

const LENSES = [
  {
    key: 'safety',
    prompt: `Lens = PRODUCTION SAFETY (the highest-stakes lens). REFUTE the claim that 8a
touches nothing in production. Re-read main.rs + the E2E script at HEAD. Check:
(a) the E2E daemon is FULLY isolated (own mktemp XDG/HOME) and can NEVER collide
with the dogfood daemon's socket/store; (b) the E2E does NOT connect to
relay.tpmt.dev or reissue any real secret; (c) no change to deploy-relay.yml or
any production secret; (d) no orphan daemon/relay processes survive the E2E.
Any way the dogfood daemon or production could be perturbed is a BLOCKER. Cite
file:line.`,
  },
  {
    key: 'e2e-honesty',
    prompt: `Lens = E2E HONESTY. REFUTE the claim the local E2E genuinely proves "real tp
daemon + real Rust relay binary + frontend auth". Check: (a) it runs the actual
built tp-relay BINARY (not the library in-process), (b) a REAL tp daemon
registers (asserted via /health|/metrics, not assumed), (c) a frontend-auth probe
really gets relay.auth.ok (asserted on the wire), (d) the scope claim (M0-M2,
no kx/session) is honest and the script doesn't silently pass if the daemon never
registers. Cite file:line.`,
  },
  {
    key: 'binary-gate',
    prompt: `Lens = BINARY + GATE. REFUTE that the binary is sound + the gate green. Check:
(a) main.rs port resolution (flag + RELAY_PORT env precedence) is correct and
SIGINT/SIGTERM shut down cleanly; (b) the [[bin]] + [lib] coexist; (c) /health on
the binary reports a buildSha (build.rs env flows to the bin). Then ACTUALLY RUN
yourself, do not trust the report:
  export PATH="$(dirname "$(rustup which cargo)"):$PATH"; cd ${REPO}/rust
  cargo fmt --all -- --check && cargo clippy --workspace --all-targets && cargo test --workspace && cargo build --release --bin tp-relay
Paste the tail. Not green = blocker. Cite file:line.`,
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
    required: ['fixed', 'gateResult', 'e2eResult', 'remaining'],
    properties: {
      fixed: { type: 'array', items: { type: 'string' } },
      gateResult: { type: 'string', description: 'tail of re-run fmt+clippy+test+build; MUST be green' },
      e2eResult: { type: 'string', description: 'tail of re-run local Rust-relay E2E; MUST pass' },
      remaining: { type: 'array', items: { type: 'string' } },
    },
  }
  repair = await agent(
    `${GROUND}

The Verify phase found defects. FINDINGS (each cites a HEAD file:line — re-read,
confirm real, fix; a finding may be wrong, then justify keeping per KEEP-AS-IS):

BLOCKERS: ${JSON.stringify(blockers)}
MAJORS: ${JSON.stringify(majors)}
MINORS (fix if cheap): ${JSON.stringify(allFindings.filter((f) => f.severity === 'minor'))}

Fix each real defect. Then RE-GATE + RE-RUN the local Rust-relay E2E:
  export PATH="$(dirname "$(rustup which cargo)"):$PATH"; cd ${REPO}/rust
  cargo fmt --all -- --check && cargo clippy --workspace --all-targets && cargo test --workspace && cargo build --release --bin tp-relay
  (then the local Rust-relay E2E script)
Paste both tails (MUST be green/pass). Report via schema. Do not commit.`,
    { label: 'gate:repair', phase: 'Gate', model: 'opus', effort: 'high', schema: REPAIR_SCHEMA },
  )
  log(`Repair: fixed=${(repair?.fixed ?? []).length} remaining=${(repair?.remaining ?? []).length}`)
}

return {
  step: '8a',
  branch: 'feat/stage1-step8a-relay-binary',
  facts,
  impl,
  verdicts: live,
  blockers,
  majors,
  repair,
  done: (blockers.length === 0 && majors.length === 0) || (repair && (repair.remaining ?? []).length === 0),
}
