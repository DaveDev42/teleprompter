---
description: 네이티브 트랙 로컬 검증 큐 순회 (고성능 Mac 전용)
argument-hint: '[all | Q1..Q7 | gate]'
---

## 네이티브 검증: $ARGUMENTS

이 커맨드는 **`docs/local-verification-queue.md`(SoT)를 읽어 순회하는 얇은 래퍼**다. 검증 항목의
전제/명령/통과 기준/결과 기록은 전부 그 문서에 있다 — 이 커맨드는 거기에 없는 로직을 추가하지
않는다. 항목을 바꾸려면 문서를 고친다(커맨드 아님).

> **이 커맨드는 고성능 Mac(16GB+, 정식 OS, 신뢰된 실기기)에서만 의미가 있다.** 저사양 머신(16GB 미만)에서
> 실행하면 Simulator/Xcode/Maestro가 시스템을 과부하시킬 수 있다. 잘못된 머신에서 호출되면 0번
> 게이트에서 멈춘다.

### Step 0 — 머신 게이트 (항상 먼저)

`docs/local-verification-queue.md`의 "0. 고성능 Mac 1회 셋업" 표를 그대로 실행한다:

```bash
sysctl hw.memsize                       # ≥ 16 GB 필요
sw_vers                                  # Developer Beta 아님
java -version                            # JDK 17–21 (OpenJDK 26 ❌)
xcrun simctl list runtimes               # iOS 런타임 ≥1
eas whoami                               # 로그인됨
grep -A2 enabledPlugins .claude/settings.local.json   # expo-mcp: true
```

- 하나라도 실패 → 그 사유를 출력하고 **중단**. (특히 `hw.memsize < 16GB`이면 이 머신은 이 커맨드의
  대상이 아니다 — 즉시 중단.)
- `.claude/settings.local.json`에 `"expo-mcp@expo-mcp": true`가 없으면, 큐 문서 "expo-mcp 켜기"
  섹션의 한 줄짜리 파일을 만들도록 안내(이 파일은 gitignored, 머신별).

### Step 1 — 인자 해석

- **`gate`** → Step 0만 실행하고 결과 보고 후 종료(셋업 점검용).
- **`all` 또는 생략** → 큐 문서의 Q1–Q7 전체를 순서대로(독립적으로) 순회.
- **`Q1`..`Q7`** → 해당 항목만 실행.

### Step 2 — dev build 확보 (Simulator/실기기 항목 전)

큐의 Simulator(Q4)/실기기(Q1–Q3) 항목은 개발 빌드가 있어야 한다. 사용자 확정 방식 =
**`eas build --local` + 실기기**:

```bash
scripts/ios-dev-build.sh --profile device --output /tmp/teleprompter-dev.ipa   # 실기기 (Q1–Q3)
eas build --profile development --platform ios --local                          # Simulator (Q4)
```

빌드 함정(WWDR G3 / Aqua 세션 / root 강등 / tmp 청소)은 `ios-dev-build.sh`가 처리한다 — 큐 문서의
"Dev build 획득" 섹션 참조. **credential·빌드 산출물은 절대 커밋하지 않는다.**

### Step 3 — 항목 실행

선택된 각 Q에 대해 큐 문서의 **prereq → command → pass** 를 그대로 수행한다:

1. `prereq`가 충족됐는지 확인. 안 되면 그 Q를 `BLOCKED — <게이트>`로 기록하고 다음으로.
2. `command`의 정확한 명령을 실행(`docs/PUSH-NOTIFICATION-TEST.md` 참조 항목 포함).
3. `pass` 기준과 대조해 PASS/FAIL 판정.
4. **expo-mcp 항목(Q4)**: `expo-mcp:qa` agent 또는 Maestro flow에 위임. push는 Simulator에서
   `xcrun simctl push`로 handler만 — 진짜 APNs 왕복은 Q1(실기기)에서만 가능(큐 "APNs 검증 범위").

> 하나의 Q 실패가 나머지를 막지 않는다. Q7(Windows/WSL)은 고성능 Mac 범위 밖이라 항상 `BLOCKED`.

### Step 4 — 결과 기록 (이 문서가 아니라 큐 문서에)

각 Q 실행 후, `docs/local-verification-queue.md`의 해당 항목 `result` 필드를 직접 편집:

- `PASS YYYY-MM-DD (build #NN, 비고)`
- `FAIL — <사유>`
- `BLOCKED — <빠진 게이트>`

그리고 **그 문서를 `docs:` prefix 커밋으로 남긴다**(검증 이력이 repo에 축적되도록). 실기기에서 버그
발견 시: 재현 fix 브랜치 + (RN Web 재현 가능하면) `e2e/app-*.spec.ts` 회귀 가드 동봉
(`CLAUDE.md` "디버그 중 발견한 UI 버그 처리").

### Step 5 — 보고

순회 종료 후 Q1–Q7의 판정 요약을 출력(PASS/FAIL/BLOCKED 카운트 + FAIL 항목 사유). PASS가 아닌데
미수행 항목이 있으면 INCONCLUSIVE로 보고 — 모호한 "다 됐음" 금지.
