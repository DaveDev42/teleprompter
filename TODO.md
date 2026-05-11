# Teleprompter TODO

## 🔧 미비한 점 — 현재 남아있는 이슈

### Voice
- [ ] `VoiceButton`이 iOS/Android에서 `null` 반환 — 네이티브 오디오 캡처/재생 미구현 (expo-av 등 필요)

### 미검증 항목 (잠재 이슈)
- [ ] Push Notifications 실기기 미검증 — Simulator에서는 push token 생성 불가, 실제 iOS/Android 디바이스에서 E2E 테스트 필요

---

## 🌟 Future (v0.x 이후 / 별도 트랙)

- [ ] Claude Code channels 양방향(output 구독) 지원 시 Chat UI 통합 재검토
- [ ] libghostty 네이티브 RN 모듈 (iOS: Metal, Android: OpenGL) — WebView 제거, GPU 렌더링
- [ ] Expo Go 드롭 → development build 전용 (Apple Watch, 네이티브 crypto, 네이티브 터미널 등)
- [ ] Apple Watch 컴패니언 앱 — 세션 상태 모니터링, 빠른 명령 전송
- [ ] 글로벌 키보드 단축키 (Cmd+K, Cmd+1/2/3 등) — useKeyboard 훅 확장
- [ ] 게임패드(8BitDo 등) 내비게이션 — Web Gamepad API 기반 D-pad 포커스 이동, A/B 버튼 매핑, useGamepad 훅. 네이티브는 MFi/Android InputDevice 모듈 필요
- [ ] 게임패드 음성인식 트리거 — 특정 버튼으로 VoiceButton 토글 (useInputAction 추상화로 키보드/게임패드/음성 통합 액션 시스템)
- [ ] **macOS 바이너리 Developer ID signing + notarization (필요 시)** — v0.1.33부터 `release.yml`은 Bun의 native 서명을 그대로 보존한다 (`--compile` 결과물은 `Developer ID Application: Jarred Sumner` 로 서명되어 있음, unnotarized — `codesign -dvv $(which tp)` 로 검증 가능). 우리 배포 경로(`brew install`, `curl … | bash`)는 `com.apple.quarantine` xattr를 붙이지 않아서 Gatekeeper가 발동하지 않으며, launchd Login Items에 "Jarred Sumner" 가 표시되는 것은 기능적 영향 없음. 향후 GUI 다운로드(브라우저, .dmg 배포)를 추가한다면 quarantine bit이 붙어 unnotarized Developer ID 경고가 뜰 수 있고, 그때 본인 명의의 Developer ID Application 인증서 + `notarytool submit --wait` + `stapler staple` 가 필요해진다. CLI-only 동안은 우선순위 낮음.
