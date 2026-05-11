# Teleprompter TODO

## 🔧 미비한 점 — 현재 남아있는 이슈

### Voice
- [ ] `VoiceButton`이 iOS/Android에서 `null` 반환 — 네이티브 오디오 캡처/재생 미구현 (expo-av 등 필요)

### 미검증 항목 (잠재 이슈)
- [ ] Push Notifications 실기기 미검증 — Simulator에서는 push token 생성 불가, 실제 iOS/Android 디바이스에서 E2E 테스트 필요

---

## 📋 v0.1.x 안정화 결과 요약

2026-05-10 ~ 2026-05-12 사이 R3 ~ R16 16 라운드 exploratory QA를 통해 발견된 P0/P1/P2/P3 버그를 모두 수정해 v0.1.31에서 안정화 확정. 주요 fix:

- **P0**: SQLITE_BUSY (PR #190, WAL journal)
- **P1**: pair new disconnect toast race, paths.ts brew detection, pair.lock TTL, daemon singleton lock, passthrough relay reconnect, stopped session historical replay, Sessions 빈 race, 브라우저 reload 후 sessions persistence
- **P2**: `tp doctor` hang (PR #203 + #206), Daemons label 표시, Chat ANSI escape 누출 (PR #193), New Session 버튼 dead, INSERT-mode chat dropout (PR #217), relay reconnect cache replay (PR #216), DiagnosticsPanel crypto self-test 크래시 (PR #221)
- **P3**: pair delete label matching (PR #194), session export 50k perf 검증

모든 fix는 git 히스토리에서 추적 가능 (`git log --oneline origin/main`).

---

## 🌟 Future (v0.x 이후 / 별도 트랙)

- [ ] Claude Code channels 양방향(output 구독) 지원 시 Chat UI 통합 재검토
- [ ] libghostty 네이티브 RN 모듈 (iOS: Metal, Android: OpenGL) — WebView 제거, GPU 렌더링
- [ ] Expo Go 드롭 → development build 전용 (Apple Watch, 네이티브 crypto, 네이티브 터미널 등)
- [ ] Apple Watch 컴패니언 앱 — 세션 상태 모니터링, 빠른 명령 전송
- [ ] 글로벌 키보드 단축키 (Cmd+K, Cmd+1/2/3 등) — useKeyboard 훅 확장
- [ ] 게임패드(8BitDo 등) 내비게이션 — Web Gamepad API 기반 D-pad 포커스 이동, A/B 버튼 매핑, useGamepad 훅. 네이티브는 MFi/Android InputDevice 모듈 필요
- [ ] 게임패드 음성인식 트리거 — 특정 버튼으로 VoiceButton 토글 (useInputAction 추상화로 키보드/게임패드/음성 통합 액션 시스템)
- [ ] **macOS 바이너리 Developer ID signing + notarization** — `release.yml`은 이미 `codesign --remove-signature` → `codesign --sign - --force --options runtime`로 Bun의 native ad-hoc 서명을 strip하고 자체 ad-hoc 으로 재서명 중. 따라서 **launchd Login Items에 "Jarred Sumner"가 더 이상 노출되지 않음** (확인: `codesign -dvv $(which tp)` → `Signature=adhoc`, `Identifier=tp-darwin_arm64-...`). 남아 있는 진짜 이슈는 **Gatekeeper 첫 실행 경고 + 수동 승인** (ad-hoc 서명은 Developer ID와 다르므로 Apple notary와 무관). 1.0 블로커로 승격 예정. 필요: (a) Apple Developer Program 가입 ($99/yr), (b) release.yml의 ad-hoc 단계를 Developer ID Application 인증서 + `notarytool submit --wait` + `stapler staple`로 교체, (c) `HOMEBREW_TAP_TOKEN` 처럼 GitHub Secrets에 `APPLE_DEV_ID_P12` + `APPLE_DEV_ID_PWD` + `APPLE_NOTARY_KEY` 등록. 영향 범위는 macOS darwin_arm64 릴리즈 아티팩트만.
