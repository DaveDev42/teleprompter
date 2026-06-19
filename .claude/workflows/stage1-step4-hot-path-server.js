export const meta = {
  name: 'stage1-step4-hot-path-server',
  description: 'Implement the tp-relay async WS server (axum + tokio-tungstenite) hot path on top of the verified ring/rate/registry/handshake modules, with adversarial async-correctness verification',
  phases: [
    { title: 'Implement', detail: 'write server.rs + conn.rs + wire deps/lib, compile + test' },
    { title: 'Verify', detail: 'adversarial async-correctness review (lock-across-await, backpressure, routing, ping-exemption)' },
    { title: 'Repair', detail: 'fix confirmed defects' },
  ],
}

// ── Grounded facts (verified file:line from live HEAD reads this session) ──────
// These are the TS reference + Rust-side type signatures the implementer must
// honor. The implementer agent MUST re-open each cited file:line and confirm
// before relying on it — these are starting pointers, not axioms.

const REPO = '/Users/dave/Projects/github.com/teleprompter'

const GROUNDED = `
## Verified reference facts (re-confirm each against live HEAD before relying)

### Rust crate state (already merged / on this branch, all green)
- \`rust/tp-relay/src/messages.rs\`: \`RelayServerMessage\` (serde tagged enum, 11 variants:
  RegisterOk/RegisterErr/AuthOk/AuthErr/Frame/KeyExchangeFrame/Presence/Pong/PushToken/Notification/RelayErr),
  \`Frame { sid, ct, seq:u64, from:Role, frontend_id:Option<String> }\`,
  \`KeyExchangeFrame { ct, from:Role }\`, \`Presence { daemon_id, online, sessions:Vec<String>, last_seen:f64 }\`,
  \`parse_relay_server_message\`. Role/Platform/PushData from \`tp_proto::relay_client\`.
- \`rust/tp-proto/src/relay_client.rs\`: \`RelayClientMessage\` enum + \`parse_relay_client_message(&serde_json::Value) -> Option<RelayClientMessage>\`.
  Variants: Auth{role,daemon_id,token,v:f64,frontend_id:Option<String>}, AuthResume{token,v:f64},
  Register{daemon_id,proof,token,v:f64}, KeyExchange{ct,role:Role}, Publish{sid,ct,seq:u64},
  Subscribe{sid,after:Option<u64>}, Unsubscribe{sid}, Ping{ts:Option<f64>},
  Push{frontend_id,sealed,title,body,interruption_level,data}, PushRegister{frontend_id,token,platform}.
  \`Role\` is \`tp_proto::relay_client::Role\` (Daemon/Frontend; serde "daemon"/"frontend").
- \`rust/tp-relay/src/registry.rs\`: \`Registry\` { daemon_states: HashMap<String,DaemonState>, registrations, valid_tokens }.
  \`DaemonState { online, sessions:IndexSet<String>, last_seen:u64, attached:HashMap<String,u32>, registration_token }\`.
  Methods: handle_register, handle_auth, handle_auth_resume, upsert_daemon_state, daemon_pub(daemon_id,sid,now_ms) (adds session + refreshes last_seen — DAEMON ROLE ONLY caller),
  daemon_disconnect(daemon_id,now_ms), frontend_disconnect(daemon_id,&[sid]), attach/detach on DaemonState,
  check_stale_daemons(now_ms,stale_timeout_ms,offline_evict_ms) -> StaleCheckResult{newly_offline:Vec<String>, evicted:Vec<String>}.
- \`rust/tp-relay/src/handshake.rs\`: handle_register/handle_auth/handle_auth_resume/handle_hello — pure handlers
  that mutate the Registry and RETURN a \`RelayServerMessage\` (the reply to send to the authing socket).
  Signatures (CONFIRM exact params by reading the file): e.g.
  handle_auth(daemon_id,token,is_daemon, frontend_id:Option<&str>?, now_ms, &mut Registry, &ResumeTokenSigner) -> RelayServerMessage.
  \`VERSION_MISMATCH_COUNT: AtomicU64\` pub static + version_mismatch_count(). v<2 rejected.
- \`rust/tp-relay/src/ring.rs\` (THIS branch, green): \`RecentFrames\` — push(daemon_id,Arc<Frame>),
  replay_after(daemon_id,sid,after)->Vec<Arc<Frame>>, purge_daemon(daemon_id), from_env()/with_cache_size.
- \`rust/tp-relay/src/rate.rs\` (THIS branch, green): \`Limiter::per_second(u32)\` + \`.check()->bool\` (GCRA, governor crate),
  rate_per_client_from_env()->u32 (500), rate_per_daemon_from_env()->u32 (5000).
- \`rust/tp-relay/src/resume_token.rs\`: \`ResumeTokenSigner\` (issue/verify). from_env constructor exists.

### TS reference (packages/relay/src/relay-server.ts) — ROUTING + TRANSPORT (verified this session)
- **Wire format = PLAIN TEXT JSON.** send() does \`ws.send(JSON.stringify(msg))\` (line 618). NO length prefix, NO binary
  framing on the relay WS. Rust must send \`axum::extract::ws::Message::Text(serde_json::to_string(&msg))\`. (The
  tp_core codec u32-frame helpers are for IPC, NOT the relay WS — do not use them here.)
- **daemonGroups: Map<daemonId, Set<ws>>** (line 245). Every authed ws (daemon + all its frontends) is in its group.
  Added on auth (registerClient ~963-969), removed on close (~1266-1272; group deleted when empty).
- **per-connection \`subscriptions: Set<sid>\`** on ConnectedClient. Added on relay.sub (line 1190), removed on relay.unsub (1218).
- **relay.pub fan-out (handlePublish ~1116-1164):** (a) if role=daemon: daemonState.sessions.add(sid) + lastSeen=now (1116-1126) — FRONTEND PUB DOES NOT (use registry.daemon_pub ONLY for role=daemon). (b) ALWAYS cache the frame in recentFrames keyed "daemonId:sid"; frontend frames carry frontendId. (c) forward to every group member whose subscriptions.has(sid), EXCEPT the sender (peerWs===ws continue). NO role filter. Forwarded wire = relay.frame {sid,ct,seq,from, frontendId?} (from="frontend" carries frontendId, from="daemon" omits). Missing group → silent return; no subscribers → silent (frame still cached).
- **relay.sub (handleSubscribe ~1190-1209):** client.subscriptions.add(sid). If role=frontend: daemonState.attached[sid]++ (registry attach). Then if after!=undefined: replay recentFrames seq>after to THIS ws via send(frameFromCache).
- **relay.unsub (~1215-1233):** subscriptions.delete(sid). If role=frontend: attached[sid]-- (registry detach; delete at 0; only if present).
- **relay.kx (handleKeyExchange ~1038-1070):** forward relay.kx.frame {t:"relay.kx.frame", ct:msg.ct, from:client.role} to every group member whose role != sender role (OPPOSITE role only), except sender. NO sid, NO subscription filter.
- **broadcastPresence(daemonId) (~1598-1619):** build Presence {t:"relay.presence", daemonId, online:state.online, sessions:[...state.sessions], lastSeen:state.lastSeen}; send ONLY to group members with role=frontend. REDESIGN per ADR §A1.4: send \`sessions: []\` (the app discards the sessions list anyway) — emit an EMPTY sessions Vec, not the full set. Called on: daemon auth/resume (876,955), daemon disconnect (1281 after online=false), and in checkStaleDaemons for each newly_offline daemon (NOT for evicted — evict purges state).
- **2-layer rate limit (685-704):** check per-client THEN per-daemon-group, EXCEPT msg.t=="relay.ping" from an AUTHED client. On exceed: send relay.err{e:"RATE_LIMITED"} and DROP the frame (do NOT close socket).
- **slow-consumer (send() 596-616):** if bufferedAmount > backpressureBytes (4MB, TP_RELAY_BACKPRESSURE_BYTES) → close(1013,"Backpressure"). REDESIGN per ADR line 52: bounded mpsc per conn; try_send full = buffer exhausted → close WS with 1013.
- **idle timeout 90s (WS_IDLE_TIMEOUT_S, hardcoded no env).** REDESIGN per ADR line 52: per-conn tokio::time::Interval reset on each inbound message; fire → close. daemon pings every 30s keep it alive.
- **auth timeout 10s (AUTH_TIMEOUT_MS, TP_RELAY_AUTH_TIMEOUT_MS), close(1008,"Auth timeout")** for sockets that never authenticate. Unauthenticated relay.ping gets NO pong + NO rate check.
- **relay.ping → relay.pong {ts}** only for authed clients (handlePing 1331-1337; role=daemon also refreshes lastSeen).
- **stale check interval 30s (STALE_CHECK_INTERVAL_MS).** stale_timeout_ms default 90s, offline_evict default 1h (TP_RELAY_* envs exist; confirm names: this.staleTimeoutMs / this.offlineEvictAfterMs construction ~).
`

const ARCH = `
## Target Rust architecture (central-state model — deadlock-free)

The ONE non-negotiable async-correctness rule: **never hold the shared state Mutex across an \`.await\`.**
Decide routing synchronously under the lock, producing a list of (ConnId, RelayServerMessage) actions; then
release the lock and deliver each action via that conn's bounded mpsc Sender (try_send). This is the central
pattern; the implementer may choose a cleaner equivalent but MUST preserve the no-lock-across-await property.

### Suggested modules (implementer may refine)
- \`src/server.rs\`: \`RelayServer\` + \`SharedState\` (Arc<Mutex<RelayCore>>). RelayCore owns Registry, RecentFrames,
  daemonGroups: HashMap<String,HashSet<ConnId>>, conns: HashMap<ConnId, ConnHandle>. ConnHandle holds the per-conn
  outbox mpsc::Sender<RelayServerMessage>, the conn's auth state (role, daemon_id, frontend_id, subscriptions:HashSet<sid>),
  per-conn rate Limiter, and a shared per-daemon-group rate Limiter (Arc<Limiter> keyed by daemon_id).
  axum Router with a single GET "/" (or "/ws") WebSocket upgrade route (NO /health|/metrics|/admin — those are Step 6).
  spawn the 30s stale-check interval task that calls check_stale_daemons and broadcasts presence for newly_offline + purges recentFrames for evicted.
- \`src/conn.rs\`: per-connection actor. On upgrade: assign ConnId, register outbox, spawn a write task draining the
  mpsc into ws.send(Message::Text(json)); the read loop parses inbound text, resets the idle Interval, runs the sync
  dispatch (rate-limit → handshake/route under lock → collect actions), then delivers actions. Auth-timeout: a
  tokio::time::timeout / Interval that closes 1008 if not authed in 10s. Backpressure: outbox is bounded (cap ~256-1024);
  on try_send Err(Full) close 1013 and tear down.

### Delivery / backpressure
- Per-conn outbox = \`tokio::sync::mpsc::channel(cap)\`. The sync routing code calls \`sender.try_send(msg)\`.
  - Ok → fine.
  - Err(TrySendError::Full(_)) → mark this conn for backpressure-close (1013). (Slow consumer: its write task can't drain fast enough.)
  - Err(TrySendError::Closed(_)) → conn already gone; drop.
- The write task owns the ws write half; it loops \`while let Some(msg)=rx.recv().await { ws.send(Text(to_string(msg))).await }\`.

### Concurrency primitives
- \`Arc<Mutex<RelayCore>>\` (std::sync::Mutex is fine since critical sections are sync + short; or tokio Mutex if you
  prefer — but then STILL never await inside). ConnId = u64 from an AtomicU64. now_ms = a small helper using
  std::time::SystemTime (NOT chrono). governor's DefaultClock handles rate-limit timing.

### Tests required (in-crate + a tests/ integration file)
- Unit: routing decision functions are pure-ish (given a RelayCore state, dispatching relay.pub yields the right
  (ConnId,msg) action set; relay.kx yields opposite-role-only; ping exemption). Test these WITHOUT a live socket by
  calling the sync routing fn directly.
- Integration (tokio::test, real loopback TcpListener + tokio-tungstenite client):
  daemon auth → frontend auth → kx exchange both directions → pub/sub fan-out (frontend subscribes, daemon pubs, frontend
  receives relay.frame) → resume reject path → rate-limit drop (send >budget, observe RATE_LIMITED + no close) →
  backpressure 1013 (fill a slow consumer) → presence on daemon disconnect. Keep integration tests deterministic and fast.
`

const CRATES = `
## Cargo deps to add to rust/tp-relay/Cargo.toml (confirm versions resolve on Rust 1.96)
- tokio = { version = "1", features = ["rt-multi-thread","macros","net","time","sync"] }
- axum = { version = "0.7" or "0.8", features = ["ws"] }   // CONFIRM which version resolves on 1.96; prefer the latest that builds
- tokio-tungstenite = "0.24"+ (for the integration-test CLIENT only — can be a dev-dependency if the server uses axum's ws)
- futures-util = "0.3" (StreamExt/SinkExt for the ws split)
governor/blake2/base64/rand_core/indexmap/serde/serde_json already present. Do NOT add reqwest/p256/apns (Step 5)
or any /health-/metrics-/admin HTTP surface (Step 6). Keep Step 4 scope tight: WS hot path only.

## Gate (MUST pass before returning success)
Run from rust/ with: export PATH="$(dirname "$(rustup which cargo)"):$PATH"
1. cargo fmt --all -- --check    (clean)
2. cargo clippy --workspace --all-targets   (exit 0; pedantic=warn is fine, same as tp-core; clippy::all=deny must pass)
3. cargo test --workspace        (all pass, including new server/conn unit + integration tests)
Report the exact final counts.
`

// ── Phase 1: implement ────────────────────────────────────────────────────────
phase('Implement')

const implementBrief = `You are implementing ADR-0003 Phase 4 Stage 1 **Step 4** — the tp-relay async WebSocket server hot path — in the repo at ${REPO}. Work directly in the working tree (you are in a git worktree; edit files in place).

${GROUNDED}

${ARCH}

${CRATES}

## Your task
1. Re-open and CONFIRM the cited Rust type signatures (handshake handler params, registry method names, ring/rate APIs) by reading the actual files — the BRIEF pointers may be slightly off; trust the live files. Cite what you confirm.
2. Add the async deps to \`rust/tp-relay/Cargo.toml\` (pick versions that resolve on Rust 1.96 — run \`cargo build -p tp-relay\` to confirm; if axum 0.8 fails, try 0.7).
3. Implement \`src/server.rs\` + \`src/conn.rs\` (or a clean equivalent module split) per the central-state, no-lock-across-await architecture. Wire them into \`src/lib.rs\` (\`pub mod server; pub mod conn;\`).
4. Implement the full hot path: WS upgrade → auth-timeout (1008) → per-conn read loop → idle Interval reset → 2-layer GCRA rate limit (ping-exempt for authed) → handshake (delegate to handshake.rs) → routing (relay.pub fan-out to sid-subscribers-except-sender, relay.kx opposite-role broadcast, relay.sub attach+replay, relay.unsub detach, relay.ping→pong) → bounded-mpsc delivery with try_send-Full → 1013 → presence broadcast (EMPTY sessions per ADR) → 30s stale-check task.
5. Write thorough unit tests (sync routing decisions) + an integration test file \`tests/server_integration.rs\` (tokio::test, loopback). Make them deterministic and fast.
6. Run the full gate (fmt --check, clippy --workspace --all-targets, test --workspace). Iterate until ALL THREE are green. The rustup PATH gotcha: bare cargo is a shim that mis-parses --all; use \`export PATH="$(dirname "$(rustup which cargo)"):$PATH"\` first.

## Hard constraints
- **Never hold the shared Mutex across an .await.** Routing decisions are synchronous; delivery is async via per-conn mpsc.
- Wire format is **plain text JSON** (\`Message::Text(serde_json::to_string(&msg))\`), NOT length-prefixed binary.
- Architecture invariants: relay is ciphertext-only (never decrypt \`ct\`), stateless beyond the ring cache, no client registry leaks beyond frontendId routing.
- presence \`sessions\` is **empty** (\`vec![]\`) per ADR §A1.4 redesign.
- last_seen refreshed ONLY by daemon-role traffic (use registry.daemon_pub for role=daemon pub; handlePing role=daemon).
- Stay in Step-4 scope: NO /health, /metrics, /admin, push/APNs, reqwest, p256. WS hot path only.
- Conventional: code/comments in English. Match the existing crate's doc-comment density (every pub item documented with a TS file:line reference where it mirrors one).

Return a structured report: files created/modified (with line counts), the deps + versions added, the exact final gate output (fmt/clippy/test counts), and a SELF-AUDIT of the no-lock-across-await property (point to each place the lock is acquired and confirm no .await inside the guard scope). Be precise — the next phase will adversarially verify your async correctness.`

const implReport = await agent(implementBrief, {
  label: 'implement:server+conn',
  phase: 'Implement',
  model: 'opus',
  effort: 'high',
})

if (!implReport) {
  log('Implementer returned null (died/skipped). Aborting workflow — manual intervention needed.')
  return { ok: false, reason: 'implementer-null' }
}

log('Implementer finished. Running adversarial async-correctness verification.')

// ── Phase 2: adversarial verification ─────────────────────────────────────────
phase('Verify')

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dimension: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          file_line: { type: 'string', description: 'exact path:line of the defect' },
          claim: { type: 'string', description: 'what is wrong, grounded in the actual code read' },
          ts_divergence: { type: 'string', description: 'how it diverges from the cited relay-server.ts behavior, or "n/a"' },
          fix: { type: 'string', description: 'the concrete fix' },
        },
        required: ['severity', 'file_line', 'claim', 'ts_divergence', 'fix'],
      },
    },
    clean: { type: 'boolean', description: 'true if no real defects found in this dimension' },
  },
  required: ['dimension', 'findings', 'clean'],
}

const verifyDims = [
  {
    key: 'async-safety',
    prompt: `Adversarially audit the Step-4 tp-relay async server for **async-correctness defects**. Read the ACTUAL files in ${REPO}/rust/tp-relay/src/ (server.rs, conn.rs, lib.rs) at live HEAD — cite file:line. Default to finding a real bug; only report \`clean:true\` if you genuinely cannot.
Hunt specifically for:
- **Lock held across .await** (the cardinal sin): any place a MutexGuard / RwLockGuard is alive while an \`.await\` runs in the same scope → deadlock/stall risk. Trace every lock acquisition's guard lifetime.
- **mpsc backpressure correctness:** is the outbox channel BOUNDED? does try_send Full → close 1013? is try_send Closed handled (drop, not panic)? Could a full channel block the routing path instead of closing the slow consumer?
- **Task leaks / no cleanup:** on conn close, are the write task, idle timer, and outbox entry torn down? Is the conn removed from daemonGroups + clients + (frontend) attached-decremented?
- **Idle/auth timer races:** does the idle Interval reset on EVERY inbound message? does the auth-timeout fire-and-close only when still unauthed (no double-close)? select! cancellation-safety.
- **Panics in the hot path:** unwrap/expect on socket I/O, serde, or lock poisoning that could crash a connection task or the whole server.
Report each as a finding with severity, file:line, claim (quote the code), and fix.`,
  },
  {
    key: 'routing-parity',
    prompt: `Adversarially audit the Step-4 tp-relay server's **message routing parity** vs packages/relay/src/relay-server.ts. Read BOTH the Rust (${REPO}/rust/tp-relay/src/server.rs + conn.rs) and the TS reference at live HEAD; cite file:line on both sides. Default to finding a real divergence.
Verify each against the TS:
- **relay.pub fan-out:** to group members whose subscriptions contain sid, EXCEPT sender, NO role filter (relay-server.ts ~1150-1164). forwarded relay.frame carries from + frontendId(only if from=frontend). frame cached ALWAYS; sessions+lastSeen updated ONLY for role=daemon.
- **relay.kx:** opposite-role-only broadcast, except sender, no sid filter, wire {t:relay.kx.frame, ct, from} (~1038-1070).
- **relay.sub:** subscriptions.add + (frontend only) attached++ + replay seq>after to the subscriber (~1190-1209).
- **relay.unsub:** subscriptions.delete + (frontend only) attached-- only if present (~1215-1233).
- **presence:** to frontends in group only, sessions EMPTY per ADR redesign (confirm it's [] not the full set), online/lastSeen correct (~1598-1619), broadcast on daemon auth/disconnect/newly-offline (NOT evicted).
- **ping exemption:** relay.ping skips BOTH rate layers, only for authed; unauthed ping → no pong, no rate check.
- **rate-limit on exceed:** relay.err{RATE_LIMITED} + DROP, no close.
Report each divergence with severity, both file:lines, and fix.`,
  },
  {
    key: 'invariant-security',
    prompt: `Adversarially audit the Step-4 tp-relay server for **architecture-invariant + security defects**. Read ${REPO}/rust/tp-relay/src/ at live HEAD and ${REPO}/.claude/rules/relay-capacity.md + the CLAUDE.md architecture invariants. Cite file:line. Default to finding a real issue.
Check:
- **ciphertext-only:** does the relay EVER decrypt or inspect \`ct\`? It must only route the opaque base64. Any base64-decode of ct that isn't pure passthrough is a violation.
- **proof-sentinel:** is the registry's Option<String> proof sentinel preserved through the server path (no \`""\` collapse)?
- **last_seen daemon-traffic-only:** confirm frontend relay.pub / relay.ping do NOT refresh lastSeen; only role=daemon does (else dead-daemon eviction is defeated).
- **pre-auth CPU:** unauthenticated sockets — are they rate-limited or cheaply closed at auth-timeout? Can an unauthed socket flood the dispatch loop (unauthed ping must be ignored, no pong)?
- **resume token:** is verification constant-time (ct_eq) and version/expiry-checked? any timing leak in the server's use of it?
- **v<2 rejection + VERSION_MISMATCH_COUNT** incremented on the hello/auth path.
- **frame size / oversize:** is there any unbounded buffer growth from a malicious peer (giant Text frame)? Is there a max-frame guard (TP_RELAY_MAX_FRAME_SIZE, 1MB in TS)? If absent, that's a capacity finding.
Report each with severity, file:line, claim, fix.`,
  },
]

const verdicts = await parallel(
  verifyDims.map((d) => () =>
    agent(d.prompt, {
      label: `verify:${d.key}`,
      phase: 'Verify',
      model: 'opus',
      effort: 'high',
      schema: VERDICT_SCHEMA,
    }).then((v) => (v ? { ...v, _key: d.key } : null)),
  ),
)

const allFindings = verdicts
  .filter(Boolean)
  .flatMap((v) => (v.findings || []).map((f) => ({ ...f, dimension: v.dimension || v._key })))

const blockers = allFindings.filter((f) => f.severity === 'blocker' || f.severity === 'major')

log(
  `Verification complete: ${allFindings.length} findings total (${blockers.length} blocker/major). ` +
    verdicts.filter(Boolean).map((v) => `${v._key}:${v.clean ? 'clean' : v.findings.length}`).join(' '),
)

// ── Phase 3: repair (only if blocker/major findings) ──────────────────────────
let repairReport = null
if (blockers.length > 0) {
  phase('Repair')
  const repairBrief = `You are repairing confirmed defects in the Step-4 tp-relay async server (${REPO}/rust/tp-relay/). An adversarial review found the following blocker/major findings. For EACH, re-read the cited file:line to confirm it is real (a verifier can be wrong — if a finding is a false positive, say so with evidence and skip it; KEEP-AS-IS is valid). Then fix the real ones.

FINDINGS (JSON):
${JSON.stringify(blockers, null, 2)}

After fixing, re-run the full gate from rust/ (export PATH="$(dirname "$(rustup which cargo)"):$PATH" first):
1. cargo fmt --all -- --check
2. cargo clippy --workspace --all-targets
3. cargo test --workspace
All three MUST be green. Add a regression test for each fixed defect where feasible. Return: per-finding disposition (fixed / false-positive-with-evidence), files changed, and the final gate output.`

  repairReport = await agent(repairBrief, {
    label: 'repair:defects',
    phase: 'Repair',
    model: 'opus',
    effort: 'high',
  })
}

return {
  ok: true,
  implemented: true,
  findings_total: allFindings.length,
  blockers_major: blockers.length,
  repaired: blockers.length > 0,
  verdict_summary: verdicts.filter(Boolean).map((v) => ({ dim: v._key, clean: v.clean, n: v.findings.length })),
  all_findings: allFindings,
  impl_report: implReport,
  repair_report: repairReport,
}
