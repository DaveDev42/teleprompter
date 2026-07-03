# Pairing 재설계 v3 — Local ECDH Commit + Per-Frontend PCT

## 0. 문서 상태 · 계보 · round-2 지적 매핑

- **상태**: **v3.1 — round-3 PASS_WITH_CONDITIONS (CRITICAL 0건, flaw1/2/3 전부 CLOSED); 12개 조건 전부 본문 반영 완료 (§0.4 매핑); 구현 준비 완료.** req-3 Option A/B 는 **4축(keychain-mechanics·threat-and-privacy·req3-convergence·implementation-cost) 독립 분석이 전부 Option A 로 수렴 완료** (confidence HIGH, §3.5) — 메커니즘 선택은 더 이상 열린 질문이 아니다. 유일한 잔여 사용자 결정은 **PR-6 착수를 위한 Option A greenlight** 하나뿐이며 (구현 조건 §3.6, 실기 검증 게이트 §3.7), 이 결정은 **PR-6 하나만** 블록한다. 본 개정(v3.1) 착지 즉시 **PR-1~PR-5, PR-7, PR-8 은 착수 가능**하다.
- **선행 문서**: `docs/design/pairing-redesign-local-ecdh-commit.md` (v2, 이하 "v2"). 본 문서는 v2를 **대체(supersede)** 하되, round-2 에서 SOUND 판정을 받은 부분(PCT 암호 코어 §A, QR v4 레이아웃 §C.1, iCloud 위협모델 §D, unpair/remove 구분 §E, relay 불변식 §F)은 재서술하지 않고 참조한다. 변경되는 부분만 본 문서가 새로 정의한다.
- **코드 ground truth**: worktree `.claude/worktrees/webpage-demo` @ `ae3a54b` (= origin/main `57dc92f` + 무관한 `.github` 커밋; 이후 origin/main `b79b157` 은 같은 CI 수정의 squash merge 라 **트리 바이트 동일** — 본 문서의 앵커는 `b79b157` 에도 그대로 유효, `git diff ae3a54b b79b157` = 공집합으로 확인). 본 문서의 모든 file:line 은 이 HEAD 에서 **직접 읽어 재검증**한 것이다 (부록 A 원장 참조). round-2 인용 라인과의 드리프트는 부록 A.3, round-3 조건 앵커의 재검증 결과는 부록 A.4 에 정리.

### 0.1 계보 (design lineage)

| Round | 설계 | 판정 | 치명 사유 |
|---|---|---|---|
| 1 | relay-HMAC signature (relay 가 pairing 성립을 서명) | **REJECTED** | 동어반복 — relay 는 zero-trust ciphertext 포워더로 daemon 의 진짜 pubkey 를 보유하지 않으며, `registrationProof` 는 self-assertion 이라 서명 주체가 될 수 없음 |
| 2 | PCT (local BLAKE2b 확인 태그) + two-phase PENDING→COMMITTED ingest + QR v4 + 단일 `pct BLOB` 컬럼 | **REDESIGN** | 암호 코어는 SOUND, 그러나 라이프사이클(CRITICAL-1)·저장 모델(CRITICAL-3)·sync 전제(CRITICAL-2)가 실코드와 불합치 |
| 3 | 본 문서 — connect-on-pending 라이프사이클 + per-frontend `pairing_confirmations` 테이블 + req-3 양안(A/B) 제시 | **PASS_WITH_CONDITIONS** (CRITICAL 0, MAJOR 4, 조건 12) | 없음 — 세 구조 결함 전부 CLOSED. 잔여 조건은 구현-체크리스트/스펙-정밀도 급 (재설계 불요) |
| 3.1 | 본 개정 — round-3 조건 12건을 관련 섹션에 in-place 반영 (§0.4) | 구현 준비 완료 | — (req-3 사용자 결정만 잔존, PR-6 한정) |

### 0.2 round-2 지적 → v3 폐지 섹션 매핑

| round-2 지적 | 내용 요약 | v3 폐지 섹션 |
|---|---|---|
| **CRITICAL-1** | two-phase ingest 닭-달걀: PENDING 레코드는 RelayClient 를 영영 못 받음 → kx 불가 → 24h GC | **§1** (connect-on-pending 라이프사이클) |
| **CRITICAL-2** | req-3 iCloud sync 전제 허위: secret 만 synchronizable, meta/index 는 비동기화 UserDefaults | **§3** (양안 A/B + 권고) |
| **CRITICAL-3** | 단일 per-pairing `pct BLOB` 은 N:N 표현 불가 (PK=daemon_id, last-writer-wins) + reconnect savePairing 클로버 | **§2** (per-frontend 테이블) |
| **MAJOR-a** | legacy pairingId 마이그레이션이 3-스택 미존재 UUIDv5/SHA-1 에 의존 | **§4.1** (BLAKE2b 기반 결정적 id) |
| **MAJOR-b** | v2 PR-4 가 ingest() 실호출부를 누락 | **§4.2** (전수 조사 + PR 매핑) |
| **MAJOR-c** | reconnect savePairing 이 신규 컬럼을 클로버 | **§4.3** (컬럼 보존 규칙) + §2.4 |

### 0.3 v3 에서 새로 발견한 사실 (round-2 도 놓친 것)

**Frontend kx keypair 는 kx-epoch 단위 ephemeral 이다.** 앱은 매 kx 마다 `kxSeedKeypair(seed: randomBytes(32))` 로 새 키쌍을 생성하고 (`ios/Sources/Relay/RelayClient.swift:746`), daemon 재시작 후 재교환 시에도 새로 생성한다 (`RelayClient.swift:804` alreadyKeyed 분기 — `startKeyExchange()` 를 먼저 돌려 fresh keypair 로 재파생). 따라서 session keys 와 PCT 는 **kx-epoch 단위로 매번 바뀐다**. v2 §C.2 는 저장된 pct 를 준영구 값처럼 취급했으나("null 이면 재계산"), 실제로는 **모든 kx 가 저장값을 stale 로 만든다** (round-3 조건 10 정정: "모든 reconnect" 가 아니다 — daemon 의 resume fast-path 는 재연결 시 peers 맵을 보존하고 re-kx 를 스킵하므로(`packages/daemon/src/transport/relay-client.ts:404-409` `msg.resumed && this.peers.size > 0` 분기, peers 보존은 :114-118 주석이 명시) resume 재연결에서는 세션키도 PCT 도 바뀌지 않는다. stale 을 만드는 단위는 정확히 **kx epoch** 다). v3 는 저장 PCT 를 "최신 kx 의 상호확인 증거(latest confirmation evidence) + `confirmed_at`" 으로 재정의하고, 양측이 매 kx 마다 overwrite 하여 epoch 단위로 수렴하게 설계한다 (§2.3). 이는 per-frontend 테이블 설계를 한층 더 필연으로 만든다 — frontend 마다 keypair 도, epoch 도 다르기 때문이다.

**v2 req-6 재심 (round-3 조건 11 — v2 §A 를 SOUND 라고 무변경 수입하지 않는다).** v2 §A 는 req-6 을 "저장된 재료로 PCT 를 재계산해 언제든 재검증 가능(re-checkable anytime)" 으로 충족한다고 주장했다. 위 ephemeral-keypair 사실이 이 주장을 **무효화**한다: PCT 의 preimage(그 epoch 의 세션키/frontend keypair)는 kx epoch 이 끝나면 어느 쪽에도 존재하지 않으므로, 저장된 재료만으로는 PCT 를 재파생할 수 없다. 명시적으로 재정의한다 — **저장 PCT 는 "최신 확인 증거 + `confirmed_at`" 이지, 재파생 가능한 유효성 증명(re-derivable validity proof)이 아니다. 진짜 재검증은 오직 fresh kx(새 epoch 성립 + hello.pct 재대조) 뿐이다.** `tp pair list` 류 진단 표면은 이 값을 "마지막으로 상호확인된 시각" 으로만 표기해야 하며, "현재 유효함" 으로 오독시키는 문구를 금지한다. v2 §A 의 나머지(파생식·도메인 분리·length-prefix 인코딩)는 그대로 유효하다.

### 0.4 round-3 조건 → v3.1 반영 매핑 (12건 전수)

| round-3 조건 # | 반영 섹션 | 해소 방식 (한 줄) |
|---|---|---|
| 1 (command-dispatcher 2번째 hello 빌더) | §2.3, §5 PR-3, §6 W5 | `case "hello"` (:480-496, v:1·pct 없음) 검증 확인 — PR-3 파일 목록에 추가, `relay.peerPct(frontendId)` 로 per-frontend pct 스레딩 (on-demand hello 복구 경로 W5 봉합) |
| 2 (pairing-row-guard 누락) | §4.3, §5 PR-3 | `StoredPairing`(:41-50)+`parseStoredPairing`(:79-115) allowlist 가 신규 컬럼을 재시작마다 strip 함을 확인 — 양쪽 확장 + `pairing-row-guard.test.ts` 를 PR-3 에 추가 |
| 3 (§2.3 hello 접근자 미컴파일) | §2.3 | `clients` 는 `RelayClient[]` 배열(:74) — Map 접근자 폐기, `buildEvents` 의 기존 `getClient()` 클로저(:105-150, 오케스트레이터 `relayRef` :83-88/:125-127 배선)로 재작성; PENDING client 도 해석되므로 "fresh pairing 은 전부 pct-less" 우려 해소 |
| 4 (상태기계 모순 + 다운그레이드) | §1.3 | 승격 규칙을 단일 표로 통합 — `pct 부재 + effective v≥3` 셀 = **FAILED** (레거시 분기 fall-through 금지) + per-pairing `minAdvertisedV` floor (kx replay 방어; onKeyExchangeFrame 에 replay/nonce 체크 부재 확인) |
| 5 (committed 에 pairingId 부재) | §1.4, §2.5, §5 PR-4, §6 W7 | committed meta 스키마에 `pairing_id`/`hostname` 을 **PR-4 에서** 추가 — W7 부트 재조정·§2.5 재검증은 **pairingId 로만** 비교 (daemonId 비교 금지) |
| 6 (PENDING client 키/재조정 미명세) | §1.6 (신설), §6 W10 | pending client 는 pairingId 키; promote 시 re-key(신규 연결 금지)·stale committed client dispose; 동일 QR 이중 ingest 멱등; GC↔promote 창 규칙 명세 |
| 7 (confirmations 미수거) | §2.3 | "cascade 로 충분" 주장 **정정** — 미승격 pairing 의 행은 cascade 가 영영 못 지움; 기동 시 sweep `DELETE ... WHERE daemon_id NOT IN (SELECT daemon_id FROM pairings)` 추가 |
| 8 (Option A 마이그레이션 삭제 위험) | §3.2 | 레거시 synchronizable secret item 은 마이그레이션 후 **삭제 금지** (synced 삭제가 구버전 앱 peer 기기의 페어링을 무음 사살 — `TeleprompterApp.swift:251` silent guard, v3.1 재검증에서 앵커 :268→:251 드리프트 정정, 부록 A.4 조건 8 행); 장기 deprecation 유지 + `errSecInteractionNotAllowed` 열거 의미론 명세 |
| 9 (`--qr-v3` 해치 브릭) | §5 (버전 게이트 문단) | 결정: **해치 폐기(drop)** — 스케치대로면 결정론적 브릭 (daemon 은 저장된 랜덤 UUID 로 PCT 계산, v3 QR 엔 pairingId 없음 → 앱은 레거시 daemonId-파생 UUID → 영구 mismatch/FAILED 루프) |
| 10 (문서 정확성 3건) | §2.3(b), §3.2, §0.3 | (a) "frontend_pk 연속성 감사" → 확인-시점 pk 포렌식으로 재규정; (b) blob 공격면 주장 을 default-relay 사용자로 스코프 (private relay 의 relayURL 은 현재 sync 안 되는 좌표); (c) "모든 reconnect" → "모든 kx" (daemon resume fast-path 확인) |
| 11 (v2 req-6 재심) | §0.3, §2.5 | 저장 PCT = "최신 확인 증거 + confirmed_at" 로 명시 재정의 — 재파생 가능한 유효성 증명 아님; 진짜 재검증 = fresh kx 뿐 |
| 12 (real-E2E 마커/테스트/loopback) | §1.4, §5 PR-3·PR-4·PR-5 | real-E2E M1 어서션을 `TP_PAIR_PENDING` 으로 재앵커 (M0-M2 범위에서 kx 는 out-of-scope/racy); `PairingStoreTests.swift`·daemon co-located 테스트 갱신을 PR 체크리스트에 명기; `local-relay-loopback.ts` kx `v:2` 하드코드(:120,:131) 갱신 없으면 PCT-confirm 경로 CI 커버리지 0 |

---

## 1. CRITICAL-1 폐지 — connect-on-pending 라이프사이클

### 1.1 결함 재검증 (HEAD 직접 확인)

round-2 의 지적은 **실코드에서 그대로 성립한다**:

- `PairingViewModel.connect(daemonId:)` 는 committed 네임스페이스 로드에 가드된다: `guard let pairing = try? store.load(daemonId: daemonId) else { return }` (`ios/Sources/TeleprompterApp.swift:250-251` — round-2 인용 :261 → round-3 :267-268 → v3.1 재검증 :250-251 로 누적 드리프트, 상류 편집 때문. 실질 동일; 부록 A.4 조건 8 행). `RelayClient` 는 이 로드된 `Pairing` 으로만 생성된다 (:253).
- 앱 기동 재연결 루프는 committed index 만 순회한다: `for did in store.daemonIds() { connect(daemonId: did) }` (`TeleprompterApp.swift:253`); `daemonIds()` 는 `Key.daemonIndex`(= `"tp.pairings.index"`) 만 읽는다 (`ios/Sources/Pairing/PairingStore.swift:164-166`, 키 정의 :76).
- `load(daemonId:)` 는 `Key.meta(did)` defaults 를 읽고 없으면 `.notFound` throw (`PairingStore.swift:169-179`).

즉 v2 §B.2 처럼 PENDING 을 **별도 네임스페이스에 격리**하면, 그 레코드에 RelayClient 를 만들어 줄 코드 경로가 전무하다 — kx 가 영영 시작되지 않고, COMMITTED 승격 조건(kx + PCT 일치)이 영영 충족되지 않으며, §B.8 GC 가 24h 후 정상 페어링 시도를 수거한다. **닭-달걀 확정.**

### 1.2 v3 설계 원칙: "PENDING 도 완전한 transport 를 갖는다"

핵심 전환: PENDING 은 *연결하면 안 되는 상태*가 아니라 **연결해야만 벗어날 수 있는 상태**다. kx 와 hello 는 승격의 전제조건이므로, PENDING 레코드는 ingest 즉시 RelayClient 를 받는다 (**connect-on-pending**). 제약은 transport 가 아니라 **UI/부수효과 레벨**에만 둔다:

- PENDING 상태의 RelayClient 는 connect→auth→kx→hello 전 구간을 정상 수행한다. kx 가 성공한 시점에 이미 양측 세션키가 성립했으므로(오늘의 커밋 기준과 동일한 보안 수준), transport 를 제한해서 얻는 보안 이득은 없다.
- 대신 UI 는 해당 daemon 행을 "확인 중(confirming)" 상태로 구분 표기하고, 세션 자동-attach 와 `TP_PAIR_OK` 마커 방출을 COMMITTED 승격 시점까지 유보한다.

### 1.3 상태 기계

```
                 QR decode OK (3개 ingest 지점)
  (none) ────────────────────────────────────────▶ PENDING
                                                     │ RelayClient 생성 (즉시)
             connect/auth 실패, daemon offline        │
        ┌───(retry/backoff — PENDING 유지, UI "대기 중")┘
        ▼
     PENDING ──kx 완료 (TP_KX_OK)──▶ CONFIRMING (in-memory)
        │                              │
        │                              └─ hello 수신 ──▶ 승격 판정 표 (아래 단일 규칙)
        │                                   ├─ COMMITTED (promote)
        │                                   ├─ COMMITTED (legacy, confirmed=false)
        │                                   └─ FAILED (visible, retryable)
        │
        ├─ user cancel ──▶ (none)  [client dispose + 레코드 삭제]
        └─ age > 24h GC ──▶ (none)  [앱 기동/포그라운드 시]
```

| 상태 | 영속화 네임스페이스 | 진입 트리거 | 이탈 트리거 |
|---|---|---|---|
| **PENDING** | `tp.pairings.pending.index` + `tp.pairing.<pairingId>.pending` (UserDefaults.standard, **디바이스 로컬 — 절대 sync 금지**) + secret 은 비동기화 Keychain item (account `pending.<pairingId>`) | ingest 성공 (3개 지점, §4.2) | promote / cancel / GC / FAILED 후 삭제 |
| **CONFIRMING** | 없음 (in-memory 전용 — 앱 kill 시 재기동에서 PENDING 으로 재개, 새 kx epoch 로 재확인) | `TP_KX_OK` (kx 세션키 성립) | hello 수신 (auto-hello 는 join 마다 보장: `packages/daemon/src/transport/relay-manager.ts:148-176`; 유실 대비 on-demand hello 요청 경로 기존재: `ios/Sources/Relay/RelayMessages.swift:277-278`) |
| **COMMITTED** | 현행 committed 레이아웃 (PR-4 시점) → req-3 결정 후 Option A/B 레이아웃 (PR-6, §3) | PCT 일치 or legacy 승격 | unpair / remove |
| **FAILED** | PENDING 레코드에 `lastError` 필드로 기록 (별도 상태 저장 없음) | 승격 판정 표의 FAILED 행 2종 (pct 불일치, 또는 pct 부재 + effective v≥3) | retry (재-kx = 새 epoch 로 재확인) / cancel / GC |

#### 승격 판정 — 단일 규칙 (round-3 조건 1·4 통합 해소)

round-3 이 지적한 대로 v3.0 은 이 판정을 §1.3/§2.3/§5 세 곳에서 서로 다르게 서술했다 ("pct 부재 = 레거시 승격" vs "v 로 판별"). **본 표가 유일한 규칙이며 다른 모든 서술은 이 표를 참조만 한다.**

입력: `hello.d.pct` (present/absent), `effectiveV = max(이번 epoch 의 kx-advertised v, 저장된 minAdvertisedV floor)`.

| `hello.d.pct` | `effectiveV` | 판정 |
|---|---|---|
| present, `== PCT_app` | (any) | **COMMITTED** (promote) + floor ← max(floor, 3) |
| present, `!= PCT_app` | (any) | **FAILED** (pct-mismatch, 가시적·재시도 가능) |
| absent | `< 3` | **COMMITTED** (legacy 승격, `confirmed=false`) — 정당한 구 daemon 경로 |
| absent | `≥ 3` | **FAILED** (pct-missing) — **레거시 분기로 fall-through 금지** |

`absent + v≥3 = FAILED` 인 근거: v≥3 daemon 은 hello 를 보낼 수 있는 시점에 반드시 해당 frontend 의 in-memory `FrontendPeer.pct` 를 갖는다 (kx 가 hello 에 선행하고, **두 hello 빌더 모두** — `relay-manager.ts` `onFrontendJoined` 의 auto-hello 와 `command-dispatcher.ts` `case "hello"` 의 on-demand 응답, §2.3 — 같은 peer 맵에서 pct 를 싣는다, PR-3). 따라서 이 셀은 구현 버그 아니면 능동적 다운그레이드 시도이며, 어느 쪽이든 조용한 레거시 승격이 아니라 **가시적 실패**여야 한다. 이 셀이 정의되지 않으면 PCT 게이트는 "pct 를 생략하면 우회되는" 게이트가 된다.

**Version floor (`minAdvertisedV`) — 안티 다운그레이드 방어.** per-pairing 영속 필드 (pending 레코드 + committed meta, §1.4):

- **초기화**: QR v4 로 ingest 된 페어링은 floor=3 (v4 QR 을 발행할 수 있는 daemon 은 정의상 v≥3 — **신규 페어링은 레거시 분기를 애초에 탈 수 없다**). QR v2/v3 레거시 레코드는 floor=0 (미상).
- **상승 전용(monotonic)**: (a) daemon kx payload 의 `v` (`DaemonKxPayload.v` — 현재 앱은 이 필드를 디코드만 하고 **어디서도 읽지 않는다**, `RelayMessages.swift:196` + `RelayClient.swift` 전수 grep 0건; PR-5 가 최초 소비자), (b) pct 를 실은 hello 수신 (E2EE 세션키 하 인증된 v≥3 증거 — kx envelope 보다 강함) 중 어느 쪽이든 더 높은 값을 관찰하면 floor 를 올려 영속화. **절대 내리지 않는다.**
- **방어 대상 (실코드 확인된 갭)**: kx 프레임에는 freshness binding 이 전혀 없다 — 앱 `onKeyExchangeFrame` (`RelayClient.swift:775-824`) 은 kxKey(정적 pairingSecret 파생)로 복호만 되면 어떤 프레임이든 수용하고, daemon `handleKxFrame` (`relay-client.ts:572-647`) 도 nonce/replay 체크 없이 peer 를 overwrite 한다. 따라서 hostile relay 가 캐시해 둔 v=2 시절 kx broadcast 를 재생하면 per-epoch 신호만으로는 앱이 구 daemon 으로 오인해 레거시 분기로 떨어질 수 있다. floor 는 이를 차단한다: v≥3 증거를 한 번이라도 본 페어링은 재생된 v=2 kx 로도 `effectiveV < 3` 이 될 수 없어 PCT 검증이 조용히 꺼지지 않는다. (kx freshness binding 자체의 추가는 wire 변경이 필요한 별도 hardening 후보로 남긴다 — floor 는 wire 무변경 방어.)
- **committed 상태에서의 floor 위반**: floor≥3 인 committed 페어링에 pct-less hello 가 오면 §2.5 와 같은 보수 처리 (연결 유지 + 경고 로그 + 진단 표면) — hello 복호 성공 = 세션키 일치라는 사실과 모순되는 신호라 버그/다운그레이드 판별을 사람에게 넘긴다. 승격 게이트(CONFIRMING)에서만 hard FAILED.

**PENDING 이 sync 되면 안 되는 이유**: pairingId 로 키된 pending 레코드가 다른 디바이스에 sync 되면 그 디바이스의 frontendId 로 kx 가 발생해 사용자가 스캔하지 않은 기기가 페어링될 수 있다. 확인 전 자격은 스캔한 그 기기에만 속한다. (committed 의 sync 는 §3 의 req-3 별도 논의.)

### 1.4 변경 파일 및 앵커

| 파일 | 현행 앵커 | 변경 |
|---|---|---|
| `ios/Sources/Pairing/PairingStore.swift` | `ingest(deepLink:)` :113-143 (마지막에 `persist` :141); 현행 committed meta = **pk/relay/did/v 4필드뿐** (:149-155, load :169-179) | ingest 는 **pending 네임스페이스에 기록**하고 `.pending(pairingId:)` 을 반환. 신규 CRUD: `pendingIds()`, `loadPending(pairingId:)`, `promote(pairingId:)` (committed 기록 + pending 삭제, 멱등), `removePending(pairingId:)`, `gcPending(olderThan:)`. **committed meta 스키마 확장 (round-3 조건 5): `pairingId`/`hostname` 을 PR-4 에서 추가** — 이게 없으면 W7 부트 재조정과 §2.5 재검증이 비교할 키 자체가 영속되지 않는다 (v3.0 의 갭). `minAdvertisedV` floor 필드는 PR-5 에서 추가 (§1.3). W7 재조정·§2.5 비교는 **항상 pairingId 로** — daemonId 비교는 재페어링(같은 daemon, 새 pairingId) 시 살아있는 pending 을 오삭한다. co-located `ios/Tests/PairingStoreTests.swift` 의 ingest 사이트(:48, :66, :85-86, :91)와 멱등 테스트가 pending 반환형으로 전환됨 — PR-4 에서 동반 갱신 (조건 12) |
| `ios/Sources/TeleprompterApp.swift` | init 재연결 루프 (`daemonIds = store.daemonIds()` :240), `connect(daemonId:)` :250-287 | init 이 **pending index 도 순회**해 각 pending 에 RelayClient 를 재생성. `connect` 는 committed/pending 양쪽에서 로드하는 `loadAny` 로 전환. 신규 `@Published pendingPairings` (UI 행 상태). RelayClient 의 `onPairingConfirmed` 콜백에서 `store.promote` + `TP_PAIR_OK` 방출. **pending client 의 맵 키·promote/GC 재조정 규칙은 §1.6** (round-3 조건 6) |
| `ios/Sources/Relay/RelayClient.swift` | first-kx :814-824 (`kxClientSessionKeys` :818-819), re-kx :791-813, hello 처리 :972-984 | kx 세션키 성립 직후 PCT_app 계산 (v2 §A 파생식, QR v4 의 pairingId/hostname 사용). hello 디코드에서 `d.pct` 비교 → `onPairingConfirmed` / `onPairingConfirmFailed` 콜백 |
| `ios/Sources/Relay/RelayMessages.swift` | `SessionHelloReply` :253-258 | `d` 에 `pct: String?` (base64, per-frontend — §2.3) 추가. `DaemonKxPayload` :189-196 은 무변경 (pairingId/hostname 은 QR v4 로 이미 앱에 있음 — daemon 이 kx 로 재전송할 필요 없음) |
| `ios/Sources/Pairing/DeepLinkHandler.swift` | `ingest` 호출 :38, `TP_PAIR_OK` 방출 :40 (마커 상수 :15, 하니스 `PAIR_MARKER` `scripts/ios.sh:88`, 어서션 4개 플랫폼 사이트 :917/:1257/:1491/:1729) | 마커 의미 재앵커: decode 성공 시점에는 `TP_PAIR_PENDING`(신규), `TP_PAIR_OK` 는 promote 시점으로 이동. smoke 하니스(`scripts/ios.sh`) 마커 목록 갱신 동반 (v2 §B.6 동일 방침). **real-daemon E2E 주의 (round-3 조건 12)**: `TP_E2E_REAL`/`TP_E2E_CLAUDE` 의 M0-M2 어서션 범위에서 kx 는 out-of-scope/racy (`.claude/rules/native-testing.md` "정직한 범위 — M0-M2 만") — promote 뒤로 이동한 `TP_PAIR_OK` 를 M1 로 계속 어서션하면 real-E2E 가 결정론적으로 깨진다. **PR-4 에서 real-E2E M1 어서션을 `TP_PAIR_PENDING` 으로 교체** (ingest 성공 = 종전 M1 과 동일 의미). loopback smoke(8마커) 는 kx 가 결정론적이므로 `TP_PAIR_OK` 를 계속 어서션하되 PR-4 단계 승격 조건(kx 완료)에 맞춰 통과 |
| `ios/Sources/Nav/DaemonsTab.swift` | `handleScanned` :242-268 (ingest :252, connect :259-261) | 결과 문구를 "페어링됨" → "확인 중"으로. pending/confirming/failed 행 UI 상태 추가. `ManualPairingView` 제시부 :181-186 의 `onPaired` 콜백 → `onPending` 으로 개명 |
| `ios/Sources/Pairing/ManualPairingView.swift` | `runIngest` :150-170 (ingest :157) | 동일 — 결과 의미 변경만 |

### 1.5 Liveness 증명

**주장: QR-decode 성공에서 출발하는 모든 경로는 COMMITTED 또는 사용자 가시적 실패에 도달하며, GC 는 진짜 실패만 수거한다.**

1. **ingest 진입점은 정확히 3곳** (§4.2 전수): `DeepLinkHandler.swift:38`, `ManualPairingView.swift:157`, `DaemonsTab.swift:252`. 세 곳 모두 성공 시 post-ingest 훅(현행: `pairings.reload()` + `connect(daemonId:)` — `TeleprompterApp.swift:83-85`(smoke URL), `:119-123`(onOpenURL), `DaemonsTab.swift:259-261`, `DaemonsTab.swift:181-186`(manual))을 타며, v3 에서 이 훅이 `beginPending(pairingId:)` = RelayClient 생성으로 치환된다. → **PENDING 생성 즉시 client 존재.**
2. **앱 재기동 시**: init 루프가 committed index 와 pending index 를 모두 순회 (§1.4) → **앱이 떠 있는 동안 client 없는 PENDING 은 구조적으로 존재 불가.** (v2 의 닭-달걀은 이 열거 누락이 원인이었다.)
3. **client 가 있는 PENDING 의 모든 결말**: (a) relay 도달 불가/auth 실패 → 기존 reconnect backoff 로 재시도, UI 행 "대기 중" 가시화; (b) kx 완료 → CONFIRMING; (c) hello 수신 → §1.3 승격 판정 표 적용 — 4행 전부 COMMITTED(확인/legacy) 아니면 가시적 FAILED (pct-mismatch 또는 pct-absent+effectiveV≥3); (d) hello 유실 → on-demand hello 재요청 (기존재 경로, §1.3 표); (e) 앱 kill → 2번에 의해 재개. **모든 잎이 COMMITTED, 가시적 FAILED, 또는 가시적 재시도 중 하나다.**
4. **GC 의 수거 대상**: 24h 동안 (여러 앱 세션에 걸쳐) 한 번도 (b)~(c) 에 도달하지 못한 레코드뿐 — 즉 daemon 측 pending 이 소멸했거나(single-slot cancel, `packages/daemon/src/pairing/pairing-orchestrator.ts:159-165`) 번들이 무효인 **진짜 실패**. 정상 시도는 1~2번에 의해 24h 내에 kx 기회를 반드시 얻는다.

### 1.6 PENDING RelayClient 소유권 — 맵 키·promote/GC 재조정 (round-3 조건 6)

v3.0 은 pending client 의 컨테이너 키와 레코드↔client 수명 동기화를 미명세로 남겼다. 규칙:

- **맵 키**: 앱의 pending client 는 `pendingClients: [pairingId: RelayClient]` — **pairingId 키** (committed client 는 현행 daemonId 키 유지; §3 Option A 착지 후 pairingId 로 수렴하되 그건 PR-6 범위). daemonId 를 pending 키로 쓰면 "같은 daemon 재페어링(새 pairingId)" 이 기존 committed/pending 과 충돌한다.
- **promote 시 re-key (신규 연결 금지)**: `onPairingConfirmed(pairingId:)` → `store.promote(pairingId:)` 성공 후, **그 client 인스턴스를 그대로** pendingClients 에서 제거하고 committed 컨테이너에 daemonId 키로 이관한다. dispose 후 재연결하지 않는다 — 확인을 성립시킨 kx epoch/세션키가 살아있는 바로 그 연결이 확인의 실체다. 이관 시 같은 daemonId 의 **stale committed client 가 이미 있으면** (재페어링 시나리오: 구 페어링 레코드가 아직 안 지워진 상태) stale 쪽을 `dispose()` 하고 교체 + 구 committed 레코드 삭제(unpair 의미론, v2 §E).
- **동일 QR 이중 ingest 멱등**: `ingest` 는 pairingId 로 멱등 — 같은 QR 재스캔/딥링크 재발화 시 기존 pending 레코드를 재사용하고 **client 를 새로 만들지 않는다** (`pendingClients[pairingId]` 존재 시 no-op). 이를 어기면 같은 frontendId 의 client 2개가 각자 kx 를 돌려 daemon peers 맵을 서로 clobber 하고 (마지막 kx 만 유효 — 먼저 kx 한 쪽의 세션키는 즉시 사망) 앱 쪽 confirm 콜백이 이중 발화한다. 기존 `PairingStoreTests.testIngestIsIdempotentNoDuplicateIndex` (:83-88) 가 인덱스 멱등을 가드 — client 멱등 가드를 PR-4 테스트로 추가.
- **GC ↔ promote 창 (§6 W10)**: `gcPending(olderThan:)` 은 레코드 삭제 **전에** 해당 pairingId 의 live client 를 `dispose()` 한다 (레코드 없는 client 좀비 금지 — dispose 안 하면 backoff 재연결이 영원히 돈다). 역방향 race: GC 가 지운 직후 in-flight `onPairingConfirmed` 가 도착하면 `promote(pairingId:)` 는 pending 레코드 부재를 보고 **멱등 no-op** + 잔여 client dispose (COMMITTED 기록 없이 client 만 남는 좀비 금지). 24h GC 와 kx-직후-confirm 이 겹치는 창은 실질 0 에 가깝지만, 규칙이 없으면 창 크기와 무관하게 좀비가 논리적으로 가능하다.

---

## 2. CRITICAL-3 폐지 — per-frontend PCT 저장 (`pairing_confirmations`)

### 2.1 결함 재검증 (HEAD 직접 확인)

- pairings 테이블 PK 는 `daemon_id` (`packages/daemon/src/store/schema.ts:27`), 반면 kx 피어는 frontendId 로 키된다 (`packages/daemon/src/transport/relay-client.ts:225` `peers = new Map<string, FrontendPeer>()`, `:609-614` `peers.set(data.frontendId, ...)`). PCT 는 frontendPubKey 와 per-frontend 세션키를 바인딩하므로 (v2 §A) **frontend 수만큼 존재**한다 — 단일 `pct BLOB` 컬럼은 마지막 kx 한 frontend 의 값으로 계속 덮인다. **성립.**
- 동형 선례가 이미 코드에 자백돼 있다: label 컬럼의 N:N last-write-wins 주석 (`packages/daemon/src/transport/relay-manager.ts:253-254` — "single label row per pairing; multiple frontends rename concurrently, last-write-wins").
- reconnect 클로버 메커니즘: daemon 재시작마다 `reconnectSaved()` (`relay-manager.ts:356-384`) → `addClient()` 가 **고정 필드 목록**으로 `savePairing` 호출 (`relay-manager.ts:322-331`; round-2 인용 :284 에서 드리프트), upsert 는 `ON CONFLICT(daemon_id) DO UPDATE SET` 으로 가변 컬럼 전부를 excluded 값으로 갱신한다 (`packages/daemon/src/store/store.ts:392-402`). v2 PR-3 처럼 `pct` 를 이 목록에 넣으면 재시작 시 undefined → NULL 클로버. **성립.**
- §0.3 의 ephemeral keypair 사실이 여기에 결합된다: 단일 컬럼이면 "다른 frontend 가 덮는" 문제에 더해 "같은 frontend 도 매 reconnect 마다 값이 바뀌는" 문제까지 겹친다.

### 2.2 설계: PCT 는 pairings 테이블에 **아예 넣지 않는다**

클로버 문제의 가장 강한 해법은 보존 규칙이 아니라 **접촉면 제거**다. `pct` 는 daemon 쪽에서 신규 테이블 `pairing_confirmations` 로 완전히 분리하고, pairings 테이블과 `savePairing` upsert, `RelayClientConfig` 의 pct 관련 변경을 0 으로 만든다. (pairings 에 추가되는 것은 PCT 입력값인 `pairing_id`/`hostname` 두 컬럼뿐이며, 이들의 보존 규칙은 §4.3.)

### 2.3 DDL 및 read/write 경로

선례: `push_tokens` 테이블 (`schema.ts:48-56`) — frontend 단위 행 + `daemon_id` 컬럼, 그리고 `deletePairing` 트랜잭션에서의 cascade 삭제 (`store.ts:452-461`). 동일 패턴을 따른다.

```sql
CREATE TABLE IF NOT EXISTS pairing_confirmations (
  daemon_id    TEXT NOT NULL,   -- FK-loose, push_tokens 와 동일 방침
  frontend_id  TEXT NOT NULL,
  pct          BLOB NOT NULL,   -- 32 bytes (BLAKE2b-256, v2 §A 파생식)
  frontend_pk  BLOB NOT NULL,   -- 32 bytes — 이 pct 가 바인딩한 kx-epoch 의 frontend pubkey
  confirmed_at INTEGER NOT NULL, -- ms epoch; "최신 확인 증거" 의미론 (§0.3)
  PRIMARY KEY (daemon_id, frontend_id)
);
```

- **Write**: `relay-client.ts` `handleKxFrame` 에서 `deriveSessionKeys` 직후 (`:594-598`) daemon 측 PCT 계산 → `FrontendPeer` (:609-614) 에 `pct` 필드로 보관 + 신규 이벤트 `onPeerConfirmed(frontendId, pct, frontendPk)` 발화. `relay-manager.ts` `buildEvents` 가 이를 받아 `store.savePairingConfirmation(...)` = `INSERT OR REPLACE` (같은 (daemon_id, frontend_id) 행을 epoch 마다 overwrite — §0.3 의미론). PCT 계산 입력인 `pairingId`/`hostname` 은 `RelayClientConfig` (`relay-client.ts:141-156`) 에 두 필드 추가로 공급 (§4.3). kx-time write 는 **미승격(pending) 페어링에서도 발생**한다 — 그 잔여물 처리는 아래 Pruning 의 startup sweep 이 담당 (kx-time write 자체를 승격 뒤로 미루는 대안은 기각: write 지점이 갈라져 "확인 증거" 의미론이 승격 여부에 오염된다).
- **hello 포함 — 접근자 정정 (round-3 조건 3)**: v3.0 의 `this.clients.get(daemonId)?.peerPct(frontendId)` 스케치는 **컴파일 불가** — `RelayConnectionManager.clients` 는 Map 이 아니라 `RelayClient[]` 배열이다 (`relay-manager.ts:74`). 올바른 경로는 `buildEvents` 가 이미 받는 **`getClient()` 클로저** (`relay-manager.ts:105-109`, `onFrontendJoined` 내부 사용례 :148-150): helloMsg (`:158-162`) 에 `getClient()?.peerPct(frontendId)` (신규 `RelayClient.peerPct` — in-memory `FrontendPeer.pct` 조회, DB 왕복 없음) 를 싣는다. 이 클로저는 pairing 플로우에서 `pairing-orchestrator.ts` 의 `relayRef` 에 배선되므로 (`:83-88` `buildEvents(() => relayRef, ...)`, `:98`/`:125-127` `relayRef = client`) **kx 시점에 아직 clients 풀에 없는 PENDING client 도 해석된다** — 즉 fresh pairing 의 첫 hello 도 pct 를 싣는다. round-3 concurrency 렌즈의 "모든 fresh pairing 이 pct-less hello 를 받는다(→전량 FAILED)" 우려는 이 접근자 정정으로 성립하지 않는다.
- **hello 는 빌더가 둘이다 (round-3 조건 1 — v3.0 누락)**: auto-hello (`relay-manager.ts` `onFrontendJoined`) 외에 **`command-dispatcher.ts` `case "hello"` (`packages/daemon/src/ipc/command-dispatcher.ts:480-496`) 가 두 번째 hello 빌더**다 — 앱의 on-demand hello 요청 (`RelayMessages.swift:277-278`) 에 대한 응답으로, 현행은 `{t:"hello", v:1, d:{sessions, daemonLabel?}}` 만 싣고 pct 가 없다. 이 경로는 정확히 **§6 W5 (auto-hello 유실 복구)** 이므로, 여기만 pct 를 빠뜨리면 CONFIRMING 앱이 v≥3 daemon 에서 pct-less hello 를 받아 §1.3 규칙상 FAILED 로 오판된다. PR-3 에서 이 arm 도 같은 in-memory 소스로 pct 를 싣는다 — dispatcher 는 `relay: RelayClient` 와 `frontendId` 를 이미 파라미터로 받으므로 (`:467-471`) `relay.peerPct(frontendId)` 직접 호출로 충분 (getClient 우회 불필요). legacy pairing (pairing_id NULL) 은 두 빌더 모두 pct 생략 — 단 §4.3 백필이 기동 시 전 행을 채우므로 이 창은 "daemon 업그레이드 직후 첫 backfill 전" 뿐이며, 백필 후 v≥3 daemon 의 hello 는 항상 pct 를 싣는다 (§1.3 FAILED 셀의 전제).
- **Read**: hot path 는 in-memory 피어에서만 읽는다. DB 행은 (a) `tp pair list` 류 진단 표면에 "confirmed at" 노출 (§0.3 — "마지막 상호확인 시각" 표기, "현재 유효" 표기 금지), (b) **확인-시점 pk 포렌식** 의 근거 자료 (round-3 조건 10 정정: v3.0 의 "frontend_pk 연속성 감사" 는 공허한 목표였다 — frontend keypair 는 kx 마다 ephemeral 재생성되므로(§0.3) pk 는 재연결마다 바뀌는 게 정상이고 "연속성" 은 감사할 수 있는 성질이 아니다. 저장된 `frontend_pk` 의 실제 가치는 사후 포렌식이다: "confirmed_at 시각의 확인이 어떤 pk 에 바인딩됐나").
- **Pruning (round-3 조건 7 — v3.0 주장 정정)**: `deletePairing` 트랜잭션에 `DELETE FROM pairing_confirmations WHERE daemon_id = ?` 추가 (push_tokens cascade `store.ts:457-461` 와 병렬). **단, v3.0 의 "cascade 로 충분하며 별도 TTL 은 두지 않는다" 는 틀렸다**: pairings 행은 promote 시점에만 생기므로 (`pairing-orchestrator.ts:172-182` `promote()` 의 `savePairing`), kx 까지 갔지만 **승격되지 못한** 페어링 (앱 FAILED/취소/GC) 의 confirmation 행은 대응하는 pairings 행이 영영 없어 cascade 가 절대 발화하지 않는다. 해소: **기동 시 sweep** `DELETE FROM pairing_confirmations WHERE daemon_id NOT IN (SELECT daemon_id FROM pairings)` 를 store 초기화에 추가 (`sweepOrphanedSidecars`/push-token PURGE 와 동일한 startup self-heal 패턴, `.claude/rules/backend-services.md` 선례). sweep + cascade 조합이면 TTL 은 여전히 불요 (행 크기 32+32+16B 수준이라 sweep 주기 사이 잔류는 무해).

### 2.4 reconnect 무해성 (클로버 명시 해소)

- `pct`: pairings 테이블에 컬럼이 존재하지 않으므로 `savePairing` upsert (`store.ts:392-402`) 도, `addClient` 의 고정 필드 목록 (`relay-manager.ts:322-331`) 도 건드릴 일이 없다. **클로버 표면 자체가 소멸.**
- `pairing_confirmations` 행: reconnectSaved → 재연결 → frontend 가 다시 kx → 새 epoch 값으로 overwrite (정상 동작). daemon 재시작 직후 아직 kx 전인 구간에는 이전 epoch 행이 남아 있으나, 의미론이 "최신 확인 증거"이므로 stale 행은 무해하다 — hello 는 in-memory 피어 pct 만 싣기 때문에 stale DB 값이 wire 로 나가지 않는다.
- `pairing_id`/`hostname` 컬럼 (pairings 테이블): §4.3 보존 규칙 적용.

### 2.5 앱 쪽 single-PCT view

앱 1대 = frontendId 1개이므로 앱이 저장할 PCT 는 자신의 것 하나다. committed 레코드의 **디바이스-로컬** 메타 (UserDefaults, 비동기화) 에 `lastConfirmedPct` + `confirmedAt` 으로 보관하고 매 kx 후 hello 재검증 시 overwrite 한다. **PCT 는 절대 sync 하지 않는다** — frontendId·ephemeral keypair 에 결박된 per-device 값이라 다른 기기에서는 정의상 불일치하며, sync 하면 §3 의 어떤 옵션에서든 오탐(가짜 mismatch)을 만든다. 이 규칙은 req-3 결정(§3)과 직교하도록 격리한다.

committed 페어링의 재검증 정책은 v2 §B.5.2 를 유지하되 결과 처리만 명시: committed 상태에서 mismatch 는 "hello 복호에 성공했다 = 세션키는 일치한다"는 사실과 모순되는 신호이므로 구현 버그/입력값 드리프트(예: hostname 변경) 로 취급 — 연결은 유지하고 경고 로그 + 진단 표면 노출 (연결 차단은 round-3 이후 hardening 후보). pct 부재 + floor≥3 도 같은 보수 처리다 (§1.3 표의 hard FAILED 는 CONFIRMING 승격 게이트 한정).

round-3 조건 5·11 명시 2건: (1) 이 재검증의 PCT_app 재계산 입력 `pairingId`/`hostname` 은 **committed meta 에서** 읽는다 — 그래서 두 필드의 committed 영속이 PR-4 필수다 (§1.4; v3.0 은 이를 PENDING 레코드에만 두어 승격 후 재검증이 입력을 잃었다). 식별·비교는 **항상 pairingId** — daemonId 는 재페어링 시 같은 값으로 다른 페어링을 가리킬 수 있다. (2) 여기서의 "재검증" 은 **fresh kx 가 성립시킨 새 epoch 의 hello 를 그 epoch 의 PCT_app 과 대조**하는 것이다 — 저장된 `lastConfirmedPct` 를 저장 재료로 재파생해 검사하는 것이 아니다 (그 preimage 는 epoch 종료와 함께 소멸, §0.3 req-6 재심). 저장값의 역할은 진단 표면과 epoch 간 변화 관찰뿐.

---

## 3. CRITICAL-2 / req-3 — 페어링 iCloud sync: 두 메커니즘의 정직한 비교

### 3.1 현실 재검증 (HEAD 직접 확인)

req-3 ("기기 A 에서 페어링하면 iCloud 로 기기 B 에도 나타난다") 의 v2 전제는 **허위였음을 확인**:

- Keychain 에 `kSecAttrSynchronizable: true` 로 저장되는 것은 **32-byte pairing secret 뿐** (`ios/Sources/Pairing/PairingStore.swift:213`; 값은 :198-202 — iOS 계열 `true`, macOS 는 컴파일타임 `false`).
- daemon pubkey/relayURL/daemonId/version 메타 (:149-155) 와 열거용 index (:156-160, :164-166), label (`ios/Sources/Pairing/PairingRelayOps.swift:82, :91-99`), frontendId (:99-106) 는 전부 `UserDefaults.standard` — **비동기화**.
- `NSUbiquitousKeyValueStore` 사용처 0 (유일한 등장은 frontendId 를 KVS 로 옮기지 말라는 주석 `PairingStore.swift:97`). ubiquity 계열 entitlement 0. `keychain-access-groups` 는 macOS Release archive 전용 entitlements 에만 존재하며 (`ios/Teleprompter-macOS.entitlements`), 로컬 smoke 빌드는 `CODE_SIGN_ENTITLEMENTS=""` 로 이를 소거한다 — macOS 컴파일타임 disable (:198-199) 은 이 ad-hoc 경로의 `-34018 errSecMissingEntitlement` 회피책이다.

결과: 기기 B 에는 secret 항목이 iCloud Keychain 으로 도착해도, (a) index 가 없어 앱이 daemonId 를 열거하지 못하고, (b) meta 가 없어 `load()` 가 `.notFound` 를 던진다 (:169-179). **sync 는 현재 완전히 불활성(inert) 이다.** req-3 를 진짜로 구현하려면 "무엇을 어디에 동기화하느냐"를 새로 결정해야 한다 — 아래 두 안이 그 후보다.

### 3.2 Option A — per-pairing whole-record synced Keychain blob

**구조**: 페어링 1건 = synchronizable Keychain item 1개.

- `kSecClass = kSecClassGenericPassword`, `kSecAttrService = "dev.tpmt.app.pairing.v2"` (레거시 service 와 충돌 방지를 위한 신규 고정 service), `kSecAttrAccount = pairingId` (UUID 문자열), `kSecValueData` = JSON blob `{ ps, pk, relay, did, v, pairingId, hostname }` (~300B), `kSecAttrSynchronizable = true`, `kSecAttrAccessible = kSecAttrAccessibleAfterFirstUnlock` (현행 :220 유지).
- **열거 = Keychain 자체가 index**: `SecItemCopyMatching` + `kSecMatchLimitAll` + `kSecAttrSynchronizable = kSecAttrSynchronizableAny` 를 고정 service 에 대해 실행 → account 목록이 곧 pairingId 목록. UserDefaults index 는 **캐시로 강등** (Keychain 이 SoT, 기동 시 재조정) 하거나 제거.
- **디바이스-로컬 잔류물** (blob 에 넣지 않는 것): frontendId(절대 sync 금지 — :90-98 규칙 유지), lastConfirmedPct(§2.5), label(현행 디바이스-로컬 유지 — LWW 충돌 표면 제거), localHidden tombstone(v2 §E).

**성질 분석**:

- *충돌*: iCloud Keychain 충돌 해소는 item 단위 LWW. blob 은 commit 후 **사실상 write-once** (ps/pk/did/relay/pairingId/hostname 모두 페어링 생성 시 고정; 세션키는 kx frame 의 pubkey 로 파생되지 item 의 pk 로 재파생되지 않음 — `RelayClient.swift:784-819`) → 같은 item 을 서로 다른 값으로 쓰는 시나리오가 없어 LWW 가 무해. 서로 다른 페어링은 서로 다른 item → 두 기기가 동시에 각각 새 페어링을 만들어도 상호 소실 없음.
- *크기*: ~300B ≪ Keychain item 한계 — 무제한에 준함.
- *offline-first*: Keychain 은 로컬 우선 저장 + 백그라운드 sync. iCloud Keychain off 인 기기에서는 synchronizable item 이 로컬 전용으로 저장·조회됨 (기능은 살아 있고 sync 만 안 됨) — 실패 모드가 "조용한 로컬 전용" 으로 우아함.
- *마이그레이션 (round-3 조건 8 — 삭제 금지)*: 기동 시 1회 — 레거시 (구 service 의 secret item + defaults meta) 를 읽어 blob 생성. pairingId 없는 레거시 레코드는 §4.1 파생식으로 채움. **레거시 synchronizable secret item 은 마이그레이션 성공 후에도 삭제하지 않는다**: synchronizable item 의 삭제는 iCloud Keychain 을 타고 **peer 기기들로 전파**되는데, 아직 구버전 앱을 쓰는 peer 기기는 그 secret 으로만 페어링을 로드하므로 삭제가 도착하는 순간 그 기기의 페어링이 죽는다 — 그것도 **무음으로** (`connect(daemonId:)` 의 `guard let pairing = try? store.load(...) else { return }`, `ios/Sources/TeleprompterApp.swift:251` — 로드 실패 시 로그도 UI 도 없이 return; 앵커는 v3.1 재검증에서 :268→:251 로 드리프트 정정, 부록 A.4 조건 8 행). 레거시 item 은 **장기 deprecation 창** (최소 수 릴리즈 + 사용률 근거) 동안 보존하고, 신규 쓰기만 blob 으로 향한다. 정리는 별도 후속 결정 (본 설계 범위 밖).
- *first-unlock 전 열거 (round-3 조건 8 후반)*: `kSecAttrAccessibleAfterFirstUnlock` (:220 유지) 하에서도 **부팅 후 첫 unlock 전** 에는 `SecItemCopyMatching` 이 `errSecInteractionNotAllowed` 를 반환할 수 있다 (background launch 등). **열거 에러 ≠ 빈 집합** — 이 에러를 "페어링 0건" 으로 해석해 캐시/index 를 비우면 정상 페어링이 전멸한다. 규칙: `errSecInteractionNotAllowed` (및 일시 에러 일반) 시 기존 캐시를 유지하고, protected-data 가용 신호 (`UIApplication.protectedDataDidBecomeAvailableNotification` / `isProtectedDataAvailable`) 후 재시도한다. `errSecItemNotFound` 만이 진짜 빈 집합이다.
- *PairingStore blast radius*: persist/load/remove/daemonIds 전면 재작성 (파일 1개 내부로 국소화, 호출자 API 불변). 시그니처가 daemonId 키에서 pairingId 키로 옮겨가는 파문은 §1.4 의 loadAny 도입과 겹치므로 증분 비용은 낮음.
- *위협모델 (round-3 조건 10 스코프 정정)*: v2 §D 계승하되 주장 범위를 좁힌다 — **default relay 사용자에 한해** blob 에 pk/relay/did 를 더해도 공격면 증가가 없다 (synced secret 이 이미 루트 자격증명; iCloud Keychain 은 E2E 암호화, Apple 접근 불가). **private/self-hosted relay 사용자는 다르다**: relayURL 은 오늘 iCloud 로 sync 되지 않는 좌표이고 (secret item 에는 32B secret 뿐, meta 는 비동기화 defaults — §3.1), 사설 relay 의 URL 은 사용자의 인프라 토폴로지(내부 호스트명/tailnet 주소 등)를 드러낸다. Option A 는 이 좌표를 **처음으로 iCloud 반출 대상에 넣는 것**이 맞다 — E2E 암호화라 Apple/제3자에게는 불가시지만, "iCloud 계정 침해 = relay 좌표 노출" 이라는 신규 의존성은 생긴다. 완화: 이는 secret 자체가 이미 같은 blob 에 있으므로 한계적(marginal) 노출이며, 수용 근거를 이 스코프로 문서화한다. 오히려 "secret 만 sync 되고 meta 는 안 되는" 반쪽 상태가 사라져 일관적이라는 이점은 스코프 무관하게 유효.

### 3.3 Option B — secret-only sync 유지 + meta/index 를 별도 synced 매체로

**구조**: 현행 Keychain secret sync (:213) 은 그대로 두고, meta+index 를 (B-1) `NSUbiquitousKeyValueStore` 또는 (B-2) 단일 synchronizable Keychain "index item" (JSON 배열) 로 동기화.

**성질 분석**:

- *B-1 (KVS)*: 신규 entitlement 필요 (`com.apple.developer.ubiquity-kvstore-identifier`) — 로컬 ad-hoc smoke 경로가 entitlements 를 소거하는 현 구조 (§3.1) 와 정면 충돌해 macOS/시뮬레이터 검증 매트릭스가 갈라진다. 한도 1MB/1024 keys (충분). 충돌은 key 단위 LWW. **핵심 결함**: KVS 는 iCloud Keychain 급 E2E 암호화가 아니며 iCloud 계정 로그인+네트워크에 의존, sync 지연도 예측 불가. relayURL/daemonId/pk 는 secret 은 아니지만 사용자의 인프라 토폴로지를 드러내는 메타데이터다 — 저장 매체를 하나 더 늘리면서 보안 등급은 낮추는 방향.
- *B-2 (synced index item)*: entitlement 추가는 없지만 **단일 item = 단일 LWW 단위** — 기기 A 가 페어링 1 추가, 기기 B 가 페어링 2 추가를 겹치는 시간창에 하면 한쪽 배열이 통째로 승리하고 다른 쪽 추가분이 소실된다. req-3 의 본질("두 기기의 페어링 집합 수렴")을 정확히 충돌 지점에서 배반하는 구조라 merge 로직(읽고-합치고-쓰기 + 충돌 감지) 을 자체 구현해야 하는데, iCloud Keychain 은 충돌 알림 API 를 제공하지 않아 신뢰성 있는 merge 가 불가능하다.
- *공통*: 저장이 2계(Keychain secret + 별도 매체 meta) 로 갈라져 **부분 도착 상태** (secret 만 왔고 meta 안 옴, 또는 역) 를 앱이 영구적으로 다뤄야 한다 — §3.1 에서 확인한 현행 반쪽 상태의 문제를 구조로 승격시키는 꼴.

### 3.4 비교 요약

| 축 | A: whole-record blob | B-1: KVS meta | B-2: synced index item |
|---|---|---|---|
| 충돌 시 데이터 소실 | 없음 (item 단위, write-once) | key 단위 LWW (낮음) | **있음** (집합 전체 LWW) |
| 부분 도착 상태 | 없음 (원자적 1 item) | 상존 (2계 저장) | 상존 (2계 저장) |
| 신규 entitlement | 불필요 | **필요** (+ 하니스 충돌) | 불필요 |
| E2E 암호화 | iCloud Keychain 급 | **아님** | iCloud Keychain 급 |
| iCloud off 실패 모드 | 로컬 전용으로 동작 | meta sync 정지, 코드 경로는 상존 | 로컬 전용으로 동작 |
| PairingStore blast radius | persist 계층 재작성 (국소) | 중간 (매체 1개 추가) | 중간 + merge 로직 |
| 마이그레이션 | 1회 blob 화 | meta 이사 | index 이사 |

### 3.5 결정 — **Option A** (4축 수렴 분석 완료, ⚠️ PR-6 착수는 사용자 greenlight 필요)

**결정: Option A.** §3.2~§3.4 의 비교를 이어받아, req-3 A/B 선택을 독립적인 4개 축(keychain-mechanics·threat-and-privacy·req3-convergence·implementation-cost) 각각으로 재분석한 결과 **네 축 전부가 Option A 를 최선으로 랭크**했다 (confidence: HIGH). 이는 "권고 후 사용자 결정 대기"가 아니라 **분석이 종결된 결정**이다 — 남은 건 메커니즘 선택이 아니라 **PR-6 착수를 위한 사용자 greenlight** 하나뿐이다 (§0 상태 참조).

**왜 A 인가 (4축 수렴)**:

| 축 | 결론 | 핵심 이유 |
|---|---|---|
| keychain-mechanics | A | 필요한 프리미티브(generic-password, 고정 service, per-account 키, `kSecAttrSynchronizableAny`, AfterFirstUnlock) 가 이미 현재 코드에 증명돼 있음 — 진짜 신규 코드는 `kSecMatchLimitAll`+`kSecReturnAttributes` 열거뿐이고 그마저 리스크가 이미 §3.2 에 명세됨 |
| threat-and-privacy | A | 오늘도 이미 synced 인 secret 이 root credential 이므로 메타데이터 동반 노출은 한계적; 유일한 순수 신규 노출(사설 relay 사용자의 relayURL)도 같은 E2EE 유닛 안이라 계정 탈취 전제가 이미 secret 도 내줌 |
| req3-convergence | A | iCloud Keychain 충돌 단위 = item — per-pairing item 은 동시 추가에서 구조적으로 무손실. B-2(단일 synced index item)는 정확히 req-3 가 요구하는 동시성 지점에서 결정론적으로 데이터를 잃음 |
| implementation-cost | A | 오늘의 2계 분리(Keychain secret + UserDefaults meta/index)를 원자적 1-item 으로 접어 merge 로직이 아예 불필요; 기존 `keychainService` seam(§3.2 하단 캡션 참조)으로 CI 유닛테스트도 리팩터 없이 가능 |

**왜 B 가 아닌가**:

- **B-2 는 탈락(disqualified)**: 단일 synced index item 은 통째로 하나의 last-writer-wins 단위다. 기기 A 가 `{P1}`→`{P1,X}`, 기기 B 가 (겹치는 창에서) `{P1}`→`{P1,Y}` 로 쓰면 마지막 sync 가 이긴 쪽만 남고 다른 기기의 페어링은 영구 소실된다. iCloud Keychain 은 충돌 콜백을 제공하지 않아 신뢰성 있는 merge 자체가 불가능하다 — req-3 이 이름 붙인 바로 그 동시성 지점에서 실패한다.
- **B-1(per-pairing `NSUbiquitousKeyValueStore` 키) 은 "동시성만 놓고 보면 맞지만 전 방위로 열등(dominated)"**: KVS 는 `NSUbiquitousKeyValueStoreDidChangeExternallyNotification` 을 제공해 per-pairing 키라면 원리상 수렴 가능하다 — B-2 처럼 자동 탈락은 아니다. 그러나 (1) 신규 `com.apple.developer.ubiquity-kvstore-identifier` entitlement 가 **필수**인데, 로컬 ad-hoc smoke 하니스가 `CODE_SIGN_ENTITLEMENTS=""` 로 entitlement 를 전부 제거하는 현 구조와 정면 충돌해 macOS/Simulator 검증 매트릭스가 갈라진다; (2) KVS 는 iCloud Keychain 급 E2E 암호화가 **아니다** — 오늘의 synced secret 대비 프라이버시 등급 하락; (3) 저장이 2계(Keychain secret + KVS meta)로 다시 갈라져, Option A 가 제거하려는 바로 그 "부분 도착 반쪽 상태"를 재도입한다.

**격리 seam**: 본 결정이 v3 의 다른 부분을 저당잡지 않도록, PairingStore 의 영속 계층을 `PairingRecordStore` 내부 프로토콜(`loadAll() / save(record) / remove(pairingId)`) 뒤로 격리한다. §1 라이프사이클, §2 PCT 저장, §4 마이그레이션·PR 순서는 A/B 어느 쪽이 선택돼도 불변이며, **PR-6 하나만** 이 결정에 블록된다 (§5).

macOS 는 어느 옵션이든 v2 §D.4 의 런타임 프로브 (컴파일타임 `false` → 기동 시 `SecItemAdd` 시험 후 sync 가용성 판정) 로 전환한다 — Release archive 는 `keychain-access-groups` 를 이미 갖고 있어 (§3.1) 동작 가능성이 있고, ad-hoc smoke 는 프로브 실패 → 로컬 전용으로 자연 강등된다.

Option A 착지의 **구현 조건**은 §3.6, **PR-6 ship 전 실기 검증**은 §3.7 참조.

---

### 3.6 Option A 구현 조건 (PR-6 착수 전 만족)

4축 분석이 A 를 최선으로 판정했더라도, 그 결론은 아래 6개 구현 조건이 지켜진다는 전제 위에 서 있다 (하나라도 어기면 축별 결론이 무효화될 수 있는 항목들 — 전부 §3.2 서술과 정합, 본 절은 PR-6 체크리스트로 명문화):

1. **relayURL 프라이버시 = 스코프 명시된 수용, relay-exclusion 완화책 채택 금지.** 사설/자가호스트 relay 사용자의 relayURL 이 synced E2EE blob 에 실리는 것(§3.2 위협모델 문단)은 "문서화된 수용 트레이드오프"로 ship 한다. blob 에서 relay 를 빼는 완화책은 채택하지 않는다 — 그 완화책은 Option A 가 없애려는 바로 그 부분 도착 반쪽 상태(secret 은 오고 relay 좌표는 안 옴)를 재도입하며, 노출되는 값은 이미 root-secret 을 내주는 계정 탈취 뒤에만 열람 가능하다.
2. **열거(enumeration) 에러 처리 — `errSecItemNotFound` 만 "빈 집합".** `errSecInteractionNotAllowed`(first-unlock 이전) / `errSecMissingEntitlement` 는 기존 캐시를 유지하고 `protectedDataDidBecomeAvailable` 시점에 재시도한다 — 이 두 에러를 "페어링 0건"으로 오독하면 정상 캐시가 순간적으로 자체 소거된다. 이 규칙은 주입된 `keychainService` seam(`PairingStore.swift` 생성자의 `keychainService` 파라미터, `PairingStoreTests.swift:25` 가 이미 이 seam 을 주입해 테스트 중)을 대상으로 유닛테스트한다.
3. **마이그레이션 멱등성 + 레거시 안전.** 각 페어링을 새 고정 service(`…pairing.v2`)로 다시 쓸 때는 기존 `SecItemDelete`-then-`SecItemAdd` 오버라이트 패턴(멱등, 재실행 안전 — `PairingStore.swift:214-216` 의 `SecItemDelete(base as CFDictionary)  // idempotent overwrite` 선례와 동일 관용구)을 그대로 재사용한다. **레거시 synchronizable secret item 은 절대 `SecItemDelete` 하지 않는다** — 삭제하면 구버전 앱을 쓰는 peer 기기가 무음으로 페어링을 잃는다.
4. **blob 내용물 = 정확히 `{ps, pk, relay, did, v, pairingId, hostname}`.** `frontendId`/`lastConfirmedPct`(PCT)/`label`/`localHidden` tombstone 은 반드시 디바이스-로컬로 유지한다 (frontendId 디바이스-로컬 불변식 재확인: `PairingStore.swift:88-100` — 세션키 clobber 방지 주석 및 `frontendId()` 함수). synced frontendId 는 세션키를 clobber 하고, synced PCT 는 오탐 mismatch 를 만든다.
5. **macOS sync 게이트 — 컴파일타임 `#if os(macOS)` 를 런타임 프로브로 교체.** 현재 macOS 는 컴파일타임에 `kSecAttrSynchronizable = false` 로 고정된다 (`PairingStore.swift:213` 및 그 앞 macOS 분기). 이를 기동 시 `SecItemAdd` 시험 결과로 sync 가용성을 판정하는 런타임 프로브로 교체 — 서명된 Release/TestFlight 빌드는 sync 하고, entitlement 가 제거된 ad-hoc smoke 빌드는 `-34018`(`errSecMissingEntitlement`) 에서 로컬 전용으로 깨끗이 강등한다.
6. **`PairingRecordStore` seam 도입 + `daemonId`→`pairingId` re-key 는 PR-6 안에서.** 현재 Keychain account 키는 daemonId 다 (`PairingStore.swift:148` `keychainSet(p.pairingSecret, account: p.daemonId)`, `:175` `keychainGet(account: daemonId)`). Option A 는 account 키를 pairingId 로 옮긴다 — 이 seam·re-key 는 **PR-4 의 pairingId-capable 영속화(§1.4) 착지 이후에** PR-6 에서 도입한다 (PR-4 가 pairingId 를 스레딩하지 않으면 PR-6 이 상류를 두 번 건드리게 되는 순서 제약).

### 3.7 PR-6 ship 전 실기 검증 (2-device iCloud)

아래 4개 항목은 CI 에서 재현 불가능하다 (iCloud 계정이 없음) — 따라서 **PR-6 머지를 게이트하는 수동 실기 체크리스트**로 2대의 실제 기기(+ 서로 다른 iCloud 상태)에서 수행한다:

1. **서명된 macOS Release/TestFlight 빌드는 실제로 sync 되는가, 로컬 ad-hoc smoke 는 `-34018` 에서 로컬 전용으로 올바르게 강등되는가.** 서명 상태가 다른 두 실빌드를 각각 기기에서 구동해 확인한다.
2. **first-unlock 이전 cold-launch 열거가 `errSecInteractionNotAllowed` 를 반환하는가 (빈 집합이 아니라).** 백그라운드/cold 상태에서 `kSecAttrAccessibleAfterFirstUnlock` 하의 `SecItemCopyMatching(kSecMatchLimitAll)` 를 실기기에서 관찰하고, retry 경로가 캐시를 비우지 않고 재충전하는지 확인한다.
3. **2-device 동시-추가가 실제 iCloud 에서도 무손실로 수렴하는가 (req-3 의 핵심 증명).** 같은 sync 창(가급적 한쪽 또는 양쪽을 잠깐 오프라인 상태로) 안에서 기기 A 는 새 daemon 하나, 기기 B 는 다른 새 daemon 하나를 페어링한 뒤 **두 페어링 모두 양쪽 기기에 수렴**하는지 확인 — per-item Keychain merge 가 이론이 아니라 실제 live iCloud Keychain 에서 설계대로 동작함을 증명한다.
4. **synced-delete 전파.** 기기 A 에서 Unpair 를 수행하면 기기 B 에도 아이템 삭제가 전파되어 페어링이 사라지는지, 반대로 기기 A 에서 로컬 Remove 를 수행하면 디바이스-로컬 tombstone 만 기록되고 기기 B/daemon 은 영향받지 않는지 확인한다.

---

## 4. MAJOR 폐지

### 4.1 (a) 레거시 pairingId — UUIDv5 없이 BLAKE2b 로 결정적 파생

**전제 재검증**: UUIDv5 는 SHA-1 기반인데, 3-스택 어디에도 SHA-1/UUID 프리미티브가 없다 — `rust/tp-core/Cargo.toml` 에 uuid/sha1 crate 부재, `packages/protocol/package.json` 동일 (grep 0건). 반면 BLAKE2b-256 은 3-스택 전부에 이미 존재한다: TS `genericHash32`/`deriveBlake2b` (`packages/protocol/src/crypto.ts:212-221`), Rust `generic_hash_32` (`rust/tp-core/src/crypto.rs:37-42`), FFI 노출 (`rust/tp-core/src/lib.rs:156-158`) → Swift 에서 호출 가능. **v2 §G.3 의 UUIDv5 의존은 실현 불가가 맞다.**

**v3 파생식** (신규 프리미티브 0개):

```
digest = generic_hash_32( "tp-pairing-id-legacy\x01" || utf8(daemonId) )
raw16  = digest[0..16]
raw16[6] = (raw16[6] & 0x0F) | 0x80   // version nibble = 8 (RFC 9562 UUIDv8: custom)
raw16[8] = (raw16[8] & 0x3F) | 0x80   // variant = 10
legacyPairingId = uuid_format(raw16)   // 소문자 hex, 8-4-4-4-12
```

- 입력을 daemonId 단독으로 한다 (v2 §G.3 은 daemonId+pubkey 였음): 레거시 백필은 daemon 쪽 (pairings 행) 과 앱 쪽 (meta) 이 **서로 통신 없이 독립 수행**되는데, 양쪽 모두 항상 가진 공통 식별자는 daemonId 다 (앱 meta 의 pk 는 있으나 daemon 쪽과 byte-order/인코딩 드리프트 리스크를 추가할 이유가 없음; daemonId 는 이미 PK 로 유일성이 보장된다 — `schema.ts:27`, 생성부 `pairing-orchestrator.ts:77`).
- 레거시 hostname 은 양쪽 모두 **빈 문자열** 로 통일 (PCT 의 length-prefix 인코딩상 모호성 없음).
- 신규 페어링의 pairingId 는 v2 §C.1 대로 daemon 이 `tp pair new` 시 랜덤 UUID 생성 → QR v4 로 전달 (기존 in-memory `pp-<ts>-<rand>` 식별자 `packages/daemon/src/pairing/pending-pairing.ts:81-83` 는 CLI cancel 라우팅용으로 별개 존속 — 혼동 금지, wire 로 나가는 것은 새 UUID).
- 골든벡터: 고정 daemonId 입력 → legacyPairingId 기대값을 3-스택 테스트에 공통 수록 (기존 wire 골든벡터 패턴).

### 4.2 (b) ingest/persist 실호출부 전수 조사 → PR 매핑

v2 PR-4 는 `PairingStore`/`DeepLinkHandler` 만 나열해 나머지 호출부를 누락했다. HEAD 전수 (grep + 각 파일 직접 확인):

| # | 호출부 | 앵커 | 후속 connect 경로 | 커버 PR |
|---|---|---|---|---|
| 1 | `DeepLinkHandler.handle` | `DeepLinkHandler.swift:38` (`store.ingest`), :40 (`TP_PAIR_OK` — 이동 대상) | `TeleprompterApp.swift:83-85` (smoke URL 주입), `:119-123` (`.onOpenURL`) | PR-4 |
| 2 | `ManualPairingView.runIngest` | `ManualPairingView.swift:157` | `onPaired` 콜백 → 제시부 `DaemonsTab.swift:181-186` | PR-4 |
| 3 | `DaemonsTab.handleScanned` | `DaemonsTab.swift:252` | 동일 파일 :259-261 (`reload` + `connect`) | PR-4 |
| — | (persist 아님) `ManualPairingView.runPreview` | `ManualPairingView.swift:133-147` — `decodePairingData` FFI 직접 호출, 저장 없음 | 없음 (v4 필드 미리보기 표기만 갱신) | PR-4 |
| — | 재연결 열거 | `TeleprompterApp.swift:253` (`daemonIds()` 루프) | pending index 열거 추가 | PR-4 |

세 ingest 지점이 전부 PR-4 하나에 속하므로 "일부 지점만 신규 라이프사이클을 타는" 반쪽 상태가 존재하지 않는다.

### 4.3 (c) reconnect savePairing 컬럼 보존 규칙

pairings 테이블에 v3 가 추가하는 컬럼은 `pairing_id TEXT`, `hostname TEXT` 둘뿐 (pct 는 §2.2 로 테이블 분리). 클로버 방지는 **이중 규칙**:

1. **스레딩 (1차)**: `StoredPairing` 타입과 `RelayClientConfig` (`relay-client.ts:141-156`) 에 두 필드를 추가하고, `reconnectSaved` (`relay-manager.ts:356-384`) → `addClient` (`:278-339`) → `savePairing` (`:322-331`) 호출 사슬이 저장된 실값을 그대로 되전달한다 — label 이 이미 밟는 경로 (`config.label ?? existingLabel`, `:318-321`).
2. **upsert 방어 (2차)**: `savePairing` upsert (`store.ts:392-402`) 의 `DO UPDATE SET` 에서 두 컬럼은 `pairing_id = COALESCE(excluded.pairing_id, pairings.pairing_id)` 꼴로 기록 — 어떤 미래 호출자가 필드를 빠뜨려도 NULL 클로버가 물리적으로 불가능. (`created_at` 이 DO UPDATE SET 제외로 보존되는 기존 선례와 같은 등급의 방어. 타깃 UPDATE 선례는 `updatePairingLabel`, `store.ts:417-422`.)

마이그레이션: `PAIRINGS_MIGRATIONS` (`schema.ts:39-41`, label 선례) 에 `ALTER TABLE ... ADD COLUMN` 2건 추가 + 기동 시 `pairing_id IS NULL` 행을 §4.1 파생식으로 백필.

---

## 5. 수정 PR 플랜 (v2 §I 대체)

각 PR 은 독립 착지 가능(그린 상태 유지)하며, **PR-6 만** §3.5 사용자 결정에 블록된다.

| PR | 내용 | 파일 체크리스트 | 의존 |
|---|---|---|---|
| **PR-1** | Rust 코어: `derive_pairing_confirmation_tag` (v2 §A 식) + `derive_legacy_pairing_id` (§4.1) + QR v4 encode/decode (`FfiPairingData` 에 `pairing_id`/`hostname`) | `rust/tp-core/src/crypto.rs`, `pairing.rs` (버전 가드 :175 → v4 수용), `lib.rs` (FFI :66-84, :247-265), 골든벡터 테스트 | — |
| **PR-2** | TS 쌍둥이 + 교차 골든벡터: 같은 두 파생 함수 + QR v4 (`PAIRING_BINARY_VERSION` 4, 디코더 2/3/4 수용 `pairing.ts:260`, `MAX_PAIRING_B64_LEN` 2048 불변 :51) | `packages/protocol/src/crypto.ts`, `pairing.ts`, co-located 테스트 | PR-1 (벡터 공유) |
| **PR-3** | Daemon: `pairing_confirmations` 테이블 (§2.3 DDL) + 기동 시 orphan sweep (§2.3 Pruning) + pairings `pairing_id`/`hostname` 컬럼·백필·보존 규칙 (§4.3) + **`StoredPairing`/`parseStoredPairing` allowlist 확장 (round-3 조건 2 — 빠지면 새 컬럼이 daemon 재시작마다 로드 단계에서 strip 되어 W8 이 조용히 재발)** + `handleKxFrame` PCT 계산·`FrontendPeer.pct`·`peerPct(frontendId)` 접근자·`onPeerConfirmed` + **hello 두 빌더 모두** 에 per-frontend `pct` (auto-hello + on-demand `case "hello"`, §2.3 / round-3 조건 1) + `deletePairing` cascade + `tp pair new` 의 pairingId/hostname 생성 | `packages/daemon/src/store/schema.ts`, `store.ts` (+ co-located `store.test.ts` 에 confirmations CRUD/sweep/cascade 테스트), **`store/pairing-row-guard.ts` (:41-50, :79-115) + `pairing-row-guard.test.ts`**, `transport/relay-client.ts` (:141, :594-614), `transport/relay-manager.ts` (:148-177, :322-331, :356-384; + co-located 테스트의 hello 픽스처 갱신), **`ipc/command-dispatcher.ts` (:480-496 case "hello" — `relay.peerPct(frontendId)` 스레딩)**, `pairing/pending-pairing.ts` (:86-144 QR v4 필드), `pairing/pairing-orchestrator.ts` (:172-189 promote 에 pairingId/hostname 전달 — 현행 savePairing 필드 목록에 둘 다 부재) | PR-2 |
| **PR-4** | 앱: pending 라이프사이클 + connect-on-pending (§1) — 3개 ingest 지점 전부 (§4.2) + pending index 열거 (pairingId 키 client 맵·promote re-key·이중 ingest 멱등·GC dispose, §1.6) + **committed meta 에 `pairingId`/`hostname` 영속 (round-3 조건 5 — W7 재조정·§2.5 재검증의 비교 키)** + UI 행 상태 + 마커 재앵커(`TP_PAIR_PENDING` 신설, `TP_PAIR_OK` 이동) + smoke 하니스 갱신 + **real-E2E M1 어서션을 `TP_PAIR_PENDING` 으로 교체 (round-3 조건 12 — kx 는 M0-M2 범위 밖이라 promote-게이트 `TP_PAIR_OK` 로는 real-E2E 가 결정론적으로 깨짐)**. **PCT 검증은 아직 없음** — 이 단계의 승격 조건은 kx 완료 (레거시 의미론) 로 두어 독립 착지 | `ios/Sources/Pairing/PairingStore.swift` (+ `ios/Tests/PairingStoreTests.swift` — ingest 사이트 :48/:66/:85-86/:91 pending 반환형 전환, 마커 상수 테스트 :118, client 멱등 테스트 추가), `TeleprompterApp.swift`, `Pairing/DeepLinkHandler.swift`, `Pairing/ManualPairingView.swift`, `Nav/DaemonsTab.swift`, `scripts/ios.sh` (마커 목록 + real-E2E 어서션 사이트 :917/:1257/:1491/:1729) | PR-1 (FFI) |
| **PR-5** | 앱: PCT 검증 승격 게이트 (§1.3 승격 판정 표 전체 — pct-mismatch FAILED, **pct-absent+effectiveV≥3 FAILED 셀 포함**) — kx 후 PCT_app 계산, hello `d.pct` 비교, `onPairingConfirmed`/`onPairingConfirmFailed`, `effectiveV<3` 레거시 분기, **`minAdvertisedV` floor 영속·상승 로직 (`DaemonKxPayload.v` 최초 소비 — 현재 디코드만 되고 미사용, `RelayMessages.swift:196`)**, committed 재검증 (§2.5) + **`scripts/local-relay-loopback.ts` 의 kx `v:2` 하드코드 (:120, :131) 를 v:3 + hello pct 로 갱신 (round-3 조건 12 — 안 하면 PCT-confirm 경로의 결정론적 CI 커버리지가 0: loopback 이 유일한 deterministic 파이프라인인데 영원히 레거시 분기만 탄다)** | `ios/Sources/Relay/RelayClient.swift` (:743-763, :775-849, :972-984), `Relay/RelayMessages.swift` (:253-258), `TeleprompterApp.swift` (콜백 배선), `scripts/local-relay-loopback.ts` | PR-3, PR-4 |
| **PR-6** | ⚠️ **req-3 저장 전환** (§3 결정 필요): `PairingRecordStore` seam 도입 → Option A(권고) blob 전환 + 레거시 마이그레이션 + macOS 런타임 프로브 | `ios/Sources/Pairing/PairingStore.swift` (영속 계층), 마이그레이션 테스트 | PR-4; **사용자 결정** |
| **PR-7** | Unpair vs "이 기기에서만 제거" 구분 (v2 §E 승계 — localHidden tombstone, pairingId 키) | `ios/Sources/Nav/DaemonsTab.swift` (:32, :214, :317), `Pairing/PairingRelayOps.swift`, `PairingStore.swift` | PR-4 |
| **PR-8** | 버전 게이트·문서: `WS_PROTOCOL_VERSION` 2→3 (`packages/protocol/src/compat.ts:43`; daemon kx 광고 `relay-client.ts:561`, 앱 수신 `RelayMessages.swift:196`) + CLAUDE.md/ARCHITECTURE/`.claude/rules/protocol.md` 갱신 | 상기 + 문서 | PR-5 |

버전 게이트 의미론 (v2 §G 승계): hello 의 `pct` 필드는 additive-optional 이므로 구 앱은 무시하고, 구 daemon 은 안 보낸다 — 강한 게이트는 필요 없고 §1.3 승격 판정 표 (`effectiveV` + floor) 가 유일한 판별 지점이다.

**`tp pair new --qr-v3` 탈출구 — 폐기 결정 (round-3 조건 9).** round-3 이 입증한 대로 이 해치는 스케치대로면 **결정론적으로 브릭**된다: 신 daemon 은 `tp pair new` 시 생성한 랜덤 UUID pairingId 로 PCT 를 계산하는데, v3 QR 에는 pairingId 필드가 없어 앱은 §4.1 레거시 파생(daemonId 기반 UUIDv8)으로 폴백 → 양측 PCT 입력이 영구 불일치 → 모든 kx epoch 에서 mismatch → FAILED 무한 루프 (재시도로 절대 탈출 불가). "pct 억제" 변형(해치로 만든 페어링은 daemon 이 pct 를 안 싣게)은 브릭은 피하지만 per-pairing suppress 상태가 상태기계·hello 두 빌더·floor 로직 전부를 오염시키고, §1.3 의 "v≥3 인데 pct 부재 = FAILED" 규칙에 정당한 예외를 뚫어 다운그레이드 방어를 약화시킨다. **결정: 해치를 만들지 않는다.** 근거: 구 앱 × 신 daemon 칸은 "QR v4 디코드 거부 (버전 가드 `pairing.ts:260`, `pairing.rs:175`) → 가시적 에러 → 앱 업데이트 안내" 로 이미 명시적 실패이며 (§7 L6 의 "조용한 실패 금지" 를 충족), 앱은 ADR-0001 재작성으로 설치 기반이 사실상 0 인 pre-release 라 구 앱 호환 창의 실수요가 없다 (v2 §G.2 "persist-at-scan fallback 금지" 원칙 유지).

---

## 6. 실패-창(failure-window) 표 (v2 §B.7 대체 — 신규 라이프사이클 기준)

| # | 창(window) | 장애 | 도달 상태 | 복구 경로 |
|---|---|---|---|---|
| W1 | QR decode | 형식 오류/버전 미지원 | 레코드 없음, `TP_PAIR_FAIL` + alert | 재스캔 |
| W2 | PENDING 기록 직후 앱 kill | client 미생성 상태로 종료 | PENDING 영속 | 재기동 시 pending index 열거 → client 재생성 (§1.5-2) |
| W3 | PENDING + relay 도달 불가 / auth 실패 | 연결 실패 | PENDING 유지, UI "대기 중" | 기존 reconnect backoff; 24h 내 미복구 시 GC (진짜 실패) |
| W4 | PENDING + daemon pending 소멸 (`tp pair new` 취소/재시작 — daemon pending 은 메모리 전용 single-slot) | kx 무응답 | PENDING 유지, UI "대기 중" | 24h GC; 사용자 수동 취소 가능 (가시적) |
| W5 | kx 완료 후 hello 유실 | CONFIRMING 정체 | in-memory 대기 | on-demand hello 재요청 (기존 경로, `RelayMessages.swift:277-278`) — **이 응답의 빌더는 `command-dispatcher.ts` `case "hello"` (:480-496) 이므로 그 arm 의 pct 스레딩 (PR-3, §2.3) 이 이 창의 복구 전제** (round-3 조건 1: 안 하면 복구 hello 가 pct-less 로 도착해 §1.3 규칙상 FAILED 오판); 앱 kill 시 W2 로 환원 (새 kx epoch 로 재확인) |
| W6 | hello.pct 불일치 | 확인 실패 | FAILED (가시적) + client teardown | 재시도 = 새 kx epoch; daemon 쪽에는 kx 시점에 이미 `pairing_confirmations` 행이 쓰였을 수 있으나 무해 (§2.4 — 다음 kx 가 overwrite, unpair 시 cascade 삭제; **영영 승격 안 되는 페어링의 잔여 행은 기동 시 sweep 이 수거**, §2.3 Pruning) |
| W7 | promote 도중 kill (committed 기록 후, pending 삭제 전) | 양쪽 레코드 공존 | COMMITTED + 잔여 PENDING | promote 멱등 규칙: 기동 시 **pairingId 비교** (committed meta 에 PR-4 부터 영속 — round-3 조건 5; daemonId 비교 금지, 재페어링 시 같은 daemonId 의 살아있는 pending 을 오삭) 로 양쪽에 있으면 committed 우선, pending 삭제 (§1.4 `promote` 명세) |
| W8 | committed 후 daemon 재시작 | 세션키 소멸 → 재kx | COMMITTED 유지 | reconnectSaved → 재kx (새 ephemeral keypair, `RelayClient.swift:804`) → 새 PCT 양측 overwrite → hello 재검증; mismatch 는 경고-only (§2.5) |
| W9 | committed 후 앱 삭제/기기 추가 (req-3) | 레코드 부재 | Option A: blob sync 도착 → 새 기기가 자체 frontendId 로 첫 kx (§3.2) | 새 kx = 새 per-frontend 확인 행 — 기존 기기 행과 충돌 없음 (§2.3 PK) |
| W10 | 24h GC 와 in-flight confirm 의 교차 (round-3 조건 6) | GC 가 pending 레코드 삭제 vs 직후 `onPairingConfirmed` 도착 | 순간적 client-without-record | 규칙 2개 (§1.6): GC 는 레코드 삭제 **전에** 그 pairingId 의 live client 를 dispose; 역순이면 `promote(pairingId:)` 가 레코드 부재를 보고 멱등 no-op + 잔여 client dispose — 어느 순서든 좀비 (COMMITTED 기록 없는 상시 재연결 client) 불가 |

v2 §B.7 의 나머지 행 (secret 유출 등 위협 시나리오) 은 라이프사이클 무관이므로 v2 참조로 유지.

---

## 7. 검증 렌즈와 반증 조건 (round-3 실행 완료)

> **상태**: round-3 은 아래 렌즈로 실행 완료 — verdict **PASS_WITH_CONDITIONS** (CRITICAL 0, 조건 12건 → §0.4 매핑대로 v3.1 에 반영). 어떤 렌즈에서도 재설계급 반증은 나오지 않았다 (L1 은 §2.3 접근자 정정으로, L6 은 §5 해치 폐기 결정으로 조건부 통과). 표는 **구현 후 검증(post-implementation) 체크리스트**로 존속한다 — 각 PR 리뷰와 최종 round-4 스팟체크가 같은 반증 조건을 코드에 대입한다.

| 렌즈 | 재실행할 검증 | 이 설계가 **반증되는** 조건 |
|---|---|---|
| L1 라이프사이클 도달성 | §1.5 증명을 HEAD 콜그래프로 재추적 (ingest 3지점 + 재기동 열거 + client 결말 전수) | client 없는 PENDING 이 존재 가능한 경로 발견, 또는 COMMITTED/가시적-실패 어느 쪽에도 닿지 않는 잎 발견 |
| L2 N:N/멀티디바이스 | 기기 2대 × daemon 재시작 × 동시 페어링/unpair 시나리오 표 대입 (§2, §6 W8-W9) | 한 frontend 의 확인 상태가 다른 frontend 의 kx 나 daemon 재시작으로 소실/오염되는 시퀀스 발견 |
| L3 저장 매체 사실성 | §3 의 API 전제 실증: `kSecMatchLimitAll`+`kSecAttrSynchronizableAny` 열거가 synchronizable item 을 실기에서 반환하는지, macOS 프로브 동작, iCloud off 동작 | 열거 불능, 미문서화 entitlement 요구, 또는 write-once 가정을 깨는 blob 변이 필드 발견 |
| L4 byte-exactness | PCT·legacyPairingId 골든벡터를 TS/Rust/Swift 세 구현에 교차 대입 (§4.1) | 스택 간 1바이트라도 불일치 (특히 length-prefix·UUID 포맷·hostname 빈 문자열 처리) |
| L5 아키텍처 불변식 | relay 가 여전히 ciphertext-only/stateless 인지 (pct 는 hello 평문이 아니라 E2EE 프레임 내부 필드), capacity bar 영향 0 인지 | relay 코드 변경 필요성 발견, 또는 relay 가 pct 를 관찰 가능한 경로 발견 |
| L6 마이그레이션 매트릭스 | {구 QR, 신 QR} × {구 daemon, 신 daemon} × {구 앱, 신 앱} 8칸 전수 — 각 칸에서 페어링 성립/실패가 명시적인지 | 어느 칸이든 조용한 실패(무한 대기·무마커) 또는 데이터 소실 발견 |
| L7 PR 착지성 | PR-1~8 각각을 단독 merge 한 상태의 그린 여부 (특히 PR-4 의 "PCT 없는 pending 승격" 중간 상태) | 어떤 PR 이 후속 PR 없이는 기존 동작을 퇴행시키는 경우 |

---

## 부록 A — 사실 확인 원장 (v3, HEAD `ae3a54b` 직접 열람)

### A.1 확인된 핵심 사실 (발췌)

| 사실 | 앵커 |
|---|---|
| connect 는 committed 로드에 가드, 실패 시 무음 return | `TeleprompterApp.swift:250-251` (v3.1 재검증, 부록 A.4 조건 8 행) |
| 재연결 루프는 committed index 만 열거 | `TeleprompterApp.swift:253`, `PairingStore.swift:164-166` |
| secret 만 synchronizable; meta/index 는 defaults | `PairingStore.swift:213, :149-160` |
| macOS sync 컴파일타임 false | `PairingStore.swift:198-202` |
| pairings PK = daemon_id | `schema.ts:27` |
| kx 피어는 frontendId 키 | `relay-client.ts:225, :609-614` |
| label 의 N:N LWW 자백 주석 | `relay-manager.ts:253-254` |
| reconnect → addClient → savePairing 고정 필드 | `relay-manager.ts:356-384, :322-331` |
| upsert DO UPDATE SET 전 컬럼 갱신 (created_at 제외) | `store.ts:392-402` |
| ingest 실호출부 3곳 | `DeepLinkHandler.swift:38`, `ManualPairingView.swift:157`, `DaemonsTab.swift:252` |
| BLAKE2b-256 3-스택 존재, UUIDv5/SHA-1 부재 | `crypto.ts:212-221`, `crypto.rs:37-42`, `lib.rs:156-158`; deps grep 0건 |
| frontend kx keypair 는 ephemeral (매 kx 재생성) | `RelayClient.swift:746, :804` |
| auto-hello 는 join 마다 발행 | `relay-manager.ts:148-177` |
| `WS_PROTOCOL_VERSION` = 2 | `compat.ts:43` |
| QR 디코더 v2/v3 수용, 초과 버전 거부 | `pairing.ts:260`, `pairing.rs:175` |
| daemon pending 은 메모리 전용 single-slot | `pairing-orchestrator.ts:36-38, :134`; `pending-pairing.ts:66-84` |

### A.2 round-2 인용의 라인 드리프트 (실질 주장은 전부 유효)

- `TeleprompterApp.swift:261/:246` → round-3 시점 `:267-268/:253` → **v3.1 재검증 시점 `:250-251/:253`** (상류 편집 누적 드리프트; connect 함수 :250, silent guard :251, RelayClient 생성 :253). **경로도 정정**: `ios/Sources/App/TeleprompterApp.swift` 가 아니라 `ios/Sources/TeleprompterApp.swift`. (앵커는 상류 편집마다 밀리므로 구현 시 file:line 을 재확인 — SoT 는 심볼명 `connect(daemonId:)` + guard 문.)
- `relay-manager.ts:284` (savePairing) → 실제 `:322-331` (addClient 내부).
- `PairingStore.swift:149-166` (meta/index) → 실제 meta `:149-155`, index `:156-160`, 열거 `:164-166`.

### A.3 v2 서술 중 v3 가 정정/강화한 것

- v2 §C.2 "pct 는 null 이면 재계산" → **불충분**: ephemeral keypair (§0.3) 로 인해 stored PCT 는 매 kx stale — "최신 확인 증거 + confirmed_at" 의미론으로 교체 (§2.3).
- v2 §G.3 UUIDv5 마이그레이션 → **실현 불가 확인** (§4.1) — BLAKE2b/UUIDv8 파생으로 교체, 입력도 daemonId 단독으로 단순화.
- v2 §I PR-3 "pairings 에 pct BLOB" → 테이블 분리로 **클로버 표면 자체 제거** (§2.2, §2.4).

### A.4 round-3 조건 앵커 재검증 원장 (v3.1, HEAD `ae3a54b` ≡ origin/main `b79b157` 직접 열람)

round-3 조건 12건의 file:line 주장을 조건문을 신뢰하지 않고 전부 워킹트리에서 직접 재확인했다. **12건 전부 실코드와 일치** — 설계를 실코드가 아닌 조건문 쪽에 맞춰야 했던 항목은 0건. 정밀도 노트:

| 조건 앵커 | 재검증 결과 |
|---|---|
| 조건 1: `command-dispatcher.ts` case "hello" ~:479-494 | 확인 — switch :479, `case "hello":` :480, reply 빌드 :487-494 (블록 종료 :496). `{v:1, d:{sessions, daemonLabel?}}`, pct 없음. dispatcher 는 `relay`/`frontendId` 를 파라미터로 이미 수령 (:467-471) |
| 조건 2: `pairing-row-guard.ts` allowlist | 확인 — `StoredPairing` :41-50 (8필드), `parseStoredPairing` :79-115 필드별 재구성; `loadPairings` 가 :437 에서 이 가드로 narrow. co-located `pairing-row-guard.test.ts` 존재 |
| 조건 3: `clients` 는 Map 아님 | 확인 — `private readonly clients: RelayClient[] = []` (`relay-manager.ts:74`). `getClient()` 클로저 경로 (:105-109, :148-150) + `relayRef` 배선 (`pairing-orchestrator.ts:83-88, :98, :125-127`) 도 확인 — PENDING client 해석됨 |
| 조건 4: kx replay 체크 부재 | 확인 — 앱 `onKeyExchangeFrame` (`RelayClient.swift:775-824`), daemon `handleKxFrame` (`relay-client.ts:572-647`) 양쪽 모두 nonce/freshness 없음. **추가 발견**: 앱은 `DaemonKxPayload.v` 를 디코드만 하고 (`RelayMessages.swift:196`) 소비처가 전무 (RelayClient.swift 전수 grep 0건) — §1.3 floor 는 기존 로직 수정이 아니라 **최초 소비자 신설**이다 |
| 조건 5: committed meta = pk/relay/did/v | 확인 — `PairingStore.swift:149-155` (persist), :169-179 (load). `pairingId`/`hostname` 부재 |
| 조건 7: cascade 는 promote 된 행만 | 확인 — `deletePairing` (`store.ts:452-461`) 은 pairings 행 기준; pairings 행은 `promote()` (`pairing-orchestrator.ts:172-182`) 에서만 생성 |
| 조건 8: `TeleprompterApp.swift:268` silent guard | **v3.1 재검증(§3.5 4축 분석 시점)에서 추가 드리프트 발견**: `connect(daemonId:)` 는 이제 :250, `guard let pairing = try? store.load(...) else { return }` 은 이제 :251 (17줄 shift, round-3 이후 상류 편집). §3.6/§3.7 및 caveats 는 `:251` 로 갱신 인용 |
| 조건 10c: resume fast-path | 확인 — `relay-client.ts:404-409` (`msg.resumed && this.peers.size > 0` 시 re-broadcast 스킵), peers 보존 주석 :114-118 |
| 조건 12: loopback v:2 하드코드 | 확인 — `scripts/local-relay-loopback.ts:120, :131`. `TP_PAIR_OK` 상수 `DeepLinkHandler.swift:15`, 하니스 `PAIR_MARKER` `scripts/ios.sh:88` + 어서션 4사이트 :917/:1257/:1491/:1729; real-E2E 정직 범위 M0-M2 는 `.claude/rules/native-testing.md` 명문 |
| (환경) worktree HEAD | `ae3a54b` — 태스크가 지칭한 origin/main `b79b157` 과 **트리 바이트 동일** (`git diff` 공집합; b79b157 = 동일 CI 수정의 squash) |

