export const meta = {
  name: 'daemon-audit',
  description: 'Fact-grounded hardening audit of packages/daemon: file-sharded finders → adversarial refute-verify → opus synthesis with autonomousSafe flags',
  phases: [
    { title: 'Find', detail: 'one finder per cohesive daemon file cluster' },
    { title: 'Verify', detail: 'adversarial refute-verify per finding (3 skeptics)' },
    { title: 'Synthesize', detail: 'dedup, rank, flag autonomous-safe vs decision-gated' },
  ],
}

// ---- shared context handed to every finder ----
const CTX = `
You are auditing the Teleprompter project's \`packages/daemon\` (Bun + TypeScript) for LATENT BUGS and HARDENING gaps.
Repo root: /Users/dave/Projects/github.com/teleprompter (you are at HEAD = main, commit e5bd8cf).

ARCHITECTURE INVARIANTS (violating these IS a bug; do NOT propose changes that break them):
- Frontend ↔ Daemon traffic ALWAYS goes via relay. Daemon opens NO WS server — it is the relay's ONLY outbound WS client.
- Relay forwards ciphertext only (zero-trust). Daemon does not track a frontend client registry; frontend identity is the \`frontendId\` in relay protocol v2.
- IPC = Unix domain socket, framed JSON (u32_be length + utf-8 JSON). Runner↔Daemon (io/event/meta) + CLI↔Daemon commands (pair.begin/pair.remove/pair.rename/session ops).
- Pairing relay URL is decided by the daemon (delivered offline via QR); frontend does not configure it.
- Native Windows is unsupported — do NOT add process.platform==="win32" branches.

KNOWN-GOOD INVARIANTS already in place (do NOT re-report these as bugs):
- IPC decode-throw teardown: FrameDecoder.decode() throws on protocol-fatal frames; callers MUST try/catch → reset() → end() the socket (runner IpcClient + CLI connectIpcAsClient already do this).
- Dead-pairing reconnect throttle: computeReconnectPlan(attempt, peerlessReconnects) throttles peerless reconnects after PEERLESS_RECONNECT_THRESHOLD; peerlessReconnects reset on real frontend join, NOT on ws.onopen.
- hook buffer cap is UTF-8 byte based; graceful-shutdown yields a macrotask before exit to flush bye.
- Unix socket path length is shortened via packages/protocol/src/socket-path.ts hash helper.
- tp pair new concurrency guarded by proper-lockfile (pair.lock).

WHAT COUNTS AS A FINDING (hunt for these):
- Unhandled promise rejections / swallowed errors that hide failures or leave state half-updated.
- Resource leaks: SQLite handles, sockets, timers (setInterval/setTimeout), file descriptors, child processes not killed on all paths.
- Race conditions / TOCTOU: check-then-act on session state, pairing state, lock files, store rows.
- SQL correctness: missing transactions where multi-statement atomicity is needed, injection (even if params are internal), unbounded queries, missing indices on hot paths, append-only violations.
- Crypto/vault: key material logged, plaintext leaked, missing zeroization expectations, weak randomness for security-relevant values.
- Input validation: IPC command fields, pairing payloads, relay frames, session ids (path traversal), worktree paths (git arg injection via paths starting with -).
- git subprocess hardening: worktree add/remove/list arg construction — untrusted paths/branch names reaching git argv, missing -- separators, ENOENT/dirty-state handling.
- Boundary/encoding: byte vs char length, base64 round-trips, JSON.parse on untrusted bytes without guard.
- Logic bugs: off-by-one, wrong comparison, inverted condition, missing await, wrong default, dead code masking intent.
- Shutdown/cleanup correctness: signal handlers, double-stop guards, orphaned runners on daemon crash.

DISCIPLINE:
- READ THE ACTUAL FILE at HEAD with the Read tool and cite file:line for EVERY finding. Do not trust commit messages, comments, or prior summaries as ground truth.
- For each finding, state: the exact file:line, the precise failure scenario (what input/sequence triggers it), the consequence, and whether a fix is mechanical/local (autonomousSafe) or needs a product/policy/contract decision (decisionGated).
- Prefer FEWER, HIGHER-CONFIDENCE findings over a long list of style nits. A finding must be a real defect a maintainer would fix, not a preference.
- Do NOT propose architecture changes that break the invariants above.
`

const FINDING_SCHEMA = {
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
        required: ['title', 'file', 'line', 'scenario', 'consequence', 'severity', 'autonomousSafe', 'suggestedFix'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'string', description: 'file:line or line range' },
          scenario: { type: 'string', description: 'exact input/sequence that triggers it' },
          consequence: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          autonomousSafe: { type: 'boolean', description: 'true if fix is mechanical/local with no product/policy/contract decision' },
          suggestedFix: { type: 'string' },
        },
      },
    },
  },
}

const CLUSTERS = [
  {
    key: 'store',
    files: [
      'packages/daemon/src/store/store.ts',
      'packages/daemon/src/store/session-db.ts',
      'packages/daemon/src/store/schema.ts',
      'packages/daemon/src/store/config.ts',
      'packages/daemon/src/store/pairing-row-guard.ts',
      'packages/daemon/src/store/session-meta.ts',
      'packages/daemon/src/store/index.ts',
    ],
    focus: 'SQLite store: append-only Record integrity, transaction atomicity for multi-statement ops, deleteSession/pruneOldSessions correctness, vault BLOB handling, handle leaks (db.close on all paths), unbounded queries, cursor/seq correctness, pairing-row guard completeness.',
  },
  {
    key: 'relay-client',
    files: ['packages/daemon/src/transport/relay-client.ts'],
    focus: 'RelayClient: reconnect/ping timers (leak on dispose?), kx frame handling, frame routing by frontendId, resume-token path, the dead-pairing throttle (already guarded — verify no regression-adjacent hole), error handling on ws events, double-dispose, send() on closed socket.',
  },
  {
    key: 'relay-manager',
    files: ['packages/daemon/src/transport/relay-manager.ts'],
    focus: 'RelayConnectionManager: per-pairing RelayClient lifecycle, reconnectSaved fan-out, removePairing/renamePairing (control.unpair/control.rename emit + store update ordering), map cleanup on dispose, concurrent pair-op races, partial-failure handling.',
  },
  {
    key: 'ipc',
    files: [
      'packages/daemon/src/ipc/command-dispatcher.ts',
      'packages/daemon/src/ipc/server.ts',
    ],
    focus: 'IPC command dispatch: untrusted field validation on every command (pair.*, session.*, input/resize), framed messaging lifecycle, connection cleanup, error replies vs silent drops, sid path-traversal, base64 decode of input, response correctness (notified-peer counts), decode-throw teardown on the server side.',
  },
  {
    key: 'pairing',
    files: [
      'packages/daemon/src/pairing/pairing-orchestrator.ts',
      'packages/daemon/src/pairing/pending-pairing.ts',
      'packages/daemon/src/pairing/begin-pairing-error.ts',
    ],
    focus: 'Pairing lifecycle: completion-gated begin (blocks until kx), pending-pairing in-memory only, kx key derivation, relay open/close on pairing, timeout/cancel paths (SIGINT), lock interaction, error propagation, no plaintext secret leak in logs/errors.',
  },
  {
    key: 'core',
    files: [
      'packages/daemon/src/daemon.ts',
      'packages/daemon/src/session/session-manager.ts',
      'packages/daemon/src/worktree/worktree-manager.ts',
      'packages/daemon/src/push/push-notifier.ts',
      'packages/daemon/src/daemon-lock.ts',
      'packages/daemon/src/index.ts',
      'packages/daemon/src/export-formatter.ts',
    ],
    focus: 'Daemon mux + supervision: Runner spawn/kill on all paths (orphans on crash?), worktree git subprocess arg hardening (untrusted paths/branches → git argv, -- separators, injection via leading -), push-notifier token/dispatch, daemon-lock pid-file singleton (recycled pid, stale lock), signal handlers + double-stop, export-formatter on untrusted records.',
  },
]

phase('Find')
const findResults = await pipeline(
  CLUSTERS,
  (c) =>
    agent(
      `${CTX}\n\n=== YOUR CLUSTER: ${c.key} ===\nRead and audit EXACTLY these files at HEAD:\n${c.files.map((f) => '  - ' + f).join('\n')}\n\nSharded focus for this cluster: ${c.focus}\n\nReturn ONLY genuine, file:line-cited findings. If a file is clean, return no findings for it. Be thorough — read every function, not just the obvious entry points.`,
      { label: `find:${c.key}`, phase: 'Find', schema: FINDING_SCHEMA, model: 'sonnet', effort: 'high' },
    ),
  // Verify stage: every finding in this cluster gets 3 independent adversarial skeptics.
  (res, c) => {
    if (!res || !res.findings || res.findings.length === 0) return { cluster: c.key, verified: [] }
    return parallel(
      res.findings.map((f) => () =>
        parallel(
          ['correctness', 'reachability', 'invariant-safety'].map((lens) => () =>
            agent(
              `${CTX}\n\nA finder claims this is a defect in packages/daemon. Your job is to REFUTE it via the "${lens}" lens. Default to refuted=true unless you can confirm, by READING THE ACTUAL FILE at HEAD (cite file:line), that the defect is real AND the scenario is reachable AND fixing it would not violate an architecture invariant.\n\nCLAIM:\n  title: ${f.title}\n  location: ${f.file}:${f.line}\n  scenario: ${f.scenario}\n  consequence: ${f.consequence}\n  suggestedFix: ${f.suggestedFix}\n\nLens "${lens}" means:\n  - correctness: is the code actually wrong, or did the finder misread it? Read the real logic.\n  - reachability: can the triggering input/sequence actually occur given how the daemon is driven (IPC callers, relay frames, runner)? Or is it dead/guarded upstream?\n  - invariant-safety: would the suggested fix break an architecture invariant or a known-good invariant, or is it already handled elsewhere?\n\nReturn your verdict.`,
              { label: `verify:${c.key}:${lens}`, phase: 'Verify', model: 'sonnet', effort: 'medium', schema: {
                type: 'object', additionalProperties: false,
                required: ['refuted', 'reason'],
                properties: { refuted: { type: 'boolean' }, reason: { type: 'string', description: 'file:line-grounded justification' } },
              } },
            ),
          ),
        ).then((verdicts) => {
          const live = verdicts.filter(Boolean)
          const refutes = live.filter((v) => v.refuted).length
          // Survives if a MAJORITY of the 3 skeptics could NOT refute it.
          const survives = refutes < 2
          return { ...f, cluster: c.key, refutes, totalVerifiers: live.length, survives, verdicts: live }
        }),
      ),
    ).then((judged) => ({ cluster: c.key, verified: judged.filter(Boolean) }))
  },
)

const allVerified = findResults.filter(Boolean).flatMap((r) => r.verified || [])
const survivors = allVerified.filter((f) => f.survives)
const killed = allVerified.filter((f) => !f.survives)
log(`Find: ${allVerified.length} candidates across ${CLUSTERS.length} clusters; ${survivors.length} survived adversarial verify, ${killed.length} refuted.`)

phase('Synthesize')
const synthesis = await agent(
  `${CTX}\n\nYou are the SYNTHESIZER. Below are daemon-audit findings that SURVIVED a 3-skeptic adversarial refute-verify (majority of skeptics could not refute). Produce the final ranked report.\n\nTasks:\n1. DEDUP findings that describe the same root defect (even across clusters).\n2. RANK by real-world risk (consequence severity × reachability). Highest first.\n3. For EACH, set autonomousSafe correctly: true ONLY if the fix is mechanical/local with NO product, policy, contract, or wire-format decision (e.g. add a try/catch, clear a timer on dispose, add a -- separator, wrap a multi-statement write in a transaction). false if it needs a decision (changing a flag's contract, a new config knob, a behavior policy, anything touching the relay/IPC wire format semantics, anything that could change observable CLI/app behavior).\n4. Keep ONLY findings you are confident are real defects a maintainer would fix. Drop anything that reads as a style preference or that the verifiers left shaky.\n\nReturn the structured report. For each finding include the original file:line, a crisp one-line title, the scenario, the consequence, severity, autonomousSafe, and a concrete suggestedFix. Also include a short \`decisionGated\` list (the autonomousSafe:false ones) with the specific decision each needs.\n\nSURVIVING FINDINGS (JSON):\n${JSON.stringify(survivors.map((f) => ({ cluster: f.cluster, title: f.title, file: f.file, line: f.line, scenario: f.scenario, consequence: f.consequence, severity: f.severity, autonomousSafe: f.autonomousSafe, suggestedFix: f.suggestedFix, refutes: f.refutes, totalVerifiers: f.totalVerifiers })), null, 2)}`,
  { label: 'synthesize', phase: 'Synthesize', model: 'opus', effort: 'high', schema: {
    type: 'object', additionalProperties: false,
    required: ['ranked', 'decisionGated', 'summary'],
    properties: {
      ranked: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['rank', 'title', 'file', 'line', 'scenario', 'consequence', 'severity', 'autonomousSafe', 'suggestedFix'],
          properties: {
            rank: { type: 'number' },
            title: { type: 'string' },
            file: { type: 'string' },
            line: { type: 'string' },
            scenario: { type: 'string' },
            consequence: { type: 'string' },
            severity: { type: 'string', enum: ['high', 'medium', 'low'] },
            autonomousSafe: { type: 'boolean' },
            suggestedFix: { type: 'string' },
          },
        },
      },
      decisionGated: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['title', 'file', 'line', 'decisionNeeded'],
          properties: {
            title: { type: 'string' },
            file: { type: 'string' },
            line: { type: 'string' },
            decisionNeeded: { type: 'string' },
          },
        },
      },
      summary: { type: 'string' },
    },
  } },
)

return {
  candidates: allVerified.length,
  survived: survivors.length,
  refuted: killed.length,
  refutedTitles: killed.map((f) => `${f.cluster}: ${f.title} (${f.refutes}/${f.totalVerifiers} refuted)`),
  report: synthesis,
}
