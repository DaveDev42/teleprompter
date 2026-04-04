---
description: CI와 동일한 로컬 사전 검증
---

## Deploy Check

CI와 동일한 검증을 로컬에서 순차 실행. 하나라도 실패 시 중단:

1. `biome ci .` — lint + format 검증
2. `pnpm type-check:all` — 전체 타입 체크
3. `bun test packages/protocol packages/daemon packages/runner apps/cli packages/relay` — Tier 1-3 테스트
4. `bun run scripts/build.ts` — CLI 바이너리 빌드
5. `./dist/tp version && ./dist/tp --help` — smoke test

각 단계 pass/fail 리포트. 전체 통과 시 push ready 보고.
