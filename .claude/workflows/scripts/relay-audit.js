export const meta = {
  name: 'relay-audit',
  description: 'Fact-grounded hardening audit of packages/relay (zero-trust ciphertext forwarder, 10k-concurrent bar): file-sharded finders → adversarial refute-verify → opus synthesis',
  phases: [
    { title: 'Find', detail: 'one finder per cohesive relay file cluster, reads live HEAD' },
    { title: 'Verify', detail: 'each finding judged by 3 refute-skeptics (distinct lenses)' },
    { title: 'Synthesize', detail: 'opus ranks survivors + flags autonomous-safe vs decision-gated' },
  ],
}

// ── Shared context: architecture invariants + KNOWN-GOOD (do NOT re-report) ──
const CTX = `
You are auditing \`packages/relay\` in the teleprompter monorepo at LIVE HEAD.
The relay is a STATELESS, ZERO-TRUST ciphertext forwarder (Bun WebSocket server).
It NEVER decrypts data — it routes E2EE frames by frontendId and caches the last
N frames per session for replay. Capacity bar: ~10k concurrent connections
(daemon + app combined) on ONE node. Latent leaks/races/DoS here have the
HIGHEST blast radius in the whole system.

ARCHITECTURE INVARIANTS (violating code is WRONG, but these are NOT findings —
they are the design contract you verify the code UPHOLDS):
- Relay forwards ciphertext only; it cannot and must not see plaintext.
- Relay is stateless beyond: per-sid recentFrames cache (default 10),
  per-daemon DaemonState (sessions Set capped at MAX_SESSIONS_PER_DAEMON=256),
  pendingAuth sockets, and ephemeral resume/push-seal HMAC keys.
- Daemon is the relay's ONLY registering client (proof-based relay.register);
  frontends auth with token + frontendId. N:N routing.
- Two-layer rate limit: per-client (500/s) + per-daemon-group (5000/s).
- Slow consumer → disconnect (close 1013), NEVER silent frame drop (a drop
  creates a sequence gap that breaks a protocol invariant). Frontend replays
  via relay.sub after=... on reconnect.
- Idle close (90s) only when zero traffic — daemon ping (30s) keeps alive.
- /health + /metrics are the capacity-monitoring SoT (/metrics = EXACTLY 17
  Prometheus lines). /admin is bearer-gated (404 when TP_RELAY_ADMIN_TOKEN
  unset, 401 on mismatch, constant-time compare, HTML-escape ids).

KNOWN-GOOD — these are DELIBERATE and ALREADY-CORRECT. Do NOT report them:
- lastSeen refresh is daemon-self-traffic-only (handlePing/handlePublish both
  role=daemon gated) so a frontend publishing to a dead daemon can't reset the
  offline-eviction clock. INTENTIONAL.
- registrations proof sentinel is null (not "") so an empty proof="" can't
  bypass the different-credentials guard. INTENTIONAL.
- Pre-auth sockets: relay.ping is rate-limit-exempt ONLY for authenticated
  clients; an unauthenticated socket's ping is ignored (no pong) — CPU-amplifier
  guard within the auth-timeout window. INTENTIONAL.
- MAX_SESSIONS_PER_DAEMON=256 cap drops oldest sid (insertion-order); routing
  uses recentFrames/live subscription so the drop is harmless. INTENTIONAL.
- resumeSecret / pushSealSecret default to random/ephemeral per-process — a
  restart forcing full re-auth / sealed-token invalidation is the DOCUMENTED
  fallback, not a bug. Production sets fixed values. INTENTIONAL.
- Push seal key rotation is one-step-only (version & version-1 window);
  skipping a version orphaning tokens is documented operator error, not a code
  bug. INTENTIONAL.
- WS-path push is a no-op in the Rust port; the TS relay's push pipeline is the
  reference. APNs JWT auto-refreshes every 50 min. INTENTIONAL.

WHAT COUNTS AS A FINDING (report ONLY these):
- A resource leak under churn: fd / socket / timer / Map/Set entry that grows
  unbounded or isn't cleaned on a teardown/error path (the 10k bar makes ANY
  per-connection leak fatal at scale).
- A race: a dispose/close/auth/rotation that interleaves with another handler
  and leaves inconsistent state (phantom socket, double-free, stale routing,
  lost frame on a path that should NOT drop).
- A DoS amplifier: unbounded work/memory an unauthenticated or single
  authenticated peer can trigger (pre-auth CPU, memory blowup, the rate-limit
  layers being bypassable).
- A zero-trust / crypto correctness bug: a place plaintext could leak, a
  timing side-channel in a security comparison, an HMAC/AEAD misuse, nonce
  reuse, a tampered-frame path that isn't rejected, a routing bug that
  mis-delivers a frame to the wrong frontend.
- A counter/metric that is wrong in a way that misleads capacity tuning
  (e.g. a drop that isn't counted, /metrics line count drift).
- A correctness bug in resume-token / push-seal HMAC verification, expiry, or
  version handling that lets a forged/expired token through.

RULES OF EVIDENCE:
- HEAD working-tree files are the ONLY ground truth. Do NOT trust commit
  messages, PR bodies, comments, or prior-session claims. Read the actual file.
- Cite every finding as file:line at HEAD. No file:line → not a finding.
- KEEP-AS-IS is a valid conclusion. Do not invent a change to look busy.
- If a behavior matches a KNOWN-GOOD item above, it is NOT a finding.
`

const CLUSTERS = [
  {
    key: 'server-auth-register',
    label: 'relay-server: auth/register/resume + connection lifecycle',
    files: [
      'packages/relay/src/relay-server.ts',
      'packages/relay/src/resume-token.ts',
    ],
    focus: `Focus on the connection lifecycle in relay-server.ts: relay.register
(daemon proof verification), relay.auth + relay.auth.resume (frontend token),
the pendingAuth Set + auth-timeout, socket open/close/drain handlers, the
different-credentials guard, and resume-token.ts (HMAC mint/verify, expiry,
constant-time compare). Look for: a socket that auths-then-disposes leaving a
phantom registration; a pendingAuth entry not cleared on close; a resume token
accepted past TTL or with a tampered HMAC; a timing side-channel in token/proof
compare; a registration that can be hijacked by a racing different-credentials
connect.`,
  },
  {
    key: 'server-routing-presence',
    label: 'relay-server: pub/frame routing, presence, kx, subscription',
    files: ['packages/relay/src/relay-server.ts'],
    focus: `Focus on the DATA PLANE in relay-server.ts: relay.pub / relay.frame
routing by frontendId, relay.sub / unsubscribe, relay.kx / kx.frame forwarding,
relay.presence broadcast, the per-sid recentFrames cache + replay (relay.sub
after=...), the DaemonState.sessions Set cap, and offline daemon eviction. Look
for: a frame mis-routed to the wrong frontend; a recentFrames cache that grows
unbounded or leaks per dead sid; a presence broadcast that serializes an
ever-growing Set; a subscription Map entry not cleaned on disconnect; a frame
DROPPED on a path that the slow-consumer invariant says must close-not-drop; a
sid that resurrects a dead DaemonState/recentFrames.`,
  },
  {
    key: 'server-ratelimit-backpressure-http',
    label: 'relay-server: rate-limit, backpressure, /health /metrics /admin',
    files: ['packages/relay/src/relay-server.ts'],
    focus: `Focus on the DEFENSE + OBSERVABILITY layers in relay-server.ts: the
two-layer rate limiter (per-client sliding window + per-daemon-group budget),
maxFrameSize oversize-close, backpressure (ws.bufferedAmount threshold →
disconnect 1013), idle timeout, and the HTTP endpoints /health, /metrics
(EXACTLY 17 lines), /admin (bearer gate, constant-time, HTML-escape). Look for:
a rate-limit layer that is bypassable or whose window leaks unbounded
timestamps; a counter that under/over-counts a drop and misleads tuning;
/metrics line-count drift; an /admin path that serves without the bearer in
some branch, a non-constant-time admin compare, or an un-escaped id (stored
XSS); a backpressure check that disconnects a well-behaved consumer or fails to
disconnect a stuck one.`,
  },
  {
    key: 'push-pipeline',
    label: 'push pipeline: push.ts dedup/rate-limit + push-seal AEAD',
    files: [
      'packages/relay/src/push.ts',
      'packages/relay/src/push-seal.ts',
    ],
    focus: `Focus on push.ts (Expo/APNs push dispatch: dedup, rate limiting,
commit-on-success ordering, dead-token eviction signalling) and push-seal.ts
(PushSealer: HMAC/AEAD seal/unseal of APNs device tokens, key rotation
version/prev, tamper/truncation rejection). Look for: a dedup or rate-limit Map
that grows unbounded (no eviction/TTL); a commit-before-success ordering that
double-sends or drops on transient failure; a seal/unseal that accepts a
tampered or truncated blob, reuses a nonce, mishandles the prev-key rotation
window, or leaks a plaintext token; a timing side-channel in the seal MAC
verify.`,
  },
  {
    key: 'apns-transport-jwt',
    label: 'apns.ts HTTP/2 transport + apns-jwt.ts ES256 signing',
    files: [
      'packages/relay/src/apns.ts',
      'packages/relay/src/apns-jwt.ts',
    ],
    focus: `Focus on apns.ts (APNs HTTP/2 client: connection reuse, error
classification 400 BadDeviceToken / 410 Unregistered → PUSH_TOKEN_DEAD, status
handling) and apns-jwt.ts (ApnsJwtSigner: ES256 P-256 JWT mint, 50-min refresh
cache). Look for: an HTTP/2 session/socket not closed on error (fd leak under
churn); a JWT cache that refreshes too eagerly/never (auth storm or stale
token); an error branch that mis-classifies a transient failure as a dead
token (evicting a live device) or vice-versa; a key/PEM parse that throws
unhandled; a missing timeout that hangs a request forever.`,
  },
  {
    key: 'index-entry',
    label: 'index.ts entry + test-helpers (env wiring, startup)',
    files: [
      'packages/relay/src/index.ts',
      'packages/relay/src/test-helpers.ts',
      'packages/relay/src/lib.ts',
    ],
    focus: `Focus on index.ts (relay process entry: env knob reading, server
construction, SIGINT/SIGTERM graceful drain) and the small helpers. This is a
thin surface — only report a real finding (e.g. a knob read with a wrong
default vs the documented table, a graceful-drain that drops in-flight frames,
an unhandled-rejection escape on startup). Most likely conclusion here is
KEEP-AS-IS; do not manufacture a finding.`,
  },
]

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['cluster', 'findings'],
  properties: {
    cluster: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'file', 'line', 'category', 'severity', 'evidence', 'why', 'fix'],
        properties: {
          title: { type: 'string', description: 'one-line summary' },
          file: { type: 'string' },
          line: { type: 'integer', description: 'line number at HEAD' },
          category: {
            type: 'string',
            enum: ['leak', 'race', 'dos', 'crypto', 'metric', 'correctness'],
          },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          evidence: { type: 'string', description: 'what the code at file:line actually does (quote/paraphrase)' },
          why: { type: 'string', description: 'why it is a bug under the 10k zero-trust bar' },
          fix: { type: 'string', description: 'the minimal concrete fix' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lens', 'refuted', 'reasoning'],
  properties: {
    lens: { type: 'string' },
    refuted: { type: 'boolean', description: 'true if this finding is NOT a real bug (false alarm, known-good, or misread)' },
    reasoning: { type: 'string', description: 'cite file:line read at HEAD' },
  },
}

const SYNTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ranked', 'decisionGated', 'summary'],
  properties: {
    ranked: {
      type: 'array',
      description: 'survivors, highest-impact first',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rank', 'title', 'file', 'line', 'category', 'severity', 'autonomousSafe', 'fix', 'rationale'],
        properties: {
          rank: { type: 'integer' },
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          category: { type: 'string' },
          severity: { type: 'string' },
          autonomousSafe: { type: 'boolean', description: 'true if the fix is mechanical/obviously-correct and safe to apply without user sign-off; false if it needs a design decision' },
          fix: { type: 'string' },
          rationale: { type: 'string' },
        },
      },
    },
    decisionGated: {
      type: 'array',
      description: 'findings whose fix involves a judgment call the user should approve',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'file', 'line', 'question'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          question: { type: 'string', description: 'the decision the user must make' },
        },
      },
    },
    summary: { type: 'string' },
  },
}

const REPO = '/Users/dave/Projects/github.com/teleprompter'

// ── Phase 1+2: pipeline — each cluster finds, then its findings verify ──
phase('Find')
const perCluster = await pipeline(
  CLUSTERS,
  // Stage 1: find
  (c) =>
    agent(
      `${CTX}

YOUR CLUSTER: ${c.label}
FILES TO READ (at HEAD, in ${REPO}):
${c.files.map((f) => `  - ${f}`).join('\n')}

${c.focus}

Read every file listed above in full at HEAD. Walk each handler/function and
trace the resource and error paths. Report ONLY real findings per the rules —
each with file:line, category, severity, evidence (what the code actually
does), why it's a bug under the 10k zero-trust bar, and the minimal fix. If the
honest answer is "no findings, this cluster is sound," return an empty findings
array. Do NOT manufacture findings.`,
      { label: `find:${c.key}`, phase: 'Find', schema: FINDINGS_SCHEMA, model: 'sonnet', effort: 'high' },
    ),
  // Stage 2: adversarial refute-verify each finding (3 distinct lenses)
  (result, c) => {
    if (!result || !result.findings || result.findings.length === 0) return []
    return parallel(
      result.findings.map((f) => () =>
        parallel(
          ['correctness', 'reachability', 'invariant-safety'].map((lens) => () =>
            agent(
              `${CTX}

You are an ADVERSARIAL VERIFIER. Your DEFAULT is to REFUTE. A finding survives
only if it withstands a genuine attempt to kill it. Your lens: ${lens}.
- correctness: is the claimed bug actually how the code behaves at HEAD? Read
  the file:line and the surrounding control flow. Misread => refuted.
- reachability: can this path actually be hit by a real (possibly hostile)
  peer, or is it dead/guarded upstream? Unreachable => refuted.
- invariant-safety: does this match a KNOWN-GOOD intentional design, or would
  the proposed fix BREAK an architecture invariant? If so => refuted.

THE FINDING:
  title: ${f.title}
  file:line: ${f.file}:${f.line}
  category: ${f.category} severity: ${f.severity}
  evidence: ${f.evidence}
  why: ${f.why}
  fix: ${f.fix}

Read ${f.file} around line ${f.line} (and any related code) at HEAD in ${REPO}.
Cite file:line. Decide: is this a REAL bug worth fixing? Default REFUTE if
uncertain. Return refuted=true to kill it, refuted=false only if it genuinely
survives your lens.`,
              { label: `verify:${c.key}:${lens}`, phase: 'Verify', schema: VERDICT_SCHEMA, model: 'sonnet', effort: 'high' },
            ),
          ),
        ).then((verdicts) => {
          const valid = verdicts.filter(Boolean)
          const refutes = valid.filter((v) => v.refuted).length
          return { finding: f, cluster: c.key, refutes, verdicts: valid, survived: refutes < 2 }
        }),
      ),
    )
  },
)

// Flatten: survivors only (refutes < 2 of 3)
const allVerified = perCluster.flat().filter(Boolean)
const survivors = allVerified.filter((v) => v.survived)
const killed = allVerified.filter((v) => !v.survived)

log(`Find→Verify complete: ${allVerified.length} candidates, ${survivors.length} survived, ${killed.length} refuted`)

if (survivors.length === 0) {
  return {
    ranked: [],
    decisionGated: [],
    summary: `Relay audit complete. ${allVerified.length} candidate findings, ALL refuted by adversarial verify. packages/relay is sound on the audited clusters — KEEP-AS-IS. Refuted: ${killed.map((k) => k.finding.title).join('; ')}`,
    _meta: { candidates: allVerified.length, survived: 0, refuted: killed.length },
  }
}

// ── Phase 3: opus synthesis ──
phase('Synthesize')
const synthInput = survivors.map((s, i) => ({
  n: i + 1,
  title: s.finding.title,
  file: s.finding.file,
  line: s.finding.line,
  category: s.finding.category,
  severity: s.finding.severity,
  evidence: s.finding.evidence,
  why: s.finding.why,
  fix: s.finding.fix,
  refutes: `${s.refutes}/3`,
  surviving_verdicts: s.verdicts.filter((v) => !v.refuted).map((v) => `[${v.lens}] ${v.reasoning}`),
}))

const synthesis = await agent(
  `${CTX}

These ${survivors.length} findings SURVIVED adversarial refute-verify (each
judged by 3 skeptics across correctness/reachability/invariant-safety lenses;
survived = fewer than 2 of 3 refuted). De-duplicate any that are the same root
cause. Rank by real impact under the 10k zero-trust capacity bar (a
per-connection leak or a routing/crypto bug outranks a cosmetic metric drift).

For EACH surviving finding, set autonomousSafe:
- true  = the fix is mechanical and obviously-correct (a guard, a cleanup on an
  error path, a missing close, a counter correction) with no behavior-change
  risk to the documented invariants — safe to apply WITHOUT user sign-off.
- false = the fix involves a design judgment (changing a default, altering a
  rate-limit/backpressure threshold, a wire/protocol-visible change, anything
  that trades off capacity vs correctness) — route to decisionGated with the
  precise question the user must answer.

SURVIVING FINDINGS (JSON):
${JSON.stringify(synthInput, null, 2)}

Re-read any file:line you are unsure about at HEAD in ${REPO} before ranking —
do not trust the finder's paraphrase blindly. Return the ranked list +
decisionGated list + a 2-3 sentence executive summary.`,
  { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA, model: 'opus', effort: 'high' },
)

return {
  ...synthesis,
  _meta: {
    candidates: allVerified.length,
    survived: survivors.length,
    refuted: killed.length,
    refutedTitles: killed.map((k) => k.finding.title),
  },
}
