---
description: 네이티브(Apple 멀티플랫폼) 로컬 검증 — Swift Simulator/native 하니스
argument-hint: '[all | gate | smoke | uitest | test | matrix]'
---

## 네이티브 검증: $ARGUMENTS

> **전면 재작성 진행 중 (ADR-0001/0002).** EAS 클라우드 빌드 + expo-mcp + Maestro + 옛 Q-큐는 제거됐다.
> 네이티브 검증은 이제 로컬 **Swift 하니스**(`scripts/ios.sh`, `TP_PLATFORM=ios|ipad|macos|visionos|watchos`)로만 한다.
> SoT 는 `.claude/rules/native-testing.md` + `ios/README.md`. 항목/절차를 바꾸려면 그 문서를 고친다(커맨드 아님).

### Step 0 — 머신 게이트 (항상 먼저)

`docs/local-verification-queue.md` "0. 셋업 게이트" 표를 그대로 실행한다:

```bash
xcrun simctl list runtimes                 # iOS 런타임 ≥1
xcodebuild -version                         # Xcode 설치됨
which xcodegen                              # XcodeGen (brew install xcodegen)
bun --version                              # Bun (백엔드 dogfood용)
rustc --version                            # Rust (tp-core Phase 2)
```

- 하나라도 실패 → 그 사유를 출력하고 **중단**.

### Step 1 — 인자 해석

- **`gate`** → Step 0만 실행하고 결과 보고 후 종료(셋업 점검용).
- **`smoke`** → `scripts/ios.sh smoke` 만 실행 (빌드 + 설치 + 부팅 + 마커 검증). `TP_PLATFORM` 으로 플랫폼 선택.
- **`uitest`** → `scripts/ios.sh uitest` (XCUITest UI-level E2E — iOS/iPadOS/macOS 풀, visionOS 부분, watchOS 미지원).
- **`test`** → `scripts/ios.sh test` (XCTest on Simulator).
- **`matrix`** → `scripts/ios.sh all` (5플랫폼 smoke 매트릭스 — 행=플랫폼, 종료코드=worst).
- **`all` 또는 생략** → gen → build → smoke → test 전체 순회.

### Step 2 — 실행

```bash
scripts/ios.sh gen      # .xcodeproj 재생성 (project.yml SoT)
scripts/ios.sh build    # xcodebuild (Debug-iphonesimulator)
scripts/ios.sh smoke    # 빌드 + 설치 + 부팅 + 마커(TP_BOOT_OK …) 검증
scripts/ios.sh uitest   # XCUITest UI-level E2E (a11y 트리 어서션)
scripts/ios.sh test     # XCTest on Simulator
scripts/ios.sh all      # 5플랫폼 매트릭스 (ios/ipad/macos/visionos/watchos)
```

플랫폼은 `TP_PLATFORM=ios|ipad|macos|visionos|watchos` (기본 `ios`). 시뮬레이터 기기는
`TP_SIM` (iOS 기본 `iPhone 17 Pro`, iPad 기본 `iPad Pro 13-inch (M4)`) / `TP_VISION_SIM` /
`TP_WATCH_SIM`. 마커는 unified log 의 `subsystem == "dev.tpmt.teleprompter"` predicate 로
검증된다 (iOS/iPad/macOS/visionOS 8마커, watchOS 7마커 — 상세 `.claude/rules/native-testing.md`).

### Step 3 — 결과 기록

검증 이력은 `docs/local-verification-queue.md` 에 누적한다 — 해당 항목 `result` 필드를
`PASS YYYY-MM-DD (비고)` / `FAIL — <사유>` / `BLOCKED — <빠진 게이트>` 로 편집하고
`docs:` prefix 커밋으로 남긴다.

### Step 4 — 보고

순회 종료 후 각 단계(build/smoke/test) PASS/FAIL 요약을 출력. PASS가 아닌데 미수행 항목이
있으면 INCONCLUSIVE로 보고 — 모호한 "다 됐음" 금지.
