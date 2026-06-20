# ADR-0003 — Phase 4 백엔드 Rust 이관 (staged, dual-run cutover)

- 상태: **Accepted** (2026-06-17, Dave) — **Stage 0 ✅ 완료** (2026-06-18, `tp-proto` 크레이트 + 106-케이스 골든벡터 green). **Stage 1 진행 중** (2026-06-19, [Amendment 1](#amendment-1-stage-1-downtime-ok-protocol-redesign-2026-06-19) 으로 dual-run-second-port → downtime-OK cutover 로 전환, 시크릿 공유 폐기, 21 redesign-now 채택). **A1.5 Step 1 ✅ (#707, LabelUpdate union)** + **Step 2 ✅ (`tp-relay` serde core, `RelayServerMessage` 11-variant + 40-케이스 골든)** + **Step 3 ✅ (handshake+resume+registry: binary versioned resume-token, `proof: Option<String>` sentinel, `relay.hello` 병합, `check_stale_daemons` TS-parity 2-phase 수정)** + **Step 4 ✅ (hot path: `Arc<Mutex<RelayCore>>` never-across-await 중앙상태, `VecDeque`+`Arc` 링버퍼, GCRA governor, axum WS per-conn actor, 121 lib + 10 loopback integration green)** + **Step 5 ✅ (push: `p256` 네이티브 P1363 ES256 JWT, `reqwest` H2+rustls `Arc` client + 429/5xx/network retry, tp-core seal 래퍼 `OsRng` fix, tagged `ApnsKey`, leak-free dedup eviction; tp-relay lib 174 green)** + **Step 6 ✅ (HTTP surface: `/health`+`/metrics`+`/admin` axum 라우터 단일 listener 공유, `metrics.rs` 12-counter `Arc<Metrics>` (RelayCore lock 밖 lock-free atomics), `build.rs` `TP_BUILD_SHA`/`TP_BUILD_TIME` 컴파일타임 주입(env→git→unknown), `/admin` bearer 게이트(`TP_RELAY_ADMIN_TOKEN` 미설정=404·불일치=401·constant-time `subtle`); tp-relay lib 187 + http_surface 3 + integration 10 green)** + **Step 7 ✅ (10k soak 하니스 — PR gate: `tp-relay/tests/soak_10k.rs` 파라미터화 concurrent 하니스 `#[ignore]` 기본, `TP_SOAK_CONNS`/`TP_SOAK_SECS` env 스케일, heavy=local full-10k / light=CI 1500×20s(`ci.yml` rust job), 세 차원(pub fan-out 0-drop + resume storm ~100% accept + push-under-load dedup/rate guard) + capacity 불변식 프로브(`/health` ok·`backpressure_disconnects==0`·`framesOut>=conns×frames`))** 완료; **Step 8a ✅ (relay 바이너리 entry `[[bin]] tp-relay`+`src/main.rs` THIN: `--port`/`RELAY_PORT`(flag wins)·`SharedState::from_env`·`serve_with_shutdown` SIGINT/SIGTERM graceful·시작로그 port+buildSha; 로컬 게이트 `scripts/rust-relay-e2e.ts` — cargo build --release bin → loopback 포트 ephemeral resume-secret 실행 → 격리 tp daemon(`real-daemon-pair.ts --relay-url`, 자체 mktemp XDG/HOME) register(`/health daemons>=1`+`/metrics relay_daemons_online>=1`) + frontend `relay.auth`→`relay.auth.ok` 프로브; production 무변경)** + **Step 8b ✅ (deploy pipeline: `deploy-relay.yml` Rust 전환 — `ubuntu-latest` native x86_64 `cargo build --release --bin tp-relay`(`TP_BUILD_SHA=github.sha`), base unit `ExecStart=/usr/local/bin/tp-relay`, 시크릿 drop-in `secrets.conf` 보존, `/health.buildSha==github.sha` assert, path 트리거 `rust/tp-relay,tp-proto,tp-core`, **flip-live-on-merge**))** + **Step 8c ✅ (live cutover — #716 머지 → deploy job green → `relay.tpmt.dev` 가 Rust relay `buildSha=7fee22a2` 로 전환, dogfood daemon(pid 73729) full-auth fallback 으로 자동 재연결(resume secret 미공유 — clean), 실 `tp` 세션 end-to-end 검증(framesIn 7→21·framesOut 3→7·bpDisc 0·drops 0·resumesRej 0, claude `CUTOVER_RELAY_OK` 왕복). ephemeral resume secret(drop-in 미설정) — push 는 APNs drop-in 추가 시 활성))**. **Stage 1 = 완료, Rust relay 프로덕션 라이브, TS relay 퇴역.** **[Amendment 2](#amendment-2--full-cli-port--bun-cli-퇴역-2026-06-20) (2026-06-20, Dave): CLI 전체 Rust 포팅 + Bun CLI 퇴역 확정** (daemon/runner/relay 서비스는 Bun 유지) — tranche 0(`rust/tp-cli` scaffold + `version` byte-parity) ✅, **tranche 1(read-only ladder 5-command) ✅** + **tranche 2(write/control via daemon IPC 4-command) ✅** + **tranche 3(interactive write — 3a session cleanup TUI + 3b pair new blocking + 합성 kx E2E) ✅** (2026-06-20) + **tranche 4a(completions install/uninstall rc write, #723) ✅** + **tranche 4b(doctor — 환경 진단 + relay IPC probe + tp-core E2EE self-test) ✅** (2026-06-20), tranche 4 잔여(daemon lifecycle: stop/status/install/uninstall·upgrade)–5(run/passthrough) 는 A2.4 잔여 결정 게이트(#2 write=daemon-up 강제로 결정됨; #1 PTY spike·#3 locate·#4 relay·#5 cutover 잔여). Stage 2–5 의 *비-CLI* 부분(Runner/Daemon 서비스)은 여전히 조건부.
- 결정자: Dave (제안: Claude Code 세션)
- 관련: [ADR-0001 §2.3](./0001-full-native-rewrite-swift-rust.md) (백엔드 최종 Rust 이관 = 후순위 Phase 로 이미 합의됨) 을 **구체화**한다. 이 ADR 은 그 "어떻게"를 staged plan 으로 박제한다.
- 근거 자료: 5-subsystem 적대적 서베이 워크플로 (`relay/daemon/runner/protocol/cli` 라이브 HEAD 리딩 + opus 합성, 2026-06-17). file:line 인용은 그 서베이 산출물에 grounding.

> **이 ADR 은 plan 만 승인받기 위한 것이다. 승인 전까지 어떤 런타임 컴포넌트도 코드 cutover 를 시작하지 않는다.** 승인 시 첫 머지 가능 증분은 **Stage 0 (메시지 타입 골든벡터) + Stage 1 (relay)** 로 한정되며, Stage 2–5 는 각 직전 stage 의 gate 통과를 조건으로 하는 *의도된 순서*일 뿐 지금 확정하지 않는다.

---

## 1. 맥락

ADR-0001 은 "앱 = Swift, 공유 코어 = Rust(`tp-core`), 백엔드(daemon/relay/runner)도 최종적으로 Rust 로 이관 — 단 포팅 완료 전까지 Bun 구현을 레퍼런스로 유지" 를 못박았다. Phase 2 에서 `tp-core` (wire codec + E2EE crypto + pairing) 가 골든벡터로 byte-exact 검증되며 **가장 어려운 정합성 리스크(E2EE byte-parity)는 이미 해소**되었다. Phase 3 (Swift 앱 parity) 가 끝났고, 이제 ADR-0001 이 예고한 백엔드 이관 = **Phase 4** 의 차례다.

대상 표면 (라이브 HEAD, 비-test `.ts` LOC):

| 컴포넌트 | LOC | 역할 |
|---|---:|---|
| relay (`packages/relay`) | 2,628 | stateless ciphertext WS forwarder |
| daemon (`packages/daemon`) | 5,391 | mux — session/store/relay-client/pairing/push/worktree |
| runner (`packages/runner`) | 763 | PTY + hooks (세션당 1개) |
| protocol (`packages/protocol`) | 4,271 | wire/E2EE SoT (상당 부분 이미 `tp-core` 로 이관됨) |
| cli (`apps/cli`) | 6,101 | `tp` 바이너리 (subcommand router) |

핵심 통찰: **모든 컴포넌트가 framed JSON 을 Unix 소켓/WS 로 주고받는다.** 따라서 어느 하나든 같은 wire 바이트를 생산/소비하는 한 **독립적으로 교체** 가능하다 — flag-day 빅뱅이 필요 없다. 5개 서베이가 독립적으로 같은 결론에 도달했다.

## 2. 결정 (제안)

1. **Big-bang 금지. staged + dual-run 만.** 각 stage 는 main 위에 머지 가능한 가역적 증분이며, 매 stage 마다 dogfood `tp` 파이프라인이 깨지지 않아야 한다.
2. **leaf-most / `tp-core`-overlap 최대 / 리스크 최소** 컴포넌트부터 포팅한다. 순서: **relay → CLI(read-only) → CLI(write/passthrough) → runner → daemon**. (relay 가 stateless 이고 절대 복호화하지 않아 second-port 로 가장 쉽게 dual-run 된다. daemon 은 모든 것을 오케스트레이션하고 SQLite 파일을 공유하므로 마지막.)
3. **byte-exact parity 의 backstop = 골든벡터.** crypto+codec 은 이미 `tp-core` 로 통과. 남은 것은 **메시지-레벨 JSON 벡터**(`message-vectors.json`: `relay.auth/kx/pub/control.rename/control.unpair` + version-gated `Label` 4-shape) — 이것이 **Stage 0** 이며 어떤 런타임 컴포넌트를 dual-run 하기 전에 green 이어야 하는 단일 hard 선행조건.
4. **Rust 워크스페이스 재사용.** `rust/Cargo.toml` 은 이미 워크스페이스다. 새 크레이트(`tp-relay`, `tp-daemon`, …)는 멤버로 추가되어 `tp-core` 를 의존한다. crypto/codec/pairing 을 다시 구현하지 않고 `tp-core` 를 그대로 쓴다.
5. **Bun 은 전환기 의존성으로 유지.** hook 의 `bun -e` one-liner 경로, 그리고 아직 TS 인 컴포넌트의 `bun build --compile` 파이프라인은 전환 동안 남긴다. 제거 시점은 나중에 결정.

## 3. 보존 불변식 (이관 후에도 byte-for-byte 유지)

ADR-0001 §3 및 `.claude/rules/{protocol,relay-capacity}.md` SoT 와 일치 — 포트가 위반하면 포트가 틀린 것:

- **wire = framed JSON** (`u32_be jsonLen + u32_be binLen + JSON + binary`, header 8B, max 64 MiB). IPC(runner↔daemon, cli↔daemon)·relay framing 공유. `tp-core` codec 이 이미 byte-exact.
- **relay = ciphertext-only / stateless / zero-trust.** `ct` 절대 복호화 안 함. 10-frame ring buffer 가 유일한 durability. (push-seal 은 좁은 예외 — APNs device token 만, 세션 데이터 아님.)
- **daemon 만이 relay 에 WS 클라이언트로 접속하며(페어링당 1 RelayClient 풀, `RelayConnectionManager.clients: RelayClient[]`) WS 서버를 열지 않는다.** CLI 는 직접 relay WS 를 열지 않는다 (pair-ops 는 cli→daemon IPC→relay).
- **relay URL = 페어링 번들에서 결정** (frontend 가 독립 설정 안 함). → relay 를 second-port 로 dual-run 할 때 daemon/app 코드 변경 0.
- **io record = binary sidecar** (`payload='' && binLen>0`). Rust 가 base64 인라인으로 바꾸면 daemon store + Swift terminal render 가 조용히 깨진다.
- **10k concurrent 용량 bar** (relay 단일 노드). 모든 relay 변경이 보존해야 함.

## 4. 가장 어려운 문제 (순위, 어려운 것부터)

1. **PTY / terminal spawn (runner).** `Bun.spawn({ terminal })` 단일 API 가 master/slave 할당 + controlling tty 설정 + raw 바이트 콜백 전달을 한다 (`pty-bun.ts:11-21`). **깨끗한 Rust 등가물 없음.** `portable-pty`(openpty + posix_spawn) 가 가장 근접하나 data 콜백이 전용 tokio reader task → 채널로 바뀌며 thread-hop + ANSI throttle 고려가 추가된다. `$TERM`(`name`) 명시 전파 필요. **단일 최대 미지수 — Stage 4 확정 전 spike 권장.**
2. **`bun build --compile` → cargo single-binary (cli + build).** 4-target `bun build --compile --minify`(`scripts/build.ts`) → `cargo build --target` + cross-rs/zigbuild + Linux MUSL. CI 매트릭스 대폭 변경. `$bunfs` compiled-vs-dev 감지(`spawn.ts:29-31`)는 완전히 사라진다(Rust 는 항상 compiled). UPX(Linux 전용) 단계는 그대로. dogfood `pnpm build:cli:local` → cargo-xtask/Makefile 등가물 결정 필요.
3. **daemon store DB.** Rust daemon 이 TS daemon 이 쓴 **동일 `sessions.sqlite`** 를 열어야 함. 스키마 마이그레이션 = ADD-COLUMN-only, WAL+`synchronous=NORMAL`+`busy_timeout=5000` 일치, LRU-of-32 `SessionDb` 핸들 close-on-evict 를 `Arc<Mutex<Connection>>` 로 재현(rusqlite 는 Clone/Send 아님), EBUSY unlink 재시도(6회 지수백오프). 기계적이지만 high-surface 이고 CLI 가 같은 파일을 직접 읽기도 한다.
4. **10k relay 용량 bar.** Bun 고유 3개 메커니즘에 Rust 등가물 없음: `idleTimeout`(커널 TCP idle close → per-conn `tokio::time::Interval` reset-on-message), `ws.getBufferedAmount()` backpressure(→ bounded `mpsc` per conn, `try_send` 실패=버퍼 소진 → WS 1013 강제 종료), 2-layer rate limit + slow-consumer disconnect. `TP_BUILD_SHA`/`TP_BUILD_TIME` 컴파일타임 주입(`build.rs`) 필요(`deploy-relay.yml` 이 `/health.buildSha == github.sha` assert). **10k soak = TS 가 이미 충족하는 새 gate.**
5. **git worktree (daemon).** `WorktreeManager` 가 `spawnSync` 배열 인자로 git 셸 호출 + `--porcelain` 파싱 + `check-ref-format` 검증. 포팅 갈림길: `spawn_blocking(Command::new("git"))`(정확한 동작 보존) vs `git2` 크레이트(git 바이너리 의존 제거하나 동작 분기). **shelling out 권장**(parity).
6. **OS-service install (cli).** launchd(plist + `launchctl bootstrap gui/<uid>` + bootout-wait + "error 5" 재시도) / systemd. 전담 크레이트 없음 — `Command::output()` 1:1 포트 + 문자열 템플릿. 지루하지만 low-risk.
7. **dual-run 중 byte-exact wire/E2EE parity (cross-cutting).** crypto+codec 골든벡터로 **대부분 de-risk 됨**. 남은 것: 메시지-레벨 JSON 벡터, 그리고 3개 공유-시크릿 seam — resume-token HMAC(`TP_RELAY_RESUME_SECRET` 공유, `b64url(payload).b64url(HMAC-SHA256)` byte-exact), push-seal(`TP_RELAY_PUSH_SEAL_SECRET[_PREV]`, daemon SQLite 의 기존 sealed 토큰을 Rust relay 가 unseal 가능해야), version-gated `Label` 디코더. (APNs ES256 는 오히려 Rust 가 *쉬움* — `p256` 이 P1363 직접 출력, `apns-jwt.ts` 의 수동 DER→P1363 불필요.)

## 5. 권장 staged cutover

> 원칙: 매 stage 후 `tp` 가 main 에서 계속 작동. leaf-most / `tp-core`-overlap 최대 / 리스크 최소 우선.

### Stage 0 — 워크스페이스 + 메시지 타입 parity (behavior 변화 0, cutover 0) — ✅ 완료 (2026-06-17)
- **포트:** serde 메시지 타입 enum + parse-boundary 등가물(`parseRelayClientMessage`/`parseIpcMessage`/`parseControlMessage`, 관대한 `Label` 디코더)을 `tp-core` 형제 크레이트로. 랜덤 `generate_keypair`(`OsRng`) 추가(`tp-core` 는 결정적 `kx_seed_keypair` 만 보유).
- **유지:** 모든 런타임 TS.
- **gate:** `message-vectors.json` — TS 직렬화 → Rust 필드별 역직렬화. `Label` 4-shape 호환 벡터(`''`, `'Office Mac'`, `{set:true,value}`, `{set:false}`, null). **첫 CI gate, 이후 모든 stage 의 선행조건.**
- **구현 결과:** `rust/tp-proto/` 형제 크레이트(host-only rlib, xcframework 미포함). 4개 파스 boundary 를 **수동 fallible parse**(`parse_*(&serde_json::Value) -> Option<T>`)로 포팅 — serde derive-deserialize 가 아니라 TS predicate 게이트를 순서대로 재현(null-vs-absent, 정수값 float `Number.isInteger(2.0)`, 관대한 `Label` legacy-string read 의 3개 발산을 정확히 보존). `scripts/gen-message-vectors.ts` 가 **라이브 `@teleprompter/protocol` 가드**를 import 해 accept/reject 벡터를 생성(`relayClient=25, ipc=54, control=9, label=18` = 106 케이스). `tests/message_vectors.rs` 가 각 raw 를 Rust 파서로 통과시켜 accept/reject parity + 직렬화 동등성을 검증(JS 의 단일 number 타입을 반영해 `Number(1)`==`Number(1.0)` 를 값 기준 `json_eq` 로 비교). **`cargo test -p tp-proto` = 22 unit + 4 golden green.** TS 런타임 변경 0 (git status = `rust/` + `scripts/` + `docs/` 만).

### Stage 1 — Relay (stateless, dual-run 가장 쉬움, 절대 복호화 안 함)
- **포트:** Rust relay (axum + tokio-tungstenite) relay protocol v2; resume-token HMAC; push-seal(`tp-core` BLAKE2b 재사용); APNs JWT + HTTP/2(`reqwest` http2).
- **유지:** daemon/runner/cli/app 전부 무변경.
- **seam:** Rust relay 를 **다른 포트**(TS 7090, Rust 7091). 테스트 daemon 이 `tp pair new --relay ws://localhost:7091` 로 페어. daemon 이 relay URL 을 번들에서 읽으므로 daemon/app 코드 변경 0. `TP_RELAY_RESUME_SECRET`+`TP_RELAY_PUSH_SEAL_SECRET[_PREV]` 공유 → TS 발급 토큰/sealed 토큰을 Rust 가 수락.
- **gate:** dual-run 검증(register→auth→kx→pub/sub→resume→push), `/health`+`/metrics` 비교, resume accept/reject + 10-frame cache parity; **production 트래픽 이동 전 10k soak**; 컴파일타임 `TP_BUILD_SHA` 로 `/health.buildSha == github.sha`.

### Stage 2 — CLI read-only 커맨드 (leaf, IPC-read + SQLite-read only)
- **포트:** `status`, `logs`, `pair list`, `session list`, `version`, `completions`(clap + clap_complete 가 수제 생성기 대체).
- **유지:** daemon(여전히 서비스), runner, relay, 모든 *write* CLI 경로.
- **seam:** Rust `tp` 를 `~/.local/bin/tp` 에 설치 → 라이브 Bun daemon 과 IPC 통신; `rm ~/.local/bin/tp` 로 즉시 brew Bun 바이너리 복귀. CLI 에 `RelayClient` 없음(불변식 보존).
- **gate:** 라이브 dogfood daemon 대상 smoke + IPC frame 골든벡터(io binary-sidecar + event base64).

### Stage 3 — CLI pair-ops + pair-new + passthrough
- **포트:** `pair delete`/`pair rename`(`requestDaemonOp` IPC — CLI 는 relay WS 안 엶), `pair new`(IPC 스트리밍 + ink QR-wait/multi-select 를 `ratatui`/`dialoguer` 로), `passthrough`(가장 어려움 — `crossterm` raw mode + `signal-hook` SIGINT forwarding + SQLite-WAL 50ms 폴). OS-service install(launchd/systemd) 도 여기.
- **유지:** daemon, runner.
- **seam/결정:** `passthrough.ts` 의 ephemeral in-process daemon 경로는 현재 `@teleprompter/daemon` 을 인라인 import — Rust 에선 CLI 가 별도 크레이트이므로 이 분기는 (a) drop(항상 daemon 실행 요구) 또는 (b) daemon 포팅까지 보류. **결정 필요(§6.2).**
- **gate:** passthrough smoke + 라이브 Bun daemon 통한 dogfood 세션.

### Stage 4 — Runner (PTY + hooks)
- **포트:** `portable-pty` PTY 라이프사이클, `tokio::net::UnixListener` hook receiver, `tp-core` codec IPC 클라이언트. `bun -e` hook one-liner 는 그대로 유지(bun 이 hot hook 경로 호스트 의존으로 남음) OR 정적 `tp-hook` 헬퍼 — **결정 필요(§6.6)**.
- **유지:** daemon(runner 를 서브프로세스로 spawn).
- **seam:** `PtyManager` 가 이미 `PtyBun` 뒤 추상화. daemon `SessionManager` 가 `TP_RUNNER_BIN` env 로 세션당 runner 바이너리 선택 → **단일 세션만 Rust runner 로 dual-run**, 나머지 TS.
- **gate:** io-record **binary-sidecar byte-exactness**(payload='' + binLen>0), event-record base64, PTY resize/signal smoke.

### Stage 5 — Daemon (마지막, 가장 복잡)
- **포트:** IPC 서버(`UnixListener` + length-delimited codec) → store(rusqlite, 동일 `sessions.sqlite`) → RelayClient 풀(tokio-tungstenite + `tp-core` E2EE + `CancellationToken` reconnect) → SessionManager(`tokio::process`) → PairingOrchestrator → PushNotifier → WorktreeManager.
- **seam:** daemon PID 락이 이미 이중 daemon 방지; CLI `ensureDaemon` 이 `TP_DAEMON_BIN` 으로 바이너리 선택. Rust daemon 이 **동일 소켓 경로 + 동일 SQLite 파일**(ADD-COLUMN-only, WAL pragma 일치)을 열어 (아직 TS 일 수 있는) CLI·runner 가 무변경 연결.
- **gate:** 전체 `bun test` 스위트를 Rust daemon IPC 서버 대상 black-box 로 실행; `daemon-pairing.test.ts`/`relay-client.test.ts`/`worktree-manager.test.ts` 골든 시나리오 검증; dogfood soak.

## 6. 리스크 & Dave 결정 필요 항목

1. **PTY 크레이트 — `portable-pty` vs `pty-process`?** 전자는 Bun 콜백 모델에 가장 근접(reader-task hop 추가); 후자는 더 low-level, tokio-native. **단일 최대 기술 미지수 — Stage 4 확정 전 spike.**
2. **CLI 가 TS 로 가장 오래 남나, 일찍 옮기나?** CLI 는 가장 깨끗한 leaf(IPC 만) + `~/.local/bin/tp` dogfood 슬롯으로 가장 안전한 dual-run → 일찍 옮기는 게 유리. 단 `passthrough.ts` 의 ephemeral in-process daemon 이 CLI 를 daemon 라이브러리에 결합 → ephemeral-daemon 을 drop(항상 daemon 요구)할지, daemon 포팅까지 CLI 를 TS 로 둘지.
3. **전환기에 `--compile` 용 Bun 유지?** 아직 TS 인 컴포넌트엔 `bun build --compile` 유지하고 포팅된 것만 cargo-build 할지, Stage 1 부터 cargo-xtask 빌드 프런트로 commit 할지.
4. **`git2` vs git 셸 아웃?** 셸 아웃이 `--porcelain` 파싱 + `check-ref-format` 동작 보존(최소 리스크); `git2` 는 git 바이너리 의존 제거하나 분기. **`spawn_blocking` 셸 아웃 권장.**
5. **rusqlite + 동일 store 포맷 동결?** dual-run 중 TS↔Rust 가 `sessions.sqlite` 핫스왑하려면 on-disk 포맷을 ADD-COLUMN-only 로 동결해야. sqlx 는 어차피 `spawn_blocking` 필요(SQLite 동기) → 단일-writer WAL 패턴엔 rusqlite 가 단순.
6. **hook 헬퍼: `bun -e` 유지 vs `tp-hook` 배포?** 전자는 runner 가 Rust 가 돼도 bun 이 모든 runner 호스트 런타임 의존으로 남음. 후자는 제거하나 배포 바이너리 추가. 보류 가능하나 배포 결정.
7. **크레이트 확정:** axum vs raw tokio-tungstenite(axum 이 `/health`/`/metrics`/`/admin` 도 서빙); `governor` vs 현재 fixed-window rate limiter; `reqwest` http2 vs `h2`+`hyper`(APNs); `ratatui`+`crossterm` vs `dialoguer`(CLI TUI — yes/no+multi-select 엔 dialoguer 가 훨씬 적은 코드).
8. **dual-run 중 resume-token/push-seal 시크릿 공유 동의?** in-flight 토큰이 트래픽 이동을 견디려면 TS·Rust relay 가 `TP_RELAY_RESUME_SECRET`+`TP_RELAY_PUSH_SEAL_SECRET[_PREV]` 를 공유해야 — Stage 1 무중단 cutover 의 필수조건.
9. **10k soak 하니스 소유자?** TS relay 는 오늘 bar 충족. Rust relay 는 production 이동 전 **새 soak/load gate** 필요 — 누가 구축하나.

## 7. 이 ADR 이 아직 commit 하지 않는 것

- **빅뱅/flag-day 재작성 금지.** 모든 I/O 가 framed JSON over Unix소켓/WS 라 flag-day 불필요 — staged dual-run 만 commit.
- **최종 크레이트 선택 미확정** (PTY 크레이트, git2-vs-shell, axum-vs-tungstenite, ratatui-vs-dialoguer, reqwest-vs-h2). spike-gated 결정으로 둠 — 특히 PTY 크레이트는 Stage 4 일정 전 PoC.
- **타임라인 / "모든 서브시스템이 Rust 가 된다" 미확정.** 첫 머지 가능·가역 증분 = **Stage 0 + Stage 1**. Stage 2–5 는 *의도된 순서*, 각각 직전 gate 통과 조건부.
- **Bun 호스트 제거 미확정** (`bun -e` hook 경로, 전환기 `--compile` 파이프라인). 전환기 의존성으로 유지, 제거는 나중.
- **ephemeral in-process daemon drop / `passthrough` ephemeral 포팅** 은 §6.2 결정 전까지 미확정.
- **on-disk SQLite 계약을 영구 불변으로 동결하지 않음** — dual-run 동안 ADD-COLUMN 호환만 commit.

## 8. 대안 (기각)

- **빅뱅 재작성 (전 백엔드 동시 Rust 전환).** dogfood 파이프라인을 무기한 깨고 가역 불가. 기각.
- **`git2` / 순수 라이브러리로 동작 분기.** parity 리스크 증가 — 셸 아웃이 레퍼런스 동작 보존. 기각(단 §6.4 재확인 대상).
- **base64 인라인으로 io record 통일** (binary sidecar 제거). daemon store + Swift terminal 조용히 깨짐 — 불변식 위반. 기각.

---

**다음 행동:** Stage 0 (메시지 타입 골든벡터 크레이트) ✅ 완료. 다음은 **Stage 1 (Rust relay)** — `tp-core` codec/E2EE 를 재사용하는 axum+tokio-tungstenite relay protocol v2 포팅. **§6.7~6.9 + 와이어 재설계 결정은 [Amendment 1](#amendment-1-stage-1-downtime-ok-protocol-redesign-2026-06-19) 에서 확정됨.**

---

## Amendment 1 — Stage 1 downtime-OK protocol redesign (2026-06-19)

- 상태: **Accepted** (2026-06-19, Dave). 이 amendment 는 본 ADR 의 §2.2/§3/§6.5/§6.8 을 **Stage 1 에 한해** 갱신한다. Stage 2–5 는 영향 없음.
- 근거 자료: 47-에이전트 적대적 서베이 워크플로 (relay-server / wire-envelope / push-apns / resume-token / pairing-e2ee 5개 영역 라이브 HEAD 리딩 → 41 후보 wart 적대적 심사 → opus 합성, 2026-06-19). file:line 인용은 그 산출물에 grounding.

### A1.1 무엇이 바뀌었나 (Dave 지시)

> **"다운타임을 용인하더라도 프로토콜을 더 올바르게 재설계해도 좋아."** (2026-06-19, Dave 원문)

이 latitude 가 Stage 1 의 전제를 바꾼다. **핵심은 "와이어를 마음껏 깨도 된다"가 아니라 — §6.8 의 dual-run-second-port 무중단 cutover 요구가 사라진다는 것이다.** 그 요구가 시크릿 공유(§6.5/§6.8)의 유일한 근거였으므로, downtime 을 허용하면 **clean reissue 가 더 단순하고 안전**하며, 그것이 resume-token 의 binary+versioned 재설계까지 풀어준다.

### A1.2 §6.7–6.9 결정 (확정)

- **§6.7 크레이트 스택 (확정):** `axum` (WS upgrade + `/health`·`/metrics`·`/admin` 단일 라우터) + `tokio-tungstenite` (per-conn read/write split) + `reqwest` (http2, APNs) + `governor` (GCRA rate limit, fixed-window 대체) + `rustls` (no-openssl TLS) + `p256`/`ecdsa` (APNs ES256, P1363 직접 출력) + `serde`/`serde_json` (수제 guard 레이어 대체). `governor` 는 "후보"에서 "채택"으로 — fixed-window 재설계가 곧 governor 도입이다.
- **§6.8 시크릿 공유 (역전 — 폐기):** downtime-OK 가 dual-run-second-port 를 불필요하게 만들므로 **`TP_RELAY_RESUME_SECRET` / `TP_RELAY_PUSH_SEAL_SECRET[_PREV]` 공유 안 함.** cutover 시 둘 다 **새로 발급(reissue)**. 미결제 4-part TS resume 토큰은 verify 실패 → 기존 full-auth fallback 경로로 흡수. SQLite 의 sealed push 토큰은 무효화 → frontend 가 앱 재오픈 시 1회 재등록 (`push_tokens` force-expire; downtime 창에 정렬된 1회·경계 있는 누락).
- **§6.9 10k soak 하니스 (소유자 확정):** **Claude (이 세션) 가 Stage 1 PR scope 로 구축, PR merge gate.** soak 은 capacity gate 이지 parity gate 가 아니다 — 어떤 재설계도 10k bar 를 낮추지 않는다 (governor 는 더 보수적; VecDeque+`Arc` fan-out 은 개선; atomic gauge 는 per-scrape O(n) 스캔 제거). soak 은 재설계 후의 resume + push 경로도 부하에서 검증해야 한다.

### A1.3 채택한 와이어 재설계 (downtime-OK 가 정당화)

본 ADR §3 의 "byte-for-byte 유지"는 **Stage 1 에 한해 아래 항목에서 완화**된다. 나머지 모든 와이어/E2EE 불변식은 유지 (relay ciphertext-only/stateless, daemon=relay 유일 클라이언트, framed JSON, io binary-sidecar, 10k bar, `tp-core` crypto/codec 골든벡터).

1. **Label 구조적 재설계 (app-facing 와이어 깸).** `decodeWireLabel` vs `decodeKxLabelOrKeep` 가 `{set:false}` 를 반대로 해석 → **재접속 kx-hello 가 사용자 label 을 조용히 지우던 실제 버그.** `LabelUpdate { Set(String), Clear }` enum 으로 두 표면(`control.rename`, kx-hello) 통일 + `wireLabel as Label` unsound cast 제거 + **v1 version-gate 통째 삭제(코드 순감소).** blast = relay+daemon+app.
2. **resume-token binary+versioned (relay-internal, 와이어 opaque).** HMAC-SHA256 + dot-delimited text → `tp-core` BLAKE2b + binary 5-part (`v.role.did.fid.exp`). dot-delimiter collision footgun 제거 + 누락된 payload-version discriminant 추가. 토큰은 `{token: string}` 으로 daemon/app 에 opaque → 실질 blast = relay-only. reissue 와 짝.
3. **`relay.kx` outer `role` drop.** 검증 후 버려지는 dead field (`relay-server.ts:1058` 은 인증된 `client.role` 사용, `msg.role` 무시). serde role-dispatch 로 JSON 동일하나 send-side footgun + guard branch 제거.
4. **`relay.hello` (register+auth 2-RTT 병합).** cold-connect 1-RTT 절감. proof-sentinel(`null` vs `""`) 로직을 신중 포팅 — different-credentials-guard 회귀 위험을 parity 테스트로 가드.
5. **`v<2` 거부 enforcement.** 와이어 깸 아님 — 존재하지 않는 클라이언트에 대한 거부만 *추가*. `relay_auth_version` 메트릭과 짝.

### A1.4 채택한 relay-내부 수정 (와이어 무변경, 전부 채택 — "처음부터 제대로")

Rust 로 올바르게 쓰면 자동으로 따라오는 것들. 와이어/앱 무변경, blast = relay-only:

- **GCRA `governor`** (fixed-window 경계 2x burst 제거) · **`VecDeque`+`Arc<CachedFrame>` 링버퍼** (`shift()` O(n) → pop_front O(1), fan-out 시 ciphertext clone 회피) · **`p256` 네이티브 P1363** (`apns-jwt.ts` 수제 DER 변환 42줄 삭제) · **seal 임시키 `OsRng`** (`push-seal.ts:65` `Math.random()` 버그 수정) · **APNs 429/5xx retry** (backoff+jitter+Retry-After) · **per-op metrics** (kx/pub/sub/push/presence counters + `AtomicU64`/`AtomicI64` gauge) · **`/admin` bearer 게이트** (현재 토폴로지 무인증 노출 — 보안 wart) · **3-struct dual-map → 2-struct** (`proof` 를 `DaemonState` 로, `registrations` 제거) · **수제 guard 6모듈 → serde derive** (~1,425줄 소멸, JSON 동일) · **dead `Envelope` catch-all 미포팅** (per-variant enum) · **`RelayAuth.frontendId` role-tagged enum** (typed-optional → 구조적 required, JSON 동일) · **nested `recentFrames` map** (per-daemon 제거 O(1)) · **presence `sessions` → `[]`** (앱이 이미 discard).

### A1.5 Stage 1 실행 계획 (gate 포함)

| # | 단계 | gate |
|---|---|---|
| 0 | 이 amendment (downtime-OK, 시크릿 reissue, 재설계 shortlist, governor/p256 확정) | Dave 승인 ✅ |
| 1 | 재설계 shape 의 message-vector 골든 확장 (serde-동일 `relay.kx`/`relay.auth`, 새 `LabelUpdate`; resume-token binary 는 relay-internal 자체 골든) | 골든 green; TS 인코더가 새 Label shape emit — **✅ #707** (`LabelUpdate` Set/Clear union, v1 label-gate 삭제, `labelUpdate` 8-케이스 골든; lefthook rust-hook PATH 픽스 동봉) |
| 2 | Rust relay core: framing + serde 구조체/enum (guard 레이어 없음), `tp-core` codec/E2EE 재사용; dead `Envelope` drop | `cargo test` 라운드트립 vs 골든; `deny_unknown_fields` parity — **✅** (새 `tp-relay` 크레이트: `RelayServerMessage` serde-derive tagged enum 11 variant, tp-proto `Role`/`Platform`/`InterruptionLevel`/`PushData` 재사용, `relayServer` 40-케이스 골든 + 라운드트립 테스트. `deny_unknown_fields` 는 **의도적으로 미적용** — TS `relay-server-guard.ts` 가 unknown-field 를 silently drop 하므로 parity 상 추가하면 발산; 미래에 reject 하는 메시지 도입 시 해당 struct 에만 추가. axum/tokio 는 Step 3+) |
| 3 | handshake + resume + registry: 2-struct `DaemonState`, binary versioned resume-token, `v<2` 거부 + version metric, **`relay.hello` 병합** | parity: hello→kx→pub/sub→**resume accept/reject**; nested-map eviction; timing-safe HMAC — **✅** (`registry.rs` 2-struct `DaemonState`+`Registration`, `proof: Option<String>` (`None`=null sentinel, `Some("")`≠sentinel — different-credentials guard 보존), sessions cap 256 oldest-drop; `resume_token.rs` `tp-core` BLAKE2b binary 5-part `v.role.did.fid.exp`+constant-time `ct_eq`, `TP_RELAY_RESUME_SECRET`≥32 else ephemeral, 8-케이스 자체 골든; `handshake.rs` `handle_register/auth/auth_resume/hello`, `relay.hello` register+auth 병합, `v<2` 거부+`VERSION_MISMATCH_COUNT`. **`check_stale_daemons` 2-phase 가 `relay-server.ts:1554-1560` parity 로 수정**: Phase 1 은 `online=false` 만 — `last_seen` 미변경(daemon-traffic-only invariant 보존, eviction clock 을 마지막 daemon 트래픽에 anchor), `StaleCheckResult{newly_offline,evicted}` 반환으로 Step-4 WS 레이어가 online→offline presence broadcast 가능. 83 lib + 8+8 골든 테스트 green) |
| 4 | hot path: `VecDeque`+`Arc` 링버퍼, GCRA governor (per-client 500 + per-daemon-group 5000), slow-consumer 1013, idle-timeout `Interval`, presence `[]` | 2-layer rate-limit; slow-consumer disconnect; 10-frame cache replay parity — **✅** (중앙상태 async 아키텍처: `Arc<Mutex<RelayCore>>` (std mutex, **never hold across `.await`**), 라우팅은 lock 아래 동기 결정→`Vec<Action>`, 배달은 per-conn bounded mpsc(cap 512) `try_send`(Full→1013 close, Closed→silent drop). `ring.rs` `RecentFrames`=`HashMap<"did:sid", VecDeque<Arc<Frame>>>` (push_back+pop_front O(1) trim, `replay_after` seq>after Arc-clone, exact-prefix `purge_daemon`); `rate.rs` `Limiter`=`governor` GCRA direct (burst==quota, no 2x window-boundary); `server.rs` 동기 라우팅 결정 fns(`route_publish`/`route_key_exchange`/`route_subscribe`/`route_ping`/`presence_actions`/`register_authed_conn`/`handle_close`) TS `relay-server.ts` parity (pub fan-out=구독한 daemonGroup non-sender·역할필터 없음, `from`+`frontendId`(frontend발신만), frame 항상 캐시, sessions/lastSeen 갱신은 role=daemon 만; kx=반대역할만 broadcast; presence=group 내 frontend, sessions=`[]`; rate-exceed→`relay.err{RATE_LIMITED}` DROP no-close; authed `relay.ping` rate-exempt); `conn.rs` axum WS upgrade(single GET `/`)+per-conn actor(write task + read loop, auth 10s→1008 / idle 90s close, 1MiB frame cap→1009, `biased` select! 로 close-code/auth-deadline race 제거, `idle.reset()`=relay-protocol Text 메시지에만, teardown=close 지시 송신→outbox drop 순서). plain-text JSON 와이어. 121 lib + 10 loopback integration(daemon/frontend auth·presence, kx 양방향, pub/sub fan-out, after-cursor replay, resume reject, rate-limit drop no-close, unknown-type, unauth-ping-no-pong, daemon-disconnect offline presence, backpressure 1013) green) |
| 5 | push: `p256` JWT, `reqwest` H2 `Arc` client, APNs retry, `OsRng` seal, tagged `ApnsKey`, lazy dedup eviction | seal 라운드트립+rotation; APNs retry(429/5xx); dead-token `PUSH_TOKEN_DEAD` parity — **✅** (4 모듈: `apns_jwt.rs` ES256 JWT `p256::ecdsa` 네이티브 P1363(`Signature::to_bytes()` 64B — TS 수제 `derToP1363` 42줄 미포팅), tagged `ApnsKey{Pem,Path}` PKCS#8 `.p8`, 50min 토큰 캐시, JWT 헤더/클레임 키순서 TS `JSON.stringify` byte-exact(serde BTreeMap 알파벳순 회피 — `b64url_obj` 고정순서 + 골든 어서션); `push_seal.rs` `PushSealer` tp-core `derive_push_seal_key`/`seal_with_aad`/`open_with_aad` 래퍼(byte-exact layout 검증 + `ts_cross_vector_contract`), `tpps1.<ver>.<b64(nonce24‖ct)>`, version rotation(current/prev), 4-outcome unseal, **`OsRng` seal**(TS `push-seal.ts:65` `Math.random()` 약 RNG 버그 수정 — ephemeral secret + per-seal nonce 둘 다 CSPRNG); `apns.rs` `ReqwestTransport` H2-prior-knowledge+rustls `Arc<Client>`, `Transport`/`Sleeper` 주입 seam(네트워크 없는 테스트), **APNs 429/5xx+네트워크오류 retry**(exp backoff+`OsRng` jitter+`Retry-After` 초 파싱; 비-dead 4xx/400/410 미재시도); `push.rs` `PushService` sendOrDeliver 우선순위(ws>dedup>rate>apns), 성공시에만 dedup/rate 기록, M14 만료윈도우 리셋, leak-free window-expiry eviction, `DeliveryResult` 6-variant. 워크플로 adversarial verify 가 apns.rs 2 blocker/major(Retry-After dead-code, 비-dead 4xx 오재시도) 발견→repair; tp-relay lib 174 + 골든 green. CA-roots = reqwest 기본 system store(Apple CA 공개신뢰 — webpki 핀은 후속 hardening)) |
| 6 | HTTP surface: `/health`+`/metrics` (per-op counter, atomic gauge, `build.rs` `buildSha==github.sha`), `/admin` bearer | `/health`+`/metrics` 필드 비교 vs TS; `TP_BUILD_SHA` assert — **✅** (`metrics.rs` `Metrics` 12 `AtomicU64` (`framesIn`…`resumesRejected`) snake_case 미러 + `inc_*` Relaxed + `snapshot()`→plain `MetricsSnapshot`; scattered static 정리: `conn::OVERSIZED_DROPS` fold-in(per-state `Arc<Metrics>`, free reader 삭제), `handshake::VERSION_MISMATCH_COUNT` 은 `/metrics` 카운터 아님(`relay.hello` 미배선 → snapshot 제외, 그대로 둠). `Arc<Metrics>` 를 `SharedState` 에 (RelayCore lock 밖) → HTTP 핸들러/emit-site 모두 lock 안 잡고 atomic R/W. 12 emit 배선: `frames_in`(oversize 가드 뒤 parse 전, ts:648), `frames_out`(deliver `try_send` Ok, ts:619), `rate_limited_drops`/`daemon_rate_limited_drops`(2-layer 분리 — 별도 메시지 "Too many…"/"Daemon group budget…", ts:688/697), `backpressure_disconnects`(1013 close, ts:606), `auth_timeouts`(auth deadline, ts:522), `oversized_drops`(ts:636), `unknown_type_drops`(ts:675), `evictions`(stale_sweep evicted 당, evictDaemon), `resumes_attempted/accepted/rejected`(AuthResume 진입/AuthOk/fallthrough, ts:889/947/892·911). `http.rs` 3 라우트 = `conn.rs` `router()` 동일 axum Router/listener 에 체인: `/health` 수제 JSON 키순서 TS-exact(`status,buildSha,buildTime,protocolVersion,clients,pendingAuth,daemons,sessions,attached,uptime,metrics`), `/metrics` 17 라인 TS 순서+trailing `\n`+`text/plain; version=0.0.4`(TS 와 동일하게 17 — brief '18' 오기), `/admin` HTML escapeHtml(daemon id + 각 session id) **+ bearer 게이트 재설계**(`TP_RELAY_ADMIN_TOKEN` 미설정→404 closed-by-default, 불일치/부재→401, `subtle::ConstantTimeEq` constant-time). `build.rs` `TP_BUILD_SHA`(env→`git rev-parse --short HEAD`→`unknown`)/`TP_BUILD_TIME`(env→`SOURCE_DATE_EPOCH` RFC3339→`unknown`) 컴파일타임 주입 + `rerun-if-env-changed`; 바이너리는 `env!` 로 read. 테스트: metrics snapshot 라운드트립, /metrics 17라인+순서+CT, /health 키순서, /admin 게이트 매트릭스(404/401/200+escape), build 상수 non-empty. lib 187 + http_surface 3 + integration 10 green) |
| 7 | 10k soak 하니스 (pub fan-out + resume + push 부하) | **10k soak green — PR gate — ✅** (`tp-relay/tests/soak_10k.rs` 파라미터화 concurrent 하니스, `#[ignore]` 기본(일반 `cargo test --workspace` 는 수천 소켓 안 엶). ONE 코드 경로를 env 로 스케일 — `TP_SOAK_CONNS`(기본 10_000)/`TP_SOAK_SECS`(기본 60)/`TP_SOAK_JSON`. **heavy=local(full 10k, on-demand) / light=CI(1500×20s, `ci.yml` rust job `cargo test --workspace` 뒤 step, `ulimit -n 65535`)**. 세 차원: (a) PUB FAN-OUT — daemon 1 + frontend N 동일 sid 구독, M frame publish → 전 frontend 가 M 전부 수신(0 drop), well-behaved consumer 1013 死 없음, `/health.status==ok`, `/metrics framesOut>=conns×frames`; rate-knob caveat (b) 채택 — `SharedState` tweak 로 `rate_per_client`/`rate_per_daemon` effectively-unbounded(fan-out delivery 격리, GCRA 자체는 별도 통합테스트) + `outbox_cap` 키움. (b) RESUME STORM — N auth → resumeToken 캡처 → drop → 재연결 → `relay.auth.resume` → ~100% `resumed:true`, `resumes_rejected==0`(daemon storm 내내 online). (c) PUSH UNDER LOAD — WS push no-op 이라 `PushService` API 레벨; fake `TransportDyn`(HTTP200) + 실 `ApnsSigner`(런타임 p256 PKCS#8)로 Step6(dedup+rate commit-on-success)까지 도달 → 동시성 하 guard mutex leak/deadlock 없음 (honest scope: 네트워크/APNs 테스트 아님). HARD failure(프레임 누락/resume reject/push leak)에서만 fail. `rust` job 은 non-required 라 flaky soak 이 무관 PR 막지 않음. 게이트: fmt+clippy+`cargo test --workspace` green(soak `#[ignore]` 로 일반 run 제외), light tier 로컬 green) |
| 8 | downtime cutover — **3개 서브스텝으로 분할** (8a local gate → 8b deploy pipeline → 8c live flip) | 아래 행별 gate |
| 8a | **바이너리 entry + 로컬 E2E ✅** — `rust/tp-relay` 에 `[[bin]] tp-relay` + `src/main.rs` (THIN: `--port`/`RELAY_PORT` env(flag wins, default 7090), `SharedState::from_env`, `serve_with_shutdown` SIGINT/SIGTERM graceful drain, 시작 로그=port+buildSha). 로컬 게이트 = `scripts/rust-relay-e2e.ts` (cargo build --release bin → free loopback 포트에 ephemeral `TP_RELAY_RESUME_SECRET` 로 실행 → **격리 tp daemon**(`real-daemon-pair.ts --relay-url`, 자체 mktemp XDG/HOME — dogfood 무관) 페어링 → `/health daemons>=1`+`/metrics relay_daemons_online>=1` 어서션 → frontend-role `relay.auth`→`relay.auth.ok` 프로브). **production 무변경**(relay.tpmt.dev/deploy-relay.yml/실시크릿 미접촉) | **✅** — 실 격리 daemon 이 Rust relay 바이너리에 register + frontend-auth ok. honest scope M0(register)+M2(frontend auth); kx(M3)/session(M4)/input(M5) 은 spawn 된 claude 세션 필요 → 8a 범위 밖. orphan 0·dogfood daemon 무손상 |
| 8b | **deploy pipeline ✅** — `deploy-relay.yml` 을 Rust 바이너리로 전환: `ubuntu-latest`+`dtolnay/rust-toolchain@1.96.0`+`Swatinem/rust-cache` 로 `cargo build --release --target x86_64-unknown-linux-gnu --bin tp-relay`(x86_64 Vultr = native), `TP_BUILD_SHA=${github.sha}` build-env(→`/health.buildSha` verbatim full 40-char), SCP `/tmp/tp-relay` → 호스트, base unit `ExecStart=/usr/local/bin/tp-relay`(별도 바이너리, `tp relay start` 아님)+`RELAY_PORT=7090`, **시크릿은 base unit 이 아니라 drop-in `/etc/systemd/system/tp-relay.service.d/secrets.conf` 에**(deploy 가 안 건드림 → base unit rewrite 가 시크릿 안 지움), `sha256(/usr/local/bin/tp-relay)` 온디스크 검증 + `/health.buildSha==github.sha` assert(`curl --retry`), `timeout-minutes:30`. **path 트리거 = `rust/tp-relay,tp-proto,tp-core,Cargo.lock`+자기자신**(TS relay 트리거 제거 — TS relay 퇴역). **flip-live-on-merge: `rust/tp-relay/**` 변경이 main 머지되면 production(relay.tpmt.dev) 자동 cutover**(downtime-OK) | CI lint/test green + 머지 시 deploy job `/health` ok·buildSha 일치 (8c 와 합쳐 라이브 검증) |
| 8c | **live cutover ✅** — #716 머지(`7fee22a2`) → deploy job green(`/health.buildSha==github.sha` assert 통과) → `relay.tpmt.dev` 가 Rust relay 로 전환. dogfood daemon(pid 73729, cutover 내내 동일 프로세스)이 **full-auth fallback** 으로 자동 재연결(resume secret 미공유 — TS 4-part 토큰 verify 실패 → 재인증, 코드 변경 0). **사용자 선택 = no secret reissue → ephemeral resume secret**(drop-in 미설정; push 는 APNs drop-in 추가까지 비활성) | **✅** — 실 `tp` 세션 end-to-end: `tp`→daemon→Rust relay→claude→records 왕복(`CUTOVER_RELAY_OK`), framesIn 7→21·framesOut 3→7·backpressureDisconnects 0·drops 0·resumesRejected 0, daemon 연결 안정(3× 샘플 daemons=1 무flap) |

### A1.6 Label 재설계가 건드리는 app/daemon 사이트 (Stage 1 의 유일한 cross-component 변경)

- TS: `packages/protocol/src/types/label.ts`, `compat.ts` (decodeWireLabel/decodeKxLabelOrKeep + v1 gate), `control-guard.ts`, daemon 의 control.rename 송수신, kx-hello label 송수신.
- Rust: `tp-proto` 의 `label.rs` (이미 관대한 디코더 보유 — `LabelUpdate` enum 으로 수렴), 새 `tp-relay`.
- Swift app: kx-hello label 을 이미 optional 로 모델링 — `control.rename` Label tagged-union 수신부만 새 shape 에 맞춤.
- gate: `tp-proto` message-vector 에 `LabelUpdate` 4-shape(Set 빈문자열/Set 값/Clear/absent) 골든 + Swift 디코드 회귀.

### A1.7 Cutover runbook (8c)

> **8c 는 즉흥이 아니라 체크리스트다.** 8a(바이너리+로컬 게이트) ✅ + 8b(deploy pipeline) ✅ 인 뒤에만 실행. **8b 는 flip-live-on-merge** — `rust/tp-relay/**` 변경의 main 머지가 곧 production 자동 cutover 다. 따라서 **시크릿 reissue 는 머지 *전에* 호스트에서 끝내야 한다.** downtime-OK(Amendment 1) 이므로 in-flight resume/push 토큰은 **공유하지 않고 새로 발급** — 미결제 토큰은 verify 실패 → 기존 full-auth fallback 으로 흡수.
>
> **시크릿은 drop-in 으로 관리한다.** deploy 가 rewrite 하는 base unit(`/etc/systemd/system/tp-relay.service.d/` 밖)이 아니라 **drop-in `/etc/systemd/system/tp-relay.service.d/secrets.conf`** 에 둔다 — base unit 을 다시 써도 systemd 가 drop-in 의 `Environment=` 을 merge 하므로 시크릿이 안 지워진다. 이 reissue 단계(아래 2)는 **사용자(호스트 root 접근)만** 수행한다.

순서 (각 단계는 직전 단계 확인 후):

1. **announce + freeze** — dogfood 사용 일시 중단. relay 무중단 보장 없음(downtime-OK).
2. **reissue secrets (drop-in, 머지 전, 사용자 수행)** — 호스트에서:
   ```bash
   RESUME=$(openssl rand -hex 32); SEAL=$(openssl rand -hex 32)
   sudo mkdir -p /etc/systemd/system/tp-relay.service.d
   sudo tee /etc/systemd/system/tp-relay.service.d/secrets.conf >/dev/null <<EOF
   [Service]
   Environment=TP_RELAY_RESUME_SECRET=$RESUME
   Environment=TP_RELAY_PUSH_SEAL_SECRET=$SEAL
   # APNs (push 활성 시): Environment=TP_RELAY_PUSH_SEAL_SECRET_PREV 는 불필요(clean reissue)
   EOF
   sudo systemctl daemon-reload
   ```
   **이전 값과 공유하지 않는다** — 미결제 4-part TS resume 토큰은 verify 실패 → full-auth fallback. clean reissue 이므로 `_PREV` 불필요(기존 sealed `push_tokens` 는 무효화, frontend 가 재등록). 시크릿 값은 절대 로그/PR/commit 에 남기지 않는다.
3. **merge 8b → auto-deploy** — `rust/tp-relay/**`(또는 deploy-relay.yml) 변경 PR 을 main 에 squash merge. `deploy-relay.yml` 이 자동 발화: Rust `tp-relay` 빌드(`TP_BUILD_SHA=github.sha`) → SCP → base unit `ExecStart=/usr/local/bin/tp-relay` 설치(drop-in 보존) → `systemctl restart tp-relay`. (수동 트리거: `gh workflow run deploy-relay.yml`.)
4. **verify /health.buildSha (deploy job 이 자동 assert)** — deploy 의 "Verify deployed build is live" step 이 `curl --retry https://relay.tpmt.dev/health` → `status:"ok"` + `buildSha == github.sha` 검증(stale 바이너리 조기 검출). `protocolVersion:2`, `daemons:0`(아직 재연결 전). deploy job green = 이 단계 통과.
5. **dogfood re-pair / reconnect** — 사용자 dogfood daemon(`~/.local/bin/tp`) 이 relay 에 재연결: 미결제 resume 토큰은 reject → full register+auth fallback 으로 자동 복구(코드 변경 불필요). 새 페어링이 필요하면 `tp pair new`. `/health daemons>=1` 확인.
6. **push re-register** — sealed `push_tokens` 가 새 push-seal 로 무효화됐으므로, frontend(앱)가 다음 relay 재연결 시 `relay.push.register` 로 1회 재등록(downtime 창에 정렬된 경계 있는 1회 누락). daemon `push_tokens` 행이 새 sealed blob 으로 갱신되는지 확인.
7. **smoke** — dogfood: pair→chat→terminal→kill/reconnect(full-auth fallback 경로 탐)→push 알림 1건 도착 확인. 이상 시 TS relay 로 롤백(8b 이전 deploy-relay.yml 복원 + 이전 secret drop-in — 단 reissue 후엔 양쪽 토큰셋이 갈라지므로 롤백도 full-auth fallback 을 한 번 더 탄다).

## Amendment 2 — Full CLI port + Bun CLI 퇴역 (2026-06-20)

- 상태: **Accepted** (2026-06-20, Dave). 이 amendment 는 본 ADR §5 Stage 2–5 의 *CLI 부분* 을 갱신한다 — 원안은 Stage 2(read-only)만 Rust 로, Stage 3(pair-ops/passthrough) 부터는 *조건부 의도된 순서* 였으나, Dave 지시("지금 바로 포팅 시행해. bun 버전은 제거하고")로 **`tp` CLI 전체를 Rust 로 포팅하고 Bun CLI(`apps/cli`)를 퇴역**시키는 것을 확정한다. **daemon/runner/relay 서비스는 Bun 유지** (지시는 CLI 한정 — daemon 포팅은 여전히 후순위 Stage 5, 미확정).

### A2.1 HEAD-grounded 핵심 발견 (워크플로우 `full-cli-port-scope`, 13 에이전트)

원안의 가장 큰 미지수였던 PTY 가 **재구성된다**:

- **CLI 는 PTY 를 소유하지 않는다.** PTY 는 Runner 서브프로세스 안에만 있다 (`packages/runner/src/pty/pty-bun.ts:11`, `Bun.spawn({ terminal })`). `tp run` 은 `new Runner()` 를 띄우는 **서비스 entrypoint** (`run.ts:1,23`), passthrough 는 `tp run` 을 자식으로 spawn 하고 (`passthrough.ts:103`) IPC `input`/`resize` 를 펌프 + SQLite WAL 에서 PTY 출력을 읽어 stdout 으로 (`passthrough.ts:152-178`). → **ADR §4.1/§6.1 의 `portable-pty` vs `pty-process` 결정은 "Runner 전체를 Rust 로 포팅" 을 선택할 때만 live.** CLI 포팅만으로는 Rust PTY 크레이트가 필요 없다 (Bun Runner 바이너리 유지 + Rust `tp run` 은 thin forwarder).
- **pairing libsodium 은 CLI 에 없다.** daemon 이 키 생성 + QR string 생성 (`pair.begin.ok.qrString`), CLI 는 받은 string 을 *렌더만* 한다. Rust CLI 에 crypto 불필요 (doctor 의 E2EE self-test 만 `tp-core` 사용 — 이미 있음).
- **모든 write 는 daemon IPC 경유** (single-SQLite-writer 불변식 보존). read-only 6 커맨드만 SQLite 직접 read.
- **service entrypoint 3개는 포팅 금지** (Bun 유지): `daemon start`(`daemon.ts:153,159` = 데몬 그 자체), `tp run`(Runner 서비스), `relay start`(이미 Rust `tp-relay` 바이너리가 production 대체 → CLI 에서 **제거**, docs 가 `tp-relay` 가리킴). 이들은 Rust→Bun **trampoline** 이 되거나 삭제된다.

### A2.2 포팅 tranche (gate 포함, Bun CLI 는 tranche 0–5 완료까지 shipped 유지)

| # | 범위 | 새 Rust dep | gate | risk |
|---|------|-------------|------|------|
| **0** ✅ | 크레이트 scaffold (`rust/tp-cli`, clap 라우터 mirrors `router.ts:19-31`) + `version` | `clap` | `tp version` byte-parity vs Bun (claude present/absent/`NO_COLOR`) ✅ | trivial |
| **1** ✅ | read-only ladder: completions/status/session list/pair list/logs (daemon-less rusqlite read) | `rusqlite`(read-only), `rustix`, `serde_json`, ANSI (hand-rolled completions, not `clap_complete`) | 각 커맨드 byte-parity + socket-path 파생 byte-exact + live daemon DB dogfood ✅ | low |
| **2** ✅ | write/control via daemon IPC: pair delete/rename, session delete/prune (IPC 1-왕복, daemon-up 강제 — fallback 없음) | **std UnixStream**(blocking, not tokio), `tp-proto::ipc::IpcMessage` 재사용(serde), `std::io::IsTerminal`(y/N 프롬프트 — not crossterm) | IPC 프레임 = `tp-proto` 60-케이스 골든벡터; live daemon 가역 round-trip(rename↔복원); non-TTY 거부 byte-parity ✅ | low |
| **3** ✅ | interactive write — **3a ✅ session cleanup(multi-select TUI)** + **3b ✅ pair new**(멀티프레임 streaming IPC + QR 렌더 + OSC52 copy + ctrl+c→`pair.cancel` + pair-lock, blocking) | `crossterm` raw-mode(3a); `qrcode`(half-block 렌더)·`base64`·`ctrlc`·`hostname`·std `File::try_lock`(flock — fs4 불필요, 1.96 std shadow)(3b) | 3a: cleanup multi-select parity + non-TTY byte-parity + raw-mode 복원(RAII Drop) ✅; 3b: 합성 kx frontend E2E(blocking pair flow 완주 → exit 0)·byte-exact URL/Daemon ID/Label/Relay·OSC52 byte-exact·SIGINT→130·daemon-down gate ✅ | medium |
| **4** | lifecycle thin(서비스 포팅 아님): daemon stop/status/install/uninstall, doctor, upgrade. `daemon start` 는 Rust→Bun trampoline | `nix`(SIGTERM), `reqwest`+`sha2`(upgrade), `tp-core`(doctor self-test) | 설치된 plist/unit 이 Rust `tp daemon start` → Bun daemon 정상 기동; doctor/upgrade parity | medium |
| **5** | run/passthrough — **PTY/runner 커플링, spike 뒤** | DECISION-GATED: CLI 에 없음(Bun runner 유지+forwarder) OR Rust PTY 크레이트(Runner 전체 포팅 시) | Tier-3 real-claude E2E: interactive parity(PTY 출력/resize/SIGWINCH/raw-mode/exit code) + 페어링된 폰 Chat/Terminal 수신; ephemeral in-process Daemon 경로(`passthrough.ts:209`) 제거 = 문서화된 behavior 변경 | **spike-needed** |

### A2.3 `rm apps/cli` 전 하드 블로커 (전부 충족돼야 Bun 제거)

tranche 0–5 전부 green + 아래 파이프라인 전환 완료 전까지 **`apps/cli` 삭제 금지** (삭제 시 사용자 stranded):
- build: `scripts/build.ts`(`bun build --compile`) → `cargo build --release`; Rust tp 가 trampoline 대상 Bun daemon/runner 바이너리를 bundle/locate.
- `release.yml` 매트릭스(darwin-arm64 + linux x64/arm64) 가 Rust tp 빌드; UPX/codesign 재검증.
- Homebrew tap bump + `checksums.txt` 가 Rust 아티팩트 네이밍.
- CI `build-cli`(**Required status check**, ruleset 14604664) → cargo; `$bunfs` compiled-mode smoke 제거.
- dogfood-freshness 자동화(CLAUDE.md) 재배선: `pnpm build:cli:local`→cargo, `~/.local/bin/tp` 경로 유지, `tp daemon install` trampoline 재검증.
- `scripts/install.sh` 아티팩트명 + apps/cli `bun:test` 인벤토리(~40 파일: pair-blocking/rename·unpair E2E/multi-frontend/args) → Rust 테스트/골든벡터로 대체.
- CLAUDE.md + `.claude/rules`(backend-services.md CLI 절, ci-workflows.md, release-deploy.md) 동일 변경에서 갱신.

### A2.4 Dave 결정 필요 (tranche 진행 전)

1. **PTY/runner spike 결과** (🔬 spike 완료 2026-06-20 — 데이터 확보, **결정은 Dave**): Rust `tp run` = thin forwarder(Rust PTY 없음) vs full Rust Runner(`portable-pty` vs `pty-process`). tranche 5 + Bun 제거를 블록.
   - **재프레이밍 (핵심)**: 이 결정은 "Rust PTY 가 되는가?"(된다)가 아니라 "**Runner 를 지금 포팅 vs Stage 4 로 연기**"다. **서비스 daemon(Bun 유지)이 runner 를 spawn**한다 (`daemon.ts:136` → `[tp,"run"]`, `spawn.ts:11-13`) — CLI 는 PTY 를 소유하지 않는다. PTY 는 Runner 서브프로세스 안 `PtyManager`(`packages/runner/src/pty/pty-manager.ts:10-16`, `pty-bun.ts:10-58` = `Bun.spawn({terminal})` 래퍼: spawn/write/resize/kill/exit-code)에만 존재. ⇒ **어느 옵션도 full Bun 제거를 unblock 하지 않음** (daemon+runner 포팅 = Stage 4–5; #1 통제 밖).
   - **portable-pty 0.9.0 spike 결과 (Darwin arm64, rustc 1.96.0, 실측)**: macOS arm64 **FULL PASS**(openpty→`/dev/ttys*`, resize→`stty size` 반영, `$TERM=xterm-256color` 전파, child exit code 캡처, interactive stdin↔stdout echo 왕복) · 1.96 핀 clean 컴파일 · **tokio 끌어오지 않음**(§4.1 의 "dedicated tokio reader task" 우려 **반증** — `std::thread`+`mpsc`, tranche 3b `ipc_session` 와 동일 패턴) · `unsafe_code="forbid"` 호환(crate 내부 unsafe 만, uniffi 와 동일) · 바이너리 기여 **~136 KB** · 0.9.0 = 0.8 보다 leaner(`serial2`+nix 0.28). `pty-process` = tokio-native(불리) · raw `rustix`/`nix` openpty = ioctl/posix_spawn 직접(노력↑, 위험↑, 마진 size win) → **portable-pty 0.9.0 권장**(B 채택 시).
   - **옵션 A (thin forwarder)**: tranche 5 를 거의 0 코드로 unblock, PTY 위험 0. **그러나** Bun runner(+`bun run …/index.ts` host, `bun -e` 훅 §6.6)가 무기한 잔존 → full Bun 제거 불가. **A2.4 #3(binary locate)이 하드 선행조건**(forwarder 가 Bun runner 아티팩트를 deterministic 하게 locate/exec 해야 함). ephemeral in-process daemon 경로(`passthrough.ts:209`, `@teleprompter/daemon` inline import)는 A 에서도 제거 필요(문서화된 behavior 변경 = "no service daemon" fallback 소멸, A2.4 #2 "daemon-up 강제"와 일관).
   - **옵션 B (full Rust Runner)**: PTY 자체는 de-risked(~1일). 그러나 "full Runner" = PTY + hooks `UnixListener` + IPC client + Collector **binary-sidecar io record**(byte-exact, Stage 4 §5 게이트) + settings-builder + `bun -e` 훅 결정 → **Stage-4 규모 multi-day**. full Bun(runner) 제거의 유일 경로지만 CLI 포팅과 직교.
   - **spike 권장(= Dave 확정 필요)**: tranche 5 는 **옵션 A(thin forwarder)** 로 지금 unblock + full Rust Runner(B)는 **Stage 4 로 명시 연기**. 근거: PTY 는 더 이상 블로커 아님(언제든 B 가능) but B 는 tranche 5 의 실제 목표(CLI 포팅 완료)에 무관 — daemon 이 runner spawn 하고 daemon 은 Bun 유지(Amendment 2). **#1+#3 를 함께 결정**할 것. ADR 에 "tranche 5 done ≠ Bun gone"(daemon+runner 여전히 Bun) 을 정직히 명시.
2. **daemon-less write fallback** — ✅ **결정됨(2026-06-20, Dave): daemon-up 강제.** pair/session write 는 daemon IPC(단일 SQLite writer) 경유; rusqlite 직접 write fallback 없음(아키텍처상 단일 writer 에 깔끔, CLI 는 read-only 만). tranche 2 dep 표면에서 rusqlite write 권한 제외.
3. **단일 Rust tp 가 Bun daemon/runner/relay 를 어떻게 locate** (bundle 동봉? PATH? embed?) — build/brew/installer 레이아웃.
4. **`tp relay start`**: 완전 제거(→ `tp-relay` 가리킴) vs deprecated trampoline 유지.
5. **파이프라인 cutover 시퀀싱**: flag 뒤 dual-build vs hard-swap; `build-cli`(Required) 가 cargo 로 flip 되는 시점.

### A2.5 진행 상태

- **tranche 0 ✅** — `rust/tp-cli` 크레이트(`[[bin]] tp`, clap 라우터, 11 서브커맨드 선언 + 미포팅은 loud-fail stub) + `version`(`build.rs` 가 root `package.json` version read → 단일 SoT, `CARGO_PKG_VERSION` 2차 필드 drift 없음). `claude --version` spawn, `NO_COLOR` gate. fmt/clippy(deny all/forbid unsafe)/test green. **byte-parity 3-케이스(claude present/absent/`NO_COLOR`) vs live Bun CLI 확인.** Bun CLI 무변경·미설치(브루 그림자 없음).
- **tranche 1 ✅** (2026-06-20) — read-only ladder 5 커맨드: `status`/`session list`/`pair list`/`completions <bash|zsh|fish>`/`logs [sid]`. 지원 모듈 `colors`(ANSI `NO_COLOR` gate)·`format`(`format_age` Howard-Hinnant civil-from-days UTC)·`store`(rusqlite **READ-ONLY** `OpenFlags::SQLITE_OPEN_READ_ONLY`, meta `sessions.sqlite` + per-session `vault/sessions/<sid>.sqlite`, `busy_timeout=5s`)·`socket`(`resolveRuntimeDir`/`getSocketPath` byte-exact 파생 + connect-probe liveness, `rustix` 안전 `getuid`)·`util`(`now_ms`). dep: `rusqlite`(bundled, read-only), `rustix`(process), `serde_json`(event JSON). **byte-parity 전수 확인 vs live dogfood store(8 sessions/1 pairing): status(녹색 running 분기 daemon-up 포함)·session list·pair list·completions(bash/zsh/fish + unknown-shell exit1)·logs(no-sid list·not-found·tail-drain).** read-only 불변식 적대적 검증 통과(어떤 경로도 DDL/CREATE/write 없음 — CLI 는 절대 2차 writer 아님). `completions install`/`uninstall`(rc 파일 write)·`pair`/`session` write 동작은 tranche 2 로 loud-fail stub 유지. fmt/clippy(deny all/forbid unsafe)/37 test green. 문서화된 divergence(전부 실 레코드에 unreachable): logs SIGINT exit(Bun 0 vs Rust 130, 시그널 크레이트 미도입)·io payload `from_utf8_lossy`·`last_assistant_message` falsy/non-string coercion·snippet UTF-16 vs scalar 절단.
- **A2.4 #2 결정됨** (2026-06-20, Dave): **write 는 daemon-up 강제** — pair/session write 는 daemon IPC(단일 SQLite writer) 경유, rusqlite write fallback 없음. tranche 1 의 read-only 사다리는 rusqlite **read-only** 만 사용하므로 이 결정과 정합.
- **tranche 2 ✅** (2026-06-20) — write/control via daemon IPC 4 커맨드: `pair delete`/`pair rename`/`session delete`/`session prune`. 신규 plumbing: `codec`(8-byte 헤더 frame `[u32_be jsonLen][u32_be binLen=0][utf-8 JSON]`, `codec.ts:30-57` byte-exact, `MAX_FRAME_SIZE` 64MiB H1 guard)·`ipc_client`(blocking `std::os::unix::net::UnixStream` 1-connection-1-request, 30s read timeout, `IpcError{DaemonDown,Timeout,Io,Decode}`, **client-side prefix matcher** `match_pairings` 5-tier(`pair.ts:354-376`)/`match_sessions` 2-tier(`session.ts:102-109`) + `parse_duration`(`session.ts:82-95`)). **와이어 타입은 `tp-proto::ipc::IpcMessage` 재사용**(이미 60-케이스 골든벡터 TS↔Rust 교차검증, `notifiedPeers`/`wasRunning`/`AgeFilter{kind:all|olderThan}`/`Label` byte-exact serde rename) — tp-cli 가 tp-proto 를 dep 로 추가, 재정의 없음. **daemon-up 강제(A2.4 #2)**: daemon down → exit 1, rusqlite write 절대 없음(read-only 불변식 유지 — 모든 mutation IPC 경유). 검증(workflow verify 단계 stall → **메인이 직접 적대 검증**): 10/10 비파괴 byte-parity(missing-arg/too-many/no-match/ambiguous/invalid-duration/dry-run × 4커맨드)·non-TTY refusal byte-identical(delete/prune/prune--running)·shorthand `daemon-` prefix·**실 가역 IPC write round-trip**(Rust 가 `daemon-mqcfogxb` rename → daemon 영속 확인 → Bun 으로 복원, 양쪽 동일 daemon IPC 경로 증명)·read-only SQLite 불변식(prod OpenFlags 전부 READ_ONLY)·wire 정합(request variant ↔ daemon dispatch string 일치). fmt clean·clippy 0 error(44 pedantic warn 비차단)·61 test green. `completions install`/`uninstall`(rc write)·`pair new`/`session cleanup`(interactive) 은 tranche 3 stub 유지.
- **tranche 3a ✅** (2026-06-20) — interactive write 1/2: `session cleanup`(multi-select TUI). 신규 `tui` 모듈: `tui::raw_mode::RawModeGuard`(crossterm `enable_raw_mode`↔Drop `disable_raw_mode` RAII 가드 — return/`?`/panic-unwind 모든 경로에서 터미널 복원). `session::cleanup`: non-TTY 가드(stdin AND stdout 둘 다 TTY 요구, `tsx:214-221` byte-exact), stopped 세션 `updated_at` DESC 정렬, raw-mode 키 이벤트 루프(Up/k·Down/j·Space toggle·'a' toggle-all·Enter confirm·Esc/Ctrl+C cancel→exit 130, `tsx:64-112`), `Delete N session(s)? [y/N]` 확인 게이트(`--yes` skip), per-sid IPC `SessionDelete`(ok/err/unexpected, `tsx:184-188` 메시지 parity), `ok("Deleted N:")` / `fail("Failed N:")` exit 1 요약. 순수 `TuiState` 로직(move/toggle/toggle-all/selected_sids) 11 유닛테스트. **daemon-up 강제(A2.4 #2)** — Bun 의 daemon-less 직접 SQLite write fallback(`tsx:294-312`)은 **의도적 미복제**(module doc + cleanup() 인라인에 divergence 명시) — daemon down 시 표준 가이드로 exit 1, CLI 는 read-only writer 불변식 유지. 검증(sequential impl→verify 워크플로 — tranche 2 의 parallel-build stall 회피): non-TTY byte-parity 3-case(plain/`--all`/`-y` 전부 identical) + **메인 최종 게이트**(build clean·fmt clean·clippy 0 error(pedantic warn 비차단)·70 test green) + cleanup() 본문 적대 리딩(raw-mode 가드 RAII 정합·confirm 게이트·IPC delete 경로 vs Bun tsx). 인터랙티브 TUI 루프 자체는 PTY 없이 헤드리스 구동 불가 → `TuiState` 유닛테스트가 동일 로직 커버(렌더 헬퍼는 thin ANSI 래퍼). `pair new`(3b)·`completions install`/`uninstall` 은 stub 유지.
- **tranche 3b ✅** (2026-06-20) — interactive write 2/2: `pair new`(QR 렌더 + OSC52 copy + ctrl+c→`pair.cancel` + pair-lock, **blocking until frontend kx**). 신규 모듈: `ipc_session`(멀티프레임 streaming IPC — `connect`→`try_clone` split→reader thread(`read_frame` loop→`parse_ipc_message`→mpsc) + `Arc<Mutex<UnixStream>>` writer; `send`/`recv`/`writer_handle`/`shutdown`; `IpcError::Closed` EOF; **tokio 없음**, 기존 all-std 패턴 유지)·`pair_lock`(advisory flock — std `File::try_lock`(1.89 stable, 1.96 pin 에서 std 가 `fs4` trait 메서드를 shadow → dep 불필요), 경합 시 `None`, Drop release)·`osc52`(`is_clipboard_support_likely`+`copy_to_clipboard`, OSC 52 `\x1b]52;c;<b64>\x07` byte-exact + tmux(ESC 더블+`\x1bPtmux;…\x1b\\`)/screen(`\x1bP…\x1b\\`) 래핑, base64 STANDARD)·`qr`(half-block 렌더, glyph 는 `qrcode-terminal` 와 다를 수 있음 — 허용, URL 만 byte-exact)·`config_dir`(`$XDG_CONFIG_HOME ?? $HOME/.config`+`/teleprompter`, store 의 `$XDG_DATA_HOME` 와 구분 — `??` nullish 시맨틱 정합(present-but-empty 는 verbatim)). `pair::new`: `--relay`/`--daemon-id`/`--label`/`-h` 파싱, `default_label()`/`normalize_host_label()`(suffix `.local`/`.lan`/`.localdomain`/`.home` 트림, `pair.ts:383-404`), pair lock(`config_dir()/pair.lock`)→`is_daemon_running()` gate(A2.4 #2 — auto-start 아님, delete/rename 와 동일 daemon-down 메시지)→`IpcSession`→`ctrlc` 핸들러(post-ok: `pair.cancel` 프레임 / pre-ok: 소켓 shutdown)→`pair.begin` 송신→프레임 drain 루프(byte-exact 출력 + exit 매핑: begin.err/error→1·completed→0·cancelled→130·disconnect Closed→1(settled-guard)). dep: `base64 0.22`·`qrcode 0.14`(no-default → `image` 제거)·`ctrlc 3`·`hostname 0.4`. **합성 kx frontend E2E**(`scripts/rust-pair-new-e2e.ts` — in-process RelayServer + 격리-XDG Bun daemon spawn, `$TP_RUST_BIN pair new` 실행, `tp://p?d=…` URL 파싱, synthetic frontend 가 `relay.auth`→`relay.auth.ok`→`relay.kx`(encrypt(payload,kxKey)) 수행(`multi-frontend.test.ts:79-103` byte-identical)→ daemon 이 pairing 완주 → blocked Rust CLI exit 0 + `Paired` 라인) **PASS(`RUST_PAIR_E2E_OK`)**. 검증(sequential impl→opus 적대 verify + **메인 최종 게이트**): build clean·fmt clean·clippy 0 error·88 test(70→+18) green·E2E PASS·live byte-parity diff(Daemon ID/Label/Relay/dim hint/URL byte-identical, QR glyph 제외)·SIGINT→exit 130 + `Pairing cancelled.`·daemon-down→exit 1·OSC52 3-branch byte-exact·**아키텍처 불변식 유지**(CLI 는 relay WS 절대 안 엶 — `pair.begin`/`pair.cancel` IPC 만; E2E 의 synthetic frontend WS 는 폰 시뮬레이션). divergence(accepted, module doc 명시): pair_lock flock vs Bun proper-lockfile mkdir-dir-lock 상호배제 안 됨(Bun CLI 퇴역 중 — benign)·QR glyph(URL byte-identical)·`-h` clap 가로채기(tranche-3a rename 과 동일 패턴). **tranche 3(interactive write) 완료.**
- **tranche 4a ✅** (2026-06-20, #723) — `completions install`/`completions uninstall`(rc 파일 write — read-only 사다리에서 유일하게 daemon 무관 로컬 write). 신규 `commands::completions_install`: 마커 블록 rc 쓰기(`MARKER_START`=`# >>> tp completions (managed by \`tp completions install\`) >>>` / `MARKER_END`=`# <<< tp completions <<<`, `completions.ts` byte-exact), atomic write(temp+rename), `$SHELL`/`$ZSH_VERSION`/`$BASH_VERSION`/`$FISH_VERSION` 셸 자동감지, fish 는 디스크 완성 스크립트 기록. **uninstall 의도 파생 byte-exact**: `run(is_uninstall_subcommand, args)` 에서 `is_uninstall = is_uninstall_subcommand || args.iter().any(|a| a == "--uninstall")`(`completions.ts:140` — `install <shell> --uninstall` 도 uninstall 로 동작). `strip_marker_block` 은 마커가 남지 않을 때까지 loop(Bun 의 global regex 처럼 중복 블록 self-heal). 검증(sequential impl→opus 적대 verify→**메인 최종 게이트**): **적대 verify 가 2 REFUTE 잡음** — (1) major: `install <shell> --uninstall` 가 uninstall 안 하고 install 함(Bun `argv.includes("--uninstall")` parity 깨짐) → `run()` 시그니처 수정으로 fix, (2) minor: `strip_marker_block` 이 첫 블록만 제거(Bun global regex 는 전부) → loop 로 fix + 2 테스트 추가. fix 후 behavioral parity 확인(Bun/Rust 둘 다 0 마커 블록 잔존). `tempfile` 은 dev-dependency only. fmt/clippy 0 error·테스트 green.
- **tranche 4b ✅** (2026-06-20) — `doctor`(환경 진단 + relay health + E2EE self-test). `commands::doctor`(625 lines, `doctor.ts` 287 + `e2ee-verify.ts` 84 byte-exact 포트): 툴 프로브(`tp`(Rust 포트는 Bun 라인 대신 `CARGO_PKG_VERSION`)·node·pnpm·claude·git — git 은 `git version ` prefix strip), daemon-socket/pairing/vault 체크(전부 non-incrementing issues — `doctor.ts:108-144` parity), **relay 는 daemon IPC `doctor.probe`/`doctor.probe.ok` 단일 round-trip 경유**(아키텍처 불변식 — CLI 는 relay WS 절대 안 엶, `socket.rs` canonical `socket_path()` 5s read timeout), E2EE self-test(`tp_core::crypto` 직접 — Swift 앱이 링크하는 동일 크레이트, `OsRng` seed 로 `kx_seed_keypair` ×2 → server/client 세션키 → 양방향 round-trip + wrong-key 거부 3-check, `verifyE2EECrypto` byte-exact 출력), `claude doctor` 포워드(inherited stdio). issues 카운팅(node/pnpm/claude/git missing + relay fail + E2EE fail 만 +1; socket/pairing/vault 부재는 0), 요약(`issues==0`→green `All checks passed!` / yellow `N issue(s) found.`). 검증(grounding→impl→**opus 적대 verify CONFIRMED**(11/11 게이트: build/fmt/clippy-0-err/119test/tool-probes/e2ee/doctor.probe-IPC-reused/no-relay-WS/byte-exact/no-unsafe)→**메인 최종 게이트**): build clean·fmt clean·clippy 0 error(pedantic warn 비차단, doctor.rs=10)·119 test green·**격리 HOME(no node/pnpm/claude) byte-parity**(header/✓✗ icon/4 tool check/3 issue 요약/claude-skip 라인 — Bun 과 line-for-line, `tp:` vs `Bun:` 런타임 라벨 + vault side-effect 라인만 의도된 divergence, issue count 3 동일)·relay 게이트 parity(`paired && first_pairing_has_relay` ≡ Bun `pairing?.relayUrl`). divergence(accepted, doctor.rs 주석 명시): `tp:`/`Bun:` 런타임 라벨(Rust 바이너리엔 `tp` 가 맞음)·fresh HOME vault `!`(Rust 순수 read vs Bun `new Store()` mkdirSync side-effect, issue count 불변)·daemon-socket 파생은 canonical `socket_path()`(Bun doctor 의 간략 inline 파생이 `/run/user/<uid>` 폴백 누락 — Rust 가 더 correct, dogfood/CI 무차이). **tranche 4 의 lifecycle 잔여**(`daemon stop`/`status`/`install`/`uninstall`·`upgrade`)는 A2.4 #3(binary locate) 게이트 뒤 — `daemon start` Rust→Bun trampoline + 서비스 설치가 Bun daemon 아티팩트 deterministic locate 를 요구.
- tranche 4 잔여(daemon lifecycle: stop/status/install/uninstall·upgrade) + tranche 5(run/passthrough, PTY) 는 잔여 A2.4 결정(#1 PTY spike, #3 locate, #4 relay trampoline, #5 cutover) 통과 후. `completions install`/`uninstall`(4a ✅)·`doctor`(4b ✅) 는 데몬 lifecycle 결정과 무관해 선행 완료.
