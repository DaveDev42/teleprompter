# tp-core — Rust core for the native rewrite

ADR-0001 백엔드 트랙의 첫 조각. 와이어 프로토콜의 **순수함수 원시기능**(codec /
KDF / AEAD / crypto_kx / ratchet / pairing)을 Rust 로 구현하고 [UniFFI] 로 Swift
앱에 노출한다. TypeScript 구현(`packages/protocol`, `packages/relay`)과 **바이트 단위로
동일**하다 — 그래야 Rust 코어로 만든 프레임을 기존 Bun daemon/relay 가 그대로 받는다.

[UniFFI]: https://mozilla.github.io/uniffi-rs/

## 레이아웃

```
rust/
  Cargo.toml               # 워크스페이스 (resolver 2, members = [tp-core, tp-proto, tp-relay, tp-cli, tp-runner, tp-daemon, tp-loopback, tp-e2e-holder])
  build-xcframework.sh     # 7-slice 빌드 (iOS/macOS/visionOS/watchOS) + 바인딩 생성 + xcframework 조립
  tp-core/                 # FFI 코어 (앱에 링크) — xcframework 슬라이스
    Cargo.toml             # crate-type = ["lib","staticlib","cdylib"]
    src/
      lib.rs               # UniFFI FFI 표면 (#[uniffi::export] 함수 + Record/Object)
      codec.rs             # framed JSON 코덱 (u32_be jsonLen + u32_be binLen + json + bin)
      crypto.rs            # XChaCha20-Poly1305 AEAD, BLAKE2b KDF, crypto_kx, ratchet
      pairing.rs           # tp://p?d=<base64url> 페어링 v4 바이너리 레이아웃 (v2/v3 하위호환 디코드)
      error.rs             # TpError (UniFFI flat_error)
      bin/uniffi-bindgen.rs
    tests/
      wire_vectors.rs      # TS 라이브 구현에서 뽑은 골든벡터 교차검증 (8개)
      fixtures/wire-vectors.json
  tp-proto/                # ADR-0003 Stage 0 — 메시지 타입 parity (host-only rlib, xcframework 미포함)
    Cargo.toml             # crate-type = lib (rlib); deps: serde/serde_json, rand_core(OsRng), x25519-dalek
    src/
      lib.rs               # 공유 guard 프리미티브 (is_number/is_non_negative_int/opt_string/…)
      label.rs             # Label tagged-union + decodeWireLabel/decodeKxLabelOrKeep (total/관대)
      control.rs           # parse_control_message (control.unpair/rename)
      ipc.rs               # parse_ipc_message (28 variant + AgeFilter + parse_label_field + reason enums)
      relay_client.rs      # parse_relay_client_message (10 variant + Role/Platform/InterruptionLevel/PushData)
      keypair.rs           # generate_keypair (랜덤 OsRng — tp-core 의 결정적 kx_seed_keypair 보완)
    tests/
      message_vectors.rs   # 라이브 TS 가드 교차검증 (accept/reject + 직렬화 동등, 값기준 json_eq)
      fixtures/message-vectors.json   # scripts/gen-message-vectors.ts 산출 (relayClient/ipc/control/label)
  tp-relay/                # ADR-0003 Stage 1 — relay 서버 (host-only). [lib] tp_relay + [[bin]] tp-relay
    src/main.rs            # runnable 엔트리 (Step 8a); production = /usr/local/bin/tp-relay
  tp-cli/                  # ADR-0003 Amendment 2 — 네이티브 `tp` CLI (host-only). Bun CLI 대체 진행 중
    Cargo.toml             # [[bin]] tp; deps: clap. build.rs = root package.json version → TP_CLI_VERSION
    build.rs               # 단일 버전 SoT (root package.json read; CARGO_PKG_VERSION fallback)
    src/
      main.rs              # THIN clap 라우터 (11 서브커맨드 선언; 미포팅은 loud-fail stub)
      commands/
        version.rs         # `tp version` — tp + claude 버전 (byte-parity vs Bun, NO_COLOR gate)
  tp-runner/               # ADR-0003 Stage 4 — 네이티브 runner (host-only). 출하 bin, 기본 cutover 완료 (task #4 — Rust tp-daemon 이 세션마다 tp-runner spawn)
    Cargo.toml             # [lib] tp_runner + [[bin]] tp-runner; deps: serde/serde_json, tp-core, tp-proto, base64, portable-pty, tokio, rustix
    src/
      lib.rs               # 모듈 선언 + 크레이트 doc (io-record 바이너리 사이드카). CLI-side seam = apps/cli resolveRunnerBinOverride (TP_RUNNER_BIN). Bun↔Rust differential wire-parity 게이트(runner-parity.test.ts)는 PR4(#5 cascade)에서 삭제 — byte-exactness 는 이제 cargo test + tp-core 골든벡터가 커버
      settings.rs          # byte-exact capture_hook_command(golden) + build_settings(hook 머지, 16 HOOK_EVENTS)
      collector.rs         # io_record(바이너리 사이드카 payload="") / event_record(base64 payload, ns="claude")
      pty.rs               # Pty over portable-pty (ADR §6.1 spike 해소; reader-thread hop, spawn/write/resize/kill, Mutex writer). 종료 시 waiter 스레드가 reader-done rendezvous 채널에 READER_DRAIN_GRACE=200ms 로 bounded-wait(recv_timeout — join 아님)해 reader/waiter 순서 레이스(Layer 1)를 닫는다: 정상 종료는 그 안에 EOF 로 남은 출력을 다 흘려보내고, grandchild 가 PTY 를 물고 있어도 200ms 안에 무조건 종료 신호를 보낸다
      socket.rs            # 런타임 dir(XDG/run-user/tmp writer-semantics) + daemon/hook 소켓 경로(sid traversal 가드)
      wire.rs              # hello/bye 아웃바운드 구조체(pid 생성 가드 + reason signal/exit, TS key-order byte-exact)
      ipc.rs               # 비동기 IPC 클라이언트(into_split writer/reader task, decode-throw teardown, inbound allowlist, overflow→close)
      hooks.rs             # HookReceiver(UnixListener, per-conn accumulate + 1 MiB UTF-8 바이트 cap, mode-0700 parent, atomic stale-socket 제거)
      runner.rs            # run() select! 루프(io/hook→rec, ack/input/resize, PTY exit/IPC close/SIGINT·SIGTERM→bye, graceful bye-flush)
      main.rs              # 엔트리 (argv 파싱 + tokio 단일스레드 런타임 + tokio::signal 130/143 매핑 → runner::run)
    tests/
      run_e2e.rs           # E2E: 스텁 daemon + TP_RUNNER_CLAUDE_BIN 가짜 claude → hello→io rec(binary sidecar)→bye reason=exit
  tp-loopback/             # #5 zero-Bun — 스모크 loopback (host-only). scripts/local-relay-loopback.ts 대체
    Cargo.toml             # [[bin]] tp-loopback; deps: tp-core, tp-relay, tokio-tungstenite(WS client), base64, rand_core
    src/main.rs            # 실 RelayServer(axum, 고정 포트 7099) + 가짜 daemon WS peer(auth→sub→kx v:3 broadcast→kx.frame→hello(PCT)/state/batch/io echo). LOOPBACK_READY 후 대기. scripts/ios.sh: TP_RUST_LOOPBACK=1 로 스폰(Bun script wire-identical, 8마커 교차검증)
  tp-e2e-holder/           # #41 PR2b (#5 zero-Bun) — 실 daemon E2E holder (host-only, dev 전용). scripts/real-daemon-pair.ts 대체
    Cargo.toml             # [[bin]] tp-e2e-holder; deps: tp-relay(embedded), tp-proto, tokio, rusqlite(read-only), rustix(SIGTERM)
    src/
      main.rs              # 엔트리: embedded relay(or --relay-url) → parity contract 라인 → tp-daemon spawn → IPC pair.begin → REAL_PAIR_URL/REAL_PAIR_READY stdout contract → claude 모드 dispatch(webpage>coding>interactive>print) → park
      spawn.rs             # resolve_bin(TP_RUNNER_BIN/TP_DAEMON_BIN env-else-sibling, die) + spawn_daemon/spawn_runner(standalone tp-runner) + SIGTERM teardown(runner→daemon)
      claude.rs            # print/M5/coding/webpage 세션 구동: answer_first_run_prompts 상태머신(1.5s tick, 40s deadline), send_turn(text→별도 \r), UserPromptSubmit 등록 확인+재전송(≤5), Stop 게이트
      db.rs                # 세션 DB read-only 접근 (rusqlite SQLITE_OPEN_READ_ONLY|NO_MUTEX; count_records/read_recent_io — 에러는 0 으로 degrade)
      push.rs              # --emit-push-notification: 세션 DB ready 폴(60s) 후 합성 Notification rec 프레임 주입(8×@3s)
      relay.rs             # embedded tp_relay::RelayServer (127.0.0.1:0, 토큰 pre-seed 없음 — daemon self-register)
      ipc.rs / envcfg.rs / out.rs  # daemon IPC 클라이언트(pair.begin/wait) / env(empty==unset) / stdout contract 라인 + stderr 진단 + FATAL die
```

## 와이어 불변식 (TS 와 바이트 동일 — 절대 깨지 않음)

- **Codec**: `u32_be jsonLen + u32_be binLen + UTF-8 JSON + binary`, HEADER_SIZE=8,
  MAX_FRAME_SIZE=64 MiB.
- **AEAD**: XChaCha20-Poly1305-IETF, 24B nonce 를 `ct||tag` 앞에 prepend, **표준**
  base64 (URL-safe 아님).
- **KDF**: `BLAKE2b_32(secret || UTF8(domain))`, domain = `relay-auth` /
  `kx-envelope` / `relay-register` / `relay-push-seal`.
- **crypto_kx**: `seed_keypair(seed)` 의 `sk = BLAKE2b-256(seed)` (generichash 32B —
  SHA-512 도 BLAKE2b-512 도 아님), `pk = scalarmult_base(sk)`. 세션키 =
  `BLAKE2b-512(shared || client_pk || server_pk)`, client rx=[0..32]/tx=[32..64],
  server 는 미러. 불변식: `daemon.rx == frontend.tx`, `daemon.tx == frontend.rx`.
- **Ratchet**: base 키 canonical 정렬 → `k_a=H(min||sid||"a")`,
  `k_b=H(max||sid||"b")`; daemon tx=k_a/rx=k_b, frontend 는 미러.
- **Pairing v4**: `magic("tp") + ver(4) + did_len + did + relay_len + relay + ps(32) + pk(32)
  + pairing_id(16 raw UUID) + hostname_len + hostname`, base64url 로 감싸 `tp://p?d=…`. 인코더는
  항상 v4 를 emit; 디코더는 v2(trailing label)/v3(…|pk)/v4 를 모두 수용(하위호환). v2/v3 로 디코드된
  번들은 `pairing_id`/`hostname` 이 빈 문자열(caller 가 legacy id 를 유도).
- **PCT (Pairing Confirmation Tag)**: `generic_hash_32("tp-pairing-confirm\x01"(19) + pairing_id(16)
  + u8_len(did)+did + u8_len(host)+host + daemon_pk(32) + frontend_pk(32) + min(tx,rx)(32)
  + max(tx,rx)(32))` — ECDH 세션키 위의 device-local BLAKE2b-256 commit(양쪽이 같은 키 합의에
  도달했음을 증명). tx/rx 를 lexicographic min/max 로 정렬해 role-독립.
- **Legacy pairing-id**: `generic_hash_32("tp-pairing-id-legacy\x01"(21) + utf8(did))[0..16]`, byte6=
  version 8 nibble / byte8=RFC-4122 variant → canonical UUIDv8 문자열. QR 가 `pairingId` 를 나르기
  전 페어링된 레코드의 안정적 id.

> 이 값들을 바꾸면 기존 daemon/relay 와 호환이 깨진다. 변경 시 `packages/protocol`,
> `packages/relay` 의 TS 구현과 `tests/fixtures/wire-vectors.json` 골든벡터를 함께 고친다.

## 호스트 테스트

```bash
cd rust
cargo test -p tp-core      # 12 단위 테스트 + 8 골든벡터 (TS 교차검증)
cargo test -p tp-proto     # 22 단위 + 4 골든벡터 (메시지 타입 parity, ADR-0003 Stage 0)
cargo test -p tp-relay     # 핫패스 lib + http surface + 10 loopback integration
cargo test -p tp-runner    # settings/collector/wire byte-exact + PTY + async ipc/hooks/runner + argv + E2E (27 테스트)
```

## `tp-relay` 바이너리 (ADR-0003 Stage 1 Step 8a)

`tp-relay` 는 `[lib]`(`tp_relay`) 외에 **runnable `[[bin]] tp-relay`** 를 갖는다 (`src/main.rs`).
바이너리는 THIN 하다 — 모든 relay 설정(resume-secret / rate / push-seal / cache / max-frame)은
`SharedState::from_env()` 가 env 에서 읽고, 바이너리는 **listen 포트와 graceful shutdown 만** 결정한다.

```bash
export PATH="$(dirname "$(rustup which cargo)"):$PATH"   # rustup shim 우회 (machine-portable)
cargo build --release --bin tp-relay
./target/release/tp-relay --port 7090      # 또는 RELAY_PORT=7090 env
./target/release/tp-relay --help           # usage + env knob 목록
```

포트 우선순위: `--port <N>` flag > `RELAY_PORT` env > 기본 `7090`. SIGINT/SIGTERM 수신 시
새 연결 수락을 멈추고 in-flight 를 drain 한 뒤 종료한다 (`systemctl stop` 안전). 시작 시
`tp-relay listening on 0.0.0.0:<port> (buildSha=<sha>)` 한 줄을 찍는데, 그 `buildSha` 는
`/health.buildSha`(컴파일타임 `build.rs` `TP_BUILD_SHA` 주입)와 동일하다.

| env | 의미 |
|-----|------|
| `RELAY_PORT` | listen 포트 (`--port` 보다 낮은 우선순위) |
| `TP_RELAY_RESUME_SECRET` | resume 토큰 HMAC 키 (미설정 시 ephemeral — 재시작마다 full-auth fallback) |
| `TP_RELAY_RATE_PER_CLIENT` / `_PER_DAEMON` | per-client / per-daemon-group GCRA budget |
| `TP_RELAY_CACHE_SIZE` | sid 당 recent-frame 링 깊이 |
| `TP_RELAY_MAX_FRAME_SIZE` | 최대 inbound frame 바이트 (기본 1 MiB) |
| `TP_RELAY_PUSH_SEAL_SECRET[_PREV]` | APNs push-token seal 키 |
| `TP_RELAY_ADMIN_TOKEN` | `/admin` bearer (미설정 → `/admin` 404 closed-by-default) |

env knob SoT 는 `.claude/rules/relay-capacity.md` "Single-node knobs" 표.

### 로컬 Rust-relay E2E (Step 8a 게이트)

`scripts/rust-relay-e2e.ts` 는 **실 `tp` daemon 이 LOCALLY-RUN Rust relay 바이너리에 페어링 +
frontend-auth 완료**를 증명하는 fully-local 게이트다. production(relay.tpmt.dev / deploy /
실 시크릿 / dogfood daemon)은 일절 건드리지 않는다.

```bash
bun run scripts/rust-relay-e2e.ts
```

순서: (1) `cargo build --release --bin tp-relay`, (2) free loopback 포트에 ephemeral
`TP_RELAY_RESUME_SECRET` 로 바이너리 실행, (3) `/health` status=ok 대기, (4)
`scripts/real-daemon-pair.ts --relay-url ws://127.0.0.1:PORT` 로 **격리 daemon**(자체 mktemp
`XDG_RUNTIME_DIR`/`XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`HOME` — dogfood store 와 절대 충돌 안 함)
페어링, (5) `/health daemons>=1` + `/metrics relay_daemons_online>=1` 어서션(daemon register),
(6) 페어링 deep link 에서 relayToken 을 유도해 frontend-role `relay.auth` → `relay.auth.ok`
프로브, (7) teardown(orphan 0, 격리 tree 삭제).

> **정직한 범위 — M0–M2 만.** register(M0) + frontend `relay.auth`→`relay.auth.ok`(M2) 를
> 증명한다. 전체 kx(M3)/session frame(M4)/input(M5) 은 spawn 된 claude 세션이 필요해 8a 범위
> 밖 — 8마커 loopback smoke(`scripts/ios.sh smoke`)가 담당. `real-daemon-pair.ts` 의 `--relay-url`
> 플래그(이 작업에서 추가)가 in-process TS relay 를 띄우는 대신 외부(Rust) relay 로 페어링한다.
> (하니스 쪽 실-daemon E2E holder 는 #41 PR2b 로 Rust `tp-e2e-holder` 가 대체 — 이 8a 게이트만
> `real-daemon-pair.ts` 를 PR6(TS 삭제)까지 유지한다.)

### Soak — 10k capacity gate (ADR-0003 §6.9)

`tp-relay/tests/soak_10k.rs` 는 **capacity gate** 다 (Stage-1 재설계가 ~10k concurrent
bar 를 낮추지 않음을 증명). `#[ignore]` 이라 일반 `cargo test --workspace` 는 수천 소켓을
열지 않는다. ONE 파라미터화 하니스가 세 부하 차원(pub fan-out + resume storm + push-
under-load)을 env 로 스케일한다 — **heavy=local, light=CI**.

```bash
# heavy = local (full 10k, on-demand). loopback 소켓이 많으니 ulimit 먼저 올린다.
ulimit -n 65535
TP_SOAK_CONNS=10000 TP_SOAK_SECS=60 \
  cargo test -p tp-relay --test soak_10k -- --ignored --nocapture

# light = CI tier (.github/workflows/ci.yml rust job 이 normal test 뒤에 실행):
ulimit -n 65535
TP_SOAK_CONNS=1500 TP_SOAK_SECS=20 \
  cargo test -p tp-relay --test soak_10k -- --ignored --nocapture

# TP_SOAK_JSON=1 을 붙이면 마지막 줄에 single-line JSON 요약을 emit.
```

env 기본값: `TP_SOAK_CONNS=10000`, `TP_SOAK_SECS=60`. 차원·rate-knob caveat·불변식
프로브 상세는 `.claude/rules/relay-capacity.md` "Soak harness" 섹션 (capacity SoT).

골든벡터(`tests/fixtures/wire-vectors.json`)는 **라이브 TS 프로덕션 경로**(libsodium
+ 프로젝트 codec)에서 생성한 것이라, Rust 출력이 이와 일치하면 TS↔Rust 바이트 동일이
증명된다.

`tp-proto` 의 `tests/fixtures/message-vectors.json` 도 같은 원리 — **라이브
`@teleprompter/protocol` 가드**(`parseRelayClientMessage`/`parseIpcMessage`/
`parseControlMessage`/`decodeWireLabel`)를 `scripts/gen-message-vectors.ts` 가 import 해
accept/reject 벡터를 뽑는다. Rust 파서가 같은 raw 입력에 대해 같은 accept/reject + 같은
직렬화 출력을 내면 메시지-레벨 parity 가 증명된다. 가드 동작이 바뀌면 재생성:
`bun scripts/gen-message-vectors.ts`. **이 크레이트는 host-only — 런타임 cutover 없음
(Stage 0 = 골든벡터 gate 만).** TS 가드 또는 enum 을 바꾸면 fixture 재생성 + Rust 포트도
함께 갱신.

### 툴체인 주의 (rustup shim)

이 repo 의 PATH 는 rustup shim 을 실제 rustc 앞에 둬서, cargo 내부의 `rustc -vV` 가
rustup 배너를 읽고 `` "didn't have a line for `host:`" `` 로 실패한다. 직접 cargo 를
부를 때는 실제 툴체인 bin 을 PATH 앞에 붙인다:

```bash
TC="/Users/dave/.rustup/toolchains/stable-aarch64-apple-darwin/bin"; export PATH="$TC:$PATH"
```

`build-xcframework.sh` 는 `rustup which cargo` 로 이를 자동 처리한다.

## iOS/macOS xcframework 빌드

```bash
rust/build-xcframework.sh            # release (기본)
rust/build-xcframework.sh --debug    # debug
# 또는 앱 하니스 경유:
scripts/ios.sh rust
```

산출물:
- `rust/target/TpCore.xcframework` — **7 슬라이스**:
  - `ios-arm64` — iOS 실기기 (arm64)
  - `ios-arm64_x86_64-simulator` — iOS/iPadOS Simulator (arm64 + x86_64 lipo fat)
  - `macos-arm64_x86_64` — native macOS (arm64 + x86_64 lipo fat, Catalyst 아님)
  - `xros-arm64` — Apple Vision Pro 실기기 (arm64, B1/ADR-0002)
  - `xros-arm64-simulator` — visionOS Simulator (arm64-only, lipo 불필요)
  - `watchos-arm64_arm64_32` — Apple Watch 실기기 (arm64 + arm64_32 lipo fat, B3/ADR-0002)
  - `watchos-arm64-simulator` — watchOS Simulator (arm64-only, lipo 불필요)
  gitignored 바이너리.
- `ios/Generated/{tp_core.swift, tp_coreFFI.h, tp_coreFFI.modulemap}` — UniFFI Swift
  바인딩. gitignored, 재현 가능.

타깃 필요:
```bash
# tier-2 (prebuilt std, stable 1.96.0)
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios \
                  aarch64-apple-darwin x86_64-apple-darwin \
                  aarch64-apple-visionos aarch64-apple-visionos-sim \
                  aarch64-apple-watchos aarch64-apple-watchos-sim
# tier-3 watchOS arm64_32 (no prebuilt std → nightly + build-std)
rustup toolchain install nightly
rustup component add rust-src --toolchain nightly
```

> iOS/macOS/visionOS 와 `aarch64-apple-watchos` 는 Rust ≥1.96 에서 prebuilt std 와 함께
> **tier-2 stable** 이다 (B0 게이트로 확인 — nightly·`-Z build-std` 불필요). tp-core 는 순수
> portable Rust (`cfg(target_os)` 0개) 라 그냥 재컴파일된다.
>
> **단, watchOS 실기기 슬라이스는 arm64 + arm64_32 fat 이어야 한다.** 우리의 watchOS 10.0
> 배포 타깃은 Apple Watch Series 4–8/SE (전부 arm64_32 전용) 를 포함하므로, 실기기 archive
> 가 arm64_32 를 요구한다 — 없으면 `TpCore.xcframework' is missing architecture(s)
> required by this target (arm64_32)` 로 링크 실패한다. `arm64_32-apple-watchos` 는 Rust
> **tier-3** (prebuilt std 없음) 라, 그 한 슬라이스만 **nightly + `-Z build-std=std,panic_abort`**
> (rust-src 필요) 로 빌드해 stable arm64 슬라이스와 `lipo` 로 fat 으로 합친다
> (`build_watchos_arm64_32()`). 두 아키는 device archive 안에서 절대 interlink 하지 않으므로
> (per-arch 슬라이스) 이 cross-toolchain mix 는 ABI-safe.
>
> xcframework 는 (platform, variant) 당 라이브러리 1개만 허용하므로, arm64-sim 과
> x86_64-sim 두 정적 아카이브를 `lipo` 로 fat archive 하나로 합쳐 simulator slice 로 넣는다.
> macOS 도 같은 방식 (arm64-darwin + x86_64-darwin → macos-fat). watchOS 실기기도 같은 방식
> (arm64 + arm64_32 → watchos-dev-fat). visionOS 는 device·sim 모두 arm64 단일 아키
> (Intel Vision Pro / x86_64 xrOS sim 이 없음) 라 lipo 가 필요없다.
>
> `xcodebuild -create-xcframework` 결과를 `plutil -p Info.plist | grep LibraryIdentifier`
> 로 확인하면 7개의 LibraryIdentifier 가 나와야 한다.

## Swift 에서 쓰기

앱 타깃은 `project.yml` 에서 `../rust/target/TpCore.xcframework` 를 `embed: false`
(정적 링크) 로 의존하고, `Generated/` 의 바인딩을 소스로 포함한다. 생성된 top-level
함수(`tpCoreVersion`, `encodeFrame`/`decodeFrames`, `seal`/`open`, `kxSeedKeypair`,
`kxServerSessionKeys`/`kxClientSessionKeys`, `ratchetSessionKeys`,
`encodePairingData`/`decodePairingData` 등)를 직접 호출한다.

검증: `ios/Sources/TpCoreCheck.swift` 가 encode→encrypt→decrypt→decode 라운드트립을
실행하고 `ContentView` 가 그 결과(`TP_CORE_OK`/`TP_CORE_FAIL`)를 통합 로그에 방출 →
`scripts/ios.sh smoke` 가 Simulator 에서 확인. `ios/Tests/TpCoreTests.swift` 가 같은
원시기능을 XCTest 로 단위 검증한다 (`scripts/ios.sh test`).

## 의존성

순수 Rust crate 만 사용 (C 툴체인 마찰 없는 iOS 크로스컴파일):
`chacha20poly1305`, `x25519-dalek`(static_secrets), `blake2`, `base64`, `serde`,
`serde_json`, `hex`, `thiserror`, `uniffi`.
