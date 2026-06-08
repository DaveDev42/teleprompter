export const meta = {
  name: 'fact-grounded-fix',
  description:
    'Find a verified fix/answer to a code question by grounding EVERY claim in HEAD source on disk — never trusting commit bodies, PR descriptions, or prior-session narration. Hardened against the wf_0f537a63 failure mode.',
  phases: [
    { title: 'Reverify', detail: 'Re-check every inherited claim against HEAD source; demote unproven ones' },
    { title: 'Enumerate', detail: 'List candidate fixes, each grounded in re-verified facts' },
    { title: 'Verify', detail: 'Adversarially refute each candidate using only file:line evidence' },
    { title: 'Synthesize', detail: 'Choose change-vs-keep; emit an exact diff or a justified no-op' },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS TEMPLATE EXISTS — the wf_0f537a63 post-mortem, encoded as structure.
//
// A prior workflow on the libsodium-Hermes rejection shipped the WRONG verdict.
// The root cause was NOT a bad agent — it was a BRIEF that:
//   (1) injected unproven PAST narration ("already failed on-device, twice") as
//       ground truth, lifted from a STALE pre-fix commit body (91b50b5) that the
//       author mistook for HEAD, and
//   (2) explicitly FORBADE re-derivation ("do not re-derive", "do NOT propose
//       these; they are dead"), so agents were structurally barred from checking
//       those claims against the real files — the one thing that would have
//       caught the error.
// The agents obeyed a poisoned brief. The on-device A/B test later proved the
// rejected candidate was actually correct.
//
// This template makes that failure mode IMPOSSIBLE BY CONSTRUCTION:
//   • Every inherited "fact" enters as a CLAIM to be re-verified (phase Reverify),
//     never as an axiom. Unverifiable/contradicted claims are demoted, not obeyed.
//   • The shared GROUND_TRUTH contract bans citing commit/PR bodies or prior
//     sessions as evidence; only file:line on disk counts.
//   • There is NO "do not re-derive" lever anywhere. Re-derivation is the job.
//   • Adversarial verify defaults to REFUTED and must cite real files.
//
// USAGE (call from the main session):
//   Workflow({ scriptPath: ".../.claude/workflows/fact-grounded-fix.js", args: {
//     repo: "/abs/path/to/repo",
//     question: "the precise fix/answer being sought",
//     targetFiles: ["src/foo.ts:120"],          // where the change would land
//     establishedFacts: ["fact A (cite file)", ...],  // OPTIONAL — treated as CLAIMS
//     inheritedClaims: [                          // OPTIONAL — past conclusions to RE-TEST
//       "claim X was 'already disproven on-device' (re-verify, do not assume)",
//     ],
//     constraints: ["must stay a no-op on web", ...],  // OPTIONAL
//     onDeviceSignals: ["WebAssembly.RuntimeError", ...], // OPTIONAL — what must stay clean
//   }})
//
// args.question is REQUIRED. Everything else is optional context. Crucially,
// establishedFacts and inheritedClaims are passed to agents as THINGS TO CHECK,
// not things to believe.
// ─────────────────────────────────────────────────────────────────────────────

// Defensive: the Workflow runner passes `args` verbatim, but a caller may
// accidentally hand it a JSON-encoded STRING instead of an object (a common
// foot-gun). Parse it back so args.question etc. resolve instead of silently
// being undefined.
let a = args ?? {}
if (typeof a === 'string') {
  try {
    a = JSON.parse(a)
  } catch {
    throw new Error(
      'fact-grounded-fix: args arrived as a non-JSON string. Pass args as an actual JSON object, e.g. args: { question: "…" }.',
    )
  }
}
const REPO = a.repo ?? '.'
const QUESTION = a.question
if (!QUESTION) {
  throw new Error('fact-grounded-fix: args.question is required (the fix/answer being sought)')
}
const TARGET_FILES = Array.isArray(a.targetFiles) ? a.targetFiles : []
const ESTABLISHED = Array.isArray(a.establishedFacts) ? a.establishedFacts : []
const INHERITED = Array.isArray(a.inheritedClaims) ? a.inheritedClaims : []
const CONSTRAINTS = Array.isArray(a.constraints) ? a.constraints : []
const ON_DEVICE = Array.isArray(a.onDeviceSignals) ? a.onDeviceSignals : []

const GROUND_TRUTH = `
GROUND-TRUTH CONTRACT (non-negotiable — this is the whole point of this workflow):
- Repo root: ${REPO}
- The ONLY admissible evidence is the ACTUAL content of files on disk RIGHT NOW:
  the working tree (= HEAD for the relevant files) and ${REPO}/node_modules.
- Commit messages, PR bodies/titles, CHANGELOGs, and any "prior session said…" /
  "we already established…" narration are NOT evidence. They are HEARSAY. If you
  cite one, you MUST independently confirm the underlying claim against a real file
  and give the exact path + line numbers you read. An unconfirmed hearsay claim is
  worth nothing and must not drive a verdict.
- A claim that something "was already tried and failed" or "is already shipped /
  already correct" is HEARSAY until you open the current file and see it. The HEAD
  working tree may differ from any commit body you were told about. CHECK IT.
- Quote the specific lines you base each conclusion on. "I believe" / "presumably"
  / "it should" are not allowed — read the file or mark the point UNVERIFIED.
- Use Read / Grep / Bash freely. There is NO instruction anywhere telling you not
  to re-derive something. Re-derivation against real files IS the task.
`

const CONTEXT = `
QUESTION (the fix/answer being sought):
${QUESTION}

${TARGET_FILES.length ? `LIKELY TARGET SITE(S) (verify they still say what's claimed):\n${TARGET_FILES.map((f) => `  - ${f}`).join('\n')}` : ''}

${CONSTRAINTS.length ? `CONSTRAINTS the fix must satisfy:\n${CONSTRAINTS.map((c) => `  - ${c}`).join('\n')}` : ''}

${ON_DEVICE.length ? `ON-DEVICE SIGNALS that must stay clean (0) after the fix:\n${ON_DEVICE.map((s) => `  - ${s}`).join('\n')}` : ''}
`

// ── Phase 1: RE-VERIFY inherited claims against HEAD. This is the guard the prior
//    workflow lacked. Nothing downstream may treat a claim as true until it passes.
phase('Reverify')
const REVERIFY_SCHEMA = {
  type: 'object',
  required: ['claims'],
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        required: ['claim', 'status', 'evidence'],
        properties: {
          claim: { type: 'string' },
          status: {
            type: 'string',
            enum: ['confirmed', 'contradicted', 'unverifiable', 'stale'],
            description:
              'confirmed=real file backs it; contradicted=real file refutes it; stale=was true of an old commit but HEAD differs; unverifiable=no file settles it',
          },
          evidence: { type: 'string', description: 'exact file:line you read (required for confirmed/contradicted/stale)' },
          correctedFact: { type: 'string', description: 'if contradicted/stale: what HEAD actually says' },
        },
      },
    },
    newFacts: {
      type: 'array',
      items: { type: 'string' },
      description: 'additional load-bearing facts you found in HEAD while checking, each with file:line',
    },
  },
}

const allClaims = [
  ...ESTABLISHED.map((c) => ({ kind: 'established-fact', text: c })),
  ...INHERITED.map((c) => ({ kind: 'inherited-conclusion', text: c })),
]

const reverify =
  allClaims.length === 0
    ? { claims: [], newFacts: [] }
    : await agent(
        `${GROUND_TRUTH}\n${CONTEXT}\n\nTASK: You have been handed the following CLAIMS. They may be true, stale, or flat wrong — the workflow that produced some of them previously trusted a stale commit body and shipped a wrong fix. Re-verify EACH claim against the HEAD working tree and node_modules. For each: open the actual file, decide confirmed / contradicted / stale / unverifiable, and cite file:line. If a claim says "X was already tried and failed" or "Y is already the correct/shipped fix", you MUST open the current source and confirm what HEAD actually contains — do not take the claim's word. Demote anything you cannot back with a real file.\n\nCLAIMS TO RE-VERIFY:\n${JSON.stringify(allClaims, null, 2)}\n\nReturn the per-claim verdicts plus any new load-bearing facts you discovered (each with file:line).`,
        { label: 'reverify-claims', phase: 'Reverify', schema: REVERIFY_SCHEMA, model: 'sonnet' },
      )

const verifiedFacts = [
  ...(reverify?.claims ?? [])
    .filter((c) => c.status === 'confirmed')
    .map((c) => `${c.claim}  [${c.evidence}]`),
  ...(reverify?.claims ?? [])
    .filter((c) => c.status === 'contradicted' || c.status === 'stale')
    .map((c) => `CORRECTED: ${c.correctedFact ?? '(HEAD differs from the claim)'}  [${c.evidence}]`),
  ...(reverify?.newFacts ?? []),
]
const demoted = (reverify?.claims ?? []).filter(
  (c) => c.status === 'contradicted' || c.status === 'stale' || c.status === 'unverifiable',
)
log(
  `reverify: ${verifiedFacts.length} facts stand on real files; ${demoted.length} inherited claims demoted (contradicted/stale/unverifiable)`,
)

const VERIFIED_FACTS_BLOCK = verifiedFacts.length
  ? `\nFACTS RE-VERIFIED AGAINST HEAD (each backed by file:line — these you may rely on):\n${verifiedFacts.map((f) => `  - ${f}`).join('\n')}\n`
  : '\n(No inherited facts survived re-verification, or none were provided. Establish facts yourself from HEAD as you go.)\n'

// ── Phase 2: ENUMERATE candidate fixes, grounded only in re-verified facts.
phase('Enumerate')
const ENUM_SCHEMA = {
  type: 'object',
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'summary', 'mechanism'],
        properties: {
          id: { type: 'string', description: 'short kebab id' },
          summary: { type: 'string' },
          mechanism: { type: 'string', description: 'concretely how it works, grounded in file:line' },
          sketch: { type: 'string', description: 'code/config sketch if applicable' },
        },
      },
    },
  },
}

const enumeration = await agent(
  `${GROUND_TRUTH}\n${CONTEXT}\n${VERIFIED_FACTS_BLOCK}\n\nTASK: Enumerate EVERY plausible candidate fix/answer for the question, grounding each in the re-verified facts and in source you read yourself (cite file:line). Be exhaustive — include weak candidates and the "do nothing / keep-as-is, because…" option when relevant. For each, state the concrete mechanism. Do NOT exclude a candidate merely because a (now-demoted) inherited claim said it was dead — if the claim was demoted in Reverify, the candidate is live again until YOU refute it on real files.`,
  { label: 'enumerate', phase: 'Enumerate', schema: ENUM_SCHEMA, model: 'opus' },
)
const candidates = enumeration?.candidates ?? []
log(`enumerated ${candidates.length} candidates: ${candidates.map((c) => c.id).join(', ')}`)

// ── Phase 3: VERIFY each candidate adversarially. Default REFUTED. file:line only.
phase('Verify')
const VERDICT_SCHEMA = {
  type: 'object',
  required: ['id', 'works', 'confidence', 'evidence', 'recommendation'],
  properties: {
    id: { type: 'string' },
    works: { type: 'boolean', description: 'does it actually answer the question / fix the issue' },
    breaksConstraints: { type: 'boolean', description: 'does it violate any stated constraint' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    evidence: { type: 'string', description: 'exact file:line citations proving the verdict (NOT commit bodies)' },
    sideEffects: { type: 'string' },
    onDeviceRisk: { type: 'string' },
    recommendation: { type: 'string', enum: ['adopt', 'reject', 'fallback-only'] },
  },
}

const verdicts = (
  await parallel(
    candidates.map((c) => () =>
      agent(
        `${GROUND_TRUTH}\n${CONTEXT}\n${VERIFIED_FACTS_BLOCK}\n\nTASK: ADVERSARIALLY verify this candidate. Default to skepticism — try to REFUTE that it works. It only "works" if you can PROVE, from real files (file:line), that it answers the question AND respects every constraint. Open the actual source; do not rely on the candidate's own description or any commit/PR narrative. If a constraint mentions on-device signals, reason explicitly about whether each stays clean. Default works=false / recommendation=reject when uncertain.\n\nCANDIDATE:\n${JSON.stringify(c, null, 2)}`,
        { label: `verify:${c.id}`.slice(0, 40), phase: 'Verify', schema: VERDICT_SCHEMA, model: 'sonnet' },
      ),
    ),
  )
).filter(Boolean)

const adoptable = verdicts.filter((v) => v.works && !v.breaksConstraints && v.recommendation === 'adopt')
log(`verified ${verdicts.length}; ${adoptable.length} adoptable: ${adoptable.map((v) => v.id).join(', ') || '(none)'}`)

// ── Phase 4: SYNTHESIZE. Change vs keep, each backed by re-verified evidence.
phase('Synthesize')
const SYNTH_SCHEMA = {
  type: 'object',
  required: ['decision', 'rationale', 'needsDeviceVerify'],
  properties: {
    decision: { type: 'string', enum: ['change', 'keep-as-is'] },
    chosenCandidateId: { type: 'string' },
    rationale: { type: 'string', description: 'why, citing re-verified file:line evidence' },
    exactDiff: { type: 'string', description: 'precise edit if change, else "NO CHANGE"' },
    needsDeviceVerify: { type: 'boolean' },
    deviceVerifyPlan: { type: 'string' },
    keepJustification: { type: 'string', description: 'if keep-as-is: why that is the right call' },
  },
}

const synthesis = await agent(
  `${GROUND_TRUTH}\n${CONTEXT}\n${VERIFIED_FACTS_BLOCK}\n\nYou are the final synthesizer. Below are the adversarial verdicts. Decide CHANGE (pick the single best adoptable candidate) or KEEP-AS-IS.\n\nDecision rules:\n- A candidate is eligible only if works=true AND breaksConstraints=false, proven with real file:line evidence (NOT a commit body — the prior workflow on a sibling problem shipped a wrong verdict precisely because it trusted a stale commit body).\n- KEEP-AS-IS is a legitimate outcome. Do not force a change just to act. Recommend CHANGE only if a candidate cleanly answers the question at low risk with no regression.\n- If CHANGE: give the EXACT diff and a concrete device/test verification plan.\n- If KEEP-AS-IS: give a crisp justification suitable to report to the user.\n\nVERDICTS:\n${JSON.stringify(verdicts, null, 2)}`,
  { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA, model: 'opus' },
)

return { reverify, demoted, verifiedFacts, enumeration, verdicts, adoptable, synthesis }
