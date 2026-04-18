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

---

## Future

- [ ] Claude Code channels 양방향(output 구독) 지원 시 Chat UI 통합 재검토
- [ ] libghostty 네이티브 RN 모듈 (iOS: Metal, Android: OpenGL) — WebView 제거, GPU 렌더링
- [ ] Expo Go 드롭 → development build 전용 (Apple Watch, 네이티브 crypto, 네이티브 터미널 등)
- [ ] Apple Watch 컴패니언 앱 — 세션 상태 모니터링, 빠른 명령 전송
- [ ] 글로벌 키보드 단축키 (Cmd+K, Cmd+1/2/3 등) — useKeyboard 훅 확장
- [ ] 게임패드(8BitDo 등) 내비게이션 — Web Gamepad API 기반 D-pad 포커스 이동, A/B 버튼 매핑, useGamepad 훅. 네이티브는 MFi/Android InputDevice 모듈 필요
- [ ] 게임패드 음성인식 트리거 — 특정 버튼으로 VoiceButton 토글 (useInputAction 추상화로 키보드/게임패드/음성 통합 액션 시스템)
