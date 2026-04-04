---
description: 변경 파일 기반 스마트 테스트 실행
argument-hint: '<auto | unit | e2e | all>'
---

## 테스트 실행: $ARGUMENTS

### auto 모드 (기본, 인자 없거나 `auto`)

1. `git diff --name-only main`으로 변경 파일 감지
2. 패키지별 매핑:
   - `packages/protocol/` 변경 → `bun test packages/protocol`
   - `packages/daemon/` 변경 → `bun test packages/daemon`
   - `packages/runner/` 변경 → `bun test packages/runner`
   - `packages/relay/` 변경 → `bun test packages/relay`
   - `apps/cli/` 변경 → `bun test apps/cli`
   - `apps/app/` 또는 `e2e/` 변경 → `pnpm test:e2e`
   - 변경 없음 → "변경된 파일이 없습니다" 보고
3. 테스트 실행 전 `pnpm type-check:all` (fail-fast)
4. 결과 요약 (passed/failed/skipped)

### unit 모드

```bash
bun test packages/protocol packages/daemon packages/runner apps/cli packages/relay
```

### e2e 모드

```bash
pnpm test:e2e
```

### all 모드

type-check → unit → e2e 순차 실행. 하나라도 실패 시 중단.
