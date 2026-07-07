# IN_PROGRESS — 후속 세션 인계 (2026-07-08 갱신 · rev17)

이 문서는 진행 중이던 작업을 후속 세션이 그대로 이어받도록 정리한 것이다.
**규율 상기**: 도구 호출은 구조화된 `tool_use` 블록으로만. squash merge only via
`gh api repos/DaveDev42/teleprompter/pulls/<n>/merge -X PUT -f merge_method=squash`.
PR title = conventional-commit. dogfood tp = `~/.local/bin/tp` (brew symlink 절대 안 건드림).
Agent 호출 시 항상 `model` 명시. 실 claude E2E 하니스는 로컬 전용(절대 CI 아님).

> **이 문서가 다루는 작업의 성격 (먼저 읽을 것).** Teleprompter 는 개발자 본인 소유의
> 셀프호스트 개발 도구다 — VS Code Remote / `tmux` over SSH / `mosh` 와 같은 범주.
> 개발자가 **자기** 머신에서 데몬을 돌리고 **자기** 폰을 페어링해 **자기** Claude Code 세션을
> 보고 조작한다. 동의한 운영자는 정확히 한 명이고, 제3자도 없고, 운영자 자신의 개발 박스
> 외에 다른 대상도 없다. E2E 하니스는 그 운영자 자신의 개발 워크플로우를 일회용 sandbox 에서
> 자동화하며, first-run 프롬프트에 응답하거나 운영자 자신의 로그인 토큰을 재사용하는 부분은
> 평범한 unattended-CI plumbing 이다.

---

## 상태 스냅샷 (origin/main = 9b35f9e0, 2026-07-08 rev17)

> rev17 (2026-07-08): **daemon Rust 포팅 — 증분 2 머지(#893, main=`9b35f9e0`) + 증분 3(relay-client, XL) 코드+게이트 완료, PR 대기.**
> **inc2 머지**: worktree differential 게이트가 CI(Linux)에서 실제 RUN(SKIP 아님)해 5개 required job GREEN, `gh api` PUT squash 머지.
> dogfood 재빌드+재설치 완료(tp v0.1.52, daemon=`tpd` 트램폴린). **inc3 (relay-client, branch `feat/tp-daemon-inc3-relay-client`)**:
> `transport/relay-client.ts`(1208 LOC)→`transport/relay_client.rs`(~1400 LOC) 포팅 — tokio reader/writer split-task 로
> callback-style WS client 를 재구성(self-register→auth→kx→N:N E2EE pub/sub→reconnect/resume state machine). **crypto 전부
> tp-core 재사용**(`seal`/`open`/`kx_server_session_keys`/`derive_kx_key`/`derive_pairing_confirmation_tag` — native `&[u8]` fns),
> msgs 는 `tp-proto::relay_client`(outbound)+`tp-relay`(inbound) 재사용. 9개 load-bearing 속성 전부 보존
> (compute_reconnect_plan pure fn·dead-pairing throttle·resume fast-path·kx race-fix(`is_new_peer` before insert)·send()
> transmitted-bool·broadcastEncrypted best-effort·dispose-race 가드·frontendId O(1) frame-fallback·relay.err 처리).
> `seal_random_nonce` = OsRng 24-byte XChaCha20 nonce → tp-core seal(base64(nonce24‖ct‖tag)) — TS libsodium 과 byte-compatible.
> **게이트 = reconnect-policy Bun↔Rust differential** (`transport/relay-client-rust-parity.test.ts`, 3 pass/86 assert —
> `computeReconnectPlan`/`nextPeerlessReconnects` 를 (attempt × peerless)+(current × hadPeer) 그리드로 두 impl 에 돌려
> backoff 곡선+30s cap+MAX_ATTEMPT clamp+throttle(≥3→30min)+counter arm/reset byte-identical 검증; 같은 `tp-daemon-probe` 의
> 신규 verbs `reconnect-plan`/`peerless-next` 로 driving, 미빌드 SKIP). **독립 검증(내가 직접 재실행 + crypto binding·reconnect
> state machine·kx race-fix·dispose 가드 정독 + agent 가 남긴 dead code[unused AtomicBool/Ordering import + stub 2개] 제거):
> reconnect 파리티 3 pass/86 assert · `cargo test -p tp-daemon` 88 pass(회귀 0) · clippy 0 err · fmt/biome/type-check clean ·
> Bun daemon 스위트 446 pass(443→446, 회귀 0).** **full E2EE relay dual-run**(Bun frontend 가 Rust-published frame 복호)은
> inc3 범위 내 후속으로 연기 — Rust client 가 golden-vector-verified tp-core seal/kx 를 그대로 호출하므로 byte-exact 는 이미 증명됨,
> WS interop 하니스는 client 가 실 daemon 에 wire 되는 inc4/inc5 에서 착지. **다음 = inc4 (pairing/push/relay-manager).**
> flip(별도 후속)·CLI seam(`TP_DAEMON_BIN`, inc6)·black-box gate(inc5) 는 후속. 상세 = plan 문서 §2 ladder.

> rev16 (2026-07-08): **daemon Rust 포팅 — 증분 1 머지(#892, main=`dbdfb16d`) + 증분 2(Tier 2) 완료, PR 대기.**
> **inc1 머지**: store 게이트가 CI(Linux)에서 실제로 RUN(SKIP 아님 — `test` job 에 `cargo build --release --bin
> tp-daemon-probe` enabler 추가)해 6/6 GREEN, 5개 required job 첫 런 통과. dogfood 재빌드+재설치 완료(daemon=`tpd`).
> **inc2 (Tier 2, branch `feat/tp-daemon-inc2-tier2`)**: 3개 Bun 모듈을 `rust/tp-daemon` 으로 포팅 —
> `ipc/server.ts`→`ipc/server.rs`(tokio `UnixListener` accept-loop, 템플릿=`tp-runner/hooks.rs`; framed-JSON
> decode-teardown + hello-SID + onMessage throw-containment + 30s dirent self-heal + QueuedWriter backpressure),
> `session-manager.ts`→`session/manager.rs`(tokio `Child` spawn/kill + **generation guard** `Arc::ptr_eq` restart-race +
> `waitForExit` + `setRunnerCommand` seam), `worktree-manager.ts`→`worktree/manager.rs`(**PARITY-SENSITIVE**, sync
> `std::process::Command` git shell-out — Dave 결정; gitEnv GIT_*-strip + **containment write-escape 가드**
> `dirname(repoRoot)` string-prefix + porcelain parse + `--` argv). `socket_path()`/`resolve_runtime_dir()` 는 tp-proto 에
> 신규(bind-side). **게이트 = worktree Bun↔Rust differential** (`worktree-rust-parity.test.ts` — sibling `git init` repo
> 로 두 impl 구동, add/list 구조 + escape REJECT(add/remove) 일치; 같은 `tp-daemon-probe` 의 worktree verbs 로 driving,
> 미빌드 SKIP). **독립 검증(내가 직접 재실행 + 보안 코드 3곳 정독): worktree 파리티 5 pass/22 assert ·
> `cargo test -p tp-daemon --lib` 78 pass · `tp-proto` 42 pass · Bun daemon 스위트 443 pass(회귀 0) · clippy 0 err ·
> fmt/biome/type-check clean.** **다음 = inc3 (relay-client, XL, tokio-tungstenite + tp-core E2EE, Rust 선례 없음).**
> flip(별도 후속)·CLI seam(`TP_DAEMON_BIN`, inc6)·black-box gate(inc5) 는 후속. 상세 = plan 문서 §2 ladder.

> rev15 (2026-07-08): **daemon Rust 포팅 착수 — 증분 1(store 레이어) 완료, PR 대기.** ADR-0003 Phase 4 의
> 마지막·최대 컴포넌트(daemon 7,014 LOC)를 `rust/tp-daemon` 으로 포팅 시작. **plan = `docs/design/daemon-rust-port-plan.md`**
> (leaf-first 6-증분 ladder + default flip 은 별도 후속, runner task #8 미러). **Dave 결정(§4): daemon inc1 지금 시작
> (runner flip 과 독립) · rusqlite bundled sqlite · git shell-out**. 증분 1 = `tp-daemon` 스캐폴드(lib only) +
> Tier 0-1 store 레이어(`store.ts` 757 LOC + config/schema/session-db/pairing-row-guard/daemon-lock/export-formatter)
> 를 rusqlite 0.40(bundled) 로 byte-exact 포팅. `tp-core::derive_legacy_pairing_id` + `tp-proto::{Label,decode_wire_label,
> label_to_nullable}` 재사용, `assert_safe_sid` 는 tp-proto 에 신규. **게이트 = 양방향 shared-file 파리티**
> (`packages/daemon/src/store/store-rust-parity.test.ts` — Bun↔Rust 가 같은 on-disk `sessions.sqlite` 를 교환 가능:
> session/pairing/record BLOB byte-identical + WAL sidecar unlink + WAL-mode PRAGMA parity, `tp-daemon-probe` 미빌드 시
> SKIP). **검증: 파리티 6 pass/23 assert · `cargo test -p tp-daemon` 53 pass · `tp-proto` 39 pass · Bun store 스위트
> 106 pass(회귀 0).** branch `feat/tp-daemon-inc1-store`. **다음 = inc2 (ipc/server + session-manager + worktree).**
> flip(inc7)·CLI seam(`TP_DAEMON_BIN`)·black-box gate 는 후속. 상세 = plan 문서 §2 ladder + §3 store 전략.

> rev14 (2026-07-07): **runner Rust 포팅 — 증분 4(파리티 *증명* 게이트) 머지(#890, main=`b4c9a2c8`).**
> dogfood tp 재빌드+재설치 완료(daemon=fresh `tpd` 트램폴린, `tp doctor` E2EE 자가검증 양방향 OK). 증분 4 는
> **Scope B = 파리티 증명만, default flip 은 별도 후속 PR(task #8)** — `resolveRunnerCommand()` 미변경.
> **CI 통과 과정에서 발견·수정한 Bun-Linux 함정**: `runner-parity.test.ts` 가 CI(Linux, Bun 1.3.13) `test` job
> 에서 Bun runner arm 을 60s hang 시켰다. WSL Ubuntu(=CI OS) 1.3.13/1.3.14 로 재현 검증한 근본원인: `terminal:`
> (PTY) 로 spawn 한 자식이 종료해도 Linux 에서 event-loop 핸들이 안 풀려 부모 Bun 프로세스가 loop-drain 자연
> 종료로 절대 안 끝난다(`proc.kill()`/`unref()` 무효, `process.exit()` 만 종료). macOS 는 핸들이 풀려 통과 →
> 로컬만 green. **수정 = 테스트가 runner 프로세스 exit 대신 `bye` *프레임* 캡처를 기다린 뒤 `proc.kill()`**
> (파리티 어서션 불변, Bun-Linux 함정 면역; CI Linux 244ms pass 확인). 프로덕션 무영향(daemon 독립 `proc.exited`
> 모니터가 세션 강제 settle, dogfood=macOS). 상세=`.claude/rules/testing-inventory.md`.
>
> rev13 (2026-07-07): **runner Rust 포팅 — 증분 3 머지(#884, main=`1c85560e`) + 증분 4(파리티 *증명* 게이트)
> 구현·PR 미제출.** 증분 4 는 **Scope B = 파리티 증명만, default flip 은 별도 후속 PR(task #8)**. 핵심 발견:
> 실 claude E2E 세션(PRINT/M5/CODING/WEBPAGE)은 daemon 의 `SessionManager.spawnRunner` 가 아니라
> **holder(`real-daemon-pair.ts`)가 `tp run --socket-path <격리>` 로 직접 spawn** 하는 standalone 프로세스라,
> inc3 의 `TP_RUNNER_BIN`/`resolveRunnerCommandWithOverride` seam(daemon-spawn 경로 전용)이 이 세션엔 무효다.
> → holder 에 자체 `runnerCmd(args)` 를 추가: `TP_RUNNER_BIN` 있으면 `[<tp-runner>, --sid, …, --, <claude>]`
> (Rust runner 는 `run` 서브커맨드 없이 같은 argv), 없으면 `[bun, run, <cli>, run, …]`(Bun). 4개 spawn 사이트
> 전부 `runnerCmd()` 경유. **게이트 배선**: `TP_E2E_RUNNER_BIN=1`(다른 claude 게이트와 직교, `E2E_REAL` 만 imply)
> → `build_rust_runner_bin`(release, rustup-shim-safe TC_BIN) → env-prefix `TP_RUNNER_BIN="$REAL_RUNNER_BIN"`
> (리터럴 assignment — `${VAR:+…}` 확장은 word-split 로 명령 오실행) 로 holder 주입 → holder 가 Rust runner 선택
> 시 `RUNNER_PARITY_BIN=<path>` 를 stderr(=`$REAL_RP_OUT`)에 emit → `assert_runner_parity` 가 그 라인(positive
> proof) + 세션 DB `kind='io'` rows≥1 을 어서션. **committed 로컬 프레임-diff 하니스** `scripts/runner-parity-real-claude.ts`
> (`TP_RUNNER_PARITY_REAL_CLAUDE=1`, 실 claude, hello/bye byte-exact mod {pid,ts} + io 구조 diff). **CI backstop**:
> ci.yml `test` job 에 `cargo build --release --bin tp-runner` 추가(+rust-toolchain@1.96.0/rust-cache, timeout 10→15)
> → `runner-parity.test.ts` 가 SKIP→RUN 상시. **기본 runner 는 여전히 Bun** — `resolveRunnerCommand()` 미변경.
> 로컬 검증: 백엔드 926(daemon+cli) pass/0, tsc daemon 0, biome ci 0. **macOS coding E2E + 파리티 게이트 진행 중
> (holder 직접 실행 시 `RUNNER_PARITY_BIN` emit 확인, 전체 smoke 재검증 중)**. **다음 = 증분 4 PR 제출
> (`test(runner): real-claude parity gate for Rust tp-runner via TP_RUNNER_BIN`) → task #8(build+ship+locate +
> default flip) → daemon 포팅(tp-daemon).**
>
> rev12 (2026-07-07): **runner Rust 포팅 — 증분 2 머지(#883) + 증분 3 완료(dual-run seam + wire-parity 게이트),
> PR 미제출.** origin/main = `ab7223fb`(#883, tokio async). **증분 3**: opt-in `TP_RUNNER_BIN`(절대 경로) 이 CLI 의
> runner command 를 Rust `tp-runner` **단일-요소 argv** 로 바꾼다 (`apps/cli/src/lib/runner-bin.ts`
> `resolveRunnerBinOverride` → `spawn.ts` `resolveRunnerCommandWithOverride`; 무효 경로=fail-loud, 조용한 Bun
> fallback 없음; `daemon.ts`/`passthrough.ts` 가 try/catch 로 감쌈). trust boundary = daemon **프로세스 env**
> 전용(relay-originated `session.create` 미접근). 양쪽 runner 에 `TP_RUNNER_CLAUDE_BIN` seam(Bun runner.ts:108 +
> Rust runner.rs:113). **wire-parity 게이트**(`packages/daemon/src/session/runner-parity.test.ts`): Bun/Rust 두
> runner 를 같은 fake claude(고정 stdout·exit 7)로 돌려 프로덕션 `FrameDecoder` 로 프레임 캡처 → hello/bye pid/ts
> 제외 byte-equal + **JSON 키순서**(placeholder 재직렬화) equal, io `payload=""` 사이드카 불변식 + concat
> 바이트스트림 byte-equal (Rust 미빌드 시 SKIP). **로컬 검증 PASS** — 전 백엔드 1765 pass/0 fail, type-check 0,
> Biome clean, Rust release runner 빌드+parity 통과. **기본 cutover 없음** — daemon 은 여전히 Bun runner spawn.
> **다음 = 증분 3 PR 제출(`feat(runner): daemon TP_RUNNER_BIN dual-run seam + Bun/Rust wire-parity gate`) → 증분 4
> (dogfood 로 parity 입증 후 기본을 Rust runner 로 cutover) → daemon 포팅(tp-daemon).**
>
> rev11 (2026-07-06): **runner Rust 포팅 — 증분 2 완료(tokio async 오케스트레이션), PR 미제출.** 증분 1 위에
> `socket`/`wire`/`ipc`/`hooks`/`runner` 5개 모듈 + `main.rs` argv/시그널 결선. tokio 단일스레드 런타임의
> `select!` 루프가 IPC(decode-throw teardown + inbound allowlist + overflow→close) · hook receiver(sid traversal
> 가드 + 1 MiB UTF-8 cap + mode-0700) · PTY 를 묶어 hello→io/event rec→bye(pid 생성 가드 + reason signal/exit) 를
> 운반. **E2E 통합 테스트**(스텁 daemon + `TP_RUNNER_CLAUDE_BIN` 가짜 claude)가 hello→io rec(binary sidecar)→bye
> reason=exit 전 체인 검증. 27 테스트 green(23 lib+3 argv+1 e2e), 전 워크스페이스 270+ green, clippy(`all=deny`)·fmt
> clean, 무회귀. **cutover 없음** — daemon 은 여전히 Bun runner spawn. 상세 = "즉시 다음 액션" 항목 9. **다음 =
> 증분 2 PR 제출 → 증분 3(daemon `TP_RUNNER_BIN` seam, 단일세션 dual-run + parity 게이트).**
>
> rev10 (2026-07-06): **runner Rust 포팅 착수 — 증분 1.** 사용자 지시로 ADR-0003 Stage 4 시작. `rust/tp-runner`
> 크레이트(workspace member) + byte-exact settings(golden `capture_hook_command`) + collector(io 바이너리
> 사이드카 = Stage 4 parity gate) + **portable-pty PTY spike**(→ ADR §6.1 "최대 기술 미지수" 해소). 12 테스트
> green, workspace clippy/fmt clean, 무회귀. 상세 = "즉시 다음 액션" 항목 9(당시). **다음 = 증분 2(완료, 위 rev11).**
>
> rev9 (2026-07-06): **rev8 의 "미착수 백로그 없음" 결론 정정.** stale `TODO.md:84` (Phase 4 = ADR-0003
> *Proposed* 승인대기)를 오인한 것 — 실제 ADR-0003 = **Accepted**, Stage 0(`tp-proto`)+Stage 1(`tp-relay`,
> 프로덕션 라이브)+CLI 전체 포팅(`tp-cli`) 완료, **runner+daemon 만 Bun 잔존 = 언블록된 다음 코딩 작업.**
> 사용자 결정 반영: CC channels **포기**, External TestFlight **보류**, 렌더러 권고 = SwiftTerm 유지(결정 대기).
> 상세 = "즉시 다음 액션" 섹션 정정 callout + `TODO.md` Phase 4 행.
>
> rev8 (2026-07-06, 검증 전용 세션): 실제 HEAD 상태를 문서가 아니라 git/테스트로 재확인 (백엔드 1753/1753 ·
> macOS 스모크 8/8 · dogfood fresh · tree clean · PR/이슈 0). *(주의: 이 판본의 "미착수 백로그 없음" 은 rev9 가 정정.)*
> `origin/main` = `65f5958f`(#879 docs-sync 반영, rev7 은 그 아래 `b221335f` 를 헤더에 박아 한 커밋 뒤처져
> 있었음 — 이번에 정정). **열린 PR 0 · 열린 이슈 0 · worktree/stash/브랜치 clean.** dogfood 빌드 시점
> (`955d04e6`, PR-8) 이후 바이너리 영향 파일 변경 **전무**(`git diff --stat 955d04e6..HEAD` = `native-testing.md`
> + `IN_PROGRESS.md` + `scripts/ios.sh` 만) → **dogfood tp 재빌드 불필요**(현행 `v0.1.52`, daemon 이 최신 `tpd`
> 로 구동 중, `dev.tpmt.app.pairing.v2` synced 스토어 실동작 확인). **이번 세션 상태 재검증(문서 수치 앵무새
> 금지 원칙)**: 백엔드 **1753 pass / 0 fail**(110 파일, 60s) · macOS 네이티브 스모크 **8/8 마커**(M1~M5
> + core OK, `TP_PAIR_OK`/`TP_INPUT_OK` 실동작) · daemon status running/healthy. **태스크 보드(#44–#51)
> 완전 드레인.** 남은 TODO 열린 항목 4개는 **전부 사용자 결정/업스트림 게이트**(아래 "즉시 다음 액션" 참조) —
> 즉시 이어갈 미착수 코딩 작업 없음.
>
> rev7: **M5 하니스 결정론 개선 머지됨 (#878, squash `b221335f`) — 이슈 #877 auto-closed(`COMPLETED`).**
> #49 종료 후 유일하게 flaky 하던 real-claude M5 E2E 하니스 arm(`TP_E2E_CLAUDE_M5`, `TP_INPUT_OK`)을
> 결정론화. **테스트 배관만 — 앱/프로토콜/백엔드 무변경.** 공유 헬퍼 `assert_m5_input`(iOS/macOS/visionOS):
> loopback arm 은 same-sid echo 마커 그대로(**byte-identical**), claude_m5 arm 은 격리 세션 DB 의
> `UserPromptSubmit≥1` 을 SoT 로 180s settle 창(≥2 probe 사이클)에 걸쳐 폴 — **stale foreign-sid 라인
> 절대 미수락**, timeout 시 이 런의 sid+DB count 명시해 정직하게 die. 3개 `claude_m5` scrape-loop break 를
> M4 로 완화(M5 는 DB-poll 이 독립 증명, racy `$input_line` 게이트 제거). 2개 root cause: (1) poll 예산
> (~75s) < cold claude probe 수렴(probeMaxAttempts=12×4s≈48s/cycle, ≥2 cycle), (2) `prefer_sid` fallback 이
> 이전 loopback 런의 stale `sess-smoketest` 라인을 잡아 "wrong sid" 오진. **검증**: loopback smoke 8/8
> (byte-identical 회귀 가드) + `TP_E2E_CLAUDE_M5` 8/8 via "DB proof: real-smoke-sess UserPromptSubmit=1" ·
> `bash -n` clean · CI 7/7 green(swift-smoke-ios loopback 회귀 없음 확인). 문서 `.claude/rules/native-testing.md`
> M5-어서션 섹션 동일 커밋 동기화. **dogfood tp 재빌드 불필요**(`scripts/ios.sh`+rule 만, `apps/cli`/`packages` 무변경).
>
> rev6: **PR-8 (`WS_PROTOCOL_VERSION` 2→3 + PCT/v4 문서) 머지됨 (#875, squash `955d04e6`) — #49 8-PR
> 페어링 재설계 완전 종료.** `WS_PROTOCOL_VERSION` 2→3 (`compat.ts:43`, TS) + `RelayProtocol.version` 2→3
> (`RelayMessages.swift:9`, Swift — 두 값 lockstep). v3 bump 이 곧 광고 `v`=3 → 새-daemon+새-앱 페어에서
> `effectiveV≥3` → PCT confirm 경로 활성(§1.3 표는 PR-5 에 이미 착지 — 별도 hard-gate 코드 없음, `pct`
> additive-optional). downgrade-safe 양방향(구-앱 `pct` 무시, 구-daemon `v:3` frontend payload 무해 수용).
> 앱 테스트 3곳 app-advertised `v` 어서션 2→3 (DaemonKxPayload decode 픽스처는 v2 유지 = 구-daemon
> backward-compat). 문서: CLAUDE.md · ARCHITECTURE §5.6 · protocol.md kx-`v`+WS-version bullet · design v3 §5.
> **검증 완료**: 백엔드 1753/1753 · Swift 187/187 · iOS/macOS smoke 8/8 · CI 필수 게이트 5/5 green.
> **dogfood tp 재빌드+재서명 완료** — daemon 이 fresh `tpd`(`955d04e6`, `WS_PROTOCOL_VERSION=3` 임베드)로
> 재기동, 광고 `v:3`. **PR-1~PR-8 전부 머지 — #49 종료.**
>
> rev5: **PR-7 (unpair vs "이 기기에서만 제거" split) 머지됨 (#874, squash `0b08a107`)** — 8-PR 페어링 재설계 중
> PR-1~PR-7 완료. device-local·NON-synced `localHidden` tombstone (pairingId 키, UserDefaults
> install-scoped). `hideLocally` 는 blob/secret 삭제도 `control.unpair` 발신도 안 함(=non-revoking) —
> synced blob 은 그대로 sync + 재설치 시 재-adopt. `reconciledPointers` 가 hidden pairingId 를
> **loser-sweep 앞단에서** 필터(HIGH: resurrected hidden blob 이 latest-`ts` race 로 live re-pair 를
> synced-delete revoke 하는 것 차단). tombstone clear = recommit(persist/ingest)·hard-delete 에서만
> (열거-부재로는 안 함). **legacy daemon 은 `deriveLegacyPairingId` 결정론적** → recommit 이
> incoming+legacy-derived id 둘 다 unhide. UI = 2-버튼 confirm 시트(normal 로컬-제거 + red Unpair).
> 다중렌즈 적대적 설계 리뷰(28 agents, 17 confirmed) 반영. iOS/macOS smoke 8/8, XCTest 187/187
> (+9: 8 store + 1 VM). 남은 것: PR-8(`WS_PROTOCOL_VERSION` 2→3 + 문서).
>
> rev4: **PR-6 (Option A synced pairing store) 머지됨 (#873, squash `12594403`)** — 8-PR 페어링 재설계 중
> PR-1~PR-6 완료. `PairingRecordStore` seam + synced whole-record Keychain blob + 레거시 마이그레이션
> + macOS 런타임 프로브 + 포인터 인덱스 reconciliation. 다중렌즈 적대적 리뷰(14 confirmed findings)
> 반영: persist save-before-sweep durability, 부분-sync 포인터 보존, latest-`ts` orphan sweep,
> retry-on-unlock. iOS/macOS smoke 8/8, XCTest 178/178. §3.7 2-device iCloud 검증은 수동 게이트(CI 아님).
>
> rev3: **PR-5 머지됨 (#871, squash `74325a80`)** — PR-1~PR-5 완료.

핵심 최근 머지:
- `#851` feat(ios): TP_E2E_WEBPAGE 게이트 (앱→relay→daemon→PTY 파이프라인이 실제 웹페이지 빌드 턴을 운반함을 증명하는 로컬 E2E)
- `#853` fix: 웹페이지 E2E 하니스의 first-run 프롬프트 응답 로직 재설계 (아래 #48 상세)
- `#854`–`#858` daemon/relay 신뢰성 fix
- `#859`–`#860` TestFlight 준비
- `#861` docs: pairing redesign v2 + v3.1 (round-3 **PASS_WITH_CONDITIONS**)
- `#862` docs: req-3 Option A 결정 기록 (pairing v3.1 4축 분석)
- `#863` feat(tp-core): **PR-1** — PCT + legacy pairing-id + QR v4 pairing layout (Rust 구현)
- `#864` feat(protocol): **PR-2** — 위의 TS twin (byte-exact)
- `#865`/`#866` docs: relay/E2E-harness 문구를 정확한 셀프호스트 단일-운영자 서술로 정리

**이전 세션 진행분 (전부 origin/main 에 착지)**:
- **PR-3 (daemon PCT 배선) — 머지됨 (#867, squash `da3d6671`)**. `pairing_confirmations`
  테이블(N:N) + `pairings.pairing_id`/`hostname` + async 백필(`migratePairingIds`) +
  `handleKxFrame` PCT 파생 + 두 hello 빌더 pct 캐리 + cascade delete + orphan sweep +
  `SessionHelloReply.d.pct?` additive-optional.
- **PR-4 (앱 Swift connect-on-pending 라이프사이클) — 머지됨 (#869, squash `fada3439`)**. PENDING
  네임스페이스(device-local, non-synced Keychain) + ingest→`TP_PAIR_PENDING` + `beginPending`
  connect-on-pending + kx 완료 시 promote(살아있는 client 재연결 없이 re-key, §1.6 R2) +
  `TP_PAIR_OK` promote-time 이동 + committed meta `pairingId`/`hostname` 영속 + 레거시 backfill.
  PCT 검증 없음 — PR-4 승격 조건은 kx 완료(레거시 의미론).
- 문서 sync: #868(PR-3), #870(PR-4).

**이 세션 진행분 (2026-07-05 rev2)**:
- **✅ dogfood tp 재빌드 완료** — #867 이 daemon/protocol 을 건드려 필요했던 것. CLAUDE.md freshness
  시퀀스 실행: Rust `tp` release 빌드 + Bun `tpd` SEA blob + prefix-tree 조립 + `bin/tp`·`tpd` 둘 다
  adhoc 재서명 + `tp daemon install`. daemon 이 06:09 새 tpd blob(`pairing_confirmations` 심볼 포함)로
  재기동 확인. `tp version` = v0.1.52 정상.
- **✅ #48 visionOS 웹페이지 E2E PASS** — fresh xcframework(`TP_FORCE_RUST=1`)로 재실행. 로그:
  `✅ WEBPAGE E2E PASS`, `UserPromptSubmit=2, Stop=2`, `PostToolUse(Write)`+`PostToolUse(Bash)` 둘 다
  `index.html` 참조. 이로써 **4-플랫폼(macOS/iOS/iPad/visionOS) 웹페이지 데모 전부 PASS** 확인.
- **✅ PR-5 (앱 PCT 검증 승격 게이트) 머지됨 (#871, squash `74325a80`)** — §1.3 승격 판정 표(4셀) +
  `minAdvertisedV` anti-downgrade floor + §2.5 committed 재검증 + loopback v:3+pct. 상세 아래 #49 섹션.
  검증: XCTest 164/164 · macOS+iOS Sim loopback smoke 8/8(+`TP_PAIR_CONFIRM_OK` 실기 확인) ·
  적대적 4-lens 리뷰 0 findings · CI 7/7 green. **dogfood 재빌드 불필요**(app+loopback+docs, 백엔드 무변경).

**현재 브랜치**: `main` (= `65f5958f`, M5 하니스 fix #878 + docs-sync #879 반영). clean.

worktree 상태: 메인 worktree 하나만 (`.claude/worktrees/*` 전부 prune 됨). stash 없음, 로컬 브랜치 `main` 뿐.

---

## Task 상태

| # | 상태 | 요약 |
|---|---|---|
| #46 | ✅ 완료 | busy indicator 반전 (#849 merged) |
| #44 | ✅ 완료 | macOS 2-window (#848 merged) |
| #45 | ✅ 완료 | iOS crash TOCTOU (#850 merged) — 단, **실기기 crash 로그는 USB 연결 시 Xcode Organizer 자동 sync 대기(사용자)** |
| #47 | ✅ 완료 | 웹페이지 하니스 (#851 merged) |
| #48 | ✅ 완료 | 웹페이지 데모 + first-run 프롬프트 응답 로직 재설계 출하 (PR #853 merged) — **4-플랫폼(macOS/iOS/iPad/visionOS) 전부 PASS 확인** (visionOS 이 세션 재실행, fresh xcframework) |
| #49 | ✅ 완료 | Pairing 재설계 8-PR — **PR-1~PR-8 전부 머지 완료 (#863/#864/#867/#869/#871/#873/#874/#875) — 재설계 종료, dogfood tp 재빌드 완료** — 아래 상세 |
| #51 | ✅ 완료 | M5 하니스 결정론 개선 (#877 이슈 → #878 머지, squash `b221335f`) — real-claude M5 E2E arm 을 세션-DB SoT 로 결정론화. 테스트 배관만. 아래 상세 |
| #50 | ⏸️ 사용자 | keychain 접근 확인 프롬프트 완화 — 아래 상세 (사용자 본인만 실행) |

---

## #48 — 웹페이지 데모 반복 루프 (사용자 핵심 목표)

**목표(사용자 verbatim)**: "iOS, iPadOS, macOS에서 현재 PC의 tp 명령어와 상호작용하여, claude code를
사용하여 간단한 웹페이지를 만드는 데모 테스트를 시행 … 발견된 어색한 점이나 버그 등을 계속 수정하며 반복."
"smoke ok 수준이 아니라, 실제 claude code를 구동해."

이 데모는 개발자 자기 머신에서 자기 폰으로 자기 claude 세션을 구동하는 로컬 통합 테스트다 — SSH/VS Code
Remote 와 동급의 단일-운영자 셀프호스트 워크플로우.

**실행 방법** (하니스는 메인 worktree 의 `scripts/` 에 있음):
```bash
cd /Users/dave/Projects/github.com/teleprompter
TP_E2E_WEBPAGE=1 TP_PLATFORM=<macos|ios|ipad|visionos> TP_SKIP_RUST=1 TP_E2E_KEEP_DIR=1 scripts/ios.sh smoke
```
- Host = Dave-MBP16 (M1 Max 64GB). claude on PATH 필수. **로컬 전용, 운영자 자신의 claude auth+credits 재사용.**
- `TP_SKIP_RUST=1` = xcframework 재사용(첫 macOS 실행이 이미 빌드). rust 수정했으면 빼거나 `TP_FORCE_RUST=1`.
- 성공 판정 = 로그에 `✅ WEBPAGE E2E PASS` + `UserPromptSubmit=2, Stop=2` + `PostToolUse(Write)`+`PostToolUse(Bash)`.

**소스 상태 (HEAD 에서 확인됨)**:
- ✅ TP_E2E_WEBPAGE 하니스 머지 (#851). trust-프롬프트 응답 로직 재설계 머지 (#853).
- ✅ `answerFirstRunPrompts()` 가 3개 holder(interactive/coding/webpage) 전부에 배선됨
  (`scripts/real-daemon-pair.ts`). ⚠️ 이 함수는 `scripts/ios.sh` 에는 없다 — ios.sh 는 bash
  오케스트레이션 하니스이고, real-daemon-pair.ts 는 PTY 를 소유하고 claude 턴을 진행하는 TS holder 다.
- ✅ **visionOS PASS 재확인 (이 세션, 2026-07-05)**: `TP_E2E_WEBPAGE=1 TP_PLATFORM=visionos
  TP_FORCE_RUST=1 scripts/ios.sh smoke` → `✅ WEBPAGE E2E PASS`, `UserPromptSubmit=2, Stop=2`,
  `PostToolUse(Write)`+`PostToolUse(Bash)` 둘 다 index.html 참조. macOS/iOS/iPad 는 PR #853 body
  Validation 근거. **4-플랫폼 전부 PASS**. (이전 판본의 "visionOS 재확인 필요"는 이제 해소.)

**🐞 근본 원인 (PR #853 이 닫음)**:
현행 claude 는 (테스트가 방금 만든 운영자 소유 격리 sandbox 를 처음 열 때) Claude 자체의 first-run 확인
프롬프트를 **2개 연속** 띄운다:
  1. "Quick safety check: Is this a project you trust? ❯ 1. Yes, I trust / 2. No, exit"
     — 문서화된 기본 강조(❯) = **1. Yes**.
  2. non-interactive 권한모드 안내 다이얼로그: "❯ 1. No, exit / 2. Yes, I accept / Enter to confirm"
     — 기본 강조(❯) = **1. No, exit**.

기존 harness 의 범용 입력 루프(`for i in 1..13: sendSubmit('\r'); sleep 2000` — 화면 내용과 무관하게
고정 간격으로 Enter 를 전송하는 턴 진행용 루프)는 **단일 "Yes"-기본 다이얼로그**를 가정했다. 그래서
화면 상태를 확인하지 않는 그 범용 재시도 루프가 두 번째 확인 다이얼로그의 기본 선택지("No, exit")에서
Enter 를 보내는 바람에 claude 프로세스가 그대로 종료됐다 → SessionEnd, `UserPromptSubmit=0`,
index.html 미생성. macOS/iOS 는 cold-start 타이밍 운으로 통과했을 뿐.

**✅ 해결 + 출하 완료 (PR #853 merged)**:
- **수정 방식**: config-seed 억제는 Claude Code 자체의 non-interactive 권한모드 CLI 플래그
  (`--permission-mode bypassPermissions`, 공식 문서화된 옵션) 경로에선 작동하지 않음을 실증. 따라서
  content-aware `answerFirstRunPrompts()` 로 재설계 — operator 소유 unattended CI 하니스가, 자신이
  방금 만든 throwaway sandbox 의 first-run 프롬프트에 사람이 눌렀을 응답을 대신 제출하는 핸들러:
  세션 DB의 라이브 io 를 읽어 현재 표시된 Claude 자체 first-run 프롬프트 종류를 식별하고, 대응 응답
  키를 전송 — 신뢰 폴더 확인=Enter(문서화된 기본값 Yes 선택) / non-interactive 권한모드 안내=Down+Enter
  ("Yes, I accept" 선택) / settings-error=`3`(Continue). holder 3곳 전부 화면 상태를 확인하지 않던
  고정 간격 `\r` 재시도 루프·`setInterval` 을 제거하고 이 핸들러로 교체.
- **🐞 3번째 블로킹 지점 발견 (사용자 로컬 환경의 실제 설정 버그)**: 위 두 프롬프트에 정상 응답하도록
  수정하니 **세 번째** 블로킹 다이얼로그가 드러남 — `~/.claude.personal/settings.json` 의 `fallbackModel`
  값이 문자열 `"opus"` 인데 현행 claude 스키마는 **배열**(`A.array(A.string())`) 요구 → "Settings
  Error … Expected array, but received string" 다이얼로그가 **매 세션** 뜨고 그 파일의 설정(hooks 포함)이
  전부 스킵됨. 하니스뿐 아니라 사용자 일상 claude 전반에 영향. → 실 파일을 `["opus"]` 로 수정(리포 밖,
  적용 완료) + 하니스도 이 다이얼로그를 방어.
- **검증(PR #853 body 기준)**: macOS ✅ / iOS ✅ / iPad ✅ (index.html Write + Bash 검증,
  `UserPromptSubmit=2, Stop=2`, Write/Bash PostToolUse). M5 input round-trip 회귀(기본 loopback smoke,
  iOS) PASS. **visionOS 는 PR body 에 없음 — 재실행 필요.**

> **주의(문서 정합)**: `.claude/rules/native-testing.md` 는 PR #853 이 갱신하지 않아, 한동안
> TP_E2E_WEBPAGE/CODING 섹션이 폐기된 "13회 Enter blind loop" 동작을 설명하고 있었다. 이 세션의
> harness 식별자 중립화 커밋이 그 문서의 심볼 참조를 새 이름으로 동기화했다 (`answerFirstRunPrompts` 등).

**남은 후속 (선택)**: 인터랙티브 UI dogfood(실기기/앱에서 사람이 직접 조작) 는 별도 후속 — 현재 E2E 는
하니스가 프로그램적으로 turn 을 진행하는 방식.

---

## #49 — Pairing 재설계 (8-PR)

**목표(사용자 verbatim)**: 앱+CLI 상호 인식 + 키 교환 + relay 등록되어야만 유효. 트랜잭셔널.
앱끼리 iCloud Keychain 공유. 모든 pairing이 UUID id + hostname property + relay 발급 signature(relay가
검증 가능) + 무제한(무만료).

> **SoT = `docs/design/pairing-redesign-local-ecdh-commit-v3.md` §5 (8-PR 플랜 표).**
> relay signature 는 폐기됨 (relay 는 zero-trust) — 대신 앱+daemon 이 이미 하는 실 ECDH kx 에서
> 양측 로컬 파생한 **Pairing Confirmation Tag(PCT)** 가 commit certificate 다.

**진행 경과 (실제 머지 기준)**:
1. 1차 설계("Minimal-State Signer", relay-HMAC) → opus 적대적 검증 → **REDESIGN 판정** (4개 확증 결함:
   relay 는 zero-trust 라 daemon 실 pk 미보유; 악의 daemon 이 임의 fingerprint 서명 획득 가능;
   "app COMMITTED⇒daemon COMMITTED" 거짓; 설계의 현재상태 서술 사실오류).
2. 사용자 결정 = **"로컬 ECDH 기반 재설계"**. relay signature 폐기, 앱+daemon 이 이미 하는 실 ECDH kx 에서
   양측 로컬 파생한 **Pairing Confirmation Tag(PCT)** 를 commit certificate 로. relay 는 stateless
   ciphertext-only 유지.
3. **v2 + v3.1 설계 문서 머지 (#861)** — round-3 재검증 판정 = **PASS_WITH_CONDITIONS** (이전 판본이
   "REDESIGN hard gate, 구현 금지" 라고 적은 상태를 이미 넘어섰다).
4. **req-3(iCloud sync 메커니즘) 결정 머지 (#862)** — 이전 판본이 "사용자 스티어 필요" 라고 남긴 미결
   항목이 **Option A 로 결정**됨 (pairing v3.1 4축 분석 기록). 더 이상 사용자 스티어 대기 아님.
5. **PR-1/PR-2 머지**: tp-core 에 PCT + legacy pairing-id + QR v4 layout Rust 구현 (#863=PR-1) + 그
   TS twin byte-exact (#864=PR-2). round-2 검증이 지적했던 3개 CRITICAL(2-phase ingest 고립 / req-3
   sync inert / 단일 pct BLOB N:N 표현불가)은 v3.1 설계 + Option A 결정에서 해소.
6. **PR-3 (daemon 배선) — 이 세션**: 이전 세션이 worktree `pr2-pairing-ts-twin` 에 구현만 해두고
   커밋 없이 "일시정지"로 인계한 것을 발견. 이 세션에서 diff 를 clean 브랜치
   `feat/pr3-daemon-pct-wiring`(off origin/main) 로 재조립·검증(모든 게이트 green)·커밋(`f962b14c`).
   내용 = `pairing_confirmations` 테이블(N:N) + `pairings.pairing_id`/`hostname` + async 백필
   (`migratePairingIds`) + `handleKxFrame` PCT 파생 + **두 hello 빌더**(auto + on-demand) pct 캐리 +
   COALESCE 클로버 가드 + cascade delete + orphan sweep + `SessionHelloReply.d.pct?` additive-optional.
   적대적 리뷰(4-lens) 통과 후 push→PR→squash merge.

7. **PR-4 (앱 connect-on-pending) — 머지됨 (#869)**: pending 라이프사이클 + 3 ingest 지점 +
   pairingId 키 client 맵·promote re-key·GC dispose + committed meta `pairingId`/`hostname` 영속 +
   `TP_PAIR_PENDING` 마커 신설. PCT 검증 없음(승격=kx 완료, 레거시).

**PR-5 완료 (머지됨 #871, squash `74325a80`)**:
- 목표(설계 §5 PR-5 행 + §1.3 승격 판정 표 전체): kx 후 PCT_app 계산 → hello `d.pct` 비교 →
  `onPairingConfirmed`(PCT 일치 게이트)/`onPairingConfirmFailed` → `effectiveV<3` 레거시 분기 →
  `minAdvertisedV` floor 영속·상승(`DaemonKxPayload.v` 최초 소비) → committed 재검증(§2.5) +
  `local-relay-loopback.ts` kx `v:2`→`v:3` + hello pct.
- **§1.3 승격 판정 표 (구현 대상 단일 규칙)**: hello.d.pct present&==PCT_app → COMMITTED(promote)+floor←max(3);
  present&!=PCT_app → FAILED(mismatch, 가시적·재시도); absent & effectiveV<3 → COMMITTED(legacy,
  confirmed=false); absent & effectiveV≥3 → **FAILED(pct-missing, 레거시 fall-through 금지)**.
- ✅ **구현 완료 (전 파일)**:
  - `PairingStore.swift` — `Pairing.minAdvertisedV` 필드 + 전 persist/load 사이트(committed/pending) floor
    스레딩 + QR v4=3 / v2·v3=0 초기화 + committed persist 가 기존 floor 를 내리지 않게 max 보존 +
    `raisePendingFloor`/`raiseCommittedFloor`(monotonic) + `recordConfirmedPct`/`lastConfirmedPct`
    (device-local §2.5 진단) + `floor()` 조회.
  - `RelayClient.swift` — `deriveEpochPct`(kx-frame daemon pubkey + ephemeral 키페어 + 세션키, FFI
    `derivePairingConfirmationTag`) + `uuid16`(big-endian, TS `parseUuid16` 와 byte-exact) + `epochAdvertisedV`
    (`DaemonKxPayload.v` 최초 소비) + 승격 신호 kx→hello 이동 + `resolvePromotion`(§1.3 4셀 전부) +
    `onPairingConfirmed(pid, confirmed)`/`onPairingConfirmFailed(pid, reason)` + pending(하드)/committed(§2.5
    보수적) 구분 + `TP_PAIR_CONFIRM_OK`/`TP_PAIR_CONFIRM_FAIL` 마커.
  - `RelayMessages.swift` — `HelloData.pct: String?` additive-optional.
  - `TeleprompterApp.swift` + `Watch/TeleprompterWatchApp.swift` — 콜백 배선(confirmed/legacy→promote,
    FAILED→client alive 유지+pendingError, committed §2.5 재검증 배선, `setPairingPhase`).
  - `local-relay-loopback.ts` — kx `v:2`→`v:3` + hello `pct`(`deriveLegacyPairingId`+`parseUuid16`+
    `derivePairingConfirmationTag`, daemon-role 세션키로 계산 — app frontend-role 과 byte-exact 수렴 확인).
  - `PairingStoreTests.swift` — floor init/promote-carry/monotonic-raise/PCT-record/absent-default + 마커 7 테스트.
  - `scripts/ios.sh` — `PAIR_CONFIRM_OK_MARKER` 문서화(loopback `TP_PAIR_OK` 가 이제 PCT-confirm 을 transitively 게이트).
- ✅ **검증 통과**: XCTest **164/164**(신규 7 포함) · macOS loopback smoke **8/8** · iOS Sim loopback smoke **8/8**
  (+`TP_PAIR_CONFIRM_OK` 실기 로그 확인 = Cell 1 byte-exact PCT 일치 증명) · swift-format lint clean(내 파일) ·
  protocol 620/620 · **적대적 4-lens 리뷰(§1.3 판정표/byte-exact PCT/lifecycle·anti-downgrade/loopback) 0 findings** ·
  **CI 7/7 green**(lint/type-check/test/build-cli/rust required + swift-build/swift-smoke-ios). 문서 sync(native-testing.md·ios/README.md)는
  같은 PR 에 동봉(squash 로 main 단일 commit). dogfood tp 재빌드 불필요(백엔드 무변경).

**PR-6 (Option A synced pairing store) — 머지됨 (#873, squash `12594403`)**:
- 목표(설계 §3.2/§3.5/§3.6): 커밋 페어링 저장을 daemonId-키 split-storage(secret Keychain + meta
  UserDefaults)에서 **per-pairing synced whole-record Keychain blob**(service `<base>.v2`,
  account=pairingId, `{ps,pk,relay,did,v,pairingId,hostname,ts}`)으로 전환. iCloud Keychain 의 item-
  granular merge 로 2-device 동시추가 무손실 수렴. **device-local 잔류**: frontendId/PCT/lastConfirmedPct/
  label/floor 는 절대 sync 안 됨(sidecar/pointer-map).
- `PairingRecordStore` seam(`loadAll/save/remove`) + `KeychainRecordStore` + `PairingSyncProbe`(macOS
  런타임 SecItemAdd 프로브, `errSecSuccess` 만 sync-on). Keychain 열거 = index; `errSecItemNotFound`
  만 `[]`, 그 외 non-success 는 `.locked` throw(캐시 보존). daemonId→pairingId **device-local pointer
  map** + reconciliation.
- **적대적 다중렌즈 리뷰(5 lens × per-finding verify) → 14 confirmed** 반영: (1) `persist` save-before-
  sweep durability(save 실패해도 옛 blob 잔류, phantom row 방지), (2) 부분-sync 열거에서 **transiently-
  absent did 의 포인터 보존**(non-empty 열거라도 라이브 pairing 을 지우지 않음), (3) 동시 재페어 시
  latest-`ts` dedupe + **losing orphan blob sweep**(≤1-blob-per-did), (4) `protectedDataDidBecomeAvailable`
  **retry-on-unlock** 옵저버(cold-launch-before-unlock 후 재연결). 마이그레이션은 레거시 secret **미삭제**
  (synced-delete 가 구버전 peer 무음 unpair), `remove`/unpair 만 삭제(revocation).
- 검증: XCTest **178/178**(신규 `PairingRecordStoreTests` 14), iOS smoke **8/8 ×2**(regression case
  재확인), macOS smoke **8/8**. 리뷰 fix 재검증 워크플로 4/4 CLOSED. §3.7 2-device iCloud 는 **수동 게이트
  (CI 불가 — iCloud 계정 없음)**, 실배포 전 수행. 문서 sync(design v3 §3.7·IN_PROGRESS·native-testing)는
  같은 PR. **dogfood tp 재빌드 불필요(app-only, 백엔드/rust/cli 무변경).**

**PR-7 (unpair vs "이 기기에서만 제거" split) — 머지됨 (#874, squash `0b08a107`)**:
- 목표(설계 §E/§5): 단일 파괴적 페어링 액션을 둘로 분리 — (1) **Unpair** = mesh revoke = 기존
  `remove()`(synced blob 삭제 propagate + 레거시 secret 삭제 + `control.unpair` daemon 통지),
  (2) **"이 기기에서만 제거"** = device-local·**NON-synced** tombstone (blob/secret 미삭제,
  `control.unpair` 미발신 → non-revoking; synced blob 은 그대로 sync 되고 재설치 시 재-adopt).
- tombstone = `tp.pairing.<pairingId>.localHidden` bool + `tp.pairings.hidden` 인덱스 array
  (UserDefaults, install-scoped; pointer map 과 동일 tier — 재설치가 지우고 synced blob 재-adopt).
  `reconciledPointers` 가 hidden pairingId 를 **loser-sweep 앞단에서** 필터.
- **적대적 다중렌즈 설계 리뷰(28 agents, 17 confirmed) 반영**: (1) **HIGH — reconcile 순서** — resurrected
  hidden blob(peer 가 재-페어 후에도 blob 보유)이 per-did latest-`ts` race 를 이겨(ts 는 replica 간
  비교불가, `>=` tie-break) live re-pair 를 `losers` 로 밀어 synced-delete revoke → hidden 필터를
  loser-sweep **앞단**으로. (2) **legacy 결정론** — `deriveLegacyPairingId(daemonId)` 는 순수함수라
  legacy(v2/v3) 재-페어가 **같은 pairingId** re-mint → recommit(persist/ingest)이 incoming+legacy-derived
  id 둘 다 unhide(안 하면 stale tombstone 뒤 영영 숨음). (3) **sidecar 보존** — `hideLocally` 가
  `Key.meta`(floor/PCT) 미삭제(blob 생존 → floor reset-to-0 downgrade 창 방지). (4) **PENDING sweep** —
  concurrent pending kx promote 부활 차단. (5) tombstone clear = recommit·hard-delete 에서만(열거-부재로는
  안 함 — hidden blob 은 계속 sync). (6) smoke `wipeAllCommittedForSmoke` 가 tombstone 도 clear
  (결정론적 v3-derived smoke id 억제 방지).
- UI = **2-버튼 confirm 시트**: "이 기기에서만 제거 (계속 페어링됨)"(normal) + "Unpair (모든 기기)"
  (red destructive). 로컬-제거는 revocation 으로 안 읽힘. 인바운드 `control.unpair` 는 synced delete 유지(§E.3).
- 검증: XCTest **187/187**(+9: 8 store hide-vs-unpair/legacy-collision/ts-race/transient-absence/
  wipe/floor + 1 VM hideLocally-non-revoking), iOS smoke **8/8**, macOS smoke **8/8**, swift-format lint
  clean(변경 5파일). **dogfood tp 재빌드 불필요(app-only — ios/ + scripts/ios.sh + docs, 백엔드/rust/cli
  무변경).**

**PR-8 (`WS_PROTOCOL_VERSION` 2→3 + PCT/v4 문서) — 머지됨 (#875, squash `955d04e6`) — 8-PR 재설계 종료**:
- 목표(설계 §5/§G): `WS_PROTOCOL_VERSION` 2→3 bump + PCT/QR-v4 문서화. **핵심 통찰**: v3 §377 이
  못박은 대로 **별도 hard `v>=3` 게이트 코드는 없다** — §1.3 승격 판정 표(`effectiveV` + floor)가 유일
  판별 지점이고 그건 PR-5 에 이미 착지됨. bump 자체가 daemon/앱의 광고 `v` 를 3 으로 올려 새-daemon+
  새-앱 페어에서 PCT confirm 경로를 켠다.
- 코드 2곳(lockstep): (1) `packages/protocol/src/compat.ts:43` `WS_PROTOCOL_VERSION = 3` — daemon
  `broadcastDaemonPublicKey`(`relay-client.ts:592` `v: WS_PROTOCOL_VERSION`)가 광고. (2)
  `ios/Sources/Relay/RelayMessages.swift:9` `RelayProtocol.version = 3` — 앱이 `KxPayload.v`/auth `v`
  로 광고(4 사이트). 앱은 광고 `v` 를 `effectiveV = max(epoch v, minAdvertisedV floor)` 로 읽어
  `RelayClient.swift:1026` §1.3 표 구동.
- **downgrade-safe 양방향 실증**: 구-앱은 `pct` additive-optional 무시; 구-daemon 은 앱의 `v:3` frontend
  payload 를 `data.v` finite-number 로 무해 수용(`relay-client.ts:635`, higher 값 거부 안 함, label-gate
  는 A1.3#1 로 이미 unconditional). 그래서 v2 §G.1 의 "gate confirm handshake on v>=3" 스케치는 불필요.
- 테스트: 앱 app-advertised `v` 어서션 3곳 2→3 (`RelayAuthTests` `testProtocolVersionIsBareInteger`/
  auth-encode, `RelayResilienceTests` `testKxPayloadIncludesVersionField`/`testRelayAuthResumeEncodesCorrectly`).
  **DaemonKxPayload decode 픽스처(`v:2`)는 유지** — 구-daemon 을 앱이 여전히 올바르게 디코드함을 커버.
  백엔드 grep 확인: `WS_PROTOCOL_VERSION===2` 어서션 없음(hit 들은 relay.auth.resume `v`/wire-v2 QR 디코드
  = 직교).
- 문서: CLAUDE.md pairing bullet(+QR-v4 필드, +PCT WS-v3 bullet) · ARCHITECTURE §5.6(PCT 계산/전달/
  §1.3 4셀/floor + 버전게이트, QR bundle 에 pairingId/hostname) · `.claude/rules/protocol.md`(relay.kx
  `v` 확장 + 전용 WS-version bullet) · design v3 §5(PR-8 착지 행) · 이 파일.
- 검증: 백엔드 **1753/1753**, Swift **187/187**, iOS smoke **8/8**, macOS smoke **8/8**(loopback 이
  `v:3`+hello pct 광고 → M1 `TP_PAIR_OK` 가 PCT-confirm 을 transitively 게이트, 실동작 확인). CLAUDE.md
  36,905 char(<40k). **dogfood tp 재빌드 필요**(compat.ts = protocol 패키지 변경 → daemon 광고 `v` 영향).

**참고 문서**: `docs/design/pairing-*` (repo 머지 — SoT 안전). §1.3 승격 판정 표 + §2.5 재검증 정책이
PR-5 구현의 SoT. subagent transcript 는 휘발성이므로 문서/PR diff 를 우선 신뢰.

---

## #51 — M5 하니스 결정론 개선 (완료 · #877→#878)

**배경**: #49 종료 후, 유일하게 비결정론적이던 것은 real-claude M5 E2E 하니스 arm
(`TP_E2E_CLAUDE_M5=1 scripts/ios.sh smoke`, `TP_INPUT_OK` 마커)이었다. `TP_INPUT_OK` 는 앱→relay→daemon→
PTY→claude 입력 왕복을 증명하는 M5 마커인데, 이 arm 이 `input round-trip wrong sid: … sid=sess-smoketest
(want sid=real-smoke-sess)` 로 간헐 실패했다. **이건 앱/프로토콜 버그가 아니라 테스트 배관 문제**임을 진단
(PR-8 diff 는 input/probe/claude-path 무관, 세션 DB 에서 `UserPromptSubmit=0` 확인 = 마커가 안 뜬 것뿐).

**2개 root cause (정량화)**:
1. **poll 예산 < probe 수렴**: `claude_e2e` scrape 루프 poll 예산(~75s)이 cold interactive claude 에
   대한 앱 probe 수렴(`probeMaxAttempts=12 × probeRetryInterval=4s ≈ 48s/cycle`, warmup 중 ≥2 cycle)보다
   짧아 앱이 수렴하기 전에 하니스가 포기.
2. **`prefer_sid` foreign-sid fallback**: 이 런의 `real-smoke-sess` 가 제때 마커를 못 emit 하면
   `prefer_sid` 가 sid 무관 최신 `TP_INPUT_OK` 라인으로 폴백 → 같은 sim 의 이전 loopback 런이 남긴
   stale `sess-smoketest` 라인을 잡아 타이밍 미스를 라우팅 버그로 오진(+ foreign-sid false-pass 위험).

**수정 (`scripts/ios.sh`, 테스트 배관만)**:
- 공유 헬퍼 `assert_m5_input`(iOS/macOS/visionOS) 신설, arm 별 분기:
  - **loopback**: same-sid `TP_INPUT_OK`(proof=echo) 그대로 — **byte-identical**(CI 가 돌리는 경로).
  - **claude_m5**: 격리 세션 DB 의 `UserPromptSubmit≥1`(= `assert_coding_e2e` 와 동일 authoritative SoT)을
    180s settle 창(≥2 probe cycle, cold-warmup 흡수)에 걸쳐 폴. same-sid 마커 떴으면 즉시 pass, 아니면
    DB submit 으로 pass, **foreign-sid 라인 절대 미수락**, timeout 시 이 런의 sid + DB count 명시해 정직하게 die.
- 3개 `claude_m5` scrape-loop break 조건을 **M4** 에서 break 하도록 완화(더는 racy `$input_line` 게이트 안 함)
  — M5 는 루프 뒤 DB 폴이 독립 증명. loopback/`else` 브랜치는 `$input_line` 유지(불변).
- 문서 `.claude/rules/native-testing.md` M5-어서션 섹션을 DB-SoT 메커니즘으로 갱신(같은 커밋).

**검증**: loopback smoke **8/8**(byte-identical 회귀 가드) · `TP_E2E_CLAUDE_M5` **8/8** via
`input OK (M5, ios) — DB proof: real-smoke-sess UserPromptSubmit=1` → `✅ REAL-CLAUDE M5 E2E PASS` ·
`bash -n scripts/ios.sh` clean · **CI 7/7 green**(필수 5 + non-required swift-build/swift-smoke-ios,
후자 = loopback 회귀 없음 CI 확인). squash merge `b221335f`, #877 auto-closed. **dogfood tp 재빌드 불필요**
(`scripts/ios.sh`+rule 만, `apps/cli`/`packages` 무변경).

---

## #50 — keychain 접근 확인 프롬프트 완화 (사용자 액션 필요)

**증상(사용자 verbatim)**: "계속 반복해서 keychain access를 위해 비밀번호를 입력해달라고 뜨는데,
이것좀 안뜨게 할 수 없어?"

**원인/완화**: dogfood daemon(또는 관련 프로세스)이 **개발자 본인 소유의** keychain 항목에 접근할 때마다
macOS 가 ACL 확인 프롬프트를 띄운다. 이는 사용자 편의 문제다. 표준 macOS 도구
(`security set-generic-password-partition-list`)로, 항목 소유자인 개발자 본인이 자신이 만든 자신의
keychain 항목 ACL 에 자신이 신뢰하는 apple-tool/apple 파티션을 등록하면 반복 프롬프트 없이 접근이
허용된다. 이는 macOS 표준 ACL 메커니즘이다 — 항목을 소유한 개발자 본인이 자신의 항목에 자신이 신뢰하는
접근자를 명시적으로 등록하는 것 (VS Code/Chrome 등 codesign 된 애플리케이션이 하는 것과 동일).

**⚠️ 이건 사용자 본인만 수행 가능** (keychain 비밀번호 입력이 필요한 macOS ACL 변경 = 에이전트 정책상
대신 실행 금지). 후속 세션도 대신 실행 금지 — 사용자에게 명령을 제시하고 직접 실행하도록 안내만.
정확한 대상 항목(어느 service name 인지)은 프롬프트가 뜰 때 어떤 프로세스/항목인지 확인 후 특정해야 함.

---

## 즉시 다음 액션 (후속 세션 우선순위)

1. ✅ **dogfood tp 재빌드 — 완료** (이 세션). #867 daemon/protocol 반영, daemon 06:09 재기동.
2. ✅ **#48 visionOS 웹페이지 데모 — PASS** (이 세션, fresh xcframework). 4-플랫폼 전부 PASS.
3. ✅ **#49 PR-5 (앱 PCT 검증 승격 게이트) — 머지됨** (#871, squash `74325a80`). §1.3 4셀 + floor +
   §2.5 + loopback v:3+pct. XCTest 164/164 · loopback smoke 8/8 · 적대적 리뷰 0 · CI 7/7 green.
4. ✅ **#49 PR-6 (Option A synced pairing store) — 머지됨** (#873, squash `12594403`).
   `PairingRecordStore` seam + synced whole-record blob + 레거시 마이그레이션 + macOS 런타임 프로브 +
   포인터 reconciliation. 적대적 리뷰 14 findings 반영. XCTest 178/178 · iOS smoke 8/8 ×2 · macOS 8/8.
5. ✅ **#49 PR-7 (unpair vs "이 기기에서만 제거" split) — 머지됨** (#874, squash `0b08a107`).
   device-local·NON-synced `localHidden` tombstone. `hideLocally` non-revoking. reconcile hidden-필터를
   loser-sweep 앞단(HIGH). legacy 결정론 → recommit 이 legacy-derived id 도 unhide. sidecar 보존 +
   PENDING sweep. 2-버튼 confirm 시트. 적대적 리뷰 28 agents/17 confirmed. XCTest 187/187 · smoke 8/8.
6. ✅ **#49 PR-8 (`WS_PROTOCOL_VERSION` 2→3 + PCT/v4 문서) — 머지됨** (#875, squash `955d04e6`) — **8-PR
   재설계 종료**. compat.ts + RelayMessages.swift lockstep bump(광고 `v`=3 → PCT confirm 활성; hard-gate
   코드 없음 = §1.3 표 SoT, PR-5 착지분). downgrade-safe 양방향. 앱 `v` 어서션 3곳 2→3(decode 픽스처 v2
   유지). 문서 CLAUDE/ARCHITECTURE/protocol.md/design v3. 백엔드 1753 · Swift 187 · smoke 8/8 · CI 5/5.
   **dogfood tp 재빌드+재서명 완료** — daemon 이 fresh `tpd`(`955d04e6`, `WS_PROTOCOL_VERSION=3`)로 재기동.
7. ✅ **M5 하니스 결정론 개선 (#877 이슈 → #878 머지, squash `b221335f`)** — real-claude M5 E2E arm 을
   세션-DB `UserPromptSubmit≥1` SoT 로 결정론화(`assert_m5_input` 공유 헬퍼). 테스트 배관만(앱/백엔드 무변경).
   loopback 8/8 byte-identical + `TP_E2E_CLAUDE_M5` 8/8 DB-proof · CI 7/7 green. #877 auto-closed. 위 #51 상세.
8. ✅ **rev8 검증 세션 (2026-07-06)** — 실제 HEAD 상태 재확인: 백엔드 1753/1753 · macOS 스모크 8/8 ·
   dogfood tp fresh · tree clean · PR/이슈 0. IN_PROGRESS 헤더 `b221335f`→`65f5958f` 정정.
9. 🔨 **runner Rust 포팅 — 증분 1 머지(#882) + 증분 2 완료·PR 미제출 (rev10–11, 이 세션)** — 사용자 지시
   ("runner 포팅 착수")로 ADR-0003 Stage 4 진행.
   - **증분 1 ✅ 머지 (#882, main=`00d11b0c`)**: `rust/tp-runner` 스캐폴딩(workspace member) + 순수 조각 —
     byte-exact `capture_hook_command`(golden) + `build_settings`(16 HOOK_EVENTS 머지) + `collector`(io =
     바이너리 사이드카 `payload=""` parity gate / event = base64) + **portable-pty PTY spike**(spawn/read/
     write/resize/kill, reader-thread hop, echo/cat 라운드트립) → **ADR §6.1 "최대 기술 미지수" 해소**.
   - **증분 2 ✅ 완료 (미커밋 워킹트리)**: 5개 async 모듈 + main.rs 결선.
     - `socket.rs` — 런타임 dir(XDG/`/run/user/<uid>`/`/tmp` writer-semantics) + daemon/hook 소켓 경로(sid
       traversal 가드: `/`,`\`,`..` 거부).
     - `wire.rs` — 아웃바운드 `hello`/`bye` 구조체(TS object-literal key-order byte-exact; **pid 생성 가드**
       + `reason` signal/exit disambiguation — `tp_proto::IpcMessage` 는 이 필드가 없어 별도 정의).
     - `ipc.rs` — tokio IPC 클라이언트(`into_split` writer/reader task; **decode-throw teardown**: decode
       err → reset+close; **inbound allowlist** ack/input/resize 만; **overflow→close**).
     - `hooks.rs` — `HookReceiver`(UnixListener; **1 MiB UTF-8 바이트 cap**; `parse_hook_event` 검증;
       parent mode-0700 + atomic stale-socket 제거; Drop 정리).
     - `runner.rs` — `run()` `select!` 루프(io/hook→rec, ack/input/resize, PTY exit/IPC close/SIGINT·SIGTERM
       →break with (exit_code, reason)→bye; graceful bye-flush tick). io/hook 은 루프 내에서만 생성돼 running
       게이팅이 구조적(별도 State enum 불요).
     - `main.rs` — argv 파싱(`--sid/--cwd/--socket-path/--worktree-path/--cols/--rows -- <claude args>`, dim
       clamp≥1, sid fallback `session-<ms>`) + tokio 단일스레드 런타임 + `tokio::signal` 130(INT)/143(TERM).
       claude 프로그램은 `TP_RUNNER_CLAUDE_BIN` 로 override 가능(테스트 seam, 프로덕션 unset→`claude`).
     - **E2E 통합 테스트 `tests/run_e2e.rs`**: 스텁 daemon UnixListener + 가짜 claude 스크립트 → run() 이
       hello→io rec(binary sidecar, payload="")→bye(reason=exit, exitCode=0, pid) 전 체인 전송 검증.
     - **검증**: tp-runner 27 테스트 green(23 lib+3 argv+1 e2e) · 전 워크스페이스 270+ green · clippy
       (`all=deny`)·fmt clean · 무회귀. **cutover 없음** (daemon 은 여전히 Bun `tpd run` spawn).
   - **증분 2 머지 ✅ (#883, main=`ab7223fb`)**.
   - **증분 3 ✅ 완료 (미커밋 워킹트리, rev12 이 세션)** — daemon `TP_RUNNER_BIN` dual-run seam + wire-parity 게이트:
     - **CLI seam**: `apps/cli/src/lib/runner-bin.ts` `resolveRunnerBinOverride(env)` — `TP_RUNNER_BIN`(runner
       바이너리 **절대 경로**) 을 `accessSync(X_OK)` 검증. 미설정/빈=null(기본 Bun), 유효=경로, **무효=throw**
       (조용한 Bun fallback 없음, `errorWithHints` cargo 힌트). `spawn.ts` `resolveRunnerCommandWithOverride` 가
       override 있으면 **단일-요소 argv** `[bin]`(Rust `main.rs` 서브커맨드 없이 `--sid/...` 직수신), 없으면 기존
       `resolveRunnerCommand()`. `daemon.ts`/`passthrough.ts` 의 `setRunnerCommand` 호출 try/catch → fail-loud exit.
     - **trust boundary**: seam 은 daemon **프로세스 env** 전용 — relay `session.create`(command-dispatcher)는 절대
       미접근(원격 peer 가 runner 바이너리 못 고름).
     - **`TP_RUNNER_CLAUDE_BIN` seam**: Bun `runner.ts:108` + Rust `runner.rs:113` 둘 다 claude 프로그램 override
       (differential 하니스 enabler).
     - **wire-parity 게이트 `packages/daemon/src/session/runner-parity.test.ts`**: Bun/Rust 두 runner 를 같은 fake
       claude(고정 stdout·exit 7)로 돌려 프로덕션 `FrameDecoder` 로 프레임 캡처 → hello/bye pid/ts 제외 byte-equal +
       **JSON 키순서** equal(placeholder 재직렬화 string 비교 — key-order 발산 포착), io `payload=""` 사이드카 불변식 +
       concat 바이트스트림 byte-equal. Rust 미빌드 시 SKIP.
     - **세부 케이스**: `runner-bin.test.ts`(5) + `spawn.test.ts`(override describe) + `session-manager.test.ts`
       (단일-요소 argv shape: `[rustBin,--sid,...]` no bun/run) + `runner.test.ts`(claude-bin seam).
     - **검증**: 전 백엔드 1765 pass/0 fail · `pnpm type-check:all` 0 · Biome clean · Rust release runner 빌드+
       parity 통과. **기본 cutover 없음**.
   - **다음(증분 3 PR → 증분 4)**: 증분 3 을 PR 로 제출(`feat(runner): daemon TP_RUNNER_BIN dual-run seam + Bun/Rust
     wire-parity gate`) → 증분 4(dogfood 로 parity 입증 후 기본을 Rust runner 로 cutover) → daemon 포팅(tp-daemon,
     최대·최종 조각).

> **⚠️ rev8 정정 (2026-07-06 rev9): "미착수 코딩 백로그 없음" 은 틀렸다.** rev8 이 stale `TODO.md:84`
> ("Phase 4 = ADR-0003 *Proposed*, Dave 승인 대기, 승인 전 cutover 금지")를 ground truth 로 오인했다.
> **실제**: ADR-0003 는 **Accepted (2026-06-17, Dave)** 이고 이미 상당 부분 실행됐다 — 그래서 백엔드 Rust
> 이관에는 **언블록된 코딩 작업이 남아 있다.** 실제 상태 (소스 재확인):
>
> - ✅ **Stage 0 (메시지 골든벡터)** — `tp-proto` (2,123 LOC, 106-케이스 green).
> - ✅ **Stage 1 (relay)** — `tp-relay` (12,038 LOC, axum/tokio, Step 2–8c) **프로덕션 라이브** (live cutover
>   #716, `relay.tpmt.dev` = Rust relay, **TS relay 퇴역**, 10k soak 하니스, 16 test 파일).
> - ✅ **CLI 전체 포팅** — `tp-cli` (4,064 LOC, Amendment 2, tranche 0–5 + #5 hard-swap). **dogfood `tp` 가
>   곧 Rust 바이너리** (Bun `tpd` blob 로 daemon/passthrough 트램폴린).
> - 🔨 **runner** (`packages/runner`, 763 LOC, PTY + hooks) — **포팅 진행 중**: 증분 1 머지(#882), 증분 2
>   완료(워킹트리, PR 미제출 — 위 항목 9). 남은 것 = 증분 3(daemon `TP_RUNNER_BIN` seam, dual-run + parity).
> - ⬜ **daemon** (`packages/daemon`, 5,391 LOC) — 미포팅, 최대·최종 조각 (store rusqlite 포맷 동결 / worktree
>   git2-vs-shell / PTY 크레이트 spike = ADR §6 열린 결정 — PTY 는 증분 1 에서 portable-pty 로 해소).
>
> **⇒ 다음 코딩 작업 = runner 증분 2 PR 제출 → 증분 3(dual-run seam), 그 다음 daemon.** ADR-0003 Accepted
> 이라 새 승인 불요. PTY 크레이트(§6.1) 는 portable-pty 로 확정 — 남은 §6 spike 는 daemon 단계(store/worktree).
>
> **사용자 결정 반영 (2026-07-06):**
> - ~~Claude Code channels 양방향~~ — **포기** (TODO.md 갱신).
> - ~~External TestFlight~~ — **보류**, 필요 시 Dave 직접 지시 (TODO.md 갱신).
> - **터미널 렌더러** (TODO.md:101): libghostty vs SwiftTerm — Dave 문의. **현 권고 = SwiftTerm 유지**
>   (libghostty 엔진 UX 우위는 실재하나, 임베딩 C API 여전히 불안정 + visionOS 슬라이스 부재 + 리모트-뷰/
>   네트워크-바운드 워크로드라 GPU 이점 희석 → 백엔드 포팅 뒤로 미루는 게 레버리지 높음. 생태계 진전:
>   Termini/GhosttyKit 로 iOS/macOS 임베딩 경로는 생김, visionOS·API-안정성은 미해결). 결정 대기.
>
> **사용자 액션 전용(에이전트 대신 실행 금지, 리마인드만)**: **#50 keychain ACL 완화**(macOS keychain
> 비밀번호 입력 필요 — 사용자 본인만), **#45 실기기 crash 로그**(USB 연결 시 Xcode Organizer 자동 sync 대기).
