---
description: QA 테스트 환경 준비 및 실행
argument-hint: '<auto | frontend>'
---

## QA 테스트: $ARGUMENTS

### 실행 순서

**Step 1: tp daemon 구동 확인**

Frontend 앱이 백엔드와 통신하려면 tp daemon이 실행 중이어야 한다:

```bash
# daemon 실행 여부 확인
pgrep -f "tp daemon" || echo "tp daemon이 실행 중이 아닙니다"
```

daemon이 필요한 테스트가 아니면 (순수 UI 테스트) 이 단계 skip 가능.

**Step 2: 테스트 시나리오 작성**

QA agent에 위임하기 전에, **변경된 코드를 분석하여 구체적인 테스트 시나리오를 작성**한다:

1. `git diff main`으로 변경 내용 분석
2. 변경사항별 테스트 항목 도출:
   - **새 기능 추가**: 해당 기능의 동작 시나리오 (정상 케이스 + 엣지 케이스)
   - **버그 수정**: 수정된 버그의 재현 불가 확인
   - **리팩토링**: 기존 동작이 동일한지 확인
3. 각 테스트 항목에 대해 구체적인 **조작 단계**와 **기대 결과** 명시

> **중요**: "regression 확인해줘" 같은 모호한 위임 금지. 반드시 테스트할 시나리오를 명시해서 전달해야 한다.

**Step 3: Frontend QA (RN Web only)**

`app-web-qa` agent에게 **테스트 시나리오와 함께** 위임 — 로컬 QA는 항상 RN Web (Playwright MCP) 으로 한다:

- QA agent에게 전달할 프롬프트에 반드시 포함:
  1. 변경된 파일 목록
  2. 각 변경사항에 대한 구체적 테스트 시나리오
  3. 테스트에 필요한 사전 조건 (데이터, 설정 등)
  4. 기대하는 UI 동작/결과

> **iOS/Android 실기기 네이티브 동작은 로컬 QA 에서 기본으로 검증하지 않는다.** 이 머신(64GB M1 Max)에서 Simulator/Xcode/Maestro 구동은 가능하지만, 일상적인 QA 는 RN Web(Playwright MCP) 으로 한다 (워크플로 선택 — 빠른 회귀 검증 + EAS 클라우드 빌드 경로와의 parity). expo-mcp 플러그인은 이 머신의 `.claude/settings.local.json`에서 `true` (머신별 결정). 네이티브 전용 동작(push 배너, 소프트 키보드 회피 등)은 코드 + RN Web 근사로 확인하고, 실기기/Simulator 검증은 `/verify-native` (`docs/local-verification-queue.md`) + TestFlight 빌드 후 사용자 디버깅으로 넘긴다.

**Step 4: QA 결과 검증**

QA agent 결과 수신 후:

1. 구조화된 보고 형식인지 확인
2. 앱 실행/UI 확인/인터랙션 항목이 모두 채워져 있는지 확인
3. Step 2 시나리오가 모두 커버되었는지 확인
4. PASS인데 미수행 항목이 있으면 → INVALID, 누락 항목만 재위임

사용자에게 보고 시 QA 판정을 그대로 전달 (INCONCLUSIVE = 테스트 미완료).

### auto 모드 (스마트 QA)

인자가 `auto`이거나 생략 시:

1. `git diff --name-only main`으로 변경된 파일 확인
2. 변경된 앱 감지:
   - `apps/app/` 변경 → `app-web-qa` (RN Web) 필요
   - `packages/` 변경 → `app-web-qa` 포함 관련 앱 QA 모두 필요
   - `apps/app/` 변경 없음 (백엔드만 변경) → QA skip, 단위/통합 테스트로 대체
3. `app-web-qa` agent에게 위임. Simulator 기반 QA(`expo-mcp:qa`)는 기본 사용하지 않는다 (정책: 일상 QA = RN Web, 네이티브 검증 = `/verify-native` 큐 + EAS 클라우드 + TestFlight). 네이티브 iOS/Android 검증은 `/verify-native` 큐 + TestFlight + 사용자 디버깅으로 넘긴다.
