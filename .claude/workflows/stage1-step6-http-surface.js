export const meta = {
  name: 'stage1-step6-http-surface',
  description: 'ADR-0003 Stage 1 Step 6: tp-relay HTTP surface (/health + /metrics + /admin bearer-gated) + build.rs buildSha, byte/field-parity vs TS reference',
  phases: [
    { title: 'Ground', detail: 'reverify TS endpoints + Rust emit sites at HEAD file:line' },
    { title: 'Implement', detail: 'metrics.rs counters + build.rs + axum routes + wiring' },
    { title: 'Verify', detail: 'adversarial parity review (fields, prometheus lines, bearer gate, buildSha)' },
    { title: 'Gate', detail: 'fmt + clippy + cargo test green' },
  ],
}

const REPO = '/Users/dave/Projects/github.com/teleprompter'

// ---------------------------------------------------------------------------
// Shared grounding preamble. Every agent re-reads HEAD; nothing below is
// asserted as fact — each file:line is a CLAIM the agent must confirm against
// the live working tree before relying on it (workflow-authoring rule 1+2).
// ---------------------------------------------------------------------------
const GROUND = `You are working in the teleprompter monorepo at ${REPO}, on branch
feat/stage1-step6-http-surface (forked from origin/main @ 3acf792).

TASK CONTEXT (ADR-0003 Phase 4 Stage 1 Step 6): the Rust relay crate
\`rust/tp-relay\` must grow an HTTP surface that is FIELD/BYTE-parity with the
TypeScript reference relay \`packages/relay/src/relay-server.ts\`:
  - GET /health   -> JSON
  - GET /metrics  -> Prometheus text v0.0.4
  - GET /admin    -> HTML dashboard, BEARER-TOKEN GATED (ADR redesign-now: the
                     TS /admin is currently unauthenticated, which is a security
                     wart; the Rust port closes it behind a bearer token)
plus a \`build.rs\` injecting TP_BUILD_SHA / TP_BUILD_TIME at compile time
(buildSha must be settable to github.sha in CI).

GROUND-TRUTH DISCIPLINE (non-negotiable):
- The ONLY ground truth is the HEAD working tree. Every file:line below is a
  CLAIM you must re-open and confirm before relying on it. Commit/PR bodies,
  this brief's prose, and "a previous step did X" are all hearsay.
- If a cited line has drifted, find the real location and report the corrected
  file:line. Do not fabricate.

TS REFERENCE CLAIMS to reverify in packages/relay/src/relay-server.ts:
- BUILD_SHA = process.env.TP_BUILD_SHA ?? "unknown" (~line 23)
- BUILD_TIME = process.env.TP_BUILD_TIME ?? "unknown" (~line 26)
- RelayMetrics interface (~line 173): 12 fields IN THIS ORDER —
    framesIn, framesOut, rateLimitedDrops, daemonRateLimitedDrops,
    backpressureDisconnects, authTimeouts, oversizedDrops, unknownTypeDrops,
    evictions, resumesAttempted, resumesAccepted, resumesRejected
- /health (~line 419): Response.json with keys IN ORDER: status:"ok", buildSha,
    buildTime, protocolVersion:2, clients, pendingAuth, daemons, sessions,
    attached, uptime (Math.floor process.uptime()), metrics:{...self.metrics}
- /metrics (~line 438): 18 lines, Content-Type "text/plain; version=0.0.4",
    trailing newline. Line order:
    relay_clients, relay_pending_auth, relay_daemons_online,
    relay_sessions_total, relay_frames_in, relay_frames_out,
    relay_rate_limited_drops, relay_daemon_rate_limited_drops,
    relay_backpressure_disconnects, relay_auth_timeouts, relay_oversized_drops,
    relay_unknown_type_drops, relay_evictions, relay_resumes_attempted,
    relay_resumes_accepted, relay_resumes_rejected, relay_uptime_seconds
- /admin (~line 470): HTML, escapeHtml(d.id) + d.sessions.map(escapeHtml) XSS
    guard; daemon rows online/offline badge + sessions + lastSeen ISO
- aggregateDaemonStats() (~line 575): single pass -> {daemonsOnline,
    sessionsTotal, attachedTotal} over daemonStates; online++ if s.online,
    sessionsTotal += s.sessions.size, attachedTotal += s.attached.size

RUST CLAIMS to reverify in rust/tp-relay/src:
- conn.rs:106-109 router(): Router::new().route("/", get(ws_upgrade)).with_state(state)
  -> HTTP routes attach to THIS SAME Router (no new TcpListener).
- conn.rs:61 OVERSIZED_DROPS: AtomicU64 static; conn.rs:358 fetch_add.
- handshake.rs:50 VERSION_MISMATCH_COUNT: AtomicU64 static.
- conn.rs:401-404 UNKNOWN_TYPE reply (unknown_type_drops emit site).
- conn.rs:471-474 RATE_LIMITED reply (rate_limited_drops emit site).
- conn.rs:162 stale-check eviction loop (evictions emit site).
- conn.rs:507 handle_auth_resume call (resumes_attempted/accepted/rejected).
- conn.rs deliver_actions() Action::Send try_send loop: frames_out increments
  per delivered Send; backpressure_disconnects per 1013 close.
- server.rs:123 struct RelayCore { conns, registry, ... }; registry.daemon_states
  holds per-daemon {online, sessions, attached, last_seen}.
- server.rs route_publish (~294) ingest -> frames_in emit site.
- server.rs alloc_conn_id / now_ms helpers.
- crates: axum 0.7 (NOT 0.8 — MSRV), tokio. lib.rs declares modules alphabetically.

rustup PATH GOTCHA: bare \`cargo\` is a rustup shim that mis-parses --workspace.
Before any cargo cmd run:
  export PATH="$(dirname "$(rustup which cargo)"):$PATH"
then \`cargo <cmd>\`. CI rust job = \`cargo fmt --all -- --check\` then
\`cargo clippy --workspace --all-targets\` (workspace lints: clippy::all=deny,
pedantic=warn — NO -D warnings) then \`cargo test --workspace\`.`

// ---------------------------------------------------------------------------
// Phase 1 — Ground. Two parallel readers confirm TS + Rust facts at HEAD.
// ---------------------------------------------------------------------------
phase('Ground')

const TS_FACTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['buildEnv', 'metricsFields', 'healthKeys', 'metricsLines', 'adminEscaping', 'aggregate', 'corrections'],
  properties: {
    buildEnv: { type: 'string', description: 'confirmed file:line for BUILD_SHA/BUILD_TIME env reads + default literal' },
    metricsFields: { type: 'array', items: { type: 'string' }, description: 'the 12 RelayMetrics field names in exact source order, with confirming file:line' },
    healthKeys: { type: 'array', items: { type: 'string' }, description: '/health JSON keys in exact source order, with file:line' },
    metricsLines: { type: 'array', items: { type: 'string' }, description: 'the 18 /metrics line prefixes in exact source order, with file:line + confirmed content-type + trailing-newline behavior' },
    adminEscaping: { type: 'string', description: 'confirmed escapeHtml usage sites + which fields are escaped, file:line' },
    aggregate: { type: 'string', description: 'aggregateDaemonStats fold semantics confirmed, file:line' },
    corrections: { type: 'array', items: { type: 'string' }, description: 'any drifted line numbers corrected, or empty if all claims confirmed' },
  },
}

const RUST_FACTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['router', 'emitSites', 'coreShape', 'crates', 'corrections'],
  properties: {
    router: { type: 'string', description: 'confirmed Router assembly file:line where HTTP routes must attach; how state is shared (SharedState/RelayCore lock)' },
    emitSites: { type: 'array', items: { type: 'string' }, description: 'for EACH of the 12 metrics, the confirmed file:line where the counter must increment (or "already exists as <static>" for OVERSIZED_DROPS etc.)' },
    coreShape: { type: 'string', description: 'RelayCore + registry.daemon_states shape: how to read clients/pendingAuth/daemonsOnline/sessionsTotal/attachedTotal at request time, file:line' },
    crates: { type: 'string', description: 'confirmed axum version + whether any new dep (e.g. for bearer/constant-time compare) is needed; check rust/tp-relay/Cargo.toml + rust/Cargo.toml workspace' },
    corrections: { type: 'array', items: { type: 'string' }, description: 'any drifted claims corrected, or empty' },
  },
}

const [tsFacts, rustFacts] = await parallel([
  () => agent(
    `${GROUND}\n\nYOUR JOB: read packages/relay/src/relay-server.ts at HEAD and CONFIRM (or correct) every TS REFERENCE CLAIM above. Open the file; cite real file:line for each. Capture the EXACT field/key/line ORDER (parity depends on byte order). Report via schema.`,
    { label: 'ground:ts-reference', phase: 'Ground', model: 'sonnet', schema: TS_FACTS_SCHEMA },
  ),
  () => agent(
    `${GROUND}\n\nYOUR JOB: read rust/tp-relay/src/*.rs + Cargo.toml files at HEAD and CONFIRM (or correct) every RUST CLAIM above. For EACH of the 12 metrics, pin the exact emit site file:line where the increment must land. Determine the cleanest place to hold a consolidated Metrics struct (RelayCore field vs SharedState) so /health + /metrics + /admin can read it lock-safely at request time. Report via schema.`,
    { label: 'ground:rust-emit-sites', phase: 'Ground', model: 'sonnet', schema: RUST_FACTS_SCHEMA },
  ),
])

log(`Ground: TS corrections=${(tsFacts?.corrections ?? ['<null>']).join('; ') || 'none'} | Rust corrections=${(rustFacts?.corrections ?? ['<null>']).join('; ') || 'none'}`)

// ---------------------------------------------------------------------------
// Phase 2 — Implement. One focused agent does the whole edit (the modules are
// tightly coupled: Metrics struct shape dictates wiring + route bodies).
// Worktree isolation NOT needed (single implementer, no parallel mutation).
// ---------------------------------------------------------------------------
phase('Implement')

const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['filesChanged', 'metricsModule', 'buildRs', 'routes', 'bearerGate', 'wiring', 'gateResult', 'openIssues'],
  properties: {
    filesChanged: { type: 'array', items: { type: 'string' }, description: 'every file created/edited with a one-line summary' },
    metricsModule: { type: 'string', description: 'how the Metrics struct is defined (AtomicU64 fields) + where it lives + how OVERSIZED_DROPS/VERSION_MISMATCH_COUNT statics were reconciled' },
    buildRs: { type: 'string', description: 'build.rs behavior: how TP_BUILD_SHA/TP_BUILD_TIME are emitted (env override -> git fallback -> "unknown"); how the binary reads them' },
    routes: { type: 'string', description: '/health + /metrics + /admin route bodies: confirm JSON key order, 18 prometheus lines + content-type + trailing newline, admin HTML escaping' },
    bearerGate: { type: 'string', description: 'how /admin bearer auth works: env var name, header parsed, constant-time compare, unconfigured behavior (open? closed?), unauthorized status code' },
    wiring: { type: 'array', items: { type: 'string' }, description: 'for EACH of the 12 counters: the file:line where the increment now fires' },
    gateResult: { type: 'string', description: 'paste the tail of: cargo fmt --all -- --check && cargo clippy --workspace --all-targets && cargo test --workspace -p tp-relay. MUST be green.' },
    openIssues: { type: 'array', items: { type: 'string' }, description: 'anything left imperfect or any parity gap you could not close (empty if none)' },
  },
}

const impl = await agent(
  `${GROUND}

GROUNDED FACTS (from this run's Ground phase — still verify against HEAD if anything looks off):
TS: ${JSON.stringify(tsFacts)}
RUST: ${JSON.stringify(rustFacts)}

YOUR JOB — implement Step 6 end to end:

1. Create rust/tp-relay/src/metrics.rs: a \`pub struct Metrics\` of 12 AtomicU64
   counters named to mirror the TS RelayMetrics fields (snake_case). Provide
   per-counter \`inc_*()\` helpers (Relaxed) and a \`snapshot()\` returning a plain
   struct (for the route bodies). RECONCILE the pre-existing scattered statics:
   fold conn.rs OVERSIZED_DROPS and (if it represents a /metrics counter)
   handshake.rs VERSION_MISMATCH_COUNT into the struct OR keep them and have
   snapshot() read them — pick the cleaner approach and document it. Declare the
   module in lib.rs ALPHABETICALLY.

2. Hold the Metrics in a way every route + every emit site can reach lock-safely.
   Prefer an \`Arc<Metrics>\` in SharedState (NOT inside the std Mutex<RelayCore>,
   so HTTP handlers read atomics without taking the routing lock). Wire it through
   construction.

3. Wire the 12 increments at the emit sites the Ground phase pinned (frames_in at
   ingest, frames_out per delivered Send, rate_limited_drops at RATE_LIMITED,
   daemon_rate_limited_drops at the daemon-side limit, backpressure_disconnects at
   the 1013 close, auth_timeouts when the auth deadline fires, oversized_drops,
   unknown_type_drops, evictions per evicted daemon, resumes_attempted/accepted/
   rejected around handle_auth_resume).

4. Create rust/tp-relay/build.rs: emit \`cargo:rustc-env=TP_BUILD_SHA=...\` and
   TP_BUILD_TIME. Precedence: env TP_BUILD_SHA if set (CI passes github.sha) ->
   else \`git rev-parse --short HEAD\` -> else "unknown". TP_BUILD_TIME: env ->
   else build timestamp from SOURCE_DATE_EPOCH if set -> else "unknown". The
   binary reads them via env!("TP_BUILD_SHA"). Add a \`rerun-if-env-changed\`.

5. Add the three routes to the axum Router (same router() as the WS "/" route):
   - GET /health: JSON via axum::Json or a manual serde_json::json! — but the
     KEY ORDER MUST MATCH TS exactly (status, buildSha, buildTime, protocolVersion,
     clients, pendingAuth, daemons, sessions, attached, uptime, metrics). Compute
     clients/pendingAuth/daemons/sessions/attached by taking the RelayCore lock
     ONCE (mirror aggregateDaemonStats single pass), uptime from a process start
     Instant, metrics from the snapshot.
   - GET /metrics: exactly the 18 lines in TS order, joined with "\\n", trailing
     "\\n", Content-Type "text/plain; version=0.0.4".
   - GET /admin: HTML dashboard mirroring the TS markup; HTML-escape daemon id +
     each session id (port escapeHtml: & < > " '). BEARER-GATE it: read bearer
     token from env (e.g. TP_RELAY_ADMIN_TOKEN). If the env is UNSET, /admin
     returns 404 (closed by default — do not serve an unauthenticated dashboard).
     If set, require \`Authorization: Bearer <token>\`; mismatch/absent -> 401.
     Use a constant-time compare (subtle crate if already in tree, else a manual
     constant-time byte compare — do NOT add a heavy dep just for this).

6. Add focused unit tests in the relevant modules:
   - metrics snapshot round-trips each counter.
   - /metrics output has exactly 18 lines in the right order + trailing newline +
     correct content-type (use axum's oneshot tower test or a direct handler call).
   - /health JSON key order matches TS (assert on the serialized string).
   - /admin: unset token -> 404; wrong token -> 401; right token -> 200 + escaped.
   - build.rs env override is honored (env!("TP_BUILD_SHA") test with a fixed env
     in CI is awkward — instead test that the binary exposes a non-empty build sha
     getter).

7. Update docs in the SAME change: docs/adr/0003-phase4-backend-rust-migration.md
   (mark Step 6 row done + advance status line to "Step 7 (10k soak)"), and if
   .claude/rules/relay-capacity.md documents the relay HTTP surface, keep it in
   sync (it is the capacity-monitoring SoT).

8. GATE — run and paste the tail of (rustup PATH first!):
     export PATH="$(dirname "$(rustup which cargo)"):$PATH"
     cd ${REPO}/rust
     cargo fmt --all -- --check && \\
     cargo clippy --workspace --all-targets && \\
     cargo test --workspace
   It MUST be green. Fix every fmt/clippy nit (workspace pedantic=warn, all=deny).
   If clippy flags pedantic warnings in your new code, fix them rather than allow.

Report via schema. Do not commit — the parent ships the PR.`,
  { label: 'impl:step6', phase: 'Implement', model: 'opus', effort: 'high', schema: IMPL_SCHEMA },
)

log(`Implement: ${impl ? `${(impl.filesChanged ?? []).length} files; gate=${(impl.gateResult ?? '').slice(-80)}` : 'NULL — implementer died'}`)

// ---------------------------------------------------------------------------
// Phase 3 — Verify. Adversarial parity reviewers, default REFUTED, cite
// file:line (not the implementer's prose). Three distinct lenses run in
// parallel: byte/field parity, security (bearer + XSS + constant-time), and
// build/gate honesty.
// ---------------------------------------------------------------------------
phase('Verify')

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lens', 'verdict', 'findings'],
  properties: {
    lens: { type: 'string' },
    verdict: { type: 'string', enum: ['pass', 'fail'], description: 'fail if ANY real defect in this lens; default to fail when uncertain' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'file', 'claim', 'evidence'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          file: { type: 'string', description: 'file:line in the working tree' },
          claim: { type: 'string', description: 'the concrete defect' },
          evidence: { type: 'string', description: 'why it is real — cite the HEAD file:line you read, and the TS reference line it diverges from. NOT the implementer report.' },
        },
      },
    },
  },
}

const LENSES = [
  {
    key: 'parity',
    prompt: `Lens = BYTE/FIELD PARITY. Independently re-read BOTH the Rust route bodies
(rust/tp-relay/src) AND packages/relay/src/relay-server.ts at HEAD. REFUTE the
claim that they match. Check: (a) /health JSON key ORDER + values
(protocolVersion==2, uptime is floor-seconds, metrics nested object); (b) /metrics
== exactly 18 lines in TS order + trailing newline + "text/plain; version=0.0.4";
(c) the 12 counter names map 1:1 to the TS RelayMetrics fields; (d) /admin escapes
daemon id + session ids the same way escapeHtml does (& < > " '). Any divergence is
at least a major. Cite file:line on BOTH sides.`,
  },
  {
    key: 'security',
    prompt: `Lens = SECURITY. REFUTE the claim that the /admin bearer gate + escaping are
sound. Check: (a) unset admin token -> /admin is CLOSED (404), never serves an
unauthenticated dashboard; (b) wrong/absent Authorization -> 401; (c) the token
compare is constant-time (no early-return byte compare / == on secrets); (d) no
attacker-controlled daemonId/sid reaches HTML unescaped (XSS); (e) the bearer token
is never logged. Also confirm no architecture-invariant break: the HTTP routes share
the existing axum listener (relay still opens exactly one inbound listener, stays
ciphertext-only on the WS path). Cite file:line.`,
  },
  {
    key: 'build-gate',
    prompt: `Lens = BUILD/GATE HONESTY. REFUTE the claim that build.rs + the gate are real.
Check: (a) build.rs precedence is env TP_BUILD_SHA -> git -> "unknown" and the binary
actually reads it via env!(); (b) a CI-set TP_BUILD_SHA would reach /health.buildSha
(trace it); (c) the wiring increments fire at the RIGHT sites (re-read each of the 12
emit sites — e.g. frames_out really increments per delivered Send, evictions per
evicted daemon, resumes_rejected only on rejection). Then ACTUALLY RUN the gate
yourself to confirm it is green, do not trust the report:
  export PATH="$(dirname "$(rustup which cargo)"):$PATH"
  cd ${REPO}/rust && cargo fmt --all -- --check && cargo clippy --workspace --all-targets && cargo test --workspace
Paste the tail. If it is not green, that is a blocker. Cite file:line.`,
  },
]

const verdicts = await parallel(LENSES.map((l) => () =>
  agent(
    `${GROUND}\n\n${l.prompt}\n\nIMPLEMENTER SUMMARY (treat as HEARSAY — verify against HEAD, do not quote it as evidence): ${JSON.stringify(impl)}\n\nReport via schema. Default verdict=fail when uncertain.`,
    { label: `verify:${l.key}`, phase: 'Verify', model: 'sonnet', schema: VERDICT_SCHEMA },
  ).then((v) => v ? { ...v, lens: l.key } : null),
))

const live = verdicts.filter(Boolean)
const allFindings = live.flatMap((v) => v.findings.map((f) => ({ ...f, lens: v.lens })))
const blockers = allFindings.filter((f) => f.severity === 'blocker')
const majors = allFindings.filter((f) => f.severity === 'major')

log(`Verify: ${live.map((v) => `${v.lens}=${v.verdict}`).join(' ')} | blockers=${blockers.length} majors=${majors.length} minors=${allFindings.length - blockers.length - majors.length}`)

// ---------------------------------------------------------------------------
// Phase 4 — Gate / repair. If blockers or majors exist, one repair pass fixes
// them and re-gates; otherwise we're done.
// ---------------------------------------------------------------------------
phase('Gate')

let repair = null
if (blockers.length > 0 || majors.length > 0) {
  const REPAIR_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['fixed', 'gateResult', 'remaining'],
    properties: {
      fixed: { type: 'array', items: { type: 'string' }, description: 'each finding addressed -> what changed, file:line' },
      gateResult: { type: 'string', description: 'tail of the re-run gate; MUST be green' },
      remaining: { type: 'array', items: { type: 'string' }, description: 'any finding intentionally left (with justification) or empty' },
    },
  }
  repair = await agent(
    `${GROUND}

The Verify phase found defects that must be fixed. FINDINGS (each cites a HEAD
file:line — re-read it, confirm it's real, fix it; a finding may be wrong, in which
case justify keeping as-is per the KEEP-AS-IS rule):

BLOCKERS: ${JSON.stringify(blockers)}
MAJORS: ${JSON.stringify(majors)}
MINORS (fix if cheap): ${JSON.stringify(allFindings.filter((f) => f.severity === 'minor'))}

Fix each real defect in rust/tp-relay/src (+ docs if parity-relevant). Then RE-GATE:
  export PATH="$(dirname "$(rustup which cargo)"):$PATH"
  cd ${REPO}/rust && cargo fmt --all -- --check && cargo clippy --workspace --all-targets && cargo test --workspace
Paste the tail (MUST be green). Report via schema. Do not commit.`,
    { label: 'gate:repair', phase: 'Gate', model: 'opus', effort: 'high', schema: REPAIR_SCHEMA },
  )
  log(`Repair: fixed=${(repair?.fixed ?? []).length} remaining=${(repair?.remaining ?? []).length} gate=${(repair?.gateResult ?? '').slice(-80)}`)
}

return {
  step: 6,
  branch: 'feat/stage1-step6-http-surface',
  tsFacts,
  rustFacts,
  impl,
  verdicts: live,
  blockers,
  majors,
  repair,
  done: blockers.length === 0 && majors.length === 0 || (repair && (repair.remaining ?? []).length === 0),
}
