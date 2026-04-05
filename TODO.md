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

## ✅ P2 — 품질 (완료)

### E2E 테스트 확충
- [x] Playwright: 세션 전환 — app-session-switch.spec.ts (sessions 탭, daemon 연결, 세션 표시)
- [x] Playwright: Settings 변경 — app-settings.spec.ts (Theme 토글, Daemon URL, Pair 버튼, Diagnostics)
- [x] Playwright: 오프라인 복구 — app-resume.spec.ts (daemon kill → restart → reconnect)
- [x] Expo MCP: iOS에서 E2EE self-test 검증 (Sodium Init/Key Gen/Encrypt-Decrypt OK on hermes)

### CI 강화
- [x] CI QA 자동화 — Playwright CI 18개 테스트 (smoke, daemon, settings, session switch, resume, relay E2E + N:N)
- [x] Playwright CI/local 프로젝트 분리 — CI는 claude 없이 7/7 pass
- [x] 테스트 커버리지 리포트 생성 — `bun test --coverage` (CI에 적용)

### 리팩터링
- [x] Vault → Store 리네이밍 (클래스, 파일, 디렉터리, 테스트, 문서)

### 에러 핸들링
- [x] WS 연결 실패 시 재연결 카운터 + daemon start 힌트
- [x] Daemon crash 시 "Reconnecting... (attempt N)" 표시
- [x] Runner 비정상 종료 시 세션 상태 error 표시 + 재시작 버튼 (session.restart WS 메시지 + SessionDrawer Restart 버튼)

---

## ✅ P3 — 확장 (완료)

### 테마 완성
- [x] NativeWind className 정리 — 불필요한 인라인 스타일 fallback 제거 (chat, terminal, layout)
- [x] Light 테마 준비 — userInterfaceStyle: "automatic", darkMode: "class" 설정

### Android 지원
- [x] Android EAS Build + Google Play submit 설정 (eas.json android track 추가)
- [x] Android Emulator에서 Expo Go 테스트 — Pixel_8 AVD, 앱 로드/연결/세션/Diagnostics 전체 PASS
- [x] Android 키보드 + WebView xterm.js 동작 확인 — 키보드 입력 정상, xterm.js WebView 로드 확인

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
- [x] Chat 코드 블록 syntax highlighting — RichText 컴포넌트 (```...``` 감지, 언어 힌트, 복사)
- [x] Terminal 선택 영역 복사 — xterm.js 기본 지원 (Web: native selection, Native: WebView)
- [x] 세션 기록 내보내기 — session.export WS 메시지 + markdown/JSON 변환 + SessionDrawer Export 버튼
- [x] Worktree 생성 UI — SessionDrawer "New Worktree" 버튼 + branch 입력 → worktree.create

---

## 🔧 Bugs — 발견된 버그

### E2E 테스트
- [x] `app-session-switch.spec.ts:70` — "clicking a session navigates to session view" 실패. `text=Chat` locator가 세션 이름 "chat-rt"와 Chat 탭 라벨 2개를 동시 매칭 (strict mode violation). → Chat 탭 Pressable에 `testID="tab-chat"` 추가, E2E를 `getByTestId("tab-chat")`로 수정

### 코드 컨벤션 위반 (tp-* semantic token)
- [x] `VoiceButton.tsx` — raw Tailwind 색상 사용 (`bg-purple-600`, `bg-red-600`, `bg-yellow-600`, `bg-zinc-700/800`, `bg-blue-600`, `text-gray-300/400/500`) → `tp-*` semantic token 교체 완료 (tp-voice-active 토큰 추가, 이모지 🎤 → 텍스트 "Mic" 교체)
- [x] `DiagnosticsPanel.tsx` — raw Tailwind 색상 사용 (`bg-zinc-900`, `text-gray-300/400/500`) → `tp-*` semantic token 교체 완료

### Silent Error Swallowing (빈 catch 블록)
- [ ] `ws-client.ts:51,62` — WS 연결/해제 실패 시 에러 무시
- [ ] `GhosttyNative.tsx:99` — 터미널 초기화 실패 시 에러 무시
- [ ] `relay-settings-store.ts:33` — secure storage 읽기 실패 시 에러 무시

---

## 📋 P4 — 미완/미비 기능

### Settings UI — Stub 버튼 (onPress={() => {}} 상태)
- [x] **Font Picker UI 구현** — FontPickerModal (chat/code/terminal 폰트 선택) + FontSizeModal (10–24px 스테퍼) 구현. Settings에서 각 행 onPress로 모달 표시
- [x] **Font 적용** — store 폰트 설정이 실제 컴포넌트에 반영:
  - `GhosttyTerminal.tsx` — useSettingsStore에서 terminalFont, fontSize 읽어서 적용
  - `GhosttyNative.tsx` — buildGhosttyHtml에 terminalFont, fontSize 전달
  - `ChatCard.tsx` — chatFont, codeFont, fontSize를 UserCard/AssistantCard/StreamingCard에 적용
  - 시스템 폰트 기반 (사전 정의 목록에서 선택, 커스텀 폰트 로딩 불필요)
- [x] **OpenAI API Key 설정 UI 구현** — ApiKeyModal (TextInput + Save/Remove) 구현. Settings에서 onPress로 모달 표시
- [x] **OpenAI API Key 영속화** — voice-store.ts에 secureGet/secureSet 추가. 앱 시작 시 load, 설정 시 persist

### Theme
- [x] **테마 선택 영속화** — theme-store.ts에 secureGet/secureSet 추가. 앱 재시작 시 선택한 테마 유지

### Voice (음성) — Web 전용, 네이티브 미지원
- [ ] `VoiceButton`이 iOS/Android에서 `null` 반환 — 네이티브 오디오 캡처/재생 미구현 (expo-av 등 필요)
- [x] `buildSystemPrompt():165` — terminal context 주입 시 정적 문자열이 불필요하게 중복 추가됨 → 정적 placeholder 제거, includeTerminal 파라미터 정리 완료

### Session Export — 기본 수준만 구현
- [ ] Markdown export가 `event` 레코드만 추출 — tool calls, permissions, elicitations 등 누락
- [ ] PTY io 레코드 완전히 무시 — 터미널 출력이 export에 포함되지 않음
- [ ] 필터링/포맷 옵션 없음 — 시간 범위, 레코드 종류 선택 등 미지원
- [ ] 10,000 레코드 hard limit — 대규모 세션에서 잘림 가능

### Store 자동 정리
- [x] `pruneOldSessions`가 수동 호출 전용 — Daemon 시작 시 자동 호출 + 24시간마다 주기적 실행. `--prune-ttl <days>` 옵션, `TP_PRUNE_TTL_DAYS` 환경변수, `--no-prune` 비활성화 플래그 지원
- [x] 기본 TTL 정책 없음 — 기본 7일 TTL 적용, `startAutoCleanup()` + `setInterval` 기반 스케줄러 구현

### Relay Presence
- [x] Daemon→Relay heartbeat/keepalive 미구현 — relay가 dead connection 감지 불가 → RelayClient가 30초 간격으로 relay.ping 발신
- [x] Stale daemon이 online으로 계속 표시됨 — 네트워크 파티션 후 프론트엔드에 잘못된 상태 전달 → RelayServer가 90초 무응답 daemon을 offline 전환 + presence 브로드캐스트
- [x] `relay.pong` 수신만 처리, 발신 ping 없음 (`relay-client.ts:175-176`) → startPing/stopPing 구현

### CLI — 서브커맨드 충돌 (tp vs claude)
- [x] **`tp doctor` / `tp upgrade` / `tp version`이 claude의 동명 서브커맨드를 가로챔** — `tp -- doctor`로 claude의 doctor 실행, `tp doctor --claude` / `tp upgrade --claude`로 claude 명령 병행 실행
- [x] **claude 전용 서브커맨드(`auth`, `mcp`, `install`, `update` 등)가 passthrough로 빠짐** — CLAUDE_UTILITY_SUBCOMMANDS 감지 → `Bun.spawn(["claude", ...])` 직접 포워딩 (daemon 미시작)
- [x] **`tp -- ...` 명시적 claude 포워딩** — `tp -- <args>`로 모든 인자를 daemon 없이 claude에 직접 전달. 서브커맨드 충돌 해소 + 의도 명확화

### CLI — 기타
- [x] `tp upgrade` — SHA-256 체크섬 검증 (release.yml에서 checksums.txt 생성, 다운로드 후 해시 비교)
- [x] `tp upgrade` — 롤백 지원 (기존 바이너리 .bak 백업 → 실패 시 자동 복원 → 성공 시 삭제)
- [x] `tp upgrade` — daemon 자동 재시작 (launchd kickstart / systemctl restart, 서비스 미설치 시 안내 메시지)
- [x] `tp completions` — `SUBCOMMANDS` 목록에 `run` 추가 (셸 자동완성 완성)
- [x] `args.ts:39-41` — `--tp-*` 플래그 값 누락 시 사용자 친화적 에러 메시지 + 사용 예시 출력 (process.exit(1))
- [x] Passthrough에서 WS port 7080 충돌 시 자동으로 port 0 (auto-assign) fallback + 안내 메시지 출력

### Worktree
- [x] `worktree-manager.ts:22` — Bun stdout 캡처 버그 워크어라운드 → Bun v1.3.6에서 execFileSync 정상 동작 확인, 워크어라운드 제거 완료
- [x] Branch name validation — `git check-ref-format --branch`로 사전 검증 + 에러 메시지에 규칙 안내
- [x] Worktree 경로 권한 검증 — 부모 디렉토리 쓰기 권한 사전 확인 + 명확한 에러 메시지

### Accessibility (접근성)
- [ ] 전체 프론트엔드에 `accessibilityLabel`, `role`, `aria-*` 속성 없음
- [ ] 스크린 리더 미지원 — 인터랙티브 요소(버튼, 탭, 입력, 세션 목록)에 시맨틱 정보 없음
- [ ] 키보드 내비게이션 미검증

### Protocol / Transport
- [x] Relay frame cache 크기 설정 가능 — `TP_RELAY_CACHE_SIZE` 환경변수 또는 `--cache-size` CLI 옵션 (기본 10)
- [x] WebSocket frame size limit — `TP_RELAY_MAX_FRAME_SIZE` 환경변수 또는 `--max-frame-size` CLI 옵션 (기본 1MB, 초과 시 연결 종료)

### UI 미노출 Store (기능은 있으나 설정 UI 없음)
- [ ] `connection-store.daemonUrl` — 커스텀 Daemon WS URL 설정 가능하나 UI 없음
- [ ] `relay-settings-store.relays` — Relay endpoint 추가/제거/토글 가능하나 UI 없음

---

## Future

- [ ] Claude Code channels 양방향(output 구독) 지원 시 Chat UI 통합 재검토
- [ ] libghostty 네이티브 RN 모듈 (iOS: Metal, Android: OpenGL) — WebView 제거, GPU 렌더링
- [ ] Expo Go 드롭 → development build 전용 (Apple Watch, 네이티브 crypto, 네이티브 터미널 등)
- [ ] Expo Push Notifications — 작업 완료, 유저 응답 대기 시 푸시 알림 (Runner hooks 이벤트 기반)
- [ ] Apple Watch 컴패니언 앱 — 세션 상태 모니터링, 빠른 명령 전송
- [ ] Windows PTY 지원 — 현재 macOS/Linux만 지원 (`Bun.spawn({ terminal })`), Windows는 `bun-pty` Rust FFI 기반 예정
- [ ] Windows IPC — Named Pipes (현재 Unix domain socket만)
