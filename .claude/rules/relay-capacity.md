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

## Capacity invariants

- **Application-level rate limiting은 두 레이어**: per-client + per-daemon-group. 한 client만 미친듯이 보내거나 한 daemon group이 통째로 폭주하는 두 케이스 모두 차단.
- **Slow consumer는 disconnect (drop이 아니라 close 1013).** Frontend는 reconnect 시 `relay.sub after=...`로 cached frame replay 받음. Frame drop은 sequence gap을 만들어 protocol invariant를 깨므로 금지.
- **Idle close는 traffic이 전혀 없을 때만.** daemon ping (30s 간격)이나 사용자 활동이 있으면 절대 close되지 않는다. idle timeout은 dead TCP를 빨리 청소해서 fd/메모리 누수를 막는 안전망일 뿐.
- **`/health` + `/metrics` 는 capacity 모니터링의 SoT.** `framesIn`, `framesOut`, `rateLimitedDrops`, `daemonRateLimitedDrops`, `backpressureDisconnects`, `authTimeouts`, `oversizedDrops`, `unknownTypeDrops`, `evictions`, `resumesAttempted` / `resumesAccepted` / `resumesRejected` counter를 since-last-restart로 노출. Tuning 변경은 이 counter 추이로 검증. `resumesRejected`가 갑자기 튀면 secret 회전이나 token 만료 정책을 의심. `unknownTypeDrops`가 튀면 적대적/구버전 peer가 malformed frame을 보내고 있다는 신호 (wire guard `parseRelayClientMessage`가 zero-trust 경계에서 거부한 횟수).
- **OS-level**: `LimitNOFILE` 200000 권장 (systemd unit). `relay-harden.sh`의 hashlimit 규칙은 그대로 유효 (per-IP `connlimit` 없음 — CGNAT 사용자 보호).

## Scale-out (10k → 100k+)

10k는 단일 노드 상한 근처. 그 이상 가야 할 때:
- **Sticky routing + 작은 KV** 가 first choice — daemonId 기반 consistent-hash LB로 daemon + 그 daemon의 모든 frontend가 같은 노드에 붙음. Token registry만 Redis/Postgres로 옮기고, frame fan-out은 backplane 없이 in-process 유지. Frame path latency 영향 0.
- **Full Redis pub/sub backplane 비추** — frame fan-out에 매번 pub/sub hop이 끼면 latency + Redis 부하가 단일 노드 이득보다 큼. Stateless ciphertext invariant도 약해짐.
- HTTP/3 / QUIC connection migration은 RN/Bun client 측 미성숙으로 현재 비현실. roadmap watch만.
