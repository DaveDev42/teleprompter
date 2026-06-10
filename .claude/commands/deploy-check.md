---
description: CI와 동일한 로컬 사전 검증
---

## Deploy Check

CI와 동일한 검증을 로컬에서 순차 실행. 하나라도 실패 시 중단:

1. `pnpm exec biome ci .` — lint + format 검증
2. `pnpm type-check:all` — 전체 타입 체크 (CI와 동일한 5개 tsconfig, 순차 실행)
3. `bun test --coverage --timeout 30000 ./packages/protocol ./packages/daemon ./packages/runner ./apps/cli ./packages/relay` — Tier 1-3 테스트
4. `bun test --coverage --timeout 30000 ./apps/app` — RN 앱 단위 테스트 (반드시 별도 invocation — `mock.module` 전역 누출이 타 패키지 crypto 테스트를 오염, CI test job과 동일한 분리)
5. `bun run scripts/build.ts` — CLI 바이너리 빌드
6. `./dist/tp version && ./dist/tp --help` — smoke test
7. Runner-spawn smoke (CI `build-cli` job과 동일 — 번들 누락 모듈 감지):
   ```bash
   timeout 10 ./dist/tp --dangerously-skip-permissions -p "test" 2>&1 | tee /tmp/tp-smoke.log || true
   if grep -q 'Module not found' /tmp/tp-smoke.log; then echo "FATAL: runner bundle is missing a module"; exit 1; fi
   ```

각 단계 pass/fail 리포트. 전체 통과 시 push ready 보고.
