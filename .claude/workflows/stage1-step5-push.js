export const meta = {
  name: 'stage1-step5-push',
  description: 'ADR-0003 Stage 1 Step 5 — Rust tp-relay push path (apns_jwt p256, push_seal OsRng, apns reqwest H2 + retry, push orchestrator) with TS-parity adversarial verification',
  phases: [
    { title: 'DepVet', detail: 'resolve p256/reqwest/rustls on MSRV 1.96, confirm cargo build' },
    { title: 'Implement', detail: 'four modules: apns_jwt, push_seal, apns, push' },
    { title: 'Verify', detail: 'adversarially verify each module vs live TS reference (file:line)' },
    { title: 'Gate', detail: 'fmt + clippy + test full workspace' },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// Grounding facts (all reverified at HEAD by the author before this workflow;
// agents MUST re-read the cited files at HEAD and cite file:line — do not trust
// this summary as ground truth, it is a pointer map only).
//
// TS reference modules (the parity source — read these at HEAD):
//   packages/relay/src/apns-jwt.ts   — ApnsJwtSigner: ES256 JWT, DER→P1363, 50min cache
//   packages/relay/src/push-seal.ts  — PushSealer: tpps1.<ver>.<b64(nonce||ct)>, version rotation, OsRng FIX
//   packages/relay/src/apns.ts       — ApnsClient: HTTP/2 POST /3/device/<tok>, dead-token set, NO retry yet
//   packages/relay/src/push.ts       — PushService: ws-priority, dedup, rate-limit, dead_token, leak-free eviction
//
// tp-core already provides byte-exact crypto (golden-tested vs TS in
// rust/tp-core/tests/wire_vectors.rs:38,63):
//   crypto::derive_push_seal_key(secret) = H(secret || "relay-push-seal") BLAKE2b
//   crypto::seal_with_aad(plaintext, key, aad, nonce) -> String  (nonce is EXPLICIT — OsRng fix lands here)
//   crypto::open_with_aad(encoded, key, aad) -> Vec<u8>
//   So Rust PushSealer is a THIN wrapper over tp-core (no new crypto).
//
// Existing Step-1..4 tp-relay crate (read for conventions):
//   rust/tp-relay/src/resume_token.rs — ResumeTokenSigner: the model PushSealer mirrors (env config, ct_eq, golden)
//   rust/tp-relay/src/rate.rs         — governor Limiter style
//   rust/tp-relay/Cargo.toml          — deps already present (axum 0.7, tokio, governor, blake2, base64, rand_core)
//   rust/Cargo.toml [workspace.lints] — clippy::all=deny, pedantic=warn (NO -D warnings in CI)
//   MSRV 1.96, edition 2021.
//
// Redesign-now items (ADR §6.7 + A1.5 Step 5) — NOT plain ports:
//   - p256 native P1363: replace TS's 42-line hand-rolled derToP1363 with p256/ecdsa Signature::to_bytes() (fixed P1363)
//   - OsRng seal: TS push-seal.ts:65-68 used Math.random() for the EPHEMERAL SECRET (not the nonce) — Rust uses
//     OsRng for BOTH the ephemeral fallback secret AND the per-seal 24-byte nonce (tp-core seal nonce is caller-supplied)
//   - reqwest H2 Arc client: one shared reqwest::Client (http2_prior_knowledge or default H2 ALPN), injectable for tests
//   - APNs 429/5xx retry: backoff + jitter + honor Retry-After header (TS apns.ts has NO retry — this is new)
//   - tagged ApnsKey: model the .p8/PEM key as a typed enum (path vs inline PEM) not a raw string sniff
//   - lazy dedup eviction: port push.ts cleanupDedup window-expiry semantics (leak-free) to a Rust interval/manual sweep
//
// rustup PATH gotcha: bare cargo is a shim that mis-parses --workspace. Agents that
// run cargo MUST first: export PATH="$(dirname "$(rustup which cargo)"):$PATH"
// ─────────────────────────────────────────────────────────────────────────────

const REPO = '/Users/dave/Projects/github.com/teleprompter'

const COMMON = `
Repo: ${REPO}. You are implementing ADR-0003 Phase 4 Stage 1 Step 5 — the Rust
\`tp-relay\` crate push path. This is a PARITY port of the TypeScript relay push
modules with specific redesign-now changes.

HARD RULES:
- Read every file you cite at HEAD in the working tree and cite file:line. The
  commit/PR/this-prompt text is a POINTER MAP, not ground truth — reverify.
- Rust edition 2021, MSRV 1.96. Workspace lints: clippy::all=deny, pedantic=warn.
  Your code must pass \`cargo clippy --workspace --all-targets\` with no deny-tier
  errors and ideally no pedantic warnings in NEW files.
- Before running any cargo command:
  export PATH="$(dirname "$(rustup which cargo)"):$PATH"
  then use \`cargo <cmd>\` (bare cargo is a rustup shim that mis-parses --workspace).
- tp-core ALREADY provides byte-exact crypto: crypto::derive_push_seal_key,
  crypto::seal_with_aad(pt,key,aad,nonce), crypto::open_with_aad(enc,key,aad).
  Do NOT reimplement crypto — wrap tp-core. (golden-tested vs TS in
  rust/tp-core/tests/wire_vectors.rs).
- Follow the conventions in rust/tp-relay/src/resume_token.rs (env config, ct_eq,
  ephemeral fallback, self-golden tests) and rate.rs (env helpers).
- No secrets/keys/tokens in code or logs. Log daemonId/frontendId only, never
  device tokens or seal secrets.
`

// ── Phase 1: DepVet ───────────────────────────────────────────────────────────
// One agent resolves the new crate deps on MSRV 1.96 and confirms a clean build
// of a trivial stub. This de-risks the whole step before any real code.
phase('DepVet')
const depVet = await agent(
  `${COMMON}

TASK: Resolve the new Cargo dependencies for Step 5 on MSRV 1.96 and prove they
build, WITHOUT writing any real module logic yet.

Add to rust/tp-relay/Cargo.toml the dependencies needed for:
  - p256 (with ecdsa + the feature that gives signing from a PKCS#8 / SEC1 key)
    and whatever is needed to PARSE an Apple .p8 (PKCS#8 PEM) EC private key.
    Apple .p8 is "-----BEGIN PRIVATE KEY-----" PKCS#8. You likely need:
    p256 = { version, features = ["ecdsa","pkcs8","pem"] } (verify exact feature
    names that compile on 1.96). ES256 = ECDSA P-256 + SHA-256; p256::ecdsa with
    the sha2 backend. Confirm Signature::to_bytes() yields fixed 64-byte P1363.
  - reqwest with HTTP/2 + rustls TLS, JSON. Pick versions that resolve on Rust
    1.96 (reqwest pulls hyper/h2/tokio — mirror the axum-0.7 / MSRV-1.96 caution
    from §6.7: a too-new reqwest/hyper bumps MSRV above 1.96). Use rustls (NOT
    native-tls / openssl). features likely: ["http2","rustls-tls","json"],
    default-features=false. You may need rustls / tokio-rustls pins.
  - getrandom/rand_core OsRng is already available (rand_core feature getrandom in
    Cargo.toml) — confirm OsRng is reachable for nonce + ephemeral secret gen.
  - base64 (already present), serde_json (present) for JWT.

Then:
  1. Add the deps to Cargo.toml with version pins that resolve on 1.96.
  2. Write a TEMPORARY throwaway proof in a new file rust/tp-relay/src/_depvet.rs
     (and \`mod _depvet;\` in lib.rs) that: parses a freshly-generated p256
     SigningKey, signs a message, asserts the ecdsa Signature::to_bytes() length
     is 64, constructs a reqwest::Client with http2 + rustls, and references
     OsRng. Gate it behind #[cfg(test)] as a unit test so it actually runs.
  3. Run: export PATH="$(dirname "$(rustup which cargo)"):$PATH"
     cargo build -p tp-relay 2>&1 | tail -30
     cargo test -p tp-relay _depvet 2>&1 | tail -20
  4. If anything fails to resolve on 1.96, iterate the versions until it builds.
     If a dep is FUNDAMENTALLY incompatible with 1.96, document the exact error
     and the minimal version that DOES work (or whether the MSRV must rise — but
     prefer staying at 1.96).
  5. Leave _depvet.rs and its mod line IN PLACE (the Implement phase will remove
     it). Do NOT remove the Cargo.toml deps.

Return JSON: the exact dep lines you added (verbatim), the resolved versions
(from \`cargo tree -p tp-relay -i p256\` etc.), whether the build+test passed,
the exact p256 API call that yields P1363 (crate::path::Type::method), the exact
reqwest Client builder call for http2+rustls, and the OsRng import path. If you
hit MSRV issues, include the error and resolution.`,
  {
    label: 'depvet:p256+reqwest',
    phase: 'DepVet',
    model: 'sonnet',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['depLines', 'buildPassed', 'p256P1363Call', 'reqwestClientCall', 'osRngImport', 'notes'],
      properties: {
        depLines: { type: 'string', description: 'verbatim Cargo.toml [dependencies] lines added' },
        resolvedVersions: { type: 'string', description: 'resolved versions of p256/reqwest/rustls/h2/hyper' },
        buildPassed: { type: 'boolean' },
        testPassed: { type: 'boolean' },
        p256P1363Call: { type: 'string', description: 'exact API path producing 64-byte P1363 signature' },
        reqwestClientCall: { type: 'string', description: 'exact reqwest::Client builder for http2+rustls' },
        osRngImport: { type: 'string', description: 'import path for OsRng' },
        msrvIssue: { type: 'string', description: 'any MSRV-1.96 incompatibility and its resolution, or empty' },
        notes: { type: 'string' },
      },
    },
  },
)

if (!depVet || !depVet.buildPassed) {
  log(`DepVet did NOT achieve a clean build — halting before Implement. notes: ${depVet?.notes ?? 'agent returned null'}`)
  return {
    halted: 'depvet-failed',
    depVet,
  }
}
log(`DepVet OK — p256 P1363: ${depVet.p256P1363Call}; reqwest: ${depVet.reqwestClientCall}`)

// ── Phase 2: Implement ────────────────────────────────────────────────────────
// Dependency order: apns_jwt and push_seal are independent (parallel); apns
// depends on apns_jwt's signer type; push depends on apns's client type. We use
// a pipeline so independent modules proceed without a barrier, but we sequence
// the dependent ones by having later agents read the earlier module at HEAD
// (they run after, since pipeline stages are ordered per-item — here we model it
// as: stage 1 = the two leaf modules in parallel, stage 2 = apns, stage 3 = push).
//
// Simpler + correct: do leaf modules as a parallel barrier (we need BOTH the
// jwt signer type and the seal module to exist before apns/push reference the
// crate), then apns, then push — each reading prior modules at HEAD.

phase('Implement')

const depContext = `
DepVet resolved the crate deps (already in Cargo.toml). Use these exact APIs:
  - p256 P1363 signing: ${depVet.p256P1363Call}
  - reqwest client: ${depVet.reqwestClientCall}
  - OsRng: ${depVet.osRngImport}
There is a throwaway rust/tp-relay/src/_depvet.rs + \`mod _depvet;\` in lib.rs.
The FIRST module agent to touch lib.rs should REMOVE the \`mod _depvet;\` line and
delete src/_depvet.rs (it was only a build probe). Coordinate: if it's already
gone, fine.
`

// Stage A — the two leaf modules, in parallel.
const leaves = await parallel([
  () => agent(
    `${COMMON}${depContext}

MODULE 1 of 4: apns_jwt.rs — ES256 JWT signer (p256 native P1363).

PARITY SOURCE: packages/relay/src/apns-jwt.ts (read at HEAD, cite file:line).
Replicate:
  - TOKEN_VALID_MS=60min, TOKEN_REFRESH_AFTER_MS=50min cache semantics.
  - JWT header {alg:"ES256", kid:keyId}, claims {iss:teamId, iat:unix_seconds}.
    base64url(header) + "." + base64url(claims) is the signing input; the token
    is signingInput + "." + base64url(P1363 signature).
  - getToken() caches the signed token for ~50min and re-signs near expiry.

REDESIGN-NOW (do NOT port the TS hand-rolled derToP1363):
  - Use p256/ecdsa to sign and emit P1363 DIRECTLY via ${depVet.p256P1363Call}.
    No DER parsing. Document with a comment that TS apns-jwt.ts:137-179 (derToP1363)
    is intentionally NOT ported because p256 yields P1363 natively.
  - tagged ApnsKey: model the key input as an enum, e.g.
      pub enum ApnsKey { Pem(String), Path(PathBuf) }  // .p8 PKCS#8 PEM
    Parse a PKCS#8 PEM EC P-256 private key into a p256 SigningKey. (Apple .p8 is
    "-----BEGIN PRIVATE KEY-----" PKCS#8.) Resolve Path by reading the file.
  - Time: this is sync pure logic except key load. Inject \`now_ms: u64\` (do NOT
    call a forbidden clock inside pure fns) OR take a now closure — match how
    resume_token.rs / the crate handles time. Look at how the crate already
    obtains time for tokens and mirror it; tokens need a real clock at the WS
    layer but the signer's CACHE math should be testable with an injected now.

Tests (self-contained, no network): generate a throwaway P-256 key, build the
signer, call get_token, split on '.', base64url-decode header+claims and assert
alg/kid/iss/iat shape, assert the signature decodes to 64 bytes, assert the
cache returns the SAME token before refresh window and a NEW token after.

Write rust/tp-relay/src/apns_jwt.rs and add \`pub mod apns_jwt;\` to lib.rs.
Run the rustup-PATH cargo fmt + clippy + test for this module. Return JSON:
the public types/fns you exposed (signatures), how you inject time, the p256
parse+sign path, file:line citations to the TS behaviors you matched, and test
pass/fail.`,
    {
      label: 'impl:apns_jwt',
      phase: 'Implement',
      model: 'sonnet',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['publicApi', 'timeInjection', 'testsPassed', 'tsCitations', 'notes'],
        properties: {
          publicApi: { type: 'string', description: 'pub types + fn signatures exposed by apns_jwt' },
          timeInjection: { type: 'string', description: 'how now_ms / clock is injected' },
          p256Path: { type: 'string', description: 'parse + sign + P1363 call path' },
          testsPassed: { type: 'boolean' },
          tsCitations: { type: 'string', description: 'file:line of TS behaviors matched' },
          notes: { type: 'string' },
        },
      },
    },
  ),
  () => agent(
    `${COMMON}${depContext}

MODULE 2 of 4: push_seal.rs — PushSealer (thin wrapper over tp-core crypto).

PARITY SOURCE: packages/relay/src/push-seal.ts (read at HEAD, cite file:line).
Replicate EXACTLY (this seals device tokens — wire-format parity matters):
  - Blob format: "tpps1." + <version:decimal> + "." + base64(nonce24 || aead_ct).
  - BLOB_PREFIX="tpps1.", SECRET_MIN_CHARS=32.
  - AAD = UTF-8 bytes of the prefix string "tpps1.<version>" (binds format+key version).
  - version: positive integer, default 1; from TP_RELAY_PUSH_SEAL_VERSION env or
    options. version>0 guard (version 0 must NOT select currentSecret).
  - current secret from TP_RELAY_PUSH_SEAL_SECRET (>=32 chars) else EPHEMERAL.
  - prev secret from TP_RELAY_PUSH_SEAL_SECRET_PREV (>=32 chars) else None.
  - getKey(version): version==current → current secret; version==current-1 && prev
    → prev secret; else None. Cache derived keys by version.
  - unseal reasons: "legacy" (no tpps1. prefix), "parse_error" (malformed tpps1.),
    "unseal_failed" (AEAD fail / rotated-out version / unknown version).
    Match the EXACT parse: slice after "tpps1.", find first '.', versionStr must
    round-trip parseInt (String(version)===versionStr → reject leading zeros etc).

USE tp-core (do NOT reimplement crypto):
  - key = tp_core::crypto::derive_push_seal_key(secret_bytes)
  - seal: tp_core::crypto::seal_with_aad(plaintext, &key, aad, &nonce)
  - open: tp_core::crypto::open_with_aad(encoded_b64, &key, aad)
  Confirm the tp-core seal/open base64 + nonce||ct layout MATCHES the TS
  sealWithAad/openWithAad layout (read packages/protocol/src/crypto.ts:268-300
  and rust/tp-core/src/crypto.rs:158-178). The TS blob is base64(nonce24||ct);
  tp-core seal_with_aad must produce the same — VERIFY and cite, do not assume.

REDESIGN-NOW (OsRng fix):
  - TS push-seal.ts:65-68 generated the EPHEMERAL fallback secret with
    Math.floor(Math.random()*16) — a weak RNG bug. In Rust, generate BOTH the
    ephemeral fallback secret AND the per-seal 24-byte nonce via OsRng
    (${depVet.osRngImport}). Comment-cite the TS bug line.

Result type: enum UnsealResult { Ok(String), Legacy, UnsealFailed, ParseError }
or a struct mirroring the TS tagged union — your call, but expose the 4 outcomes.

Tests: round-trip seal→unseal; ephemeral self-consistency; version rotation
(current key seals, prev key unseals version-1, version-2 → unseal_failed);
legacy (no prefix) → Legacy; tamper/truncate → unseal_failed; malformed version
(leading zero, non-numeric) → parse_error. Cross-check ONE vector against the TS
test expectations in packages/relay/src/push-seal.test.ts if a fixed-secret
vector exists there (cite it).

Write rust/tp-relay/src/push_seal.rs + \`pub mod push_seal;\` in lib.rs. Run the
rustup-PATH fmt+clippy+test. Return JSON: the public API, the verified statement
that tp-core seal layout == TS layout (with file:line both sides), the 4 unseal
outcomes, test pass/fail, TS citations.`,
    {
      label: 'impl:push_seal',
      phase: 'Implement',
      model: 'sonnet',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['publicApi', 'layoutParityVerified', 'unsealOutcomes', 'testsPassed', 'tsCitations', 'notes'],
        properties: {
          publicApi: { type: 'string' },
          layoutParityVerified: { type: 'string', description: 'proof that tp-core seal layout == TS layout, file:line both sides' },
          unsealOutcomes: { type: 'string', description: 'the 4 unseal result variants' },
          testsPassed: { type: 'boolean' },
          tsCitations: { type: 'string' },
          notes: { type: 'string' },
        },
      },
    },
  ),
])

const leafFail = leaves.filter((r) => !r || !r.testsPassed)
if (leafFail.length) {
  log(`Leaf module(s) failed tests — continuing to dependent modules anyway so the Verify phase surfaces everything, but flagging.`)
}

// Stage B — apns.rs (depends on apns_jwt signer type).
const apnsImpl = await agent(
  `${COMMON}${depContext}

MODULE 3 of 4: apns.rs — APNs HTTP/2 delivery client (reqwest H2 + retry).

PARITY SOURCE: packages/relay/src/apns.ts (read at HEAD, cite file:line).
The apns_jwt module is now implemented (rust/tp-relay/src/apns_jwt.rs — READ it
at HEAD to use its real signer type). Replicate:
  - APNS_DEAD_TOKEN_REASONS = {"Unregistered","BadDeviceToken"}.
  - ApnsDeliveryResult: Ok | Err{dead_token:bool, reason:String}.
  - send(payload): POST https://<host>/3/device/<deviceToken>
    headers: authorization "bearer <jwt>", apns-topic <bundleId>,
             apns-push-type "alert", content-type application/json,
             apns-priority "10" ONLY when interruptionLevel=="time-sensitive".
    body: { aps: { alert:{title,body}, sound:"default",
                   ["interruption-level": level if present] }, ...data }.
  - response.ok → Ok. Non-200 → parse JSON {reason} (fallback "HTTP <status>"),
    dead = reasons.contains(reason).
  - resolveApnsHost(env): "sandbox" → api.sandbox.push.apple.com else api.push.apple.com.

REDESIGN-NOW (new — TS apns.ts has NO retry):
  - reqwest H2 client: ONE shared client (Arc), built with http2 + rustls
    (${depVet.reqwestClientCall}). Injectable for tests — accept a trait object
    or an injected client/transport so tests need no network. Mirror how the TS
    injects fetchFn (apns.ts:67-68) but in idiomatic Rust (a Transport trait with
    a real reqwest impl + a fake in tests).
  - APNs 429 / 5xx retry: bounded retries with exponential backoff + jitter,
    honoring the Retry-After header when present (seconds or HTTP-date — handle
    the seconds form at minimum; document if you skip HTTP-date). 4xx OTHER than
    429 (incl. dead-token 400/410) must NOT be retried. A successful retry → Ok.
    Exhausted retries → Err{dead_token:false, reason}. Make max-retries + base
    backoff configurable with sane defaults; make jitter deterministic-in-test
    (inject the sleeper/clock or a no-op sleeper so tests are fast + stable).

Time/sleep injection: do NOT call a real sleep in unit tests. Abstract the
backoff sleep behind an injected async sleeper (default tokio::time::sleep, test
no-op). Same for any clock the JWT signer needs at this layer.

Tests (no network, fake transport): success → Ok; 410 Unregistered → dead_token
true no-retry; 400 BadDeviceToken → dead_token true no-retry; 429 then 200 →
retried→Ok with backoff invoked N times; persistent 503 → exhausts retries →
Err; time-sensitive sets apns-priority 10; non-time-sensitive omits it; verify
the request URL/headers/body shape via the fake transport capturing the request.

Write rust/tp-relay/src/apns.rs + \`pub mod apns;\` in lib.rs. fmt+clippy+test via
rustup PATH. Return JSON: public API (ApnsClient/transport trait/result),
the retry policy (max, backoff, what's retried), the injection seam, test
pass/fail, TS citations.`,
  {
    label: 'impl:apns',
    phase: 'Implement',
    model: 'sonnet',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['publicApi', 'retryPolicy', 'injectionSeam', 'testsPassed', 'tsCitations', 'notes'],
      properties: {
        publicApi: { type: 'string' },
        retryPolicy: { type: 'string', description: 'max retries, backoff, what is/ is not retried, Retry-After handling' },
        injectionSeam: { type: 'string', description: 'transport + sleeper/clock injection for tests' },
        testsPassed: { type: 'boolean' },
        tsCitations: { type: 'string' },
        notes: { type: 'string' },
      },
    },
  },
)

// Stage C — push.rs (depends on apns client type).
const pushImpl = await agent(
  `${COMMON}${depContext}

MODULE 4 of 4: push.rs — PushService orchestrator (ws-priority, dedup, rate-limit).

PARITY SOURCE: packages/relay/src/push.ts (read at HEAD, cite file:line).
The apns module is now implemented (rust/tp-relay/src/apns.rs — READ it at HEAD
to use its real ApnsClient/result types). Replicate EXACTLY:
  - Defaults: RATE_LIMIT_PER_MINUTE=5, DEDUP_WINDOW_MS=60_000,
    DEDUP_CLEANUP_INTERVAL_MS=30_000, RATE_LIMIT_WINDOW_MS=60_000.
  - DeliveryResult enum: Ws | Push | RateLimited | Deduped | Error | DeadToken.
  - sendOrDeliver(req) ORDER (this exact precedence — port push.ts:105-205):
      1. isFrontendConnected → Ws (skip push).
      2. dedup check (do NOT record yet): key = "<frontendId>:<sid>:<event>";
         if seen within dedupWindow → Deduped.
      3. rate-limit check (do NOT increment yet): key = "<daemonId>:<frontendId>";
         M14 fix — if existing window expired, RESET it (count=0, windowStart=now)
         BEFORE the check; if count>=limit → RateLimited.
      4. if no apns client → Error.
      5. apns.send(...). !ok && deadToken → DeadToken; !ok → Error.
      6. ONLY on success: record dedup ts + increment/create rate entry. → Push.
      catch/err → Error.
  - cleanup (port push.ts:222-234 leak-free eviction): dedup entries past window
    deleted; rate-limit entries deleted on WINDOW EXPIRY regardless of count (the
    leak fix — NOT count==0). Expose a manual run_cleanup + an entry-count getter
    for leak tests.
  - Background cleanup interval (30s) — in Rust, spawn a tokio interval task that
    the service owns, with a dispose/Drop that cancels it; OR expose run_cleanup
    and let the WS layer schedule it. Prefer an owned task with a shutdown handle.
    Time MUST be injectable for the dedup/rate-limit math (inject now_ms or a
    clock) so tests are deterministic — do NOT call a forbidden clock in pure fns.

Tests (deterministic clock, fake apns client): ws-priority returns Ws without
calling apns; dedup within window → Deduped, only after a SUCCESSFUL push;
rate-limit at the 6th in a window → RateLimited; expired window resets; dead
token from apns → DeadToken; apns error → Error; LEAK test — a frontend that
hits the limit then goes silent has its rate entry evicted on window-expiry
cleanup (rate_limit_entry_count drops to 0).

Write rust/tp-relay/src/push.rs + \`pub mod push;\` in lib.rs. fmt+clippy+test via
rustup PATH. Return JSON: public API, the exact sendOrDeliver precedence you
implemented, how time is injected, the eviction/leak semantics, test pass/fail,
TS citations.`,
  {
    label: 'impl:push',
    phase: 'Implement',
    model: 'sonnet',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['publicApi', 'precedence', 'timeInjection', 'evictionSemantics', 'testsPassed', 'tsCitations', 'notes'],
      properties: {
        publicApi: { type: 'string' },
        precedence: { type: 'string', description: 'the sendOrDeliver step order implemented' },
        timeInjection: { type: 'string' },
        evictionSemantics: { type: 'string', description: 'leak-free window-expiry eviction' },
        testsPassed: { type: 'boolean' },
        tsCitations: { type: 'string' },
        notes: { type: 'string' },
      },
    },
  },
)

// Cleanup the depvet probe if any agent left it behind.
phase('Implement')
await agent(
  `${COMMON}

CLEANUP TASK: ensure the throwaway dep-probe is GONE.
  - Delete rust/tp-relay/src/_depvet.rs if it still exists.
  - Remove any \`mod _depvet;\` / \`pub mod _depvet;\` line from rust/tp-relay/src/lib.rs.
  - Confirm lib.rs now declares: apns_jwt, push_seal, apns, push (plus the
    pre-existing modules). Do not remove pre-existing modules.
  - Run: export PATH="$(dirname "$(rustup which cargo)"):$PATH"; cargo build -p tp-relay 2>&1 | tail -15
Return JSON {depvetRemoved: bool, libModules: "the pub mod lines in lib.rs", buildOk: bool}.`,
  {
    label: 'impl:cleanup-depvet',
    phase: 'Implement',
    model: 'sonnet',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['depvetRemoved', 'libModules', 'buildOk'],
      properties: {
        depvetRemoved: { type: 'boolean' },
        libModules: { type: 'string' },
        buildOk: { type: 'boolean' },
      },
    },
  },
)

// ── Phase 3: Verify ───────────────────────────────────────────────────────────
// One adversarial verifier per module, each prompted to REFUTE parity by reading
// BOTH the Rust impl and the TS source at HEAD. Default verdict = parity broken
// unless proven. KEEP-AS-IS is a valid verdict.
phase('Verify')

const VERIFY_MODULES = [
  { key: 'apns_jwt', rust: 'rust/tp-relay/src/apns_jwt.rs', ts: 'packages/relay/src/apns-jwt.ts',
    focus: 'JWT header/claims base64url shape; iat seconds; P1363 64-byte signature; 50min cache + re-sign; tagged ApnsKey PKCS#8 parse; that derToP1363 is correctly NOT needed (p256 native P1363).' },
  { key: 'push_seal', rust: 'rust/tp-relay/src/push_seal.rs', ts: 'packages/relay/src/push-seal.ts',
    focus: 'blob format tpps1.<ver>.<b64(nonce||ct)> EXACT; AAD="tpps1.<ver>"; version>0 guard; current/prev key selection; the 4 unseal outcomes incl. parse_error round-trip (String(version)===versionStr); legacy passthrough; OsRng for ephemeral secret AND nonce; tp-core seal layout == TS layout.' },
  { key: 'apns', rust: 'rust/tp-relay/src/apns.rs', ts: 'packages/relay/src/apns.ts',
    focus: 'URL /3/device/<tok>; exact headers incl. apns-priority only when time-sensitive; aps body shape; dead-token set {Unregistered,BadDeviceToken}; resolveApnsHost; reqwest H2+rustls shared client; NEW retry: 429/5xx retried w/ backoff+jitter+Retry-After, 400/410 NOT retried, exhaustion→Err; transport+sleeper injection real.' },
  { key: 'push', rust: 'rust/tp-relay/src/push.rs', ts: 'packages/relay/src/push.ts',
    focus: 'sendOrDeliver precedence (ws>dedup>ratelimit>apns); record-only-on-success for BOTH dedup + rate; M14 expired-window reset BEFORE check; DeliveryResult variants; leak-free window-expiry eviction (NOT count==0); defaults 5/60000/30000/60000; deterministic time injection.' },
]

const verdicts = await parallel(
  VERIFY_MODULES.map((m) => () => agent(
    `${COMMON}

ADVERSARIAL VERIFY — module "${m.key}". Your DEFAULT verdict is parityBroken=true.
Only flip to false if you can PROVE byte/behavior parity by reading BOTH files at
HEAD and citing file:line on each side.

Rust impl:   ${m.rust}
TS parity:   ${m.ts}
Focus areas: ${m.focus}

Method:
  1. Read the TS source at HEAD fully. Enumerate every observable behavior +
     constant + wire-format detail + edge case (cite TS file:line).
  2. Read the Rust impl at HEAD. For EACH TS behavior, find the Rust line that
     implements it (cite Rust file:line) OR record it as MISSING/DIVERGENT.
  3. Pay special attention to: off-by-one, wrong constant, reversed condition,
     a redesign-now item done WRONG (p256 P1363 length, OsRng actually used,
     retry actually skips 400/410, eviction on window-expiry not count==0),
     and any place the Rust "passes its own tests" but the tests assert the
     WRONG thing vs TS.
  4. Run the module's tests yourself to confirm they pass and that they assert
     the right invariants:
       export PATH="$(dirname "$(rustup which cargo)"):$PATH"
       cargo test -p tp-relay ${m.key} 2>&1 | tail -25
  5. For crypto/wire modules (push_seal), independently CONFIRM the tp-core seal
     layout equals the TS layout by reading both crypto sources — do not trust
     the impl agent's claim.

Return JSON: parityBroken (bool), a list of concrete divergences each with
{severity: blocker|major|minor, tsRef, rustRef, description, fix}, whether the
tests pass and whether they assert the correct invariants, and an overall verdict
string. An empty divergences list with parityBroken=false means full parity.`,
    {
      label: `verify:${m.key}`,
      phase: 'Verify',
      model: 'sonnet',
      effort: 'high',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['module', 'parityBroken', 'divergences', 'testsPass', 'testsAssertCorrectly', 'verdict'],
        properties: {
          module: { type: 'string' },
          parityBroken: { type: 'boolean' },
          divergences: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['severity', 'description', 'fix'],
              properties: {
                severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
                tsRef: { type: 'string' },
                rustRef: { type: 'string' },
                description: { type: 'string' },
                fix: { type: 'string' },
              },
            },
          },
          testsPass: { type: 'boolean' },
          testsAssertCorrectly: { type: 'boolean' },
          verdict: { type: 'string' },
        },
      },
    },
  ).then((v) => ({ ...(v ?? { module: m.key, parityBroken: true, divergences: [], verdict: 'verifier died' }), _key: m.key })),
  ),
)

// Collect actionable findings (blocker/major; minors logged but not auto-repaired
// unless trivial — the repair agent decides).
const allFindings = verdicts
  .filter(Boolean)
  .flatMap((v) => (v.divergences || []).map((d) => ({ ...d, module: v._key })))
const blockers = allFindings.filter((d) => d.severity === 'blocker' || d.severity === 'major')

log(`Verify done. ${verdicts.filter((v) => v && !v.parityBroken).length}/4 modules clean. ` +
    `${blockers.length} blocker/major divergence(s), ${allFindings.length - blockers.length} minor.`)

// ── Repair (only if blockers/majors found) ────────────────────────────────────
let repair = null
if (blockers.length) {
  phase('Verify')
  repair = await agent(
    `${COMMON}

REPAIR TASK. The adversarial verifiers found ${blockers.length} blocker/major
parity divergence(s) in the Step 5 push modules. Fix EACH one. For every fix,
re-read the TS parity source at HEAD to confirm the correct behavior (cite
file:line), apply the minimal correct Rust change, and re-run that module's
tests. Do NOT introduce new behavior beyond restoring parity + the documented
redesign-now items.

Findings to fix (JSON):
${JSON.stringify(blockers, null, 2)}

After fixing, run the FULL crate gate:
  export PATH="$(dirname "$(rustup which cargo)"):$PATH"
  cargo fmt --all
  cargo clippy --workspace --all-targets 2>&1 | tail -20
  cargo test -p tp-relay 2>&1 | grep -E "test result|error" | tail -20

Return JSON: for each finding {module, whatYouChanged, rustRef, tsRef, fixed:bool},
plus gateFmtOk, gateClippyClean (no deny-tier errors), gateTestsPass, and any
finding you DECLINED to fix with the reason (a finding can be a false positive —
if so, prove it with file:line and mark fixed:false + reason).`,
    {
      label: 'verify:repair',
      phase: 'Verify',
      model: 'sonnet',
      effort: 'high',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['fixes', 'gateFmtOk', 'gateClippyClean', 'gateTestsPass'],
        properties: {
          fixes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['module', 'whatYouChanged', 'fixed'],
              properties: {
                module: { type: 'string' },
                whatYouChanged: { type: 'string' },
                rustRef: { type: 'string' },
                tsRef: { type: 'string' },
                fixed: { type: 'boolean' },
                declineReason: { type: 'string' },
              },
            },
          },
          gateFmtOk: { type: 'boolean' },
          gateClippyClean: { type: 'boolean' },
          gateTestsPass: { type: 'boolean' },
        },
      },
    },
  )
}

// ── Phase 4: Gate ─────────────────────────────────────────────────────────────
// Final independent full-workspace gate (a fresh agent, not trusting prior runs).
phase('Gate')
const gate = await agent(
  `${COMMON}

FINAL GATE. Run the full workspace gate exactly as CI's rust job does and report
verbatim tails. Do NOT fix anything — only report (the orchestrator decides next).
  export PATH="$(dirname "$(rustup which cargo)"):$PATH"
  cargo fmt --all -- --check 2>&1 | tail -5 ; echo "FMT_EXIT=$?"
  cargo clippy --workspace --all-targets 2>&1 | grep -E "^error|error\\[|error:" | tail -20 ; echo "CLIPPY_ERR_COUNT above"
  cargo test --workspace 2>&1 | grep -E "test result:|error\\[|FAILED" | tail -40

Also confirm rust/tp-relay/src/lib.rs declares apns_jwt, push_seal, apns, push and
NO _depvet. Return JSON: fmtClean (bool), clippyDenyErrors (int — count of
deny-tier errors, should be 0), testsAllPass (bool), libDeclaresFourModules (bool),
depvetGone (bool), and a verbatim short summary of the test result lines.`,
  {
    label: 'gate:full-workspace',
    phase: 'Gate',
    model: 'sonnet',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['fmtClean', 'clippyDenyErrors', 'testsAllPass', 'libDeclaresFourModules', 'depvetGone', 'summary'],
      properties: {
        fmtClean: { type: 'boolean' },
        clippyDenyErrors: { type: 'integer' },
        testsAllPass: { type: 'boolean' },
        libDeclaresFourModules: { type: 'boolean' },
        depvetGone: { type: 'boolean' },
        summary: { type: 'string' },
      },
    },
  },
)

return {
  depVet,
  leaves,
  apnsImpl,
  pushImpl,
  verdicts: verdicts.map((v) => v && { module: v._key, parityBroken: v.parityBroken, divergences: v.divergences, testsPass: v.testsPass }),
  blockerCount: blockers.length,
  repair,
  gate,
}
