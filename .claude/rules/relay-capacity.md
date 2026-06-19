---
paths:
  - "packages/relay/**"
---

# Relay Capacity Target

**Always design and tune for ~10k concurrent connections (daemon + app combined) on a single relay node.** This is the standing capacity bar — every relay change must preserve it.

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
- **`/health` + `/metrics` 는 capacity 모니터링의 SoT.** `/health` JSON 필드: `status` ("ok"), `buildSha` (compile-time git SHA, `TP_BUILD_SHA` define; `"unknown"` for local/uninstrumented builds), `buildTime` (ISO timestamp, `TP_BUILD_TIME` define; `"unknown"` for local builds), `protocolVersion` (2), `clients`, `pendingAuth`, `daemons`, `sessions`, `attached`, `uptime`, `metrics` (object). `framesIn`, `framesOut`, `rateLimitedDrops`, `daemonRateLimitedDrops`, `backpressureDisconnects`, `authTimeouts`, `oversizedDrops`, `unknownTypeDrops`, `evictions`, `resumesAttempted` / `resumesAccepted` / `resumesRejected` counter를 since-last-restart로 노출. Tuning 변경은 이 counter 추이로 검증. `resumesRejected`가 갑자기 튀면 secret 회전이나 token 만료 정책을 의심. `unknownTypeDrops`가 튀면 적대적/구버전 peer가 malformed frame을 보내고 있다는 신호 (wire guard `parseRelayClientMessage`가 zero-truth 경계에서 거부한 횟수). `buildSha`는 deploy pipeline이 `/health.buildSha == github.sha`를 assert해 stale 바이너리를 조기에 잡는다 (`deploy-relay.yml` "Verify deployed build is live" step). `/metrics` 는 Prometheus text v0.0.4 (`Content-Type: text/plain; version=0.0.4`) — **정확히 17 라인** (`relay_clients`…`relay_resumes_rejected` + `relay_uptime_seconds`) `\n` join + trailing `\n`. (Rust 포트 `tp-relay` 의 12 카운터는 `Arc<Metrics>` 로 RelayCore lock 밖 lock-free atomics; `build.rs` 가 `TP_BUILD_SHA`(env→`git rev-parse --short HEAD`→`unknown`)/`TP_BUILD_TIME` 을 컴파일타임 주입.)
- **`/admin` 은 bearer 게이트 필수 (Rust 포트 재설계).** TS 레퍼런스 relay 의 `/admin` 대시보드는 현재 무인증 노출 (보안 wart). **Rust 포트(`tp-relay`)는 이를 닫았다**: `TP_RELAY_ADMIN_TOKEN` 미설정이면 `/admin` 은 **404 (closed by default — 무인증 대시보드를 절대 서빙하지 않음)**, 설정 시 `Authorization: Bearer <token>` 일치를 요구 (부재/불일치 → 401, `subtle::ConstantTimeEq` constant-time 비교). daemon id + 각 session id 는 stored-XSS 방어로 HTML-escape. TS 무인증 `/admin` 경로에 의존하는 운영 자동화 금지 — Rust cutover 전에 토큰을 발급/배포할 것.
- **OS-level**: `LimitNOFILE` 200000 권장 (systemd unit). `relay-harden.sh`의 hashlimit 규칙은 그대로 유효 (per-IP `connlimit` 없음 — CGNAT 사용자 보호).

## Scale-out (10k → 100k+)

10k는 단일 노드 상한 근처. 그 이상 가야 할 때:
- **Sticky routing + 작은 KV** 가 first choice — daemonId 기반 consistent-hash LB로 daemon + 그 daemon의 모든 frontend가 같은 노드에 붙음. Token registry만 Redis/Postgres로 옮기고, frame fan-out은 backplane 없이 in-process 유지. Frame path latency 영향 0.
- **Full Redis pub/sub backplane 비추** — frame fan-out에 매번 pub/sub hop이 끼면 latency + Redis 부하가 단일 노드 이득보다 큼. Stateless ciphertext invariant도 약해짐.
- HTTP/3 / QUIC connection migration은 RN/Bun client 측 미성숙으로 현재 비현실. roadmap watch만.
