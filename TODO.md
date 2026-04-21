# Teleprompter TODO

## 🔧 미비한 점 — 현재 남아있는 이슈

### Voice
- [ ] `VoiceButton`이 iOS/Android에서 `null` 반환 — 네이티브 오디오 캡처/재생 미구현 (expo-av 등 필요)

### Windows
- [ ] Bun `bun:sqlite` Windows finalizer 지연 — Bun 1.3.12 업그레이드 및 `Store.deleteSession`의 double-GC(`Bun.gc(true) → sleep 50ms → Bun.gc(true)`) 보강에도 불구하고 Windows CI에서 `unlinkRetry`의 모든 retry(1.575s budget)를 소진해도 lock이 풀리지 않는 케이스 확인됨. 실제 timeout 문제가 아니라 lock 자체의 지속성 문제라, retry budget을 키우면 다른 `auto-cleanup` 테스트들이 연쇄 timeout. `store-cleanup.test.ts`의 2개 테스트는 `describe.skipIf(win32)`로 skip 유지. 추가로 `auto-cleanup.test.ts` 전체와 `store-cleanup.test.ts`의 `pruneOldSessions removes error sessions` 테스트도 Windows CI 속도 개선을 위해 skip 확장 (macOS/Linux에서 동일 경로 검증됨). Bun upstream issue [oven-sh/bun#25964](https://github.com/oven-sh/bun/issues/25964) (WAL mode file lock on Windows after close) 해결 시 재시도 — 2026-04 현재 open, assignee/milestone 없음.

### 미검증 항목 (잠재 이슈)
- [ ] Push Notifications 실기기 미검증 — Simulator에서는 push token 생성 불가, 실제 iOS/Android 디바이스에서 E2E 테스트 필요
- [ ] Windows PTY/IPC 실환경 미검증 — CI unit test만 통과, 실제 Windows 환경에서 `tp` passthrough + daemon 동작 E2E 검증 필요
- [ ] Windows install.ps1 실환경 미검증 — PowerShell 설치 스크립트 (v0.1.9 기준), 실제 Windows 기기에서 `irm ... | iex` → `tp version` → `tp upgrade` 플로우 확인 필요
- [ ] Session Export 대규모 세션 성능 미검증 — 10,000+ records 세션에서 export 속도/메모리 사용량 확인 필요 (현재 limit 50,000)

### 발견된 버그
(현재 없음)

---

## 🛠 리뷰 기반 구조 개선 (2026-04-20 전체 리뷰)

우선순위 순. 각 항목 말미의 `[group: X]`는 병렬 수행 그룹.

### Phase 1 — 완료 (2026-04-20)
- [x] **CLAUDE.md Tier 1–3 테스트 목록 재동기화** — PR #116. 실제 66개 테스트 파일과 동기화.
- [x] **IPC / relay control 경계 스키마 가드 도입** — PR #120. `parseIpcMessage` / `parseRelayControlMessage` 2개 guard 도입, `daemon.ts` 내 `as unknown as` / `Record<string, unknown>` 전부 제거 (14개 narrowing cast 제거). 50개 guard 테스트 추가.
- [x] **`apps/app/src/lib/relay-client.ts` 단위 테스트** — PR #118. 26개 테스트 (E2EE roundtrip, ECDH, ratchet, WS 상태머신, reconnect 백오프).
- [x] **`apps/app/src/lib/{secure-storage, crypto-native, crypto-polyfill}.ts` 단위 테스트** — PR #119. 21개 테스트. `apps/app/tsconfig.json`에 `*.test.ts` exclude 추가해 bun:test TS2307 해소.
- [x] **zustand 스토어 핵심 로직 테스트** — PR #121. 57개 테스트 (pairing v2→v3 migration, session store multicast, chat streaming). v2 migration 제거 전 안전망 확보.
- [x] **`apps/cli/src/lib/ipc-client-windows.ts` 문서화** — PR #117. 호출 체인과 참고 구현을 주석으로 명시.

### Phase 1 follow-up (land-on-reality)
- [x] **Windows CLI pair flow 실제 구현 (2026-04-20)** — `apps/cli/src/lib/ipc-client-windows.ts`의 스텁 `throw`를 제거하고 실제 Named Pipe 클라이언트로 교체. `packages/runner/src/ipc/client-windows.ts`의 `connectWindows`와 동일한 전략(Bun native pipe → `node:net` fallback). Windows 전용 단위 테스트를 `apps/cli/src/lib/ipc-client-windows.test.ts`에 추가 (`describe.skipIf(process.platform !== "win32")`). `pair-blocking.test.ts`는 Windows에서도 실행되도록 skip을 풀고 Named Pipe 경로 대응을 추가. `pair.test.ts`의 list/delete 스위트는 SQLite 파일 핸들 지속 이슈(위 Windows 섹션의 bun#25964)로 여전히 Windows skip 유지 — IPC와 무관한 별도 문제. `ipc-client.test.ts`의 POSIX 전용 테스트는 `\\.\pipe\...` 경로 요구 때문에 Windows 스킵 유지, 그 대체가 새로 추가한 `ipc-client-windows.test.ts`.

### Phase 2 — 진행 중 (daemon.ts 분해)
`daemon.ts` 같은 파일을 순차 수정해야 하므로 C1 → C2 → C3 순서.

- [ ] **C1: `IpcCommandDispatcher` 추출** — `daemon.ts`의 `onMessage` + relay control / worktree / session export 라우팅을 별도 클래스로 분리 (`daemon.ts:91-102`, `561-1008` 영역). B1(PR #120)이 만든 타입드 경계 위에서 분해하므로 cast 재도입 없이 가능.
- [ ] **C2: `RelayConnectionManager` 추출** — `relayClients: RelayClient[]`, 연결/재연결, push fan-out (`daemon.ts:55, 73-79, 248-560`). C1 선행.
- [ ] **C3: `PairingOrchestrator` 추출** — `pendingPairing` / `__handlePairBegin` / `__handlePairCancel` lifecycle (`daemon.ts:59-60, 297-509`). C2 선행.

분해 후 `Daemon` 클래스는 DI 컨테이너 성격으로 200–300 LOC 목표.

### Phase 3 — A4 완료 후 대기
- [ ] **D1: `pairing-store.ts` v2 마이그레이션 제거** — 파일 내 `TODO: delete v2 migration after N releases` 코멘트 참조. 기준 릴리즈(예: v0.1.15) 결정 후 그 이후 첫 PR에서 마이그레이션 블록 제거. A4(PR #121) 테스트가 안전망.

---

## Future

- [ ] Claude Code channels 양방향(output 구독) 지원 시 Chat UI 통합 재검토
- [ ] libghostty 네이티브 RN 모듈 (iOS: Metal, Android: OpenGL) — WebView 제거, GPU 렌더링
- [ ] Expo Go 드롭 → development build 전용 (Apple Watch, 네이티브 crypto, 네이티브 터미널 등)
- [ ] Apple Watch 컴패니언 앱 — 세션 상태 모니터링, 빠른 명령 전송
- [ ] 글로벌 키보드 단축키 (Cmd+K, Cmd+1/2/3 등) — useKeyboard 훅 확장
- [ ] 게임패드(8BitDo 등) 내비게이션 — Web Gamepad API 기반 D-pad 포커스 이동, A/B 버튼 매핑, useGamepad 훅. 네이티브는 MFi/Android InputDevice 모듈 필요
- [ ] 게임패드 음성인식 트리거 — 특정 버튼으로 VoiceButton 토글 (useInputAction 추상화로 키보드/게임패드/음성 통합 액션 시스템)
