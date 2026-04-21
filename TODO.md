# Teleprompter TODO

## 🔧 미비한 점 — 현재 남아있는 이슈

### Voice
- [ ] `VoiceButton`이 iOS/Android에서 `null` 반환 — 네이티브 오디오 캡처/재생 미구현 (expo-av 등 필요)

### Windows
- [ ] Bun `bun:sqlite` Windows finalizer 지연 — Bun 1.3.12 업그레이드 및 `Store.deleteSession`의 double-GC(`Bun.gc(true) → sleep 50ms → Bun.gc(true)`) 보강에도 불구하고 Windows CI에서 `unlinkRetry`의 모든 retry(1.575s budget)를 소진해도 lock이 풀리지 않는 케이스 확인됨. 실제 timeout 문제가 아니라 lock 자체의 지속성 문제라, retry budget을 키우면 다른 `auto-cleanup` 테스트들이 연쇄 timeout. `store-cleanup.test.ts`의 2개 테스트는 `describe.skipIf(win32)`로 skip 유지. 추가로 `auto-cleanup.test.ts` 전체와 `store-cleanup.test.ts`의 `pruneOldSessions removes error sessions` 테스트도 Windows CI 속도 개선을 위해 skip 확장 (macOS/Linux에서 동일 경로 검증됨). Bun upstream issue [oven-sh/bun#25964](https://github.com/oven-sh/bun/issues/25964) (WAL mode file lock on Windows after close) 해결 시 재시도 — 2026-04 현재 open, assignee/milestone 없음.

### 미검증 항목 (잠재 이슈)
- [ ] Push Notifications 실기기 미검증 — Simulator에서는 push token 생성 불가, 실제 iOS/Android 디바이스에서 E2E 테스트 필요
- [ ] Windows PTY/IPC 실환경 미검증 — CI unit test만 통과, 실제 Windows 환경에서 `tp` passthrough + daemon 동작 E2E 검증 필요 (유저가 Windows 개발 환경 제공 시 진행 예정)
- [ ] Windows install.ps1 실환경 미검증 — PowerShell 설치 스크립트 (v0.1.9 기준), 실제 Windows 기기에서 `irm ... | iex` → `tp version` → `tp upgrade` 플로우 확인 필요 (유저가 Windows 개발 환경 제공 시 진행 예정)
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

### Phase 2 — 완료 (2026-04-20 ~ 2026-04-21)
`daemon.ts` 1190 → 464 LOC (-61%). 3개 추출 모두 완료, 후속 리뷰-픽스 루프(5-pass) PR #128로 마감.

- [x] **C1: `IpcCommandDispatcher` 추출 (2026-04-20)** — PR #123. `onMessage` + relay control / worktree / session export 라우팅을 `packages/daemon/src/ipc/command-dispatcher.ts`로 분리. B1(PR #120)의 타입드 경계 위에서 cast 재도입 없이 분해.
- [x] **C2: `RelayConnectionManager` 추출 (2026-04-20)** — PR #124. `relayClients` 풀, 연결/재연결, push fan-out, `buildEvents`/`attachHandlers`/`registerClient` DI 지점을 `packages/daemon/src/transport/relay-manager.ts`로 분리.
- [x] **C3: `PairingOrchestrator` 추출 (2026-04-20)** — PR #125. `pendingPairing` 단일 슬롯 상태머신 + `begin`/`cancel`/`promote`/`clearPending`/`stop` lifecycle을 `packages/daemon/src/pairing/pairing-orchestrator.ts`로 분리. RelayClient 생성은 `relayManager`에 위임.
- [x] **Phase 2 review-fix loop (2026-04-21)** — PR #128. 5-pass 리뷰→수정 반복. 핵심 수정: `clearPending`/`stop`에서 orphan RelayClient 명시적 dispose (리소스 누수 차단), `RelayConnectionManager.removePairing`의 concurrent `indexOf` 재조회 race 수정, `toWsSessionMeta` 공유 헬퍼로 중복 제거, `RelayConnectionManager` 전용 테스트 10개 신설.

### Phase 3 — 완료 (2026-04-21)
- [x] **D1: `pairing-store.ts` v2 마이그레이션 제거 (2026-04-21)** — PR #126. `apps/app/src/stores/pairing-store.ts`의 v2→v3 migration 블록을 제거. A4(PR #121) 테스트가 안전망.
- [x] **Windows CLI IPC 실제 구현 (2026-04-21)** — PR #127. `apps/cli/src/lib/ipc-client-windows.ts` Named Pipe 클라이언트 실구현 + `pair-blocking.test.ts` Windows 복원.

---

## 🧹 Simplify Pass (2026-04-21)

3-agent 병렬 리뷰(reuse / quality / efficiency) 결과 도출된 정리 작업. 하위호환성은 신경쓰지 않고 정리 — 채택 그룹 A(안전/명확) + B(범위 있음) 전부 진행.

### 그룹 A — 완료
- [x] **A1: `formatAge` 3중 중복 제거** — `apps/cli/src/lib/format.ts`로 이동 + 테스트.
- [x] **A2: `resolveTpBinary` 3플랫폼 중복 제거** — `lib/paths.ts` 단일화, 플랫폼 모듈에서 re-export.
- [x] **A3: `getConfigDir` 통일** — `lib/paths.ts`로 이동, 5곳 인라인 제거, Windows APPDATA/XDG 일관성 수정.
- [x] **A4: `daemon-status.ts` stale-socket 오탐 수정** — `isDaemonRunning()` connect-probe로 교체 (status 커맨드도 동일 처리).
- [x] **A5: `waitForDaemonReady` 추출** — `ensure-daemon.ts`의 폴링 루프 2중 중복 제거.
- [x] **A6: `SessionState.connected` 제거** — `useAnyRelayConnected()` 파생 훅 도입; N-daemon last-write-wins 버그 수정.
- [x] **A7: relay-client publish helper 통합** — `sendEncrypted`/`broadcastEncrypted`/`sendControl` 내부 helper, ~140줄 축소.
- [x] **A8: `FrameDecoder` O(N²) 수정** — 빈 버퍼일 때 copy 스킵, 핫패스 O(N) 유지.
- [x] **A9: `reconnectSavedRelays` 병렬화** — `Promise.allSettled`로 N× handshake 지연 제거.
- [x] **A10: `QueuedWriter` 큐 크기 제한** — 8 MiB 기본 cap + overflow 플래그.
- [x] **A11: `Store.sessionDbs` LRU 캡** — 32-slot LRU, evict 시 `SessionDb.close()` 호출.
- [x] **A12: CLI dynamic imports** — per-subcommand dynamic import로 `tp version/status` startup cost 제거.
- [x] **A13: `checkForUpdates()` 범위 축소** — `upgrade/doctor/pair/passthrough`만 호출, 나머지 스킵.

### 그룹 B
- [x] **B1: 레거시 `pairing.json` 마이그레이션 제거** — unlink 블록 + 상수 + 테스트 제거.
- [x] **B2: CLI `pair delete`/`pair rename` → daemon IPC 이관 (2026-04-21)** — "daemon must be stopped" 제약 제거. daemon이 running이면 새 `pair.remove`/`pair.rename` IPC를 보내 daemon이 기존 RelayClient로 peer notify + store 업데이트를 한 번에 수행. daemon이 running이 아니면 store를 직접 수정 (fallback). `RelayConnectionManager`에 `renamePairing` 메서드 신설 + `removePairing`이 notify된 peer 수를 반환하도록 시그니처 변경. 프로토콜에 `IpcPairRemove{,Ok,Err}` / `IpcPairRename{,Ok,Err}` 타입 + `parseIpcMessage` guard 확장. 단위 테스트 6 (dispatcher) + 4 (RelayConnectionManager) + 6 (ipc-guard) 추가.
- [ ] **B3: IPC 바이너리 프레이밍 (io records)** — scope 과대로 보류. 프로토콜 버전 bump + runner/daemon/relay 전역 테스트 업데이트 필요. 별도 브랜치.
- [x] **B4: Relay 상태 TTL eviction** — offline 1시간 후 `daemonStates` + `recentFrames` evict.
- [x] **B5: `cacheFrame` 배치 업데이트** — Map in-place mutate + 120ms throttled flush; PTY 버스트 시 rerender 폭주 해소.
- [x] **B6: ANSI strip 추출** — `lib/ansi-strip.ts` + 7 단위 테스트.
- [x] **B7: 하드코딩 hex → `tp-*` 토큰** — `lib/tokens.ts`에 palette + `TERMINAL_COLORS` 중앙화.
- [x] **B8: `swallow(err)` helper** — `lib/swallow.ts` 추가. 개별 callsite 전환은 점진적.

---

## Future

- [ ] Claude Code channels 양방향(output 구독) 지원 시 Chat UI 통합 재검토
- [ ] libghostty 네이티브 RN 모듈 (iOS: Metal, Android: OpenGL) — WebView 제거, GPU 렌더링
- [ ] Expo Go 드롭 → development build 전용 (Apple Watch, 네이티브 crypto, 네이티브 터미널 등)
- [ ] Apple Watch 컴패니언 앱 — 세션 상태 모니터링, 빠른 명령 전송
- [ ] 글로벌 키보드 단축키 (Cmd+K, Cmd+1/2/3 등) — useKeyboard 훅 확장
- [ ] 게임패드(8BitDo 등) 내비게이션 — Web Gamepad API 기반 D-pad 포커스 이동, A/B 버튼 매핑, useGamepad 훅. 네이티브는 MFi/Android InputDevice 모듈 필요
- [ ] 게임패드 음성인식 트리거 — 특정 버튼으로 VoiceButton 토글 (useInputAction 추상화로 키보드/게임패드/음성 통합 액션 시스템)
