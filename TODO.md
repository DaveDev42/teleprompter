# Teleprompter TODO

## 🔴 P0 — 실제 사용 가능하게 만들기

### Terminal 렌더링 검증
- [ ] xterm.js에서 Claude Code rich TUI (색상, 커서, 대체 화면 버퍼) 깨지지 않는지 Playwright E2E로 검증
- [ ] ANSI escape 시퀀스 종류별 렌더링 테스트 (bold, color, cursor move, alternate screen)
- [ ] Terminal 탭에서 키 입력 → Claude Code 전달 → 응답 표시 양방향 E2E

### Chat 라운드트립 E2E
- [ ] Chat 입력 "hello" → Claude 응답 → Chat에 assistant 카드 표시 전체 흐름 Playwright 검증
- [ ] hooks 이벤트 카드 (Stop, PreToolUse, PostToolUse) 실제 데이터로 렌더링 확인
- [ ] PTY 스트리밍 버블 → Stop 이벤트 시 최종 메시지 카드 전환 확인

### Session Resume 실제 검증
- [ ] 네트워크 끊김 시뮬레이션 → WS 재연결 → backlog batch 수신 → UI 복원 E2E
- [ ] daemon restart 후 앱 자동 재연결 + 세션 resume 확인

---

## 🟡 P1 — 사용성

### Relay 원격 배포
- [ ] Hetzner 또는 Oracle Cloud에 relay 서버 배포
- [ ] 실제 다른 네트워크에서 E2EE relay 통신 검증
- [ ] relay RTT 측정 및 성능 확인

### iOS Native Build
- [ ] Apple Developer 계정으로 TestFlight 배포
- [ ] EAS Build → `.ipa` 생성 및 TestFlight 업로드
- [ ] App Store 제출 준비

### Native E2EE
- [ ] react-native-quick-crypto 통합 (Hermes WASM 대체)
- [ ] iOS/Android에서 E2EE relay 연결 검증
- [ ] QR 페어링 → 암호화 통신 네이티브 E2E

### Daemon 자동 시작
- [ ] `tp status`, `tp logs` 등에서 daemon이 없으면 자동 시작 옵션
- [ ] OS 서비스 등록 (launchd/systemd) 가이드 또는 스크립트

---

## 🟢 P2 — 품질

### E2E 테스트 확충
- [ ] Playwright: 세션 전환 (Sessions 탭 → 다른 세션 클릭 → Chat/Terminal 내용 변경)
- [ ] Playwright: Settings 변경 (Theme 토글, Daemon URL 설정) → 앱 동작 변경 확인
- [ ] Playwright: 오프라인 복구 (daemon kill → 앱 "Connecting..." → daemon restart → 자동 재연결)
- [ ] Expo MCP: iOS에서 daemon 연결 + 실제 PTY 출력 수신 E2E (포트 감지 수정 후 재검증)

### CI 강화
- [ ] GitHub Actions에서 iOS 시뮬레이터 Expo MCP QA 자동화
- [ ] Playwright real E2E (daemon + claude) CI 안정화 — 현재 `claude` CLI 필요
- [ ] 테스트 커버리지 리포트 생성

### 에러 핸들링
- [ ] WS 연결 실패 시 사용자에게 의미있는 에러 메시지 (URL, 포트, 네트워크 상태)
- [ ] Daemon crash 시 앱에서 "Daemon disconnected, reconnecting..." 상태 표시
- [ ] Runner 비정상 종료 시 세션 상태 error 표시 + 재시작 버튼

---

## 🔵 P3 — 확장

### 테마 완성
- [ ] NativeWind className이 네이티브에서 완전히 동작하도록 수정 (인라인 스타일 fallback 제거)
- [ ] Light 테마 전체 UI 검증 (현재 Dark만 테스트됨)

### Android 지원
- [ ] Android Emulator에서 Expo Go 테스트
- [ ] Android 키보드 + WebView xterm.js 동작 확인
- [ ] EAS Build Android → Google Play 준비

### 멀티 디바이스
- [ ] 하나의 daemon에 여러 프론트엔드 동시 연결 테스트
- [ ] 동시 연결 시 record broadcast 정합성 확인
- [ ] 디바이스 간 세션 전환 UX

### 추가 기능
- [ ] Chat에서 코드 블록 syntax highlighting
- [ ] Terminal에서 선택 영역 복사
- [ ] 세션 기록 내보내기 (markdown/JSON)
- [ ] Worktree 생성 UI (Frontend에서 branch + path 입력)
