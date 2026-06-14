# ADR-0001 — Rust 백엔드 + 점진 네이티브 앱 (full Swift/Rust 재작성 기각)

- **상태**: Accepted (2026-06-15)
- **결정자**: Dave
- **맥락 근거**: HEAD 워킹트리 직접 측정 + 2026-06 upstream 조사 (워크플로우 `wf_cdc4d2d2-578` 4개 미지수 검증) + 기존 설계 문서 `docs/native-terminal-plan.md` (2026-06-12)
- **상위 참조**: `docs/native-terminal-plan.md` (터미널 사다리 SoT), `CLAUDE.md` (아키텍처 invariant)

> 이 문서는 결정의 **이유와 경계**를 박제한다. 실제 작업 항목 추적은 TODO.md + GitHub Project,
> 터미널 증분 사다리는 `native-terminal-plan.md` 가 SoT. 코드가 이 문서와 어긋나면 코드가 진실이다 —
> 결정 자체가 바뀌면 이 ADR 을 Superseded 로 표시하고 후속 ADR 을 추가한다.

## 1. 맥락 — 무엇을 결정하려 했나

"모든 것을 iOS native 로 피벗하고 Rust & Swift 로 재작성" 제안에서 출발했다. 초기 스코프는
**전면 재작성**: 앱=Swift (watchOS/iOS/iPadOS/macOS), 백엔드(daemon/relay/runner/cli)=Rust,
protocol wire-spec 개념만 보존, Web/Android 드롭.

동기 (사용자 명시, 전부):
1. iOS 네이티브 UX/성능
2. 백엔드 성능/메모리 ("daemon, relay 의 성능 부족도 분명히 느껴져" — 현재 체감, 미래 가정 아님)
3. 단일 Apple 생태계 집중 (watchOS/iOS/iPadOS/macOS)
4. 기술부채/유지보수 감소 (멀티런타임 CryptoProvider seam 등)

## 2. 실측 규모 (HEAD 직접 측정)

| 컴포넌트 | LOC | 비고 |
|---|---:|---|
| apps/app | 22,066 | RN + RN Web |
| apps/cli | 14,445 | 그중 51%(7,434)가 테스트 → 프로덕션 ~7k, TUI 는 ~943(7%) |
| packages/daemon | 12,543 | |
| packages/protocol | 9,178 | codec + crypto + pairing |
| packages/relay | 5,756 | |
| packages/runner | 1,895 | |
| **합계** | **~65,900** | 전면 재작성 시 재작성 대상 |

## 3. 결정

**전면 Rust+Swift 재작성을 기각한다.** 대신 두 개의 **분리 가능한 트랙**으로 진행한다:

### 트랙 A — 앱: full Swift 재작성 대신 점진 네이티브화
- **Expo/RN 셸을 유지**하고, `docs/native-terminal-plan.md` 의 Rung 0–6 사다리를 따른다.
- 터미널만 네이티브 Expo Module (`TPTerminalView`) 로 교체. Chat/Sessions/Pairing 은 RN 유지.
- **OTA 를 Chat/Sessions/Pairing 에서 보존** (fingerprint break 는 Rung 2+ 네이티브 모듈에만).
- Web/Android 는 우선순위 강등 (deprecate), 단 코드 즉시 삭제하지 않음 (kill-switch 보존).

### 트랙 B — 백엔드: Rust 코어 + UniFFI (단계적)
- `tp-core` Rust crate: framed codec · crypto(XChaCha/BLAKE2b KDF) · pairing · Envelope. 단일 소스.
- UniFFI 로 **순수 함수만** 노출 (encrypt/decrypt/encode/decode/pairing). 소켓 I/O·상태머신·스트림은 호스트 쪽 네이티브.
- 단계: **Phase 0 crypto/UniFFI 스파이크 (Go/No-Go)** → relay → daemon/runner → (CLI 는 TS 유지).
- **CLI 는 무기한 TypeScript 유지** (§5-② 참조). daemon Rust화 시 `Store` 직접 import 를 IPC 로 끊는 선행 작업 필요.

### 두 트랙은 독립적이다
"앱 네이티브화"와 "백엔드 Rust화"는 서로를 요구하지 않는다. wire(framed JSON)가 transport·언어 무관 seam 이라
어느 쪽이든 먼저/나중/병행 가능하다.

## 4. 검증된 4개 미지수 (근거)

워크플로우 `wf_cdc4d2d2-578` (research → adversarial verify 파이프라인) 결과. 신뢰도 표기는 검증 단계 판정.

### ① 터미널 엔진 (高, 검증이 과장 교정)
- **iOS 에서 libghostty 임베드는 실제로 가능** — GhosttyKit + Metal 로 8개+ 상용 iOS 앱 출시 (`native-terminal-plan.md:66`).
- 단 **C API 공식 unstable**, iOS 는 커뮤니티 위임 (Mitchell: "no plan for iPhone/iPad", Discussion #9285), xcframework 자체 빌드(Zig) 필요. standalone 태그 릴리즈 전무.
- iOS 엔 PTY 없으나 **우리 PTY 는 원격 daemon WebSocket → ghostty "external backend" 모델에 정확히 부합** (오히려 유리).
- **결정: SwiftTerm now (Rung 3) → libghostty 태그 릴리즈 후 스왑 (Rung 6).** 엔진 스왑은 `TPTerminalView` 한 컴포넌트로 국소화. 이미 ghostty-web 을 써서 libghostty 로 가면 엔진 패리티 보장.

### ② CLI Rust화 (高)
- 14.4k LOC 중 **51% 가 테스트**. 프로덕션 7k, 그중 **TUI 는 단 ~943 LOC(7%)**. 87% 는 arg 파싱·IPC·다운로드·서비스 관리 등 평범 로직.
- **CLI 프로덕션 9개 파일이 `@teleprompter/daemon` 의 `Store`/`Daemon` 을 in-process import** → daemon Rust화 시 깨짐.
- **결정: CLI 무기한 TypeScript 유지.** napi-rs 하이브리드는 `bun --compile` 단일 바이너리(=`curl|bash` 설치)를 깨므로 기각. Ink(React)→ratatui 는 번역이 아니라 재설계.

### ③ OTA 상실 (中 — 일부 수치 무근거, 방향은 유효)
- **TestFlight 내부 빌드는 App Review 우회** (빌드+처리 ~수십분~1.5h 추정). full 피봇 시 이게 *모든* 변경의 바닥.
- **현재 일상 dogfood 는 RN Web 핫리로드(초 단위).** full Swift 피봇은 이 폴백을 통째로 제거 → 솔로 개발자에게 구조적 속도 타격.
- **결정: 이것이 full 피봇 기각의 핵심 비용.** 트랙 A 점진화는 OTA 를 Chat/Sessions 에서 보존하므로 이 비용을 회피.
- ⚠️ 검증 플래그: "EAS 10–20분", "Apple 처리 ~1h", "iOS 제출 80% 급증" 등 수치는 무근거 — 방향만 신뢰.

### ④ watchOS (高)
- **Rust aarch64-watchOS = Tier 3** (nightly + `-Zbuild-std`). 코드베이스에 Rust 0인데 watchOS 때문에 도입은 순손해.
- **Expo watchOS 미지원** → watchOS 는 무조건 별도 순수 Swift WatchKit 앱.
- **크립토 갭: CryptoKit ChaChaPoly 12B nonce vs 우리 XChaCha 24B** → watchOS 도 libsodium xcframework 필요 (Rust 아님).
- **결정: watchOS 는 Phase 1 후로 연기.** 페어링은 QR 없이 iPhone → `WatchConnectivity` 시크릿 전달. v1 범위 = 세션 상태 glance + Stop 알림 + 권한요청 Approve/Deny. 터미널·Chat·voice 제외.

## 5. 함께 결정된 세부

- **① UniFFI 경계 = 순수 함수만.** async cancellation 미지원·Swift6 async 미적합이라 장수명/스트리밍 연결을 UniFFI 너머로 넘기지 않는다.
- **② transport: WS → QUIC/HTTP3 전환을 트랙 B Phase 2(relay Rust)에 묶어 평가.** wire(framed JSON)는 transport 무관. 이득: HoL blocking 제거, connection migration(모바일 핸드오프 시 현재의 dead-pairing throttle/heartbeat 우회를 구조적으로 대체), 0-RTT 재연결. 단 10k capacity 는 QUIC 에서 재측정 필요. `quinn`/`tokio-quiche`(Cloudflare, production-battle-tested) 후보.
- **③ crypto byte-exactness silent killer 소멸.** Rust 코어 1개를 Swift 가 UniFFI 로 링크 → "Rust·Swift 각각 구현 후 맞춤" 위험 자체가 사라짐. 남는 위험은 "UniFFI 가 이 crypto/codec 을 무탈히 브리지하느냐" = Phase 0 스파이크가 검증.

## 6. 대안 (기각된 것들)

- **전면 Swift+Rust 재작성** (원안): 기각. 미지수 4개 중 어느 것도 full 재작성을 *요구*하지 않음. OTA 상실 + 22k LOC 앱 재작성 비용이 가장 큼. 현재 동작 결함 없음 (동기 전부 비기능적) — rewrite-trap 위험.
- **Swift 앱만 (백엔드 Rust 무기한 보류)**: 기각. 백엔드 성능이 현재 체감 문제라 트랙 B 가 정당화됨.
- **napi-rs 하이브리드 CLI**: 기각 (§4-②).

## 7. 첫 실행 (Go/No-Go 게이트)

**Phase 0 — UniFFI crypto/codec 스파이크 (코드만, 출하 없음):**
최소 `tp-core` crate (XChaCha20-ietf 24B nonce AEAD + BLAKE2b-512 kx-derive + framed codec) 를
(a) UniFFI 로 Swift 테스트가 round-trip, (b) 같은 crate 가 **기존 Bun daemon 과 실제 페어링 왕복**.
둘 다 통과 = 트랙 B Go. 실패 = 트랙 B 전략 재고 (트랙 A 는 독립적으로 진행 가능).

## 8. 결과/영향

- 긍정: 동기 4개를 더 싸게·덜 위험하게 달성. 가장 큰 동인(백엔드 성능)은 살리고 가장 큰 비용(OTA 상실)은 회피. 각 단계 독립 출하·롤백 가능.
- 비용: 두 트랙 병행 관리 부담. transport 교체(QUIC)는 Phase 2 까지 미뤄짐. watchOS 는 별도 Swift 코드베이스(공유 안 됨).
- 되돌리기: 트랙 A 각 Rung·트랙 B 각 Phase 는 wire seam 덕에 개별 롤백 가능. 이 ADR 자체는 Phase 0 결과에 따라 갱신될 수 있음.
