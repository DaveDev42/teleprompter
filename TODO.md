# Teleprompter TODO

## ✅ P0 — 실제 사용 가능하게 만들기 (완료)

- [x] Terminal xterm.js ANSI 렌더링 (색상, vim, 프롬프트 — 1540자 실제 출력)
- [x] Terminal 탭 전환 시 backlog replay (onReady + resume)
- [x] Chat PTY 스트리밍 + hooks 이벤트 카드 (resume replay)
- [x] Chat 입력 editable + 타이핑
- [x] Session resume (daemon restart → 자동 재연결 → 콘텐츠 복원)

---

## ✅ P1 — 사용성 (완료)

### Relay 원격 배포
- [x] Hetzner 또는 Oracle Cloud에 relay 서버 배포 — deploy-relay.yml + SSH binary deploy
- [x] 실제 다른 네트워크에서 E2EE relay 통신 검증 — `tp relay ping --verify-e2ee`
- [x] relay RTT 측정 및 성능 확인 — `tp relay ping --count N` (min/avg/max/p95)

### iOS Native Build
- [x] Apple Developer 계정으로 TestFlight 배포
- [x] EAS Build → `.ipa` 생성 및 TestFlight 업로드
- [x] App Store 제출 준비

### Native E2EE
- [x] libsodium asm.js fallback 활성화 (Expo Go 호환, 네이티브 모듈 불필요)
- [x] Hermes crypto polyfill — expo-crypto `getRandomValues` → `self.crypto` (libsodium 초기화 필수)
- [x] iOS/Android에서 E2EE relay 연결 검증 (Expo Go 실기기 테스트)
- [x] QR 페어링 → 암호화 통신 네이티브 E2E
- [x] DiagnosticsPanel E2EE self-test (Sodium Init / Key Gen / Encrypt-Decrypt, 플랫폼 감지)

### Daemon 자동 시작
- [x] `tp status`, `tp logs` 등에서 daemon이 없으면 자동 시작 — ensureDaemon()
- [x] OS 서비스 등록 — `tp daemon install/uninstall` (macOS launchd, Linux systemd)

---

## 🟢 P2 — 품질

### E2E 테스트 확충
- [ ] Playwright: 세션 전환 (Sessions 탭 → 다른 세션 클릭 → Chat/Terminal 내용 변경)
- [ ] Playwright: Settings 변경 (Theme 토글, Daemon URL 설정) → 앱 동작 변경 확인
- [x] Playwright: 오프라인 복구 — app-resume.spec.ts (daemon kill → restart → reconnect)
- [ ] Expo MCP: iOS에서 daemon 연결 + 실제 PTY 출력 수신 E2E (포트 감지 수정 후 재검증)

### CI 강화
- [ ] GitHub Actions에서 iOS 시뮬레이터 Expo MCP QA 자동화
- [x] Playwright CI/local 프로젝트 분리 — CI는 claude 없이 7/7 pass
- [ ] 테스트 커버리지 리포트 생성

### 리팩터링
- [x] Vault → Store 리네이밍 (클래스, 파일, 디렉터리, 테스트, 문서)

### 에러 핸들링
- [x] WS 연결 실패 시 재연결 카운터 + daemon start 힌트
- [x] Daemon crash 시 "Reconnecting... (attempt N)" 표시
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

### N:N Relay (프로토콜 v2) ✅
- [x] Relay protocol v2 types — relay.register, relay.kx, frontendId
- [x] Crypto: deriveKxKey, deriveRegistrationProof + unit tests (domain separation, determinism)
- [x] Relay self-registration (relay.register) — daemon이 token 자동 등록 (proof 기반, pre-registration 불필요)
- [x] In-band key exchange (relay.kx) — pairing secret에서 파생된 kxKey로 pubkey 암호화 교환
- [x] frontendId — per-frontend E2EE session key 분리 (RelayAuth, RelayFrame에 포함)
- [x] Daemon multi-peer relay client — peers Map<frontendId, SessionKeys>, fan-out encryption
- [x] Frontend relay client v2 — auth 후 relay.kx로 pubkey 전송, kxKey로 envelope 암호화
- [x] Multi-daemon pairing store — Map<daemonId, PairingInfo> + expo-secure-store 영속화
- [x] Multi-client relay hook — per-daemon FrontendRelayClient 관리 (incremental add/remove)
- [x] Direct WS + relay 병렬 실행 (상호 배제 제거)
- [x] Daemon pairing persistence (vault DB pairings 테이블) — 재시작 시 reconnectSavedRelays()
- [x] 멀티 디바이스 E2E 테스트 — multi-frontend.test.ts (2 frontends, 독립 E2EE, cross-decrypt 거부)
- [x] 디바이스 간 세션 전환 UX — Settings에서 active daemon 선택, 연결 상태 표시
- [x] Settings "Pair with Daemon" 버튼 + 다중 pairing 목록 UI

### 추가 기능
- [ ] Chat에서 코드 블록 syntax highlighting
- [ ] Terminal에서 선택 영역 복사
- [ ] 세션 기록 내보내기 (markdown/JSON)
- [ ] Worktree 생성 UI (Frontend에서 branch + path 입력)
