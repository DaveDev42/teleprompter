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
  *(Shipped in **inc6 ✅** — `daemon-bin.ts` + `resolveDaemonSpawnCommand`; see the inc6 row.)*
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
| **2 ✅** | Tier 2: `ipc/server` (tokio `UnixListener`) + `session-manager` (tokio `Child` + generation guard) + `worktree` (sync `std::process::Command` git shell-out) — **DONE** (branch `feat/tp-daemon-inc2-tier2`) | **worktree Bun↔Rust differential parity gate GREEN** (`worktree-rust-parity.test.ts`, 5 pass / 22 assert — same op sequence through both impls against sibling `git init` repos: add/list structure + main-first order identical, escape-path REJECTED identically in both `add` and `remove`; SKIP when `tp-daemon-probe` unbuilt) + `cargo test -p tp-daemon --lib` **78 pass** (ipc decode-teardown/heal-rebind, session generation-guard restart-race, worktree containment-reject/gitEnv-strip/porcelain-parse) + `tp-proto` 42 pass (`socket_path`/`resolve_runtime_dir`). Bun daemon suite 443 pass (no regression). | **L** | 1 |
| **3 ✅** | Tier 3: `relay-client` (`tokio-tungstenite` `connect_async` + `tp-core` E2EE) — **DONE** (branch `feat/tp-daemon-inc3-relay-client`). ~1400 LOC `transport/relay_client.rs`: tokio reader/writer split-task port of the callback-style WS client; full self-register→auth→kx→N:N E2EE pub/sub→reconnect/resume state machine. Crypto ALL reused from `tp-core` (`seal`/`open`/`kx_server_session_keys`/`derive_kx_key`/`derive_pairing_confirmation_tag`); msgs reused from `tp-proto::relay_client` (outbound) + `tp-relay` (inbound). All 9 load-bearing props preserved (compute_reconnect_plan/throttle/resume/kx-race-fix/send-bool/best-effort-fanout/dispose-race/frame-fallback/err-handling). | **reconnect-policy differential parity gate GREEN** (`relay-client-rust-parity.test.ts`, 3 pass / 86 assert — same (attempt × peerless) + (current × hadPeer) grid through Bun `computeReconnectPlan`/`nextPeerlessReconnects` AND Rust via `tp-daemon-probe` verbs `reconnect-plan`/`peerless-next`: backoff curve + 30s cap + MAX_ATTEMPT clamp + dead-pairing throttle + counter arm/reset byte-identical; SKIP when probe unbuilt) + `cargo test -p tp-daemon` **88 pass** (10 new: reconnect grid, throttle, base64/uuid16/seal-random-nonce). Bun daemon suite 446 pass (no regression). **Full E2EE relay dual-run** (Bun frontend decrypts a live Rust-published frame) deferred within inc3 scope — transitively covered: the Rust client calls the same golden-vector-verified `tp-core` `seal`/`kx_server_session_keys`, so byte-exactness is already proven; the WS interop harness lands with inc4/inc5 when the client is wired into an actual daemon. | **XL** | 2 |
| **4 ✅** | Tier 4: pairing + push + relay-manager — **DONE** (branch `feat/tp-daemon-inc4-orchestration`). 4 modules ported: `transport/relay_manager.rs` (`RelayConnectionManager<D>` + `RelayManagerDeps` trait — per-pairing `RelayClient` pool, `build_events`, `remove_pairing` store-first, `rename_pairing`, `reconnect_saved`, `removing_daemon_ids` guard), `pairing/{pending_pairing,orchestrator,random_pairing_bundle}.rs` (single-slot `PendingPairing`, rank-1 `on_frontend_joined` guard decoupled via `tokio::spawn`, genuinely-random `StaticSecret::random_from_rng(OsRng)` pairing keypair — NOT the deterministic `kx_seed_keypair`), `push/notifier.rs` (`NOTIFY_EVENTS` + `tokenCount>0` gate, `build_push_message` incl. Notification title regex + code-point-safe truncation). Crypto/msgs reused from `tp-core`/`tp-proto`; store/session/relay-client reused from inc1/2/3. | **push-gate differential parity gate GREEN** (`push-notifier-rust-parity.test.ts`, 16 pass / 31 assert — same (eventName × tokenCount × payload) grid through Bun `interruptionLevelFor`/`buildPushMessage`+NOTIFY_EVENTS gate AND Rust via new `tp-daemon-probe push-gate` verb: shouldNotify + level + title + body byte-identical incl. multibyte truncation; SKIP when probe unbuilt) + `cargo test -p tp-daemon` **136 pass** (store-first, `removing_daemon_ids` guard, idempotent double-remove, rename, rank-1 guard, cancel-during-connect, NOTIFY/token gate). Bun daemon suite green (no regression). | **L** | 3 |
| **5 ✅** | Tier 5: `command-dispatcher` + `daemon.ts` + `index`→`bin/tp_daemon.rs` + **`[[bin]] tp-daemon`** (THIN, same `daemon.sock`; NOT the dogfood default) — **DONE** (branch `feat/tp-daemon-inc5-dispatcher`). 3 modules ported: `ipc/command_dispatcher.rs` (~3189 LOC incl. tests — `dispatch_ipc` + `dispatch_relay_control`, all 29 arms + every guard: stale-bye generation, `assert_safe_sid`, worktree `sanitize_for_sid` + orphan-rollback, worktree.remove live-session kill-on-force via `list_runners`/`wait_for_exit`, `session.export` off-by-one, unsubscribe-on-delete, doctor.probe throttled), `daemon.rs` (~1596 — cyclic slot wiring, pairing poll-watcher, `start_auto_cleanup` TTL/scheduler with panic-caught timer task, stale-running sweep, stop), `bin/tp_daemon.rs` (pid-lock singleton → `Daemon::new/start` → auto-cleanup → `reconnect_saved_relays` → SIGINT/SIGTERM). Reused inc1-4 Store/SessionManager/IpcServer/WorktreeManager/RelayConnectionManager/PairingOrchestrator/PushNotifier verbatim. **Parity bug caught by the gate + fixed**: inc3 `to_wire_session_meta` emitted absent `worktreePath`/`claudeVersion` as explicit `null`; TS `JSON.stringify` DROPS undefined keys → wire omits them (diverged every hello/state/export frame). Fixed Rust-side (omit-when-None) + tightened the inc3 unit test to assert key absence. | **command-dispatcher differential gate GREEN** (`dispatcher-rust-parity.test.ts`, 4 pass / 67 assert — **dispatcher-level** (honest: both sides drive the in-process dispatch seam with recording fakes, everything below the seam is real production code incl. real SQLite Store; IPC framing has separate `ipc/server` coverage): same input through real Bun `IpcCommandDispatcher` AND real Rust dispatcher via 4 new `tp-daemon-probe` verbs `sanitize-sid`/`dispatch-bye`/`dispatch-create-sid`/`dispatch-export` — reply frames + store side-effects + guard decisions byte-identical (rank-3 traversal reject, rank-4 export off-by-one incl. markdown `d` byte-exact, bye truth-table + stale-pid guard, sanitizeForSid grid); SKIP when probe unbuilt) + `cargo test -p tp-daemon` **184 pass** (16 daemon + 32 dispatcher + 136 pre-existing). Bun daemon suite 465 pass / 2 skip (no regression). | **XL** | 4 |
| **6 ✅** | **`TP_DAEMON_BIN` opt-in dual-run seam** — **DONE** (branch `feat/tp-daemon-inc6-daemon-bin`). Shipped: `apps/cli/src/lib/daemon-bin.ts` `resolveDaemonBinOverride` (mirrors `runner-bin.ts` exactly — unset/empty → `null`, `accessSync(X_OK)`, **throw-on-invalid with cargo-build hints, never a silent Bun fallback**; trust boundary = daemon-spawning process env only) + `ensure-daemon.ts` seam: the inline `[cmd, spawnArgs]` selection (was :114-124) extracted into pure exported `resolveDaemonSpawnCommand(env)` — override → `[<tp-daemon>, []]` with **NO `daemon start` subcommand** (the Rust bin IS the daemon: pid-lock → `Daemon::new/start` → auto-cleanup → signals; double-spawn = no-op exit-0 via the same pid-lock), absent-env → byte-identical pre-inc6 argv (compiled/dev branches unchanged); invalid override = loud contained exit inside `ensureDaemon()` (mirrors the `daemon.ts`/`passthrough.ts` `resolveRunnerCommandWithOverride` wraps). Socket parity CONFIRMED automatic — TS `getSocketPath()` ≡ Rust `tp-proto get_socket_path()` = `resolveRuntimeDir()/daemon.sock`; NO `--socket-path` flag added to the Rust bin. **Scope decision — foreground `tp daemon start` NOT wired**: it constructs `new Daemon()` in-process (`daemon.ts:161`), so honoring the override there would be exec-into-Rust-bin — structurally different from the runner precedent (spawn sites only) — and the soak reaches the Rust daemon without it (launch `tp-daemon` directly: socket+pid-lock parity routes every `tp` client through it; or holder-side selection à la `TP_E2E_RUNNER_BIN`'s `runnerCmd()`). `service-*.ts` (launchd/systemd) untouched — service daemon stays Bun until the flip PR. | Automated: `daemon-bin.test.ts` (5 — null on unset/empty, real-executable path, throw-missing incl. cargo hint, throw-non-exec) + `ensure-daemon.test.ts` `resolveDaemonSpawnCommand` (4 — absent==default byte-identical, empty fall-through, override `[bin, []]` with no daemon/start/bun tokens, invalid throws). Local (per §4 Q6, runner precedent): full `bun test ./packages/daemon` black-box vs Rust daemon (ADR §5 Stage-5 gate) + dogfood soak (real claude through pair→relay→session→store→push; verify io sidecar renders in Swift terminal). `TP_E2E_DAEMON_BIN=1` in `scripts/ios.sh` was DEFERRED here (not a cheap stub — the E2E holder spawns the daemon itself, needing holder-side daemon-binary selection + a positive-proof assert mirroring `build_rust_runner_bin`) → **delivered in flip-prep A2** below. | **M** | 5 |
| **A1 ✅** | *(flip-prep — E2E-independent mechanical prep, NOT the flip; changes NO default)* ship `tp-daemon` as a locatable release artifact + `locate_tp_daemon()`. `scripts/build.ts` `buildBundle()` gains a step 2b `cargo build --release --bin tp-daemon --target <t>` → `libexec/tp/tp-daemon` (alongside `tpd`; each target on its native CI runner). `scripts/install.sh` copies it **guarded** (`[ -f … ]` — a new installer against an old pre-A1 tarball must not `set -e`-abort). `rust/tp-cli/src/locate.rs` `locate_tp_daemon()` mirrors `locate_bun_blob()`'s 5-step ladder (`$TP_DAEMON_BIN` → `../../libexec/tp/tp-daemon` → sibling → dev fallback `<repo>/rust/target/release/tp-daemon` → hard error; same `is_self` guard) — **added `#[allow(dead_code)]`, NOT wired** (wiring it = the flip; the first real caller in the flip PR removes the allow). No CI/release.yml edit needed (`--workspace --all-targets` + `--bundle` already cover it). | Automated: 4 `locate.rs` unit tests (prefix-tree/sibling/dev-fallback geometry + not-found error names `TP_DAEMON_BIN`+Reinstall) + bundle round-trip (`tar tzf … | grep tp-daemon`, extracted member = executable arm64 Mach-O) + `bash -n install.sh` + `install-script.test.ts`. `cargo clippy --workspace --all-targets` 0 deny-errors (allow suppresses the unwired-fn `dead_code`). | **S** | 6 |
| **A2 ✅** | *(flip-prep — E2E-independent harness plumbing, NOT the flip; changes NO default)* `TP_E2E_DAEMON_BIN` daemon-parity gate — the daemon twin of `TP_E2E_RUNNER_BIN`, so the local real-claude soak can drive the Rust `tp-daemon` and POSITIVELY PROVE it did. `scripts/real-daemon-pair.ts`: `DAEMON_BIN` const (reads `TP_DAEMON_BIN`) + `daemonCmd()` (Rust → `[<tp-daemon>]` no subcommand; else `[bun, run, <cli>, daemon, start]`) replacing the single hardcoded daemon-spawn `cmd`; emits `DAEMON_PARITY_BIN=<path>` to stdout before spawn. `scripts/ios.sh`: `E2E_DAEMON_BIN` gate (implies `E2E_REAL`, orthogonal to claude gates, composable with `E2E_RUNNER_BIN`) + `build_rust_daemon_bin` (release→debug fallback, loud-die, mirrors `build_rust_runner_bin`) + `TP_DAEMON_BIN="$REAL_DAEMON_BIN"` literal env-prefix injection + `assert_daemon_parity` (7 call sites). **Positive proof is the PRIMARY discriminator** here (not a secondary check like the runner's io-row count): Bun↔Rust daemons are byte-identical on wire/store by design, so `grep -F DAEMON_PARITY_BIN=<path>` on the holder log is the sole guard against a silent Bun fallback; a `records≥1` store check confirms the substituted daemon actually served. Why holder-side (not the inc6 seam): the holder spawns the daemon directly, never via `ensureDaemon()`, and foreground `tp daemon start` doesn't honor the override (inc6 scope). | Automated: `bash -n scripts/ios.sh` + `real-daemon-pair.ts` parse/type-check + `biome check .` (0 new warnings) + `type-check:all`. The gate itself is local-only real-claude (never CI): `TP_E2E_CLAUDE_CODING=1 TP_E2E_DAEMON_BIN=1 [TP_PLATFORM=…] scripts/ios.sh smoke`. | **S** | 6 + A1 |
| **—** | *(SEPARATE, LATER — NOT the port)* default flip: point `ensure-daemon.ts`/`locate_tp_daemon()` at the now-shipped `tp-daemon` by default, retire Bun `tpd` daemon path | N× clean real-claude E2E (`TP_E2E_CLAUDE_M5`/`_CODING`/`_WEBPAGE`/`_PUSH` **× `TP_E2E_DAEMON_BIN`**) + soak | **M–L** | 6 + A1 + A2 + E2E |

Critical path strictly linear (tiers import only lower tiers). Port (inc1–6) ≈ **6–7 person-weeks**.
The two XL increments (relay-client inc3, dispatcher inc5) carry the risk; each is gated by a
differential/dual-run parity test *before* it can influence dogfood. **The default flip is deferred behind
E2E evidence, mirroring the runner flip (task #8) — never bundled into the port.** Flip-prep (A1: ship+locate
the artifact; A2: `TP_E2E_DAEMON_BIN` harness plumbing) is E2E-independent, CI/unit-verifiable, and lands
ahead of the flip so the E2E soak has a real Rust daemon to exercise — leaving only the one-line default
switch behind the gate.

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
5. **`TP_DAEMON_BIN` seam location** ✅ (re-confirmed at inc6) — as planned: new
   `apps/cli/src/lib/daemon-bin.ts` → `ensure-daemon.ts` (`resolveDaemonSpawnCommand`, background
   auto-spawn site). Foreground `tp daemon start` deliberately NOT wired (in-process `new Daemon()`
   construction — exec-into-Rust semantics belong to the flip PR); `service-*.ts` untouched.
6. **inc6 black-box gate CI-vs-local** ✅ (re-confirmed at inc6) — as planned: seam unit tests are
   CI-able (`daemon-bin.test.ts` + `ensure-daemon.test.ts` — no Rust build needed); full-suite
   black-box + dogfood soak stay local pre-merge (runner precedent). `TP_E2E_DAEMON_BIN` harness
   gate deferred (needs holder-side daemon-binary selection in `real-daemon-pair.ts`).

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

## inc3 scoping (relay-client — the XL, gate-carrying increment)

Scoped 2026-07-08 against HEAD (post-inc2). inc3 ports **`transport/relay-client.ts` (1208 LOC)** only —
`relay-manager.ts` (593 LOC, the per-pairing `RelayClient` pool + `reconnectSaved`) is **inc4**, not inc3.

**Two de-risking findings (both verified in-repo):**
1. **The WS client transport is NOT novel here.** `tp-relay/tests/{soak_10k,server_integration}.rs`
   already drive `tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream}` against a live
   server. `tokio-tungstenite = "0.29"` is already a workspace dep. So the daemon's outbound WS client
   is a *move-to-production* of a proven pattern, not a green-field transport. (tp-daemon must add the
   dep to its own `Cargo.toml`; tp-relay's is server-scoped today.)
2. **The E2EE surface is already complete in `tp-core` FFI.** Every crypto call `relay-client.ts`
   makes is exposed: `derive_relay_token` / `derive_kx_key` / `derive_registration_proof`
   (register+auth), `kx_client_session_keys` (ECDH from the frontend pubkey), `ratchet_session_keys`,
   `seal`/`seal_with_aad` (E2EE data + control frames), `derive_pairing_confirmation_tag` (PCT / WS v3).
   **inc3 is WS transport + reconnect/resume state machine + protocol framing — NOT crypto.**

**Where the risk actually lives — the reconnect/resume/dispose state machine** (this is what the inc3
gate must bite, mirroring inc1/inc2 discipline):
- **`computeReconnectPlan(attempt, peerlessReconnects)` is PURE and exported** (`relay-client.ts:95`) —
  port it as a free fn and pin it with a **parity UNIT test** (Bun table of (attempt, peerless) →
  {delayMs, throttled} vs Rust), the cheapest highest-value gate. Covers exponential backoff
  (`RECONNECT_BASE_MS * 2^n`, capped) AND the **dead-pairing peerless throttle**
  (`PEERLESS_RECONNECT_THRESHOLD=3` → `PEERLESS_RECONNECT_MS=30min`; the branch leaves `attempt`
  unchanged so a recovered pairing resumes fast backoff). Documented in backend-services.md
  "Dead-pairing throttle" — a reconnect-storm safety property, do not drop it.
- **resume fast-path** (`relay.auth.resume` w/ HMAC token, survives relay restart): `resumeToken` +
  `resumeExpiresAt`, `resuming` flag so an `auth.err` on a resume attempt schedules a *fresh full-auth*
  reconnect (`relay-client.ts:291-296`). Session keys persist across reconnects for this path.
- **dispose-race guards** (all in backend-services.md "RelayClient dispose-race guards"): `if
  (this.disposed) return` re-checks after the two await points (`deriveKxKey`, `broadcastDaemonPublicKey`);
  `scheduleReconnect`'s timer callback MUST `.catch()` (a rejecting `connect()` else kills the reconnect
  loop + leaks as `unhandledRejection`); `send()` returns a real transmitted-bool so `sendRename/UnpairNotice`
  don't over-count `notified`; `broadcastEncrypted` is per-peer best-effort (one peer's `encrypt()` throw
  must not abort the fan-out). Each has a source-only-revert regression test on the Bun side — the Rust
  port must preserve the *observable* behavior each asserts.
- **`isThrottled()` / `getRelayHealth`** surface the throttle state to `tp doctor` honestly (throttled ≠
  outage). Wire-optional `IpcDoctorRelayStatus.throttled` — reader treats absent as false (cross-version).

**inc3 gate = relay-client DUAL-RUN** (plan §2 inc3 row): a real relay (`tp-relay` in-proc, or
`real-daemon-pair.ts --relay-url`) drives register→auth→kx→pub/sub→resume, and a **Bun frontend decrypts
a Rust-published frame** (the E2EE cross-check — same shape as the runner wire-parity gate but over the
relay plane). Plus the `computeReconnectPlan` parity unit. io records publish with `payload=''` (the
sidecar-not-inline invariant). SKIP-when-unbuilt via the same `tp-daemon-probe` (add relay verbs) or a
dedicated harness bin — decide when the relay-client lib API is final.

## Critical files for implementation
- `packages/daemon/src/store/store.ts` · `store/schema.ts` (DDL+PRAGMA SoT)
- `packages/daemon/src/transport/relay-client.ts` · `ipc/command-dispatcher.ts`
- `packages/daemon/src/session/runner-parity.test.ts` (differential-gate template)
