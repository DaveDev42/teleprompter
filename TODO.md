# Teleprompter TODO

## 🔧 미비한 점 — 현재 남아있는 이슈

> **재작성 컨텍스트 (ADR-0001):** 아래 완료된 항목들은 Expo 스택 기준이다.
> Expo 앱(`apps/app`)은 제거됨. Chat/Terminal UI 이슈는 Swift 재작성(Phase 3)에서 재구현 예정.

### Chat / Terminal UI (Expo 스택 완료 이력 — 재작성 대상)
- [x] **터미널이 UTF-8 입력 시 깨짐** — Expo 스택에서 PR #455로 해결. Swift 재작성 시 재구현.
- [x] **Chat UI 가 PTY raw 출력을 그대로 노출** — hooks-only 전환 완료 (PR #457). Swift 앱도 동일 설계 적용 예정.
- [x] **Chat auto-scroll 이 사용자 스크롤 의도를 무시** — PR #457로 해결.
- [x] **`tp --resume` 세션이 첫 메시지 보내기 전까지 history 비어보임** — PR #457로 해결.
- [x] **Sessions bulk-delete 에 "Select all" 토글 부재** — PR #458로 구현.
- [x] **Sessions 리스트가 resume-reconnect 후 stale** — PR #584로 해결.
- [x] **Session row 제목이 cwd basename 만 표시** — PR #586로 해결 (`formatCwd` 로직).
- [x] **Sessions Refresh 버튼이 in-flight 상태를 보조기기에 알리지 않음** — PR #588로 해결.

### Voice (Expo 스택 완료 이력 — 재작성 대상)
- [x] `VoiceButton` 네이티브 오디오 — Expo 스택에서 react-native-audio-api 0.12.2로 구현 (2026-06-11). Swift 재작성 시 AVFoundation/Swift Concurrency 기반으로 재구현 예정 (Phase 3).

### 미검증 항목 (완료)
- [x] **Push Notifications 실기기** — APNs push token 발급 + 알림 왕복 E2E 실기기 검증 완료 (2026-06-07, build #59).
- [x] **N:N 다중 daemon/frontend 회귀** — 2×1 및 2×2 N:N 회귀 테스트 완료.
- [x] **Linux daemon install** — Lima Ubuntu VM에서 systemd 풀 사이클 검증 완료 (Q5 PASS 2026-06-07).
- [x] **passthrough claude 서브커맨드 wiring 검증** — integration test 17건 완료 (#438).
- [x] **Long-running 안정성 (1시간 soak)** — 2026-06-03 실측 1h SOAK PASS. (`scripts/soak.ts`)
- [x] **iOS 실기기 검증 (Expo)** — Q1·Q2 PASS 2026-06-07. Swift 재작성 후 Simulator 검증으로 전환.
- [x] **Android QA (Expo)** — Q3 PASS 2026-06-05 (Pixel_8 AVD). Android 재작성은 Phase 3 이후 별도 결정.

### 인프라 한계로 미검증 (완료)
- [x] **Windows under WSL** — Q7 PASS 2026-06-05. 상세는 `docs/local-verification-queue.md` Q7.

---

## 🔒 Type-safety debt (null/sentinel → tagged union + 런타임 guard 전환)

전 코드베이스에서 `null`/`undefined`/string-sentinel 을 찾아 tagged/discriminated union 으로 교체하고,
zero-trust 경계(파싱·복호화·IPC·SQLite)를 런타임 guard 로 강화하는 작업. 우선순위 Rank 1→9.

- [x] **Rank 1** — `parseControlMessage` guard + daemon `decryptAndDispatch` control plane 강화 (PR merged)
- [x] **Rank 2** — `parseRelayServerMessage` guard + daemon/app relay-client exhaustive switch (PR merged)
- [x] **Rank 3** — frontend `handleFrame` 복호화 E2EE payload guard (`parseRelayDataMessage` + control checks) (PR merged)
- [x] **Rank 4** — runner/CLI IPC + hook-socket parse 를 `parseIpcMessage` guard 경유 (PR merged)
- [x] **Rank 5** — SQLite Blob/key row 를 libsodium key 생성 전 validate (PR merged)
- [x] **Rank 6** — pairing-store label + active-daemon 을 tagged union 으로 (PR merged)
- [x] **Rank 7** — session/voice store 의 null/sentinel state → discriminated union
  - 7a session-store: `ActiveSession` + `RelayState` union (PR #525)
  - 7b voice-store: `VoiceConnectionState` + `VoiceKeyState` union (PR #524, 테스트 격리 후속 PR #528)
- [x] **Rank 8** — magic sentinel → union
  - 8a RTT `-1` sentinel → `Rtt = { measured: true; ms } | { measured: false }` (PR #526)
  - 8b resume-token role → `ResumeTokenPayload` daemon/frontend tagged union, wire byte-compat 유지 (PR #527)
  - 8c **worktree-path = DEFER** — `SessionMeta.worktreePath` 는 wire-serialized 필드인데 버전 협상 채널이 없고
    소비자가 display-only 라, 빈-문자열/undefined 를 union 으로 바꾸면 cross-version app 이 깨질 위험만 크고
    얻는 안전성은 작다. protocol 버전 협상이 들어오면 재검토.
- [x] **Rank 9** — `noUncheckedIndexedAccess` + `noPropertyAccessFromIndexSignature` 전역 활성화
  - 9A `noPropertyAccessFromIndexSignature` (TS4111, ~2277 sites — 대부분 `*-guard.ts` 의 untrusted-key
    bracket access) — base.json + app tsconfig 에 활성화, tsc-guided codemod (`scripts/codemod-ts4111.ts`) 로 변환 (PR #529)
  - 9B `noUncheckedIndexedAccess` (TS2532/18048/2345 등) — base.json + app tsconfig 에 활성화. ~64 index-access
    site 를 판단 처리: provably-in-bounds 는 `arr[i]!` (bound 주석), genuinely-possibly-undefined 는 guard/narrow/default.
    **부수로 진짜 latent bug 한 건 발견·수정**: `decodePairingData` 가 relay-length byte 직전에서 정확히
    잘린 페어링 payload 를 reject 하지 않고 bogus `PairingData` 로 silently decode 하던 버그 (`o === buf.length`
    일 때 `relayLen` 이 `undefined` → `o + undefined = NaN` → `NaN > buf.length === false` 로 bounds check
    통과). `relayLen === undefined` guard 추가 + 회귀 테스트 (`pairing.test.ts` "rejects a payload truncated at
    the relay-length byte") sabotage-verify 완료.

---

## 🌟 재작성 트랙 (ADR-0001)

- [ ] **Phase 2: Rust `tp-core` + Swift FFI** — codec/crypto/pairing Rust 구현 + UniFFI xcframework, Swift 앱에 링크, encode→encrypt→decrypt→decode 라운드트립 Simulator 검증
- [ ] **Phase 3: Swift 앱 기능 parity** — pairing(QR), relay client(WS), 세션 목록, Chat(hooks-only), 터미널 렌더러 선택(SwiftTerm vs libghostty), Voice(AVFoundation)
- [ ] **Phase 4: 백엔드 Rust 이관** — relay→daemon→runner, wire 호환 유지하며 컷오버

## 🌟 Future (Phase 3 이후 / 별도 트랙)

- [ ] Claude Code channels 양방향(output 구독) 지원 시 Chat UI 통합 재검토
- [ ] Apple Watch 컴패니언 앱 — 세션 상태 모니터링, 빠른 명령 전송 (Swift WatchKit, post-Phase-3)
- [ ] 글로벌 키보드 단축키 (Cmd+K, Cmd+1/2/3 등) — Swift KeyboardShortcut/UIKeyCommand
- [ ] 게임패드(8BitDo 등) MFi 내비게이션 — GCController 기반 D-pad 포커스 이동, 버튼 매핑
- [ ] 터미널 렌더러 엔진 최종 결정 — libghostty (불안정 C API) vs SwiftTerm (Metal 아님) — Dave 결정 필요 (Phase 3 착수 전)
