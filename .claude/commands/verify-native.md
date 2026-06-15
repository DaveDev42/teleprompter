---
description: 네이티브(iOS) 로컬 검증 — Swift Simulator 하니스
argument-hint: '[all | gate | smoke | test]'
---

## 네이티브 검증: $ARGUMENTS

> **전면 재작성 진행 중 (ADR-0001).** EAS 클라우드 빌드 + expo-mcp + Maestro + 옛 Q-큐는 제거됐다.
> 네이티브 iOS 검증은 이제 로컬 **Swift Simulator 하니스**(`ios/scripts/ios.sh`)로만 한다. SoT 는
> `docs/local-verification-queue.md` + `ios/README.md`. 항목/절차를 바꾸려면 그 문서를 고친다(커맨드 아님).

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
- **`smoke`** → `ios/scripts/ios.sh smoke` 만 실행 (빌드 + 설치 + 부팅 + 부트마커 검증).
- **`test`** → `ios/scripts/ios.sh test` 만 실행 (XCTest on Simulator).
- **`all` 또는 생략** → gen → build → smoke → test 전체 순회.

### Step 2 — 실행

```bash
ios/scripts/ios.sh gen      # .xcodeproj 재생성 (project.yml SoT)
ios/scripts/ios.sh build    # xcodebuild (Debug-iphonesimulator)
ios/scripts/ios.sh smoke    # 빌드 + 설치 + 부팅 + 부트마커(TP_BOOT_OK) 검증
ios/scripts/ios.sh test     # XCTest on Simulator
```

시뮬레이터 선택은 `TP_SIM` env (기본 `iPhone 17 Pro`). 부트마커는 unified log 의
`subsystem == "dev.tpmt.teleprompter"` predicate 로 검증된다 (상세 `ios/README.md`).

### Step 3 — 결과 기록

검증 이력은 `docs/local-verification-queue.md` 에 누적한다 — 해당 항목 `result` 필드를
`PASS YYYY-MM-DD (비고)` / `FAIL — <사유>` / `BLOCKED — <빠진 게이트>` 로 편집하고
`docs:` prefix 커밋으로 남긴다.

### Step 4 — 보고

순회 종료 후 각 단계(build/smoke/test) PASS/FAIL 요약을 출력. PASS가 아닌데 미수행 항목이
있으면 INCONCLUSIVE로 보고 — 모호한 "다 됐음" 금지.
