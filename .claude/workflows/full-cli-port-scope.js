export const meta = {
  name: 'full-cli-port-scope',
  description: 'Ground the FULL tp CLI surface (write/control + passthrough + daemon/relay lifecycle), beyond the 6 read-only Stage-2 commands, to scope a complete Rust port that RETIRES the Bun CLI. Maps every subcommand to its IPC-write verbs, PTY/passthrough needs, and what must stay in Bun (daemon/runner/relay services). PLAN ONLY — no code.',
  phases: [
    { title: 'Ground', detail: 'read every non-read-only command + the IPC write/control verbs + passthrough/run PTY surface at HEAD file:line' },
    { title: 'Plan', detail: 'synthesize the full-port roadmap + what blocks Bun-CLI removal' },
  ],
}

const REPO = '/Users/dave/Projects/github.com/teleprompter'

const BRIEF = `teleprompter monorepo at ${REPO}, on main. Stage 1 ✅ (Rust relay live).
The user has DIRECTED a FULL CLI port: port the ENTIRE \`tp\` CLI to Rust and
REMOVE the Bun CLI ("지금 바로 포팅 시행해. bun 버전은 제거하고"). This is bigger
than ADR-0003 Stage 2 (which was only the 6 read-only commands). We already have
the read-only surface grounded; THIS run grounds the REST so we can scope a
complete port.

CRITICAL ARCHITECTURE FACTS (invariants, 절대 위반 금지):
- The DAEMON stays in Bun (it is the long-running service; the user removed the
  CLI, not the daemon). RUNNER + RELAY also stay Bun services. Only the \`tp\`
  CLI binary (apps/cli) is being ported+retired.
- The CLI has NO RelayClient — pairing/relay flow is daemon-only (CLI → daemon
  IPC → relay). The Rust CLI must preserve this: it talks ONLY to the daemon
  over the IPC unix socket, never opens a relay WS.
- The daemon is the single SQLite WRITER. CLI WRITE commands (pair new/delete/
  rename, session delete/prune) must go through daemon IPC, NOT direct SQLite,
  so the daemon's in-memory state stays coherent. Read commands may read SQLite
  directly (daemon-less) — that is already grounded.

GROUND-TRUTH DISCIPLINE: the ONLY ground truth is the HEAD working tree. Every
claim is something to open and confirm with file:line. Commit/PR bodies, the
ADR, and this brief's prose are hearsay until reconfirmed against real files.

PLAN-ONLY. Produce NO code. Output is a scope the user approves before any Bun
removal. The single biggest unknown is the \`run\`/passthrough PTY path (ADR
Stage 4 flags the Rust PTY crate choice — portable-pty vs pty-process — as the
top technical risk needing a spike). Ground it honestly; do not hand-wave it.`

phase('Ground')

const CMD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['command', 'sourceFile', 'ipcVerbs', 'writesState', 'ptyOrSpawn', 'interactivity', 'sharedDeps', 'portRisk', 'mustStayBun', 'notes'],
  properties: {
    command: { type: 'string' },
    sourceFile: { type: 'string', description: 'apps/cli/src/commands/*.ts file:line' },
    ipcVerbs: { type: 'string', description: 'exact IPC request/reply verbs it sends to the daemon (e.g. pair.begin, session.delete), with the protocol type file:line, or "none"' },
    writesState: { type: 'string', description: 'what daemon/store state it mutates (pairings, sessions, worktrees, runners) — confirms it must go via daemon IPC not direct SQLite, file:line' },
    ptyOrSpawn: { type: 'string', description: 'does it spawn a PTY / child process (claude, daemon, relay)? which spawn API, file:line. THIS is the PTY-crate risk surface for run/passthrough.' },
    interactivity: { type: 'string', description: 'TTY prompts, multi-select (ink TSX?), QR rendering, confirmations, spinners — what interactive UI must be reproduced, file:line' },
    sharedDeps: { type: 'string', description: 'protocol/daemon imports, crypto, QR libs, ink — what the Rust port must reproduce or replace, file:line' },
    portRisk: { type: 'string', enum: ['trivial', 'low', 'medium', 'high', 'spike-needed'] },
    mustStayBun: { type: 'boolean', description: 'true if this is actually a daemon/runner/relay SERVICE entrypoint that must NOT be ported (e.g. `daemon start` runs the daemon process itself)' },
    notes: { type: 'string', description: 'gotchas: QR codes, libsodium pairing crypto, ink multi-select, detached daemon spawn, claude passthrough arg-forwarding, signal handling' },
  },
}

// The commands NOT yet grounded (read-only set already done): the write/control
// + lifecycle + passthrough surface.
const COMMANDS = [
  { key: 'pair new', file: 'apps/cli/src/commands/pair.ts (new — QR + libsodium pairing kx)' },
  { key: 'pair delete', file: 'apps/cli/src/commands/pair.ts (delete — IPC pair.remove)' },
  { key: 'pair rename', file: 'apps/cli/src/commands/pair.ts (rename — IPC pair.rename)' },
  { key: 'session delete', file: 'apps/cli/src/commands/session.ts (delete — IPC)' },
  { key: 'session prune', file: 'apps/cli/src/commands/session.ts (prune — IPC, non-interactive)' },
  { key: 'session cleanup', file: 'apps/cli/src/commands/session.ts (cleanup — interactive multi-select, ink TSX?)' },
  { key: 'daemon (start/stop/status/install/uninstall)', file: 'apps/cli/src/commands/daemon.ts — SERVICE entrypoint + lifecycle' },
  { key: 'relay start', file: 'apps/cli/src/commands/relay.ts — note: relay is now Rust tp-relay; what does `tp relay start` do?' },
  { key: 'run / passthrough (the PTY path)', file: 'apps/cli/src/commands/run.ts + index.ts passthrough — claude in a PTY, the Stage 4 spike surface' },
  { key: 'doctor', file: 'apps/cli/src/commands/doctor.ts — env diagnostics + relay/E2EE check + claude doctor' },
  { key: 'upgrade', file: 'apps/cli/src/commands/upgrade.ts — self-upgrade + claude update' },
  { key: 'claude utility passthroughs (auth/mcp/install/update/agents/...)', file: 'apps/cli/src/router.ts CLAUDE_UTILITY_SUBCOMMANDS + index.ts forwarding' },
]

const grounded = await parallel(COMMANDS.map((c) => () =>
  agent(
    `${BRIEF}\n\nGROUND "${c.key}" (${c.file}) at HEAD. Read the source + every IPC verb / spawn / crypto / interactive-UI surface it touches. For pairing: confirm the libsodium kx + QR rendering (what crate replaces it in Rust). For daemon/relay lifecycle: determine if it's a SERVICE entrypoint that must STAY Bun (set mustStayBun=true) vs a thin control command that can be a Rust IPC call. For run/passthrough: ground the EXACT PTY/spawn API (Bun.spawn terminal? node-pty?) — this is the top risk; set portRisk="spike-needed" if the Rust PTY crate choice is genuinely unresolved. Fill the schema with REAL file:line.`,
    { label: `ground:${c.key.slice(0, 24)}`, phase: 'Ground', model: 'sonnet', schema: CMD_SCHEMA },
  ).then((r) => r ? { ...r, command: c.key } : null),
))

const cmds = grounded.filter(Boolean)
log(`Ground: ${cmds.length}/${COMMANDS.length} commands grounded — risks: ${cmds.map((c) => `${c.command.slice(0, 12)}=${c.portRisk}`).join(' ')}`)

phase('Plan')

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'staysBun', 'portTranches', 'bunRemovalBlockers', 'ptyDecision', 'openDecisions', 'risks', 'recommendation'],
  properties: {
    summary: { type: 'string', description: '3-4 sentences: the full-port scope grounded in findings, what stays Bun, what the dominant risks are' },
    staysBun: { type: 'array', items: { type: 'string' }, description: 'entrypoints that must NOT be ported (daemon/runner/relay services) — cite which command file:line is a service vs a CLI' },
    portTranches: {
      type: 'array',
      description: 'ordered tranches for the full port (read-only set first = already planned; then write/control via IPC; then run/passthrough PTY last behind a spike)',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['n', 'title', 'commands', 'newDeps', 'gate', 'risk'],
        properties: {
          n: { type: 'string' },
          title: { type: 'string' },
          commands: { type: 'string' },
          newDeps: { type: 'string', description: 'new Rust crates this tranche introduces (rusqlite, clap, libsodium/sodiumoxide, qrcode, a PTY crate, etc.)' },
          gate: { type: 'string' },
          risk: { type: 'string', enum: ['trivial', 'low', 'medium', 'high', 'spike-needed'] },
        },
      },
    },
    bunRemovalBlockers: { type: 'array', items: { type: 'string' }, description: 'what MUST be true before the Bun CLI (apps/cli) can be deleted — every command ported+gated, build/install/dogfood-freshness pipeline switched to Rust, brew formula updated, release.yml building the Rust tp, etc.' },
    ptyDecision: { type: 'string', description: 'the run/passthrough PTY path: what the Bun impl does today (file:line), which Rust PTY crate(s) are candidates, and whether a spike is required before committing — be honest' },
    openDecisions: { type: 'array', items: { type: 'string' }, description: 'decisions the user must settle for the FULL port (PTY crate, pairing crypto crate, QR crate, how the single Rust binary subsumes daemon-start spawn, release/brew pipeline switch, whether daemon also eventually moves)' },
    risks: { type: 'array', items: { type: 'string' } },
    recommendation: { type: 'string', description: 'honest: the full port is a multi-PR effort spanning ADR Stages 2-4; what is safe to start NOW (Step 0 + version per the read-only plan) vs what needs the PTY spike + user decisions before Bun can be removed. Do NOT recommend deleting the Bun CLI until every command is ported+gated.' },
  },
}

const plan = await agent(
  `${BRIEF}

GROUNDED WRITE/CONTROL/PASSTHROUGH FINDINGS (HEAD file:line — verified):
${JSON.stringify(cmds, null, 1)}

NOTE: the 6 READ-ONLY commands (version/completions/status/logs/session list/
pair list) are ALREADY grounded+planned as a 7-step ladder (Step 0 scaffold →
version → completions → status → session list → pair list → logs), direct
rusqlite read-only. THIS plan EXTENDS that to the full CLI so the Bun CLI can be
retired.

Synthesize the FULL-PORT roadmap. Identify what STAYS Bun (daemon/runner/relay
are services, NOT CLI — \`daemon start\` runs the daemon process itself and must
not be ported; but \`daemon stop/status/install\` are thin control commands that
COULD be Rust IPC/service calls). Order tranches: read-only set (done-planned) →
write/control via daemon IPC (pair new/delete/rename, session delete/prune/
cleanup) → lifecycle control → run/passthrough PTY LAST behind a spike. For each
tranche: new Rust deps, gate, risk. List the HARD BLOCKERS before \`rm apps/cli\`
(every command ported+gated, build:cli:local → cargo, brew formula → Rust tp,
release.yml building Rust tp, dogfood-freshness automation rewired, CLAUDE.md
updated). Be brutally honest in the recommendation: this spans ADR Stages 2-4,
the PTY path needs a spike before commitment, and the Bun CLI must NOT be deleted
until the full set is ported+gated. What is genuinely safe to start NOW. Schema.`,
  { label: 'plan:full-port', phase: 'Plan', model: 'opus', effort: 'high', schema: PLAN_SCHEMA },
)

return { fullPort: true, commands: cmds, plan }
