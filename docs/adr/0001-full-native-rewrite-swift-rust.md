# ADR-0001 — 전면 네이티브 재작성 (Swift 앱 + Rust 코어)

- 상태: **Accepted** (2026-06-15) · **플랫폼 범위는 [ADR-0002](./0002-multiplatform-apple-expansion.md) 가 대체(Superseded by 0002, platform scope)** — §6 "향후 플랫폼" 및 "iOS Simulator 우선 / watchOS post-Phase-3" 전제는 0002 로 갱신. 나머지 본문(전면 재작성 결정, `tp-core` 공유 코어, 보존 불변식, 로컬 하니스)은 유효.
- 결정자: Dave
- 대체: (없음) — 점진 피봇 제안(`chore/pivot-planning-docs` 브랜치의 미머지 초안)을 **기각**하고 전면 재작성을 택함.

## 1. 맥락

기존 스택: Expo(React Native + RN Web) 프런트엔드 + Bun(daemon/relay/runner) 백엔드 +
EAS 클라우드 빌드/배포. 성능(daemon/relay), 순수 네이티브 UX, RN/Hermes/Expo 의존성 부담,
EAS 빌드 회귀 표면이 누적 비용이 됐다.

처음에는 "RN 셸 유지 + 터미널만 네이티브화 + 백엔드만 점진 Rust" 의 점진 전환을 검토했으나
(미머지 초안), Dave 의 결정으로 **전면 재작성**으로 방향을 확정했다:

> "완전하게 작동하는 teleprompter를 Swift + Rust로 재작성한다. 모든 작동이 완벽하게
> 이뤄짐을 제대로 검증한다. 정기적으로 iOS Simulator에서 구동하여 테스트한다."
>
> "기존 Expo 스택은 모두 정리하고, Expo EAS 스택도 모두 정리한다. 또한, Swift로 작성하여
> 이를 빌드하고 배포하여 iOS Simulator에서 테스트하기 위한 harness를 구축하는 것을 최우선으로
> 진행한다."

## 2. 결정

1. **앱 = Swift (SwiftUI).** Expo/RN/RN Web 전면 제거. iOS(Simulator 우선) 네이티브 앱.
2. **공유 코어 = Rust (`tp-core`).** wire codec + E2EE crypto + pairing + Envelope 를
   Rust 로 단일 구현하고, Swift 에 FFI(UniFFI 우선 평가)로 **순수 함수만** 노출.
3. **백엔드(daemon/relay/runner)** 도 최종적으로 Rust 로 이관. 단, 현재 동작하는 Bun
   구현은 **포팅 완료 전까지 레퍼런스로 유지** (dogfood daemon/relay 가 계속 떠 있어야 함).
   삭제 대상은 **Expo 앱(`apps/app`) + EAS 인프라**로 한정한다.
4. **CLI** 는 당분간 TypeScript 유지(별도 재평가) — 단일 `tp` 바이너리 dogfood 파이프라인 보존.
5. **빌드/배포/검증 = 로컬 Simulator 하니스.** EAS 클라우드 빌드 제거. `xcodebuild` +
   `xcrun simctl` 로 빌드→설치→실행→스모크 테스트하는 재실행 가능한 스크립트를 **최우선** 구축.

## 3. 보존 불변식 (재작성 후에도 유지)

`docs/native-terminal-plan.md` 및 protocol SoT 와 일치:

- **wire = framed JSON** (`u32_be jsonLen + u32_be binLen + JSON + binary`, header 8B,
  max 64 MiB) — transport 무관. `packages/protocol/src/codec.ts` 가 byte-exact 레퍼런스.
- **E2EE = payload 안.** XChaCha20-Poly1305-IETF, nonce **24B prepended**, 표준 base64,
  키 32B, tag 16B. KDF = `BLAKE2b_32(secret || domain)` (domain: `relay-auth` /
  `kx-envelope` / `relay-register` / `relay-push-seal`). 세션키 ratchet = `crypto.ts:153`.
  X25519 `crypto_kx` (client/server session keys rx/tx). 상수 전체는 protocol 레퍼런스 참조.
- **relay = 이미 암호화된 프레임만 중계, 평문 미접근, stateless** (untrusted hosted hop — 표준 E2EE privacy; 10-frame 캐시만).
- **daemon = relay 의 유일 클라이언트**, WS 서버 미오픈.
- relay protocol v2 메시지 shape (register/auth/auth.resume/kx/pub/frame/presence/control) 유지.

Rust `tp-core` 는 위 상수를 **byte-for-byte** 재현해야 기존 daemon/relay 와 wire 호환된다
(점진 컷오버를 위해 필수).

## 4. 단계

- **Phase 0 (최우선): Swift→Simulator 하니스.** 최소 SwiftUI 앱이 `xcodebuild`로 빌드되고
  `simctl install/launch`로 Simulator 에서 부팅 + 스모크 테스트 통과. 재실행 스크립트화.
- **Phase 1: Expo + EAS 정리.** `apps/app`(Expo) 제거, `eas.json`/`.eas/`/EAS CI(eas-gate)/
  expo-mcp/RN Web 도그푸드/관련 docs·rules 제거. 백엔드 TS 는 유지.
- **Phase 2: `tp-core` (Rust) + Swift FFI.** codec/crypto/pairing 구현 + UniFFI xcframework,
  Swift 앱에 링크, encode→encrypt→decrypt→decode 라운드트립을 Simulator 에서 검증.
- **Phase 3: Swift 앱 기능 parity.** pairing(QR), relay client(WS), 세션 목록, Chat(hooks),
  터미널(SwiftTerm→libghostty). 각 마일스톤마다 Simulator 검증.
- **Phase 4: 백엔드 Rust 이관** (relay→daemon→runner), wire 호환 유지하며 컷오버.

## 5. 기각된 대안

- **점진 피봇 (RN 셸 유지 + 터미널만 네이티브 + 백엔드만 Rust):** 누적 RN/Expo 의존성·EAS
  회귀 표면을 끝내지 못함. Dave 가 전면 재작성으로 결정.
- **EAS 클라우드 빌드 유지:** 빌드 회귀·반복 지연. 로컬 Simulator 하니스로 대체.

## 6. 향후 플랫폼 (Android / Windows) — 확장 경로

iOS 가 E2E 로 완성된 뒤(Phase 3 M5) 검토한다. 지금 구현하지 않지만, 진행 중인 작업이
이 경로의 문을 닫지 않도록 다음 규율을 지킨다. **공유 단위는 `tp-core`(Rust)** 이며, 새 플랫폼이
와도 crypto/wire 는 한 줄도 재구현하지 않는다 — 분기는 UI 셸에만 생긴다.

- **공유 코어는 OS·언어 중립.** `tp-core` 의 wire codec + E2EE(AEAD/KDF/crypto_kx/ratchet) +
  pairing 은 순수 Rust 라 모든 타깃에 byte-exact 로 재사용된다.
  - **Android**: `cargo-ndk` 빌드 → UniFFI 가 **Kotlin** 바인딩 자동 생성 (iOS 의 Swift 바인딩과
    동일 메커니즘). UI 셸은 Jetpack Compose 별도. Swift 는 Android 로 가지 않으므로 Swift 레이어
    (RelayClient/세션 디코드)는 iOS/macOS/watchOS 한정 — **진짜 공유 단위는 `tp-core` 다**.
  - **Windows**: (a) controller GUI 앱이면 `tp-core` C ABI → Tauri(Rust+web) 또는 .NET P/Invoke.
    (b) daemon **호스트**로서의 Windows 는 **이미 WSL 로 지원**(네이티브 Windows 는 startup 차단);
    네이티브 Windows daemon 은 Phase 4(백엔드 Rust 이관) 시 재검토.
- **와이어는 이미 N:N 멀티플랫폼.** relay v2 는 기기별 고유 `frontendId` 로 N:N 라우팅하므로
  iPhone·Mac·Android·Watch 가 같은 daemon 에 동시 접속하는 게 설계에 내장돼 있다. `frontendId` 는
  반드시 기기-로컬(동기화 금지) — daemon 이 세션키를 `frontendId` 로 스코프하기 때문 (Phase 3
  결정 참조).
- **Push 는 provider 별로 분리.** push egress 를 `apns.ts` 로 독립시킨 패턴(Expo→APNs 마이그레이션)
  을 그대로 따라, Android 는 `fcm.ts`(FCM), Windows 는 WNS 를 `platform` 필드로 분기한다
  (`platform: 'ios'|'android'` 는 이미 와이어에 존재). 환경 선택은 relay 배포별 env 모델(APNS_ENV)
  과 동일 패턴으로 키만 추가.
- **시크릿 저장소 대응**: iOS/macOS Keychain(+iCloud 동기화) ↔ Android Keystore ↔ Windows DPAPI/
  Credential Manager. 동기화는 Apple 생태계만 iCloud Keychain; Android/Windows 는 QR 재페어링
  또는 각 OS 백업 메커니즘.

## 7. 결과

- (+) 순수 네이티브 UX, Rust 단일 crypto/codec 코어(byte-exactness 위험 소멸), EAS 의존 제거.
- (−) RN Web 핫리로드 도그푸드 손실 → Simulator 빌드 사이클로 대체(하니스가 이 비용을 흡수).
- (−) 큰 재작성 — parity 까지 기간 소요. 각 단계 Simulator 검증으로 회귀 차단.
- Web/Android 우선순위 강등 (iOS Simulator 우선). watchOS = 별도 Swift WatchKit, post-Phase-3.
