# Local Verification Queue (네이티브 트랙)

> **[REWRITE IN PROGRESS — ADR-0001]**
> Expo / EAS / React Native / Maestro / expo-mcp 기반의 이전 큐는
> ADR-0001 (full native rewrite to Swift + Rust) 으로 전면 폐기됐다.
> `apps/app` (Expo 앱) 과 `scripts/ios-dev-build.sh` (EAS 로컬 빌드 스크립트) 가
> 레포에서 삭제됐으므로 이전 Q1–Q13 항목은 실행 불가 상태다.
>
> 이전 큐 내용(Q1–Q13: EAS `.ipa` 빌드, Maestro flow, expo-mcp `verify_on_device`,
> APNs/keychain/audio on-device, libsodium Hermes workaround 등)은 ADR-0001
> 커밋 이전 git 히스토리에서 참조할 수 있다.

---

## 현재 네이티브 검증 전략

네이티브 트랙 검증은 **로컬 Swift Simulator 하네스** (`ios/scripts/ios.sh`) 로 수행한다.
EAS 클라우드 빌드, Maestro, expo-mcp 는 더 이상 사용하지 않는다.

### 1회 셋업 게이트

| 게이트 | 확인 명령 | 통과 기준 |
|---|---|---|
| Xcode + 시뮬레이터 런타임 | `xcrun simctl list runtimes` | iOS 런타임 1개 이상 설치 |
| XcodeGen | `which xcodegen` | 설치됨 (`brew install xcodegen`) |
| Bun (백엔드용) | `bun --version` | 1.3.13+ |
| Rust + cargo | `cargo --version` | stable (UniFFI 빌드용, Phase 2 이후) |

### 검증 명령

```bash
# iOS Simulator 하네스 전체 순서
ios/scripts/ios.sh gen      # XcodeGen → .xcodeproj 생성
ios/scripts/ios.sh boot     # Simulator 부팅
ios/scripts/ios.sh build    # xcodebuild (Debug Simulator)
ios/scripts/ios.sh run      # xcrun simctl install + launch
ios/scripts/ios.sh smoke    # 부트 마커 확인 (Phase 0 smoke)
ios/scripts/ios.sh test     # XCTest 실행
```

전체 절차와 각 스텝의 통과 기준은 **`ios/README.md`** 를 참고한다.

### 현재 검증 상태 (Phase 0 — boot-marker shell)

ADR-0001 Phase 0 기준: Swift 앱이 Simulator 에서 빌드·기동되고 부트 마커를 내보낸다.
페어링, Chat, Terminal, E2EE, 음성 등의 기능은 Phase 2–3 에서 구현된다
(현재 미구현 — ADR-0001 §Phase 참조).

백엔드 (daemon / relay / runner) 검증은 이전과 동일하게 `bun test` 를 사용한다:

```bash
bun test ./packages/protocol ./packages/daemon ./packages/runner ./apps/cli ./packages/relay
pnpm type-check:all
```

### Q5. Linux daemon install — systemd 풀 사이클 (VM)

이 항목만 Expo 와 무관하게 여전히 유효하다.

- **prereq**: Lima/Ubuntu(또는 Debian) VM.
- **command**:
  ```bash
  # VM 안에서 Linux tp 바이너리 설치 후
  tp daemon install
  systemctl --user status tp-daemon
  # VM 재부팅 후
  systemctl --user status tp-daemon
  ```
  코드 레퍼런스: `apps/cli/src/lib/service-linux.ts`.
- **pass**: install 후 active(running), 재부팅 후 자동 기동.
- **result**: PASS 2026-06-07 (Lima Ubuntu VM, systemd 257, aarch64, `tp-linux_arm64` v0.1.46).

### Q6. Long-running 안정성 — 1시간 soak

백엔드 전용 항목으로 여전히 유효하다.

- **command**: `bun run scripts/soak.ts --minutes 60 --json`
- **pass**: RSS 단조증가(누수) 없음, reconnect 전부 복구, latency p95 안정.
- **result**: PASS 2026-06-07 (64GB M1 Max, `scripts/soak.ts --minutes 60 --json`,
  60 라운드 × {reconnect 100, rtt 100}: reconnect 6000/6000, rtt 6000/6000,
  RSS Δ −3% = 누수 없음, relay drop 카운터 전부 0).

### Q7. Windows under WSL — install.sh 풀 사이클

별도 Windows/WSL 환경에서 실행. 여전히 유효하다.

- **command**: WSL 안에서 `install.sh` → `tp daemon` → 페어링 → 세션 풀 사이클.
- **pass**: Linux 빌드가 WSL에서 install·daemon·페어링·세션 전부 동작.
- **result**: PASS 2026-06-05 (Windows 11 + WSL2, PR #559 버그 발견+수정 포함).
