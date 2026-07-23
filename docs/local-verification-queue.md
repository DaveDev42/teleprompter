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
| Rust + cargo | `cargo --version` | `rust/rust-toolchain.toml` 핀 버전 (백엔드/CLI + UniFFI xcframework) |

### 검증 명령

```bash
# Apple 플랫폼 하네스 전체 순서 (TP_PLATFORM=ios 기본 / macos / visionos / watchos)
scripts/ios.sh gen      # XcodeGen → .xcodeproj 생성
scripts/ios.sh boot     # Simulator 부팅
scripts/ios.sh build    # xcodebuild (Debug Simulator)
scripts/ios.sh run      # install + launch
scripts/ios.sh smoke    # 8마커 E2E smoke (Rust tp-loopback relay)
scripts/ios.sh test     # XCTest 실행
```

전체 절차와 각 스텝의 통과 기준은 **`ios/README.md`** 를 참고한다.

### 현재 검증 상태

앱은 페어링/Chat/Terminal/E2EE/음성까지 구현된 멀티플랫폼 빌드로, `scripts/ios.sh smoke`
(8마커) + `test`(XCTest) + `uitest` 가 회귀 게이트다. 백엔드/CLI (Rust workspace — #5 PR6
이후 유일 구현) 검증:

```bash
( cd rust && cargo test --workspace )
( cd rust && cargo clippy --workspace --all-targets && cargo fmt --all -- --check )
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
  코드 레퍼런스: `rust/tp-cli/src/service_linux.rs` (구 `apps/cli/src/lib/service-linux.ts` 의 byte-exact 포트).
- **pass**: install 후 active(running), 재부팅 후 자동 기동.
- **result**: PASS 2026-06-07 (Lima Ubuntu VM, systemd 257, aarch64, `tp-linux_arm64` v0.1.46).

### Q6. Long-running 안정성 — 1시간 soak

백엔드 전용 항목으로 여전히 유효하다.

- **command** *(역사적 — Bun `scripts/soak.ts` 는 PR6 에서 삭제)*: 현행 soak = `cargo test -p tp-relay --test soak_10k`(relay 10k capacity gate) + real-claude E2E soak (`TP_E2E_CLAUDE*` 게이트, 로컬 전용)
- **pass**: RSS 단조증가(누수) 없음, reconnect 전부 복구, latency p95 안정.
- **result**: PASS 2026-06-07 (64GB M1 Max, `scripts/soak.ts --minutes 60 --json`,
  60 라운드 × {reconnect 100, rtt 100}: reconnect 6000/6000, rtt 6000/6000,
  RSS Δ −3% = 누수 없음, relay drop 카운터 전부 0).

### Q7. Windows under WSL — install.sh 풀 사이클

별도 Windows/WSL 환경에서 실행. 여전히 유효하다.

- **command**: WSL 안에서 `install.sh` → `tp daemon` → 페어링 → 세션 풀 사이클.
- **pass**: Linux 빌드가 WSL에서 install·daemon·페어링·세션 전부 동작.
- **result**: PASS 2026-06-05 (Windows 11 + WSL2, PR #559 버그 발견+수정 포함).
