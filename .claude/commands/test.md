---
description: 변경 파일 기반 스마트 테스트 실행
argument-hint: '<auto | protocol | daemon | runner | relay | cli | app | e2e | unit | all>'
---

## 테스트 실행: $ARGUMENTS

### Step 1: 변경 범위 감지

`auto` 또는 인자 없음일 때, `git diff --name-only main`으로 변경 파일을 분석하여 아래 매핑에 따라 테스트 대상을 결정한다.

| 변경 경로 | 테스트 대상 | 명령어 |
|-----------|------------|--------|
| `packages/protocol/` | protocol | `bun test packages/protocol` |
| `packages/daemon/` | daemon | `bun test packages/daemon` |
| `packages/runner/` | runner | `bun test packages/runner` |
| `packages/relay/` | relay | `bun test packages/relay` |
| `apps/cli/` | cli | `bun test apps/cli` |
| `apps/app/` | app (e2e) | `pnpm test:e2e` |
| `e2e/` | app (e2e) | `pnpm test:e2e` |

**의존성 전파 규칙:**
- `packages/protocol/` 변경 → protocol + 이를 의존하는 daemon, runner, relay, cli도 함께 테스트
- `packages/daemon/` 변경 → daemon + cli (cli가 daemon을 의존)
- 변경 없음 → "변경된 파일이 없습니다" 보고

### Step 2: 실행

1. `pnpm type-check:all` (fail-fast — 실패 시 테스트 실행하지 않음)
2. 감지된 대상별 테스트 순차 실행
3. 결과 요약 (passed/failed/skipped 카운트)

### 명시적 대상 지정

인자로 대상을 직접 지정할 수 있다:

| 인자 | 명령어 |
|------|--------|
| `protocol` | `bun test packages/protocol` |
| `daemon` | `bun test packages/daemon` |
| `runner` | `bun test packages/runner` |
| `relay` | `bun test packages/relay` |
| `cli` | `bun test apps/cli` |
| `app` 또는 `e2e` | `pnpm test:e2e` |
| `unit` | `bun test packages/protocol packages/daemon packages/runner apps/cli packages/relay` |
| `all` | type-check → unit → e2e 순차 실행 |

여러 대상 지정 가능: `/test protocol daemon` → protocol + daemon 테스트.
