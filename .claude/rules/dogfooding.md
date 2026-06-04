---
paths:
  - "apps/app/**"
  - "e2e/**"
  - "scripts/dev-pair.ts"
---

# Dog-fooding (tp + RN Web 라이브 디버그)

이 repo에서 Claude Code를 돌릴 때는 **항상 `tp` 명령으로 실행한다.** 즉 `claude ...` 가 아니라 `tp ...` (또는 인자 없이 `tp`) 로 진입해서, 모든 Claude 세션이 로컬 daemon → relay → RN Web 프론트엔드 파이프라인을 타게 한다. 이게 두 가지를 동시에 보장한다:

1. Chat UI / Terminal UI 의 모든 변경이 매일 우리 자신의 워크플로우로 검증된다 (진짜 dogfood).
2. UI 회귀를 e2e 테스트가 잡기 전에 사람 눈으로 먼저 마주친다.

> **로컬 `tp` 바이너리 + daemon 항상 최신** 자동 룰(PR 머지/dev 세션 시작/명시 요청 시 재빌드+재설치)은 CLAUDE.md "Local `tp` Binary Freshness" 섹션이 SoT — 여기서는 라이브 디버그 절차만 다룬다.

## 라이브 디버그 워크플로우 (권장)

로컬 web dev + 로컬 daemon 조합. Relay 는 production `wss://relay.tpmt.dev` 를 그대로 쓴다 (자체 호스팅보다 회귀 표면이 작다).

```bash
# 1. RN Web dev 서버 (hot reload 살아있음)
pnpm dev:app                          # → http://localhost:8081

# 2. 로컬 daemon 시작 (필요 시; install 되어 있으면 자동)
tp status                             # daemon 자동 부팅
tp pair new --label "dev-web"         # QR + tp://p?d=... 출력

# 3. 브라우저에서 http://localhost:8081/pairing 열고
#    위에서 출력된 tp://p?d=... 문자열을 textarea 에 붙여넣고 Connect.
#    (web 에는 카메라 QR scan 이 없으므로 manual paste 경로.)

# 4. 페어링 완료 후 sessions 탭에서 daemon 이 보이면
#    별도 터미널에서 실제 작업 세션 시작:
tp                                    # 현재 cwd 로 새 Claude 세션
# 또는 기존 작업을 그대로 tp 통해 진입:
tp <claude-args...>

# 5. RN Web 의 Sessions 탭에 방금 만든 세션이 라이브로 뜬다.
#    Chat 탭: hooks 이벤트 + PTY 스트림 hybrid 렌더.
#    Terminal 탭: xterm.js / ghostty-web 으로 풀 PTY.
#    UI 변경을 만지는 동안 이 세션을 계속 띄워두고 직접 클릭/타이핑.
```

## 한 번 페어링하고 계속 재활용 (`pnpm dev:pair`)

위 3번 step (수동 paste) 을 매번 반복하기는 번거롭다. `scripts/dev-pair.ts` 를 한 번 돌리면:

1. `tp pair new --label dev-web` 를 자식 프로세스로 띄워 stdout 에서 `tp://p?d=...` URL 을 캡처한다.
2. Playwright (chromium headed) 로 `/pairing` 을 열어 URL 을 paste + Connect → daemon 쪽 `pair.completed` 까지 대기.
3. 브라우저 storage state 를 `apps/app/.dev-pairing-state.json` 에 dump (gitignored).

이후의 모든 dev/QA 흐름은 그 storage state 를 `context.storageState({ path: ... })` 로 로드해서 페어링된 상태로 즉시 진입. Daemon 쪽 페어링은 store DB 에 영속되므로 daemon 을 죽였다 살려도 그대로 살아 있다.

```bash
pnpm dev:app                          # 한 터미널 — Expo web on :8081
pnpm dev:pair                         # 다른 터미널 — 한 번만 실행
# 이후 chromium 을 그 storage state 로 띄우면 페어링 완료된 상태로 시작.
```

Fixture 가 깨지는 케이스 (다시 실행해서 재생성해야 하는 경우):
- `tp pair delete <id>` 로 페어링을 의도적으로 지운 경우.
- Daemon store DB 를 삭제했거나 (`~/.local/share/teleprompter/store.sqlite`) clean 환경으로 옮긴 경우.
- Relay 의 `TP_RELAY_RESUME_SECRET` 이 회전되어 resume token 이 무효화된 경우 — 단 이 경우는 full auth 폴백이 동작하므로 보통 fixture 재생성 없이 자동 복구.
- protocol 의 kx/ratchet 포맷이 깨지는 변경 (드물지만 발생하면 fixture 와 store 둘 다 리셋).

## 무엇을 관찰할까

- **Chat 탭**: 새 메시지 도착 시 자동 스크롤, hooks 카드 (Tool/StopFailure/System) 렌더, code block 토글, 마크다운 표시, IME 입력, Enter-to-send / Shift+Enter newline.
- **Terminal 탭**: PTY 출력 스트리밍 끊김 없는지, ANSI 컬러/커서 정확한지, 키보드 입력 라운드트립, 리사이즈 시 reflow.
- **연결 상태**: daemon 을 `tp daemon uninstall && pkill tp-daemon` 으로 일부러 죽여보고 `session-connection-live-region` (disconnect → reconnect 배너) 가 정상 동작하는지 — PR #324 회귀 가드.
- **Pairing**: 이미 페어링된 상태에서 `tp pair delete <id>` 실행 시 `control.unpair` 가 web 에 도달해 토스트 + Daemons 리스트에서 사라지는지.

## 무엇을 피할까

- **`apps/app/dist` 정적 서빙으로는 hot reload 가 죽는다.** e2e 재현/CI 검증에만 쓰고 일상 디버그에는 쓰지 말 것 (`pnpm test:e2e:ci` 가 이미 그 경로를 다룬다).
  - **단, RN Web QA / 회귀 재현은 static serve (`serve apps/app/dist -s`) 가 오히려 정답** — `test:e2e:ci` 가 타는 바로 그 번들이라 프로덕션 충실도가 높고, HMR 이 측정 중 모듈을 갈아끼우는 오염이 없다.
  - **그러므로 static serve 로 QA 를 시작하기 전에는 항상 먼저 `pnpm build:web` 으로 `dist` 를 갱신할 것.** static serve 의 함정은 serve 자체가 아니라 *stale 번들* 이다 — `dist` 가 마지막 빌드 시점에 고정돼 있어, 그 이후 머지된 변경은 재빌드 전까지 번들에 없다. (실제로 ping fix 검증 시 하루 전 빌드된 `dist` 를 서빙해 fix 가 번들에 없는 채로 "미검출" 로 한참 헛다리. `dist/_expo/static/js/web/index-*.js` 에 `grep` 으로 대상 심볼이 있는지 확인하면 즉시 판별된다.)
- **로컬 relay 띄우기는 기본값이 아니다.** `tp relay start` 는 protocol 변경/relay 자체 디버그 시에만. 일반적인 UI 디버그는 production relay 가 표면이 작아 더 빠르게 진실에 접근한다.
- **`claude` 직접 실행은 회피.** PATH 에 `claude` 가 있어도 매번 `tp` 를 거치는 습관이 dogfood 의 본질. `tp` 가 미설치된 환경이라면 먼저 `pnpm build:cli:local && ./dist/tp ...` 로 빌드본을 쓴다.

## 디버그 중 발견한 UI 버그 처리

1. 즉시 reproduce 가능한 브랜치 (`fix/...`) 를 새로 떼서 패치 + 회귀용 Playwright spec (`e2e/app-*.spec.ts`) 을 동봉.
2. 새 spec 은 `playwright.config.ts` 의 `ci` project `testMatch` 배열에 반드시 등록 (등록 안 되면 CI 에 안 돈다).
3. `pnpm build:web && pnpm test:e2e:ci` 로 로컬 그린 확인 후 PR.
4. PR title 은 conventional-commit prefix (`fix(app): ...`) — squash merge 시 main commit subject 가 된다.
