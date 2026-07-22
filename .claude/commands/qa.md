---
description: QA 테스트 환경 준비 및 실행
argument-hint: '<auto | app | backend>'
---

## QA 테스트: $ARGUMENTS

> **전면 재작성 진행 중 (ADR-0001/0002).** Expo/RN Web 프런트엔드는 제거됐다. 앱 QA 는 이제
> 로컬 Swift 하니스(`scripts/ios.sh`, `TP_PLATFORM=ios|ipad|macos|visionos|watchos`)로 한다.
> RN Web/Playwright/expo-mcp/Maestro 기반 QA(`app-web-qa`, `expo-mcp:qa`)는 더 이상 존재하지 않는다.
> 마커 E2E(`smoke`) + XCUITest UI E2E(`uitest`) + 5플랫폼 매트릭스(`all`) 가 검증 레이어다
> (상세 `.claude/rules/native-testing.md`).

### 실행 순서

**Step 1: tp daemon 구동 확인**

앱이 백엔드와 통신하려면 tp daemon이 실행 중이어야 한다:

```bash
# daemon 실행 여부 확인
pgrep -f "tp daemon" || echo "tp daemon이 실행 중이 아닙니다"
```

daemon이 필요하지 않은 테스트(순수 앱 부팅/UI)면 이 단계 skip 가능.

**Step 2: 테스트 시나리오 작성**

위임/실행 전에, **변경된 코드를 분석하여 구체적인 테스트 시나리오를 작성**한다:

1. `git diff main`으로 변경 내용 분석
2. 변경사항별 테스트 항목 도출:
   - **새 기능 추가**: 해당 기능의 동작 시나리오 (정상 케이스 + 엣지 케이스)
   - **버그 수정**: 수정된 버그의 재현 불가 확인
   - **리팩토링**: 기존 동작이 동일한지 확인
3. 각 테스트 항목에 대해 구체적인 **조작 단계**와 **기대 결과** 명시

> **중요**: "regression 확인해줘" 같은 모호한 위임 금지. 반드시 테스트할 시나리오를 명시해야 한다.

**Step 3: 실행**

- **앱(Swift) 변경** → 로컬 하니스로 검증:
  ```bash
  scripts/ios.sh smoke    # 빌드 + 설치 + 부팅 + 마커 검증 (TP_PLATFORM 으로 플랫폼 선택)
  scripts/ios.sh uitest   # XCUITest UI-level E2E (시나리오 인터랙션 어서션)
  scripts/ios.sh test     # XCTest on Simulator
  ```
  시나리오 기반 인터랙션 검증은 `uitest` (XCUITest) 로 한다 — a11y 식별자 쿼리로 세션 row tap →
  pane picker → chat bubble 어서션.
- **백엔드(daemon/relay/runner/cli) 변경** → 단위/통합 테스트 (cwd = `rust/`,
  rustup-shim-safe PATH — rust/README.md):
  ```bash
  cargo test --workspace
  cargo clippy --workspace --all-targets
  ```

**Step 4: QA 결과 검증**

1. 빌드/스모크/테스트가 모두 통과했는지 확인 (FAIL 은 출력과 함께 그대로 보고)
2. Step 2 시나리오가 모두 커버되었는지 확인
3. PASS인데 미수행 항목이 있으면 → INCONCLUSIVE, 누락 항목만 재실행

사용자에게 보고 시 판정을 그대로 전달 (INCONCLUSIVE = 테스트 미완료).

### auto 모드

인자가 `auto`이거나 생략 시:

1. `git diff --name-only main`으로 변경된 파일 확인
2. 변경 영역 감지:
   - `ios/**` 변경 → Swift 하니스(`scripts/ios.sh smoke|uitest|test`, `TP_PLATFORM` 선택)
   - `rust/**` 변경 → 백엔드 `cargo test --workspace` + `cargo clippy --workspace --all-targets`
   - 둘 다 변경 → 둘 다 실행
