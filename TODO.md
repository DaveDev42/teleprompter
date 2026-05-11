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

## 🎨 UX 개선 (P3, 회귀 아님)

R16 QA에서 발견된 비-회귀 UX 개선 여지 — v0.1.x patch 외 별도 트랙으로 진행 가능.

- [x] **Edit tool card에 unified diff 렌더링** (2026-05-12 v0.1.32 fix) — Chat 탭의 Edit/MultiEdit/Write PreToolUse 카드가 raw JSON 대신 `old_string` / `new_string` 의 unified diff(- / +) 를 렌더하도록 개선. `ChatCard.tsx`에 `EditDiff` 컴포넌트 추가.
- [x] **Bash tool stdout 카드 body inline 렌더링** (2026-05-12 v0.1.32 fix) — Bash PostToolUse 카드가 `tool_result`에서 stdout/stderr/interrupted 를 추출해 카드 본문에 monospace 로 inline 노출. `ChatCard.tsx`에 `BashOutput` 컴포넌트 + `extractBashOutput` 헬퍼 추가. stdout 20줄, stderr 10줄 truncate.

---

## 🌟 Future (v0.x 이후 / 별도 트랙)

- [ ] Claude Code channels 양방향(output 구독) 지원 시 Chat UI 통합 재검토
- [ ] libghostty 네이티브 RN 모듈 (iOS: Metal, Android: OpenGL) — WebView 제거, GPU 렌더링
- [ ] Expo Go 드롭 → development build 전용 (Apple Watch, 네이티브 crypto, 네이티브 터미널 등)
- [ ] Apple Watch 컴패니언 앱 — 세션 상태 모니터링, 빠른 명령 전송
- [ ] 글로벌 키보드 단축키 (Cmd+K, Cmd+1/2/3 등) — useKeyboard 훅 확장
- [ ] 게임패드(8BitDo 등) 내비게이션 — Web Gamepad API 기반 D-pad 포커스 이동, A/B 버튼 매핑, useGamepad 훅. 네이티브는 MFi/Android InputDevice 모듈 필요
- [ ] 게임패드 음성인식 트리거 — 특정 버튼으로 VoiceButton 토글 (useInputAction 추상화로 키보드/게임패드/음성 통합 액션 시스템)
- [ ] **macOS 바이너리 Developer ID signing + notarization** — 현재 `tp` (bun SEA) 는 Jarred Sumner (bun runtime) 의 서명을 그대로 상속. 사용자가 launchd daemon 을 등록하면 macOS Login Items & Extensions UI 에 "Jarred Sumner" entry 가 표시되는 UX 이슈. 0.x 에서는 S1 (수용) 로 합의했고, 1.0 블로커로 승격 예정. 필요: (a) Apple Developer Program 가입 ($99/yr), (b) release.yml 에 `codesign` + `notarytool` + `stapler` 단계 추가, (c) darwin 바이너리에 자체 Developer ID 서명 후 notarize. 영향 범위는 macOS darwin_arm64 릴리즈 아티팩트만 (x64 는 PR #185 에서 drop). Linux 는 무관.
