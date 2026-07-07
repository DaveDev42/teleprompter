# Daemon Rust Port Plan — `packages/daemon` → `rust/tp-daemon` (ADR-0003 Phase 4, Stage 5)

> **Status:** Plan drafted 2026-07-07 (Plan agent, opus, grounded on HEAD `a3e2a810`).
> Awaiting Dave's decisions on §4 before inc1 starts. SoT for the *how* = this doc +
> `docs/adr/0003-phase4-backend-rust-migration.md` §5/§6. The runner port
> (`rust/tp-runner`, increments merged #883/#884/#890) is the decomposition template.

Daemon = **7,014 non-test LOC, 23 files**. It is the last and most complex backend
component (orchestrates session/store/relay-client/pairing/push/worktree; shares the
`sessions.sqlite` file with the CLI). Ported last, exactly as ADR-0003 §5 sequences.

## 0. Preconditions verified (HEAD reads)

- **No `TP_DAEMON_BIN` seam exists yet.** `apps/cli/src/lib/ensure-daemon.ts:114-124`
  selects the daemon binary (`process.execPath daemon start` compiled, or `bun run …/index.ts
  daemon start` dev). No env override analogous to `TP_RUNNER_BIN`. The final port increment adds it.
- **Rust CLI daemon `start` is a trampoline** (`rust/tp-cli/src/commands/daemon.rs:470-500` →
  `locate.rs:1-38` `locate_bun_blob()` → exec Bun SEA `tpd`). Dogfood daemon is always Bun today.
- **Bun surfaces (grep-confirmed, non-test):** `bun:sqlite` (`store/session-db.ts:1`,
  `store/store.ts:1`; ~14 call sites), `Bun.listen` (`ipc/server.ts:41,77`), `Bun.spawn`
  (`session/session-manager.ts:122`), `Bun.sleepSync` (`store/store.ts:289`), `node:os`
  (`pairing/pairing-orchestrator.ts:1`, `store/config.ts:2`), `import.meta.dir`
  (`session/session-manager.ts:89`), `spawnSync("git",…)` (`worktree/worktree-manager.ts:43,68,88`).
  Relay client uses the browser `WebSocket` global (`transport/relay-client.ts:252,333`) → port to `tokio-tungstenite`.

## 1. Dependency-ordered module decomposition (leaf-first — Tier N imports only < N)

### Tier 0 — pure leaves (zero intra-daemon deps)
`store/config.ts` (11), `store/schema.ts` (92 — **copy DDL+PRAGMAS byte-for-byte**),
`store/session-meta.ts` (27), `store/pairing-row-guard.ts` (135), `export-formatter.ts` (157),
`pairing/begin-pairing-error.ts` (11), `daemon-lock.ts` (162 — `O_CREAT|O_EXCL` pidfile + `kill(pid,0)`,
`rustix`), `lib.ts` (20).

### Tier 1 — store layer (**highest risk, §3**)
`store/session-db.ts` (108), `store/store.ts` (757 — LRU-32 `:71,207-226`, `unlinkRetry` 6× `:272-298`,
WAL sweep `:317-347`, `deletePairing` txn `:472-478`, `loadPushTokens` purge `:655-689`),
`store/index.ts` (4).

### Tier 2 — session + IPC transport + worktree
`session/session-manager.ts` (208 — `tokio::process`, generation guard `:151-170`),
`ipc/server.ts` (258 — `tokio::net::UnixListener`, dirent heal timer `:189-212`, `tp-core` codec),
`worktree/worktree-manager.ts` (383 — `spawn_blocking(Command::new("git"))` shell-out, `check-ref-format`
`:88`, `GIT_*` strip `:26-32`).

### Tier 3 — relay client (**highest risk — no Rust precedent**)
`transport/relay-client.ts` (1208 — `tokio-tungstenite` client + `tp-core` E2EE; peers `:256`, kx `:258`,
resume-token `:291-299`, reconnect throttle `computeReconnectPlan`, ping. `tp-relay` is the *server* side;
only its `resume_token.rs`/`push_seal.rs` value-formats cross-check).

### Tier 4 — orchestration mid-layer
`pairing/pending-pairing.ts` (252), `pairing/pairing-orchestrator.ts` (268), `push/push-notifier.ts`
(326 — `NOTIFY_EVENTS` gate `:25-29`), `transport/relay-manager.ts` (593 — client pool, `buildEvents`
`:106-272`, `removePairing` store-first `:440-492`, `reconnectSaved` `:400-430`).

### Tier 5 — dispatch + top orchestrator (port last)
`ipc/command-dispatcher.ts` (1328 — `dispatchIpc` 15 cases `:133-207` + `dispatchRelayControl` 14 cases
`:467-756`; the correctness junction), `daemon.ts` (594 — cyclic wiring `:88-172`, auto-cleanup `:205-273`),
`index.ts` (75 — entry: lock, argv, signals, `reconnectSavedRelays`).

### Highest-risk modules
1. **`store/store.ts`+`session-db.ts` (865)** — shared-file concurrency (§3).
2. **`transport/relay-client.ts` (1208)** — no Rust precedent; full E2EE client state machine; io
   binary-sidecar must survive encrypt→publish.
3. **`ipc/command-dispatcher.ts` (1328)** — 29 cases, all guards (stale-bye generation, `assertSafeSid`,
   worktree orphan-rollback, `session.export` off-by-one).
4. **`worktree/worktree-manager.ts` (383)** — parity-sensitive shell-out; live-session kill-on-force gate.
5. **`ipc/server.ts` (258)** — the dual-run contract surface (same `daemon.sock`; heal timer prevents split-brain).

## 2. Increment ladder (each = one reversible merge-able PR; dogfood daemon = Bun until the flip)

| inc | Scope | Gate | Size | Blocks |
|---|---|---|---|---|
| **1 ✅** | Scaffold `rust/tp-daemon` (lib only) + Tiers 0–1 (store on `rusqlite` 0.40 bundled) — **DONE** (branch `feat/tp-daemon-inc1-store`) | **store-DB bidirectional shared-file parity gate GREEN** (`store-rust-parity.test.ts`, 6 pass / 23 assert — Bun↔Rust interchangeable on the same on-disk SQLite: session/pairing/record BLOBs byte-identical, WAL sidecar unlink, WAL-mode PRAGMA parity; SKIP when `tp-daemon-probe` unbuilt) + `cargo test -p tp-daemon` 53 pass (LRU-32/cap-0/unlinkRetry/sweep/upsert-preserves-cursor) + `tp-proto` 39 pass (`assert_safe_sid`) | **L** | — |
| **2** | Tier 2: `ipc/server` + `session-manager` + `worktree` | async IPC round-trip (`tp-core` codec byte-exact) + worktree add/list/remove golden vs Bun fixtures + session generation-guard unit | **L** | 1 |
| **3** | Tier 3: `relay-client` (`tokio-tungstenite` + `tp-core` E2EE) | **relay-client dual-run gate** — real relay (`tp-relay` in-proc / `real-daemon-pair.ts --relay-url`), register→auth→kx→pub/sub→resume; **Bun frontend decrypts Rust-published frames** (E2EE cross-check); io `payload=''`; `computeReconnectPlan` unit parity | **XL** | 2 |
| **4** | Tier 4: pairing + push + relay-manager | pairing round-trip (begin→QR→fake-kx→complete→promote→persist row-match) + `NOTIFY_EVENTS`/token parity + `removePairing` store-first guard | **L** | 3 |
| **5** | Tier 5: `command-dispatcher` + `daemon.ts` + `index`→`main.rs` + **`[[bin]] tp-daemon`** (THIN, same `daemon.sock`) | **IPC dispatcher differential gate** (`dispatcher-rust-parity.test.ts`, new) — same frame sequence into Bun + Rust sockets, reply frames byte-identical mod non-determinism; covers all guards; SKIP when unbuilt | **XL** | 4 |
| **6** | **`TP_DAEMON_BIN` opt-in dual-run seam** (`apps/cli/src/lib/daemon-bin.ts` mirroring `runner-bin.ts` → `ensure-daemon.ts:114-124`; abs path, `X_OK`, throw-on-invalid, no silent Bun fallback; daemon-process-only trust boundary) | full `bun test ./packages/daemon` black-box vs Rust daemon (ADR §5 Stage-5 gate) + dogfood soak (real claude through pair→relay→session→store→push; verify io sidecar renders in Swift terminal); optional `TP_E2E_DAEMON_BIN=1` in `scripts/ios.sh` | **M** | 5 |
| **—** | *(SEPARATE, LATER — NOT the port)* default flip: build+package+brew-tap `tp-daemon`, point `ensure-daemon.ts` at it by default, retire Bun `tpd` daemon path | N× clean real-claude E2E (`TP_E2E_CLAUDE_M5`/`_CODING`/`_WEBPAGE`/`_PUSH`) + soak | **M–L** | 6 + E2E |

Critical path strictly linear (tiers import only lower tiers). Port (inc1–6) ≈ **6–7 person-weeks**.
The two XL increments (relay-client inc3, dispatcher inc5) carry the risk; each is gated by a
differential/dual-run parity test *before* it can influence dogfood. **The default flip is deferred behind
E2E evidence, mirroring the runner flip (task #8) — never bundled into the port.**

## 3. Store-DB shared-file strategy (load-bearing risk)

Rust daemon opens the same `<XDG_DATA_HOME>/teleprompter/vault/sessions.sqlite` (`store/config.ts:5-10`
+ `store.ts:94`) a still-Bun CLI (`tp session list/delete/prune`) and daemon write.

- **Handle model.** rusqlite `Connection` is not `Send`/`Clone`. Bun keeps one `metaDb` + LRU-of-32
  per-session `SessionDb` (`store.ts:79,71`). Port each to `Arc<Mutex<Connection>>` (ADR §3.3).
  Reproduce touch-on-access (`:187-205`) + close-on-evict (`:207-226`, cap-0 guard `:214`) with
  insertion-ordered structure (`indexmap` or `VecDeque<sid>`+`HashMap`) for identical eviction order.
- **PRAGMA parity — verbatim** from `schema.ts:82-92`: `journal_mode=WAL`, `synchronous=NORMAL`,
  `cache_size=-2000`, `busy_timeout=5000`, on **every** connection open (`store.ts:96-98`/`session-db.ts:21-24`).
  Dropping `busy_timeout` surfaces `SQLITE_BUSY` the Bun path never sees.
- **Migration safety — ADD-COLUMN-only, probe-before-ALTER.** Reproduce `store.ts:103-125`:
  `PRAGMA table_info` → skip existing-column ALTER; swallow duplicate-column race errors.
  `PAIRINGS_MIGRATIONS` (`schema.ts:41-47`) stays ADD-COLUMN-only; on-disk contract frozen
  ADD-COLUMN-compatible during dual-run (ADR §7).
- **Upsert semantics — byte-for-byte.** `createSession` `ON CONFLICT(sid) DO UPDATE` preserving
  `last_seq`+`created_at` (`store.ts:134-144`); `savePairing` `ON CONFLICT(daemon_id)` +
  `COALESCE(excluded.pairing_id, pairings.pairing_id)` (`:401-416`). A plain `INSERT OR REPLACE`
  would reset cursors / shift reconnect priority — port exact SQL text.
- **Self-heal — none omissible.** `deletePairing` 3-delete txn (`:472-478`) → rusqlite `transaction()`.
  `deleteSession` unlinks `.sqlite`/`-wal`/`-shm` (`:266-269`) with `unlinkRetry` 6× exp backoff
  (`:277-298`, `Bun.sleepSync`→`std::thread::sleep` in `spawn_blocking`). `sweepOrphanedSidecars`
  (`:317-347`), `loadPushTokens` corrupt-row PURGE (`:655-689`), `sweepOrphanedConfirmations`
  (`:558-562`) — omitting any = unbounded-accumulation regressions (backend-services.md). The inc1
  bidirectional gate proves all of this before any daemon runtime uses it.

## 4. OPEN DECISIONS

**Resolved (Dave, 2026-07-07) — gate inc1:**
1. **Start daemon inc1 now** ✅ — two backend ports (runner flip task #8 + daemon port) in flight
   simultaneously; daemon inc1–5 have no dependency on the runner flip.
2. **Bundled sqlite** ✅ — rusqlite `bundled` feature. Reproducible builds, no system-lib skew; WAL
   on-disk format compatible with Bun's linked sqlite regardless.
3. **Shell out to git** ✅ — `spawn_blocking(Command::new("git"))`, behavior-identical to the Bun
   `spawnSync` path (exact `--porcelain`/`check-ref-format`). Keeps the (already-required) git-binary dep.

**Deferred (non-blocking for inc1; re-confirm at the noted increment):**
4. **hook one-liner host dependency.** Runner's `bun -e` hook keeps Bun a runner-host dep (ADR §6.6).
   Interacts with when Bun can be removed (task #6), not the daemon port. Defer.
5. **`TP_DAEMON_BIN` seam location** — plan default: new `apps/cli/src/lib/daemon-bin.ts` →
   `ensure-daemon.ts` (selector runs under whatever CLI is live). Re-confirm at **inc6**.
6. **inc6 black-box gate CI-vs-local** — plan default: differential gates (inc1/5) CI-able
   (SKIP-when-unbuilt); full-suite black-box + soak local pre-merge (runner precedent). Re-confirm at **inc6**.

## inc1 parity-gate probe contract (`tp-daemon-probe`)

The bidirectional shared-file gate (`packages/daemon/src/store/store-rust-parity.test.ts`, written
2026-07-07) drives the Rust store through a tiny probe bin with a FIXED line-oriented CLI, so the TS test
never couples to internal Rust method names — it asserts only on-disk bytes + the probe's canonical-JSON
dumps. Build: `(cd rust && cargo build --bin tp-daemon-probe)`; SKIP-when-unbuilt (runner precedent).

```
tp-daemon-probe <cmd> <vaultDir> [args...]
  write-session  <vault> <sid> <cwd> <worktreeOrEmpty> <verOrEmpty>
  update-state   <vault> <sid> <state>
  append-rec     <vault> <sid> <kind> <ts> <ns|-> <name|-> <hexPayload>
  dump-sessions  <vault>                 → stdout canonical JSON array (sorted keys)
  dump-recs      <vault> <sid>           → stdout canonical JSON array (payload as hex)
  write-pairing  <vault> <daemonId> <relayUrl> <relayToken> <regProof>
                 <pubHex> <secHex> <secretHex> <label|-> <pairingId|-> <hostname|->
  dump-pairings  <vault>                 → stdout canonical JSON array (BLOBs as hex)
  delete-session <vault> <sid>
```
The probe bin lives at `rust/tp-daemon/src/bin/probe.rs` (a `[[bin]]` name = `tp-daemon-probe`, added
when the store lib API is final — NOT the shipping `tp-daemon` bin, which is inc5). It is a thin CLI over
the `Store` lib. This keeps inc1 "lib only" for the daemon proper while still giving the gate an executable.

## Critical files for implementation
- `packages/daemon/src/store/store.ts` · `store/schema.ts` (DDL+PRAGMA SoT)
- `packages/daemon/src/transport/relay-client.ts` · `ipc/command-dispatcher.ts`
- `packages/daemon/src/session/runner-parity.test.ts` (differential-gate template)
