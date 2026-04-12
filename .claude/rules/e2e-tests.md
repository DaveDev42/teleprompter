---
paths:
  - "e2e/**"
  - "playwright.config.ts"
---

# E2E Test Conventions (Playwright)

## 구조
- `e2e/` 디렉토리에 `.spec.ts` 파일
- 프로젝트 분리: CI (daemon 불필요 테스트), local (daemon/relay 필요 테스트)
- Base URL: `http://localhost:8081` (Expo web)

## CI vs Local
- CI: `app-web`, `app-settings`, `app-keyboard-nav` — retries 없음 (daemon 불필요)
- Local: 전체 테스트 (daemon/relay 필요한 `app-daemon`, `app-session-switch`, `app-resume`, `app-relay-e2e`, `app-roundtrip`, `app-real-e2e`, `app-chat-roundtrip` 포함) — 1 retry

## 명령어
- `pnpm test:e2e` — local 프로젝트 (전체 테스트)
- `pnpm test:e2e:ci` — CI 프로젝트 (daemon 불필요 테스트만)
- `npx playwright test -g "테스트 이름"` — 특정 테스트 실행

## 패턴
- 서버: `apps/app/dist` 정적 서빙 (port 8081, 기존 프로세스 재사용)
- Timeout: 60초/테스트, Workers: 1 (순차)
- testID 기반 요소 선택: `data-testid="xxx"` → `page.getByTestId("xxx")`
