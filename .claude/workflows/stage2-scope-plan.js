export const meta = {
  name: 'stage2-scope-plan',
  description: 'ADR-0003 Stage 2 scoping: ground the read-only CLI commands (status/logs/pair list/session list/version/completions) against HEAD, enumerate exact IPC-read + SQLite-read surface each needs, and produce a step-by-step Rust port plan (clap + clap_complete) with golden-vector + dogfood gates. PLAN ONLY — no code.',
  phases: [
    { title: 'Ground', detail: 'read each read-only command + its IPC/SQLite reads at HEAD file:line' },
    { title: 'Plan', detail: 'synthesize a gated step plan (crate surface, golden vectors, dogfood smoke, seam)' },
  ],
}

const REPO = '/Users/dave/Projects/github.com/teleprompter'

const BRIEF = `teleprompter monorepo at ${REPO}, on main (Stage 1 ✅ — Rust relay live in
production). ADR-0003 Stage 2 = port the READ-ONLY CLI commands to a Rust \`tp\`
binary: status, logs, pair list, session list, version, completions (clap +
clap_complete replacing the hand-rolled generators). KEEP: daemon (still the
service), runner, relay, and ALL *write* CLI paths in Bun. SEAM: Rust \`tp\` at
~/.local/bin/tp talks to the LIVE Bun daemon over IPC; \`rm ~/.local/bin/tp\`
instantly reverts to the brew Bun binary. INVARIANT: the CLI has NO RelayClient
(it never opens a relay WS — pairing/relay flow is daemon-only).

GROUND-TRUTH DISCIPLINE: the ONLY ground truth is the HEAD working tree. Every
claim is something to open and confirm with file:line. Commit/PR bodies, this
brief's prose, and the ADR are hearsay until reconfirmed against real files.

This is a PLAN-ONLY scoping run. Produce NO code. The output is a step plan the
user will approve before any Stage 2 implementation begins (mirroring how the
A1.5 step plan structured Stage 1).`

phase('Ground')

const CMD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['command', 'sourceFile', 'ipcReads', 'sqliteReads', 'rendering', 'sharedDeps', 'portRisk', 'notes'],
  properties: {
    command: { type: 'string' },
    sourceFile: { type: 'string', description: 'apps/cli/src/commands/*.ts file:line range' },
    ipcReads: { type: 'string', description: 'exact IPC request/response message types this command sends/reads (e.g. status.get), or "none". cite the IPC command name + the protocol type file:line' },
    sqliteReads: { type: 'string', description: 'direct SQLite reads (if the CLI reads the store directly) or "via daemon IPC only". cite file:line' },
    rendering: { type: 'string', description: 'how output is rendered (plain text / table / ink TSX / colors) — what the Rust port must reproduce, cite file:line' },
    sharedDeps: { type: 'string', description: '@teleprompter/protocol imports + any shared helper (socket-path, framing) the Rust port must byte-match, file:line' },
    portRisk: { type: 'string', enum: ['trivial', 'low', 'medium', 'high'], description: 'porting risk' },
    notes: { type: 'string', description: 'gotchas: ink TSX (session-cleanup is .tsx), TTY detection, exit codes, daemon-auto-start, etc.' },
  },
}

const COMMANDS = [
  { key: 'version', file: 'apps/cli/src/commands/version.ts' },
  { key: 'status', file: 'apps/cli/src/commands/status.ts' },
  { key: 'logs', file: 'apps/cli/src/commands/logs.ts' },
  { key: 'pair list', file: 'apps/cli/src/commands/pair.ts (list subcommand)' },
  { key: 'session list', file: 'apps/cli/src/commands/session.ts (list subcommand)' },
  { key: 'completions', file: 'apps/cli/src/commands/completions.ts' },
]

const grounded = await parallel(COMMANDS.map((c) => () =>
  agent(
    `${BRIEF}\n\nGROUND the read-only command "${c.key}" (${c.file}). Read the source + every IPC type / SQLite read / shared helper it touches at HEAD. Also read packages/protocol/src for the IPC message types it uses (socket-path.ts, framing, the request/response envelope) and how the daemon answers it (packages/daemon/src). Fill the schema with REAL file:line. Determine portRisk honestly (clap mechanical = low/trivial; ink TSX or tricky TTY = medium/high).`,
    { label: `ground:${c.key}`, phase: 'Ground', model: 'sonnet', schema: CMD_SCHEMA },
  ).then((r) => r ? { ...r, command: c.key } : null),
))

const cmds = grounded.filter(Boolean)
log(`Ground: ${cmds.length}/${COMMANDS.length} commands grounded — risks: ${cmds.map((c) => `${c.command}=${c.portRisk}`).join(' ')}`)

// Also ground the cross-cutting CLI plumbing the Rust binary needs regardless of command.
const PLUMBING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['router', 'ipcClient', 'socketPath', 'framing', 'daemonAutostart', 'goldenVectorSurface', 'existingRustCrates', 'openDecisions'],
  properties: {
    router: { type: 'string', description: 'how apps/cli/src/index.ts / router.ts dispatches subcommands; what the Rust clap structure mirrors, file:line' },
    ipcClient: { type: 'string', description: 'connectIpcAsClient + the IPC framing the CLI uses to talk to the daemon, file:line' },
    socketPath: { type: 'string', description: 'packages/protocol/src/socket-path.ts hashing the Rust CLI must byte-match (ENAMETOOLONG avoidance), file:line' },
    framing: { type: 'string', description: 'the u32_be length + JSON framing — already in tp-proto? confirm reuse, file:line' },
    daemonAutostart: { type: 'string', description: 'ensureDaemon() — does status/logs auto-start the daemon? what the Rust CLI must do, file:line' },
    goldenVectorSurface: { type: 'string', description: 'what IPC frames need golden vectors (io binary-sidecar + event base64 per ADR Stage 2 gate), where existing vectors live (rust/tp-proto/tests), file:line' },
    existingRustCrates: { type: 'string', description: 'what tp-proto / tp-core ALREADY provide that a tp-cli crate would reuse (framing, socket-path, message types), file:line' },
    openDecisions: { type: 'array', items: { type: 'string' }, description: 'decisions the user must make before Stage 2 starts (new tp-cli crate? clap version? where the binary installs? how it coexists with the Bun tp at ~/.local/bin during transition?)' },
  },
}

const plumbing = await agent(
  `${BRIEF}\n\nGROUND the cross-cutting CLI plumbing a Rust read-only \`tp\` needs: read apps/cli/src/index.ts + router.ts (dispatch), the IPC client (connectIpcAsClient — find it in packages/daemon or protocol), packages/protocol/src/socket-path.ts, the framing (is it in rust/tp-proto already?), ensureDaemon() auto-start, and what rust/tp-proto + rust/tp-core ALREADY expose that a new tp-cli crate would reuse. Identify the IPC frames needing golden vectors (ADR Stage 2 gate: io binary-sidecar + event base64). List the OPEN DECISIONS the user must settle before Stage 2 implementation. Schema, real file:line.`,
  { label: 'ground:plumbing', phase: 'Ground', model: 'sonnet', schema: PLUMBING_SCHEMA },
)

log(`Ground: plumbing — ${(plumbing?.openDecisions ?? []).length} open decisions surfaced`)

phase('Plan')

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'steps', 'openDecisions', 'gates', 'risks', 'recommendation'],
  properties: {
    summary: { type: 'string', description: '2-3 sentence Stage 2 scope grounded in the findings' },
    steps: {
      type: 'array',
      description: 'ordered, individually-shippable steps (each its own gated PR, mirroring A1.5)',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['n', 'title', 'scope', 'gate', 'risk'],
        properties: {
          n: { type: 'string' },
          title: { type: 'string' },
          scope: { type: 'string', description: 'concrete files/crates touched, cite the grounded file:line' },
          gate: { type: 'string', description: 'how this step is verified (golden vector / dogfood smoke / unit)' },
          risk: { type: 'string', enum: ['trivial', 'low', 'medium', 'high'] },
        },
      },
    },
    openDecisions: { type: 'array', items: { type: 'string' }, description: 'consolidated user decisions required BEFORE step 1 (crate layout, clap deps, install seam, transition coexistence)' },
    gates: { type: 'string', description: 'the overall Stage 2 gate per ADR (live dogfood daemon smoke + IPC frame golden vectors)' },
    risks: { type: 'array', items: { type: 'string' } },
    recommendation: { type: 'string', description: 'honest recommendation: start Stage 2 now, or hold for user decision on X; what the smallest safe first increment is' },
  },
}

const plan = await agent(
  `${BRIEF}

GROUNDED COMMAND FINDINGS (HEAD file:line — these are verified):
${JSON.stringify(cmds, null, 1)}

GROUNDED PLUMBING (HEAD file:line):
${JSON.stringify(plumbing, null, 1)}

Synthesize a Stage 2 STEP PLAN: ordered, individually-shippable steps (each its
own gated PR, mirroring how A1.5 structured Stage 1 into Steps 1-8). Order by
risk (trivial leaf commands first: version/completions; then status/logs;
session list / pair list last if they read more). Each step: concrete scope
(cite grounded file:line), its gate (golden vector / dogfood smoke / unit), risk.
Consolidate the OPEN DECISIONS the user must settle before step 1 (new tp-cli
crate layout? clap + clap_complete deps? install seam at ~/.local/bin? how the
Rust tp coexists with the Bun tp during the read-only transition — since only
SOME subcommands are ported, does the Rust binary shell out to the Bun one for
unported commands, or is it a separate binary?). Be honest in the recommendation:
is Stage 2 safe to start autonomously now, or does it need a user decision first?
What's the smallest safe first increment? Schema.`,
  { label: 'plan:stage2', phase: 'Plan', model: 'opus', effort: 'high', schema: PLAN_SCHEMA },
)

return { stage: 2, commands: cmds, plumbing, plan }
