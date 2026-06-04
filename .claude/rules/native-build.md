---
paths:
  - "apps/app/ios/**"
  - "apps/app/android/**"
  - "apps/app/app.json"
  - "apps/app/eas.json"
  - "scripts/ios-dev-build.sh"
---

# iOS 빌드 & 검증 워크플로우

**로컬에서 iOS Simulator / Xcode / Maestro 를 띄우지 않는다 — 빌드든 실행이든.** 1차 이유는 단순하다: **이 개발 머신(8GB Mac)은 Simulator + Xcode(또는 네이티브 컴파일)를 동시에 돌리면 시스템이 과부하된다** (load 100+, heavy swap 으로 머신 전체가 사실상 멈춘다). 그래서 미리 빌드된 `.app` 을 Simulator 에서 *실행*하는 것조차 하지 않는다. `eas build --local` 같은 로컬 네이티브 빌드도 같은 이유로 폐기했다 (아래 "왜 로컬 iOS 를 안 하나"). 모든 네이티브 iOS 빌드/배포는 **EAS 클라우드**가, 로컬 검증은 **RN Web**이 담당한다.

(머신 이름이 아니라 *정책*이다 — 8GB 급 머신에서는 항상 이 규칙을 따른다. 더 사양 좋은 Mac 으로 옮기더라도 로컬 Simulator/빌드 재개는 그때 사용자가 명시적으로 결정한다.)

## 표준 절차 (이대로만 진행)

1. **로컬 검증 = RN Web.** UI/로직 변경은 RN Web dogfood (`pnpm dev:app` + `pnpm dev:pair`, `.claude/rules/dogfooding.md`)로 검증한다. PR #481 류의 화면 변경(daemon 카드, 모달, 페어링 라벨 등)은 RN Web 에 동일하게 적용되므로 브라우저에서 확인할 수 있다. 네이티브 전용 동작(소프트 키보드 회피, push 배너 등)은 코드 + web 근사로 확인하고, 실기기 거동은 다음 단계로 넘긴다.
2. **빌드/배포 = EAS 클라우드 + TestFlight.** main push → `ci.yml` eas-gate → `preview.yaml` 가 fingerprint 기반으로 OTA(JS-only) 또는 풀빌드(네이티브 변경)를 TestFlight/Internal 에 발행한다 (`.claude/rules/release-deploy.md`). 로컬에서 `.ipa`/`.app` 을 굽지 않는다.
3. **실기기 디버깅 = 사용자에게 요청.** 네이티브 거동을 실기기에서 확인해야 하면, TestFlight 빌드가 올라간 뒤 **사용자(Dave)에게 디버깅을 요청**한다. Claude 가 로컬에서 기기에 직접 설치/구동하려 시도하지 않는다.
4. **네이티브 트랙 전체 = 고성능 Mac 으로 이관.** 이 8GB 머신에서 구조적으로 못 도는 검증(iOS/Android 실기기, Simulator QA, Linux daemon VM, 1h soak, WSL)은 **`docs/local-verification-queue.md`** 큐(SoT)에 모아 두고, 16GB+ Mac 의 별도 세션이 **`/verify-native`** 커맨드로 순회한다. 그 Mac 은 `.claude/settings.local.json`에서 expo-mcp 를 `true` 로 켜고, dev build 는 `scripts/ios-dev-build.sh` (`eas build --local` + EAS credential 다운로드, **이 머신 실행 금지**)로 굽는다. expo-mcp 활성화는 **머신별** — 공유 `settings.json`은 enable 플래그를 들지 않고 각 머신의 `settings.local.json`이 결정한다 (이 머신 = `false`).

## Credentials = EAS single source of truth (변경 없음)

서명 자격은 repo 에 절대 저장하지 않는다. EAS 서버가 distribution cert + provisioning profile 의 SoT 이고, EAS 클라우드 빌드가 빌드 시점에 사용한다. `eas.json` 에 `credentialsSource` 를 명시하지 않는다 (`remote` 가 기본값). iOS push 용 profile 에 `aps-environment` capability 가 필요하면 `eas credentials -p ios` (대화형) 또는 ASC API key 로 EAS 측에서 갱신한다 — 로컬 keychain 은 건드리지 않는다.

## 왜 로컬 iOS 를 안 하나 (재시도 방지용 기록)

**근본 한계는 메모리다. 이 머신은 8GB RAM 이라 Simulator + Xcode/네이티브 컴파일을 함께 돌리는 순간 시스템이 과부하된다** — iOS 26.5 시뮬레이터 런타임 + 네이티브 빌드가 메모리를 동시에 압박해 load 가 100+ 까지 치솟고 heavy swap 으로 머신 전체(에디터·daemon·이 agent 까지)가 사실상 멈춘다. 이건 도구를 더 잘 맞춘다고 풀리는 게 아니라 **하드웨어 천장**이다. `eas build --local` 로 device `.ipa` + simulator `.app` 을 실제로 빌드해본 적은 있지만, 그 성공이 "조금만 더 손보면 된다"는 뜻은 아니었다 — 빌드를 *검증으로 잇는 구간* 이 이 머신에선 전부 막혔다:

- **시뮬레이터 (주 이유)**: `.app` 설치·실행은 됐으나 RAM 압박으로 idb/Maestro 가 불안정하고, Expo MCP 가 쓰는 **Maestro 가 반복 크래시** (`Maestro process terminated`; 시스템 **OpenJDK 26** ↔ Maestro 권장 JDK 17–21 비호환도 겹침). 무엇보다 시뮬레이터를 띄우는 것 자체가 위의 과부하를 일으킨다.
- **실기기**: iPhone 이 USB 연결돼도 trust/`pairing: unsupported` 로 설치 불가 (Developer Beta OS 의심). `xcrun devicectl ... install` 이 기기에 안 붙는다.
- **부수 비용**: 로컬 빌드 한 사이클에 WWDR G3 수동 설치 / Aqua(GUI) 세션 re-exec / root-owned tmp 정리 / `xcodebuild -downloadPlatform` (8GB+ 다운로드) 같은 깨지기 쉬운 전제가 많았다. (이건 곁가지 — 위 메모리 천장이 없어도 본질 문제는 그대로다.)

→ **결론: 로컬 Simulator/Xcode/네이티브 빌드 전부 재시도 금지.** 네이티브 빌드는 EAS 클라우드, 로컬 검증은 RN Web, 실기기는 TestFlight + 사용자 디버깅으로 간다. (16GB+ / 정식 OS / 신뢰된 기기를 갖춘 다른 Mac 이라면 메모리 천장이 사라져 로컬 경로가 다시 유효할 수 있으나 — 이건 **자동으로 재개하지 않고** 그 시점에 사용자가 명시적으로 결정한다. 위 명령들을 재시도 레시피로 읽지 말 것.)

# Native Build (Expo Go 드롭 예정)

향후 Apple Watch 앱, 네이티브 libghostty 터미널 등을 위해 Expo Go 호환성 제약을 해제할 예정.
현재는 WASM/asm.js 기반으로 동작하지만, dev/preview build(**EAS 클라우드** — 위 "iOS 빌드 & 검증 워크플로우" 참조, 로컬 빌드 아님) 전환 후 네이티브 모듈 사용 가능:
- ✓ libsodium-wrappers (WASM on Web/Bun, asm.js fallback on Hermes)
- ✓ expo-crypto (Expo SDK 내장 — `getRandomValues` polyfill 제공)
- ✓ ghostty-web (libghostty WASM — Canvas 2D 터미널 렌더링)
- 🔜 react-native-quick-crypto (JSI — development build 전환 후)
- 🔜 libghostty 네이티브 RN 모듈 (Metal/OpenGL GPU 렌더링 — development build 전환 후)
