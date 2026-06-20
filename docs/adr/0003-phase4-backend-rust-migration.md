# ADR-0003 — Phase 4 백엔드 Rust 이관 (staged, dual-run cutover)

- 상태: **Accepted** (2026-06-17, Dave) — **Stage 0 ✅ 완료** (2026-06-18, `tp-proto` 크레이트 + 106-케이스 골든벡터 green). **Stage 1 진행 중** (2026-06-19, [Amendment 1](#amendment-1-stage-1-downtime-ok-protocol-redesign-2026-06-19) 으로 dual-run-second-port → downtime-OK cutover 로 전환, 시크릿 공유 폐기, 21 redesign-now 채택). **A1.5 Step 1 ✅ (#707, LabelUpdate union)** + **Step 2 ✅ (`tp-relay` serde core, `RelayServerMessage` 11-variant + 40-케이스 골든)** + **Step 3 ✅ (handshake+resume+registry: binary versioned resume-token, `proof: Option<String>` sentinel, `relay.hello` 병합, `check_stale_daemons` TS-parity 2-phase 수정)** + **Step 4 ✅ (hot path: `Arc<Mutex<RelayCore>>` never-across-await 중앙상태, `VecDeque`+`Arc` 링버퍼, GCRA governor, axum WS per-conn actor, 121 lib + 10 loopback integration green)** + **Step 5 ✅ (push: `p256` 네이티브 P1363 ES256 JWT, `reqwest` H2+rustls `Arc` client + 429/5xx/network retry, tp-core seal 래퍼 `OsRng` fix, tagged `ApnsKey`, leak-free dedup eviction; tp-relay lib 174 green)** + **Step 6 ✅ (HTTP surface: `/health`+`/metrics`+`/admin` axum 라우터 단일 listener 공유, `metrics.rs` 12-counter `Arc<Metrics>` (RelayCore lock 밖 lock-free atomics), `build.rs` `TP_BUILD_SHA`/`TP_BUILD_TIME` 컴파일타임 주입(env→git→unknown), `/admin` bearer 게이트(`TP_RELAY_ADMIN_TOKEN` 미설정=404·불일치=401·constant-time `subtle`); tp-relay lib 187 + http_surface 3 + integration 10 green)** + **Step 7 ✅ (10k soak 하니스 — PR gate: `tp-relay/tests/soak_10k.rs` 파라미터화 concurrent 하니스 `#[ignore]` 기본, `TP_SOAK_CONNS`/`TP_SOAK_SECS` env 스케일, heavy=local full-10k / light=CI 1500×20s(`ci.yml` rust job), 세 차원(pub fan-out 0-drop + resume storm ~100% accept + push-under-load dedup/rate guard) + capacity 불변식 프로브(`/health` ok·`backpressure_disconnects==0`·`framesOut>=conns×frames`))** 완료; **Step 8a ✅ (relay 바이너리 entry `[[bin]] tp-relay`+`src/main.rs` THIN: `--port`/`RELAY_PORT`(flag wins)·`SharedState::from_env`·`serve_with_shutdown` SIGINT/SIGTERM graceful·시작로그 port+buildSha; 로컬 게이트 `scripts/rust-relay-e2e.ts` — cargo build --release bin → loopback 포트 ephemeral resume-secret 실행 → 격리 tp daemon(`real-daemon-pair.ts --relay-url`, 자체 mktemp XDG/HOME) register(`/health daemons>=1`+`/metrics relay_daemons_online>=1`) + frontend `relay.auth`→`relay.auth.ok` 프로브; production 무변경)** + **Step 8b ✅ (deploy pipeline: `deploy-relay.yml` Rust 전환 — `ubuntu-latest` native x86_64 `cargo build --release --bin tp-relay`(`TP_BUILD_SHA=github.sha`), base unit `ExecStart=/usr/local/bin/tp-relay`, 시크릿 drop-in `secrets.conf` 보존, `/health.buildSha==github.sha` assert, path 트리거 `rust/tp-relay,tp-proto,tp-core`, **flip-live-on-merge**))**; 8c(live cutover — 머지 전 사용자가 drop-in 시크릿 reissue → 머지 = auto-deploy, [A1.7 runbook](#a17-cutover-runbook-8c)) 사용자 게이트 대기. Stage 2–5 는 각 직전 gate 통과 조건부.
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
| 8c | **live cutover** (pending, user-gated) — 아래 [CUTOVER RUNBOOK](#a17-cutover-runbook-8c) 순서대로. flip-live-on-merge 이므로 **머지 전에 사용자가 호스트에서 drop-in 시크릿 reissue → 머지 → auto-deploy** | dogfood: pair→chat→terminal→kill/reconnect(full-auth fallback)→push 재등록 |

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
