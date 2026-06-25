---
paths:
  - "packages/relay/**"
---

# Relay Capacity Target

**Always design and tune for ~10k concurrent connections (daemon + app combined) on a single relay node.** This is the standing capacity bar — every relay change must preserve it.

## Rust relay binary (`tp-relay`, ADR-0003 Stage 1 Step 8a)

`rust/tp-relay` 는 `[[bin]] tp-relay`(`src/main.rs`) 를 갖는다 — THIN 바이너리로 listen 포트와 SIGINT/SIGTERM graceful drain 만 결정하고, 아래 모든 knob 은 `SharedState::from_env()`(+ lazy push-sealer) 가 env 에서 읽는다.

```bash
export PATH="$(dirname "$(rustup which cargo)"):$PATH"   # rustup shim 우회 (machine-portable)
cargo build --release --bin tp-relay        # rust/ 에서
./target/release/tp-relay --port 7090       # 또는 RELAY_PORT=7090 (flag wins)
```

포트 우선순위: `--port` > `RELAY_PORT` env > 기본 `7090`. 시작 로그 `tp-relay listening on 0.0.0.0:<port> (buildSha=<sha>)`. 로컬 검증 게이트 = `bun run scripts/rust-relay-e2e.ts` (격리 tp daemon → Rust relay register + frontend-auth ok, production 무변경; 상세는 `rust/README.md`). 8b deploy 는 `x86_64-unknown-linux-gnu` cross-compile + systemd `ExecStart=/usr/local/bin/tp-relay`(별도 바이너리, `tp relay start` 아님). 아래 env 표가 두 구현(TS·Rust) 공통 SoT.

## Single-node knobs (already wired in `packages/relay/src/relay-server.ts`)

| Knob | Default | Env | 의미 |
|------|---------|-----|------|
| `cacheSize` | 10 | `TP_RELAY_CACHE_SIZE` | sid당 최근 frame 개수 (replay) |
| `maxFrameSize` | 1 MB | `TP_RELAY_MAX_FRAME_SIZE` | 단일 frame 최대 크기 (oversize → close) |
| `ratePerClient` | 500/sec | `TP_RELAY_RATE_PER_CLIENT` | per-socket sliding window |
| `ratePerDaemon` | 5000/sec | `TP_RELAY_RATE_PER_DAEMON` | daemon group 전체 budget (daemon + 모든 frontend 합) |
| `backpressureBytes` | 4 MB | `TP_RELAY_BACKPRESSURE_BYTES` | `ws.bufferedAmount` 임계 — 초과 시 disconnect (1013) |
| `authTimeoutMs` | 10 s | `TP_RELAY_AUTH_TIMEOUT_MS` | 인증 안 한 socket close (slowloris 방어) |
| `idleTimeout` | 90 s | (코드 상수) | Bun WS idleTimeout. daemon ping 30s → 3 missed = close |
| `resumeSecret` | random/ephemeral | `TP_RELAY_RESUME_SECRET` | HMAC key for `relay.auth.resume` tokens. ≥32 chars. 미설정 시 프로세스 시작마다 새로 생성 — 재시작 시 모든 client는 full auth로 폴백. Production은 반드시 고정값 설정. |
| `resumeTtlMs` | 1 h | `TP_RELAY_RESUME_TTL_MS` | resume token 유효기간. 만료 시 client는 full auth로 폴백. |
| `pushSealSecret` | random/ephemeral | `TP_RELAY_PUSH_SEAL_SECRET` | HMAC/AEAD key for sealing APNs device tokens (PushSealer). ≥32 chars. 미설정 시 ephemeral (프로세스 재시작 = 모든 sealed token 무효화). Production은 반드시 고정값 설정. 회전 시 `TP_RELAY_PUSH_SEAL_SECRET_PREV`에 이전 값 유지. |
| `apnsKey` | (none) | `APNS_KEY` | APNs HTTP/2 인증용 ES256 P-256 private key. `.p8` 파일 경로 또는 PEM 문자열. |
| `apnsKeyId` | (none) | `APNS_KEY_ID` | APNs Key ID (10자 대문자). Apple Developer Console에서 발급. |
| `apnsTeamId` | (none) | `APNS_TEAM_ID` | Apple Team ID (10자 대문자). |
| `apnsBundleId` | (none) | `APNS_BUNDLE_ID` | APNs topic (app bundle ID, e.g. `dev.tpmt.teleprompter`). |
| `apnsEnv` | `"sandbox"` | `APNS_ENV` | APNs 환경: `"sandbox"` (개발) 또는 `"prod"` (배포). **per-deployment, not on wire.** |
| `pushSealSecretPrev` | (none) | `TP_RELAY_PUSH_SEAL_SECRET_PREV` | 이전 push seal key (회전 오버랩용). 설정 시 unseal 시도 순서: 현재 키 → 이전 키. 회전 완료 후 제거. |
| `pushSealVersion` | 1 | `TP_RELAY_PUSH_SEAL_VERSION` | sealed blob에 삽입되는 version 숫자 (positive integer). Key rotation 추적용. |

**Push seal key 회전 절차 (one-step only):** unseal 윈도우는 `version`(현재) 과 `version-1`(prev) 두 단계뿐이다. 회전 시 반드시 `TP_RELAY_PUSH_SEAL_VERSION` 을 **정확히 +1** 하고 직전 secret 을 `TP_RELAY_PUSH_SEAL_SECRET_PREV` 로 옮긴다. 버전을 건너뛰면(예: 1→3) 기존 v1/v2 sealed token 이 전부 고아가 되어 즉시 `PUSH_UNSEAL_FAILED` 가 되고, 영향받은 frontend 는 다음 relay 재연결 때 re-register(`relay.push.register`) 로만 복구된다. `PREV` 는 outstanding sealed token 이 모두 새 키로 재등록될 때까지(= 모든 daemon 이 재연결로 fresh `relay.push.token` 을 받을 때까지) 유지.

**Dead APNs token eviction:** APNs가 HTTP 400 `BadDeviceToken` 또는 410 `Unregistered` 를 반환하면 relay는 daemon에 `relay.err { e: "PUSH_TOKEN_DEAD" }` 를 전송한다. Daemon은 이를 받아 `handleTokenDead(frontendId)` → store의 push_token 행 삭제. Frontend가 앱 재설치 또는 재연결 시 새 `relay.push.register`로 재등록한다. APNs JWT 토큰(`ApnsJwtSigner`)은 50분마다 자동 갱신된다.

## Capacity invariants

- **Application-level rate limiting은 두 레이어**: per-client + per-daemon-group. 한 client만 미친듯이 보내거나 한 daemon group이 통째로 폭주하는 두 케이스 모두 차단.
- **Slow consumer는 disconnect (drop이 아니라 close 1013).** Frontend는 reconnect 시 `relay.sub after=...`로 cached frame replay 받음. Frame drop은 sequence gap을 만들어 protocol invariant를 깨므로 금지.
- **Idle close는 traffic이 전혀 없을 때만.** daemon ping (30s 간격)이나 사용자 활동이 있으면 절대 close되지 않는다. idle timeout은 dead TCP를 빨리 청소해서 fd/메모리 누수를 막는 안전망일 뿐.
- **Per-daemon 메모리는 상한이 있어야 한다.** `DaemonState.sessions` Set 은 `MAX_SESSIONS_PER_DAEMON` (256) 으로 캡 — sid 는 매 `relay.pub` 마다 추가되지만 online 동안 자연 만료가 없어 캡 없이는 무한 증가 (presence broadcast 마다 full Set 직렬화). 캡 초과 시 oldest sid drop (insertion-order); routing 은 `recentFrames`/live subscription 으로 하므로 영향 없음. **`lastSeen` refresh 는 daemon 자기 트래픽만** (handlePing/handlePublish 둘 다 role=daemon gate) — frontend 가 죽은 daemon 으로 계속 publish 해도 offline-eviction clock 을 리셋하지 못하게 해 dead DaemonState/recentFrames 누수 차단.
- **Pre-auth 소켓은 CPU 를 못 쓰게 한다.** `relay.ping` 은 rate-limit 면제이지만 그 면제는 인증된 client 에만 — 미인증 소켓의 ping 은 pong 없이 무시 (auth-timeout 창 안에서의 unauthenticated CPU amplifier 차단). registrations 의 proof sentinel 은 `""` 아닌 `null` — 빈 문자열은 진짜 `proof=""` 와 충돌해 different-credentials guard 우회 가능.
- **Relay 가 identity authority — wire-supplied identity 를 절대 신뢰하지 않는다.** `handlePushRegister` 는 `relay.push.token` 을 **인증된 `client.frontendId`** 로 라우팅한다 (wire 의 `msg.frontendId` 아님). msg 값을 믿으면 한 daemon group 안의 인증된 frontend 가 victim 의 frontendId 로 자기 APNs 토큰을 등록해 victim 의 push 를 가로챌 수 있다 (cross-frontend push-token hijack — sealed credential 오배송). honest client 는 `msg.frontendId == client.frontendId` 라 무변경. 회귀 가드: `relay-server.test.ts` "routes under AUTHENTICATED frontendId".
- **Auth 거부 path 는 소켓을 close 한다 (neither-map 누수 금지).** `handleAuth` 는 `role=frontend && !frontendId` 거부 시 `relay.auth.err` 송신 후 `ws.close(1008)` — `clearPendingAuth` 가 이미 pendingAuth 에서 뺐고 `this.clients` 엔 등록 전이라, close 없으면 소켓이 양쪽 map 어디에도 없이 90s idle-timeout 까지 떠 있고 `relay_pending_auth`/`relay_clients` 에도 안 잡힌다 (fd 누수 + 모니터링 사각). 회귀 가드: `relay-server.test.ts` "rejected AND closed (no neither-map socket leak)".
- **Push dedup/rate-limit 은 reserve-before-await.** `PushService.sendOrDeliver` 는 dedup `dedupSeen.set` + rate `rl.count++` 을 await 전에 동기적으로 reserve 하고 실패 path(apnsClient 부재·dead_token·error·throw)에서 `rollbackReservation()` 로 되돌린다. await 후에 commit 하면 같은 key 의 동시 호출 N개가 같은 pre-commit 스냅샷을 읽어 전부 통과 → per-(sid,event) dedup 와 per-minute cap 이 동시성 하에서 깨진다 (hook event 는 별도 WS 콜백이라 정상 부하에서 발생). 성공 path 는 rollback 안 함. 회귀 가드: `push.test.ts` "concurrency" describe.
- **APNs 요청은 deadline 이 있다.** `ApnsClient.send` 의 fetch 는 `AbortController`(`requestTimeoutMs`, 기본 10s)로 bound — APNs delivery 는 relay 에서 fire-and-forget(`handlePush .catch()`)이라 timeout 없으면 partition 시 각 push 가 HTTP/2 stream + Promise 를 OS TCP keepalive(분~시간)까지 잡아 10k 규모에서 fd/async-task 누수가 된다. 기존 catch 가 AbortError 를 `{ok:false, deadToken:false}` (transient, dead-token 아님)로 변환. 회귀 가드: `apns.test.ts` "request timeout".
- **`/health` + `/metrics` 는 capacity 모니터링의 SoT.** `/health` JSON 필드: `status` ("ok"), `buildSha` (compile-time git SHA, `TP_BUILD_SHA` define; `"unknown"` for local/uninstrumented builds), `buildTime` (ISO timestamp, `TP_BUILD_TIME` define; `"unknown"` for local builds), `protocolVersion` (2), `clients`, `pendingAuth`, `daemons`, `sessions`, `attached`, `uptime`, `metrics` (object). `framesIn`, `framesOut`, `rateLimitedDrops`, `daemonRateLimitedDrops`, `backpressureDisconnects`, `authTimeouts`, `oversizedDrops`, `unknownTypeDrops`, `evictions`, `resumesAttempted` / `resumesAccepted` / `resumesRejected` counter를 since-last-restart로 노출. Tuning 변경은 이 counter 추이로 검증. `resumesRejected`가 갑자기 튀면 secret 회전이나 token 만료 정책을 의심. `unknownTypeDrops`가 튀면 적대적/구버전 peer가 malformed frame을 보내고 있다는 신호 (wire guard `parseRelayClientMessage`가 zero-truth 경계에서 거부한 횟수). `buildSha`는 deploy pipeline이 `/health.buildSha == github.sha`를 assert해 stale 바이너리를 조기에 잡는다 (`deploy-relay.yml` "Verify deployed build is live" step). `/metrics` 는 Prometheus text v0.0.4 (`Content-Type: text/plain; version=0.0.4`) — **정확히 17 라인** (`relay_clients`…`relay_resumes_rejected` + `relay_uptime_seconds`) `\n` join + trailing `\n`. (Rust 포트 `tp-relay` 의 12 카운터는 `Arc<Metrics>` 로 RelayCore lock 밖 lock-free atomics; `build.rs` 가 `TP_BUILD_SHA`(env→`git rev-parse --short HEAD`→`unknown`)/`TP_BUILD_TIME` 을 컴파일타임 주입.)
- **`/admin` 은 bearer 게이트 필수 (두 구현 모두 적용됨).** **TS 레퍼런스 relay 와 Rust 포트(`tp-relay`) 모두** `TP_RELAY_ADMIN_TOKEN` 미설정이면 `/admin` 은 **404 (closed by default — 무인증 대시보드를 절대 서빙하지 않음)**, 설정 시 `Authorization: Bearer <token>` 일치를 요구 (부재/불일치 → 401, constant-time 비교 — TS: `timingSafeEqual`, Rust: `subtle::ConstantTimeEq`). daemon id + 각 session id 는 stored-XSS 방어로 HTML-escape. `/admin` 경로에 의존하는 운영 자동화는 반드시 `TP_RELAY_ADMIN_TOKEN` 을 설정하고 `Authorization: Bearer` 헤더를 포함해야 한다.
- **OS-level**: `LimitNOFILE` 200000 권장 (systemd unit). `relay-harden.sh`의 hashlimit 규칙은 그대로 유효 (per-IP `connlimit` 없음 — CGNAT 사용자 보호).

## Soak harness — the 10k capacity gate (ADR-0003 §6.9)

`rust/tp-relay/tests/soak_10k.rs` 가 **capacity gate** 의 SoT 다. Stage-1 Rust 재설계가 standing ~10k concurrent bar 를 낮추지 않음을 증명한다 (parity gate 아님 — 골든벡터가 byte-parity 담당). **ONE 파라미터화 하니스**: connection 수 + duration 을 env 로 받아 같은 코드 경로를 heavy(local)/light(CI) 두 tier 로 굴린다. `#[ignore]` 이라 일반 `cargo test --workspace` 는 절대 수천 소켓을 열지 않는다.

| Env | 기본 | 의미 |
|-----|------|------|
| `TP_SOAK_CONNS` | `10_000` | dimension 당 frontend conn 수 (heavy=10k, CI light=1500) |
| `TP_SOAK_SECS` | `60` | dimension 당 soft wall-clock 예산 (CI light=20) |
| `TP_SOAK_JSON` | (off) | `=1` 이면 마지막 줄에 single-line JSON 요약 emit (`scripts/soak.ts` 정직성 미러) |

**세 부하 차원 (각각 명확한 sub-phase):**
1. **PUB FAN-OUT** — daemon 1 + frontend N 이 모두 같은 sid 구독, daemon 이 M frame publish → 모든 frontend 가 M 전부 수신(0 drop) 어서션. 잘 drain 하는 well-behaved consumer 는 1013 backpressure close 당하면 안 됨. `/metrics framesOut` 이 fan-out 반영. **rate-knob 주의 (ADR caveat (b)):** daemon-publish fan-out 은 per-daemon-group GCRA(`rate_per_daemon`, 기본 5000/s)로 체크되므로 10k-wide publish burst 가 group limiter 를 trip 할 수 있다 — 이 phase 는 `SharedState` tweak 으로 `rate_per_client`/`rate_per_daemon` 을 effectively-unbounded 로 올려 *fan-out delivery* 만 격리 측정한다(rate-limit 자체는 `rate_limit_drops_frame_without_closing` 통합테스트가 담당). `outbox_cap` 도 frame 수에 맞춰 키워 well-behaved consumer 의 일시적 scheduling hiccup 을 slow-consumer 로 오인하지 않게 한다.
2. **RESUME STORM** — N conn auth → 각 `auth.ok` 의 resumeToken 캡처 → 소켓 drop → 재연결 → `relay.auth.resume {token}` → ~100% `resumed:true` 어서션 (daemon 은 storm 내내 online 유지). `relay_resumes_rejected == 0`.
3. **PUSH UNDER LOAD** — WS Push 는 no-op(conn.rs)이라 `PushService` API 레벨에서 구동. fake `TransportDyn`(HTTP 200) + 실 `ApnsSigner`(런타임 생성 p256 PKCS#8)로 Step 6(dedup+rate-limit commit-on-success)까지 도달 → 동시성 하 dedup/rate-limit guard mutex 가 leak/deadlock 없이 직렬화됨을 증명. **honest scope**: 네트워크/APNs 테스트 아님; concurrency 하 guard 정확성 검증.

**불변식 프로브:** fan-out 후 `/health.status == "ok"`, `relay_backpressure_disconnects == 0`(well-behaved consumer), `framesOut >= conns×frames`. HARD failure(프레임 못 받음 / resume reject / push leak)에서만 non-zero exit.

```bash
# heavy = local (full 10k, on-demand). 먼저 ulimit 올린다.
ulimit -n 65535
export PATH="$(dirname "$(rustup which cargo)"):$PATH"   # rustup shim 우회
cd rust && TP_SOAK_CONNS=10000 TP_SOAK_SECS=60 \
  cargo test -p tp-relay --test soak_10k -- --ignored --nocapture

# light = CI gate (.github/workflows/ci.yml rust job, normal test 뒤 step):
#   ulimit -n 65535; TP_SOAK_CONNS=1500 TP_SOAK_SECS=20 cargo test -p tp-relay \
#     --test soak_10k -- --ignored --nocapture
```

`rust` job 은 required check 아님 — flaky soak 이 무관한 PR 을 막지 않지만, relay capacity 경로를 건드리는 PR 에선 반드시 green.

## Scale-out (10k → 100k+)

10k는 단일 노드 상한 근처. 그 이상 가야 할 때:
- **Sticky routing + 작은 KV** 가 first choice — daemonId 기반 consistent-hash LB로 daemon + 그 daemon의 모든 frontend가 같은 노드에 붙음. Token registry만 Redis/Postgres로 옮기고, frame fan-out은 backplane 없이 in-process 유지. Frame path latency 영향 0.
- **Full Redis pub/sub backplane 비추** — frame fan-out에 매번 pub/sub hop이 끼면 latency + Redis 부하가 단일 노드 이득보다 큼. Stateless ciphertext invariant도 약해짐.
- HTTP/3 / QUIC connection migration은 RN/Bun client 측 미성숙으로 현재 비현실. roadmap watch만.
