# tp-core — Rust core for the native rewrite

ADR-0001 백엔드 트랙의 첫 조각. 와이어 프로토콜의 **순수함수 원시기능**(codec /
KDF / AEAD / crypto_kx / ratchet / pairing)을 Rust 로 구현하고 [UniFFI] 로 Swift
앱에 노출한다. TypeScript 구현(`packages/protocol`, `packages/relay`)과 **바이트 단위로
동일**하다 — 그래야 Rust 코어로 만든 프레임을 기존 Bun daemon/relay 가 그대로 받는다.

[UniFFI]: https://mozilla.github.io/uniffi-rs/

## 레이아웃

```
rust/
  Cargo.toml               # 워크스페이스 (resolver 2, members = [tp-core, tp-proto])
  build-xcframework.sh     # 7-slice 빌드 (iOS/macOS/visionOS/watchOS) + 바인딩 생성 + xcframework 조립
  tp-core/                 # FFI 코어 (앱에 링크) — xcframework 슬라이스
    Cargo.toml             # crate-type = ["lib","staticlib","cdylib"]
    src/
      lib.rs               # UniFFI FFI 표면 (#[uniffi::export] 함수 + Record/Object)
      codec.rs             # framed JSON 코덱 (u32_be jsonLen + u32_be binLen + json + bin)
      crypto.rs            # XChaCha20-Poly1305 AEAD, BLAKE2b KDF, crypto_kx, ratchet
      pairing.rs           # tp://p?d=<base64url> 페어링 v3 바이너리 레이아웃
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
- **Pairing v3**: `magic("tp") + ver(3) + did_len + did + relay_len + relay + ps(32) + pk(32)`,
  base64url 로 감싸 `tp://p?d=…`.

> 이 값들을 바꾸면 기존 daemon/relay 와 호환이 깨진다. 변경 시 `packages/protocol`,
> `packages/relay` 의 TS 구현과 `tests/fixtures/wire-vectors.json` 골든벡터를 함께 고친다.

## 호스트 테스트

```bash
cd rust
cargo test -p tp-core      # 12 단위 테스트 + 8 골든벡터 (TS 교차검증)
cargo test -p tp-proto     # 22 단위 + 4 골든벡터 (메시지 타입 parity, ADR-0003 Stage 0)
```

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
  - `watchos-arm64` — Apple Watch 실기기 (arm64, B3/ADR-0002)
  - `watchos-arm64-simulator` — watchOS Simulator (arm64-only, lipo 불필요)
  gitignored 바이너리.
- `ios/Generated/{tp_core.swift, tp_coreFFI.h, tp_coreFFI.modulemap}` — UniFFI Swift
  바인딩. gitignored, 재현 가능.

타깃 필요:
```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios \
                  aarch64-apple-darwin x86_64-apple-darwin \
                  aarch64-apple-visionos aarch64-apple-visionos-sim \
                  aarch64-apple-watchos aarch64-apple-watchos-sim
```

> visionOS 타깃은 Rust ≥1.96 에서 prebuilt std 와 함께 **stable** 이다 (B0 게이트로 확인 —
> nightly·`-Z build-std` 불필요). tp-core 는 순수 portable Rust (`cfg(target_os)` 0개) 라
> 그냥 재컴파일된다. watchOS 슬라이스는 B3 (별도 `TeleprompterWatch` 타깃) 에서 추가된다.
>
> xcframework 는 (platform, variant) 당 라이브러리 1개만 허용하므로, arm64-sim 과
> x86_64-sim 두 정적 아카이브를 `lipo` 로 fat archive 하나로 합쳐 simulator slice 로 넣는다.
> macOS 도 같은 방식 (arm64-darwin + x86_64-darwin → macos-fat). visionOS 는 device·sim
> 모두 arm64 단일 아키 (Intel Vision Pro / x86_64 xrOS sim 이 없음) 라 lipo 가 필요없다.
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
