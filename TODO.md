# Teleprompter TODO

## 🔧 미비한 점 — 현재 남아있는 이슈

### Voice
- [ ] `VoiceButton`이 iOS/Android에서 `null` 반환 — 네이티브 오디오 캡처/재생 미구현 (expo-av 등 필요)

### 미검증 항목 (잠재 이슈)
- [ ] Push Notifications 실기기 미검증 — Simulator에서는 push token 생성 불가, 실제 iOS/Android 디바이스에서 E2E 테스트 필요
- [ ] **N:N 다중 daemon/frontend 회귀** — 1:1 페어링만 실 실행 검증. 2 daemon × 2 frontend, 페어링 4개, frontend가 daemon 사이 스위치 시 독립 E2EE 세션 키 유지 + 한쪽 disconnect가 다른 쪽 영향 안 주는지 Playwright spec으로 확인 필요. (현재 로컬에서 30–45분)
- [ ] **Linux daemon install** — systemd unit 생성/등록/start 경로는 코드만 검토. Lima/Ubuntu VM에서 `tp daemon install` → `systemctl status` → 재부팅 후 자동 기동까지 직접 확인 필요. (VM 준비 30분 + 검증 30분)
- [x] **passthrough claude 서브커맨드 wiring 검증** — #438에서 fake `claude` 바이너리 기반 integration test 17건 (9 utility subcommands × argv-verbatim + exit code 0/1/7/42 + "claude not found" 메시지) 추가. `forwardToClaudeCommand`을 `Promise<number>` 반환으로 리팩터링하여 테스트 가능하게 함.
- [ ] **Long-running 안정성 (1시간 soak)** — daemon 메모리 RSS 추이, 100회 relay reconnect, 100개 frame round-trip latency, WS idle/wake cycle 5회. 자동 측정 스크립트 필요. (1시간 + setup 15분)
- [ ] **iOS 실기기 검증** — Simulator만 R15까지 검증. push token, audio capture (VoiceButton 구현 후), keychain 실 거동, App Switcher background/foreground 사이클은 실기기에서만 정확함.
- [ ] **Android 시뮬레이터/실기기 QA** — Web/iOS 위주로만 진행, Android QA round 자체가 없음. 페어링/세션/Chat/Terminal 전체 골든 패스 1회 + 권한 모델 (network, foreground service) 확인 필요.

### 인프라 한계로 미검증 (별도 환경 필요)
- [ ] **Windows under WSL** — exit 분기 코드 (`process.platform === "win32"`)만 검증. 실제 WSL Ubuntu에서 install.sh → tp daemon → 페어링 → 세션 풀 사이클은 Windows 머신 없이는 검증 불가.

---

## 🌟 Future (v0.x 이후 / 별도 트랙)

- [ ] Claude Code channels 양방향(output 구독) 지원 시 Chat UI 통합 재검토
- [ ] libghostty 네이티브 RN 모듈 (iOS: Metal, Android: OpenGL) — WebView 제거, GPU 렌더링
- [ ] Expo Go 드롭 → development build 전용 (Apple Watch, 네이티브 crypto, 네이티브 터미널 등)
- [ ] Apple Watch 컴패니언 앱 — 세션 상태 모니터링, 빠른 명령 전송
- [ ] 글로벌 키보드 단축키 (Cmd+K, Cmd+1/2/3 등) — useKeyboard 훅 확장
- [ ] 게임패드(8BitDo 등) 내비게이션 — Web Gamepad API 기반 D-pad 포커스 이동, A/B 버튼 매핑, useGamepad 훅. 네이티브는 MFi/Android InputDevice 모듈 필요
- [ ] 게임패드 음성인식 트리거 — 특정 버튼으로 VoiceButton 토글 (useInputAction 추상화로 키보드/게임패드/음성 통합 액션 시스템)
