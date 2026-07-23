---
paths:
  - "rust/tp-relay/**"
---

# Relay Capacity Target

**Always design and tune for ~10k concurrent connections (daemon + app combined) on a single relay node.** This is the standing capacity bar — every relay change must preserve it.

## Rust relay binary (`tp-relay`, ADR-0003 Stage 1 Step 8a)

`rust/tp-relay` is the **only** relay implementation — it has `[[bin]] tp-relay`(`src/main.rs`) as a THIN binary that only decides the listen port and SIGINT/SIGTERM graceful drain; every knob below is read from the environment by `SharedState::from_env()` (+ the lazily-initialised push sealer).

```bash
export PATH="$(dirname "$(rustup which cargo)"):$PATH"   # bypass the rustup shim (machine-portable)
cargo build --release --bin tp-relay        # from rust/
./target/release/tp-relay --port 7090       # or RELAY_PORT=7090 (flag wins)
```

Port precedence: `--port` > `RELAY_PORT` env > default `7090`. Startup log: `tp-relay listening on 0.0.0.0:<port> (buildSha=<sha>)`. Local verification gate = `cargo test -p tp-relay` (loopback integration) + `TP_E2E_REAL=1 scripts/ios.sh smoke` (full-path real-daemon pairing through the relay; see `rust/README.md`). The 8b deploy is a `x86_64-unknown-linux-gnu` cross-compile + systemd `ExecStart=/usr/local/bin/tp-relay` (a standalone binary, not `tp relay start`). The env table below is the SoT.

## Single-node knobs (wired in `rust/tp-relay` `SharedState::from_env()`)

| Knob | Default | Env | 의미 |
|------|---------|-----|------|
| `cacheSize` | 10 | `TP_RELAY_CACHE_SIZE` | sid당 최근 frame 개수 (replay) |
| `maxFrameSize` | 1 MiB | `TP_RELAY_MAX_FRAME_SIZE` | 단일 frame 최대 크기 (oversize → close 1009) |
| `ratePerClient` | 500/sec | `TP_RELAY_RATE_PER_CLIENT` | per-socket sliding window (GCRA) |
| `ratePerDaemon` | 5000/sec | `TP_RELAY_RATE_PER_DAEMON` | daemon group 전체 budget (daemon + 모든 frontend 합) |
| `outboxCap` | 512 messages | *(compile-time constant, no env)* | conn당 bounded outbox(`mpsc::channel`) capacity — write task 가 못 따라가 채널이 차면 `try_send` 가 `Full` 반환, 그 conn 을 1013 로 close. `DEFAULT_OUTBOX_CAP`(`server.rs`), env override 없음 — TS 레퍼런스는 `ws.bufferedAmount`(byte 임계)로 measure 했지만 Rust 포트는 **message-count 기반 bounded channel** 로 재설계했다. |
| `authTimeoutMs` | 10 s | *(compile-time constant, no env)* | 인증 안 한 socket close (slowloris 방어). `AUTH_TIMEOUT_MS`(`conn.rs`) — env override 없음. |
| `maxRegistrations` | 50000 | `TP_RELAY_MAX_REGISTRATIONS` | 보유 가능한 distinct daemon 등록 수 상한. 초과 시 *신규* daemonId 의 `relay.register` 는 `relay.register.err` (기존 daemonId rotate 는 허용). proof 가 암호학적으로 검증되지 않고 register-without-auth 항목은 어떤 reclaim 경로도 안 거치므로 cap 없이는 무한 증가. |
| `maxPreauthMsgs` | 30 | `TP_RELAY_MAX_PREAUTH_MSGS` | 미인증 socket 이 close 전 보낼 수 있는 최대 메시지 수. rate-limiter 가 인증 client 에만 적용되므로 pre-auth socket 의 유일한 throttle. 정상 핸드셰이크는 ≤2 프레임이라 여유. |
| `maxRecentFrameKeysPerDaemon` | 256 | `TP_RELAY_MAX_RECENT_FRAME_KEYS` | daemon 당 `recentFrames` sid-key 상한 (`MAX_SESSIONS_PER_DAEMON` 미러). 초과 시 oldest sid-key evict. recentFrames 는 daemon/frontend publish 둘 다로 seed 되고 evictDaemon(~1h offline)에서만 reclaim 되므로 cap 없이는 online 동안 무한 증가. |
| `idleTimeout` | 90 s | *(compile-time constant, no env)* | `WS_IDLE_TIMEOUT_S`(`server.rs`). conn 의 read loop 가 `tokio::time::Interval` 을 매 inbound frame 마다 `reset()` — 그 interval 이 먼저 tick 하면(= 90s 동안 아무 프레임도 안 옴) 소켓을 close. daemon ping(30s 간격)이 살아있으면 절대 안 tick. env override 없음. |
| `resumeSecret` | random/ephemeral | `TP_RELAY_RESUME_SECRET` | HMAC key for `relay.auth.resume` tokens (`ResumeTokenSigner`, BLAKE2b-keyed). ≥32 chars. 미설정 시 프로세스 시작마다 새로 생성 — 재시작 시 모든 client는 full auth로 폴백. Production은 반드시 고정값 설정. |
| `resumeTtlMs` | 1 h | *(compile-time constant, no env)* | resume token 유효기간. `DEFAULT_TTL_MS`(`resume_token.rs`) — **env override 없음** (`ResumeTokenSigner::from_env()` 이 `ttl_ms` 를 항상 `DEFAULT_TTL_MS` 로 고정; `ttl_ms` 를 바꾸는 유일한 길은 `ResumeTokenSigner::new(secret, Some(ttl_ms))` 직접 호출뿐이고 `from_env()`/`tp-relay` 바이너리는 그 경로를 안 씀). 만료 시 client는 full auth로 폴백. |
| `pushSealSecret` | random/ephemeral | `TP_RELAY_PUSH_SEAL_SECRET` | HMAC/AEAD key for sealing APNs device tokens (`PushSealer`). ≥32 chars. 미설정 시 ephemeral (프로세스 재시작 = 모든 sealed token 무효화). Production은 반드시 고정값 설정. 회전 시 `TP_RELAY_PUSH_SEAL_SECRET_PREV`에 이전 값 유지. |
| `apnsKey` | (none) | `APNS_KEY` | APNs HTTP/2 인증용 ES256 P-256 private key. `.p8` 파일 경로 또는 PEM 문자열. |
| `apnsKeyId` | (none) | `APNS_KEY_ID` | APNs Key ID (10자 대문자). Apple Developer Console에서 발급. |
| `apnsTeamId` | (none) | `APNS_TEAM_ID` | Apple Team ID (10자 대문자). |
| `apnsBundleId` | (none) | `APNS_BUNDLE_ID` | APNs topic (app bundle ID, e.g. `dev.tpmt.app`). |
| `apnsEnv` | **prod** (미설정 시) | `APNS_ENV` | APNs 환경. `"sandbox"` (case-insensitive) 일 때만 `api.sandbox.push.apple.com`; **미설정 포함 그 외 모든 값은 production `api.push.apple.com`** (`resolve_apns_host`, `apns.rs`; 회귀 가드 있음). dev 빌드/E2E 에서 sandbox APNs 를 원하면 반드시 명시 설정 — 미설정이 sandbox 라고 가정하지 말 것. **per-deployment, not on wire.** |
| `apnsMaxRetries` | 3 | `APNS_MAX_RETRIES` | APNs 전송 재시도 횟수 (`ApnsClientConfig::from_env`, `apns.rs`). |
| `apnsRetryBaseMs` | 500 ms | `APNS_RETRY_BASE_MS` | 재시도 backoff base. |
| `apnsRequestTimeoutMs` | 10000 ms | `APNS_REQUEST_TIMEOUT_MS` | 단일 APNs HTTP/2 요청 데드라인 (`0` = 비활성). 상세는 아래 "APNs 요청은 deadline 이 있다" 불변식 참조. |
| `pushSealSecretPrev` | (none) | `TP_RELAY_PUSH_SEAL_SECRET_PREV` | 이전 push seal key (회전 오버랩용). 설정 시 unseal 시도 순서: 현재 키 → 이전 키. 회전 완료 후 제거. |
| `pushSealVersion` | 1 | `TP_RELAY_PUSH_SEAL_VERSION` | sealed blob에 삽입되는 version 숫자 (positive integer). Key rotation 추적용. |
| `adminToken` | (none) | `TP_RELAY_ADMIN_TOKEN` | `/admin` 대시보드 bearer 게이트. 미설정 시 `/admin` 은 404 (closed by default). |

**Push seal key 회전 절차 (one-step only):** unseal 윈도우는 `version`(현재) 과 `version-1`(prev) 두 단계뿐이다. 회전 시 반드시 `TP_RELAY_PUSH_SEAL_VERSION` 을 **정확히 +1** 하고 직전 secret 을 `TP_RELAY_PUSH_SEAL_SECRET_PREV` 로 옮긴다. 버전을 건너뛰면(예: 1→3) 기존 v1/v2 sealed token 이 전부 고아가 되어 즉시 `PUSH_UNSEAL_FAILED` 가 되고, 영향받은 frontend 는 다음 relay 재연결 때 re-register(`relay.push.register`) 로만 복구된다. `PREV` 는 outstanding sealed token 이 모두 새 키로 재등록될 때까지(= 모든 daemon 이 재연결로 fresh `relay.push.token` 을 받을 때까지) 유지.

**Dead APNs token eviction — daemon-side eviction is NOT wired today (honest gap).** APNs가 HTTP 400 `BadDeviceToken` 또는 410 `Unregistered` 를 반환하면 relay(`conn.rs` `map_delivery_result`)는 daemon에 `relay.err { e: "PUSH_TOKEN_DEAD", m: "APNs device token is dead for frontendId <fid>" }` 를 전송한다(unseal 실패의 `PUSH_UNSEAL_FAILED` 도 동일 shape). **그러나 이 relay.err 프레임의 `RelayErr` wire struct(`messages.rs`)는 `e`/`m` 두 필드뿐 — `frontendId` 가 구조화 필드로 없다** (`fid` 는 `m` 의 사람이 읽는 문자열 안에만 박혀 있다). daemon 측 `RelayClient::handle_relay_err`(`rust/tp-daemon/src/transport/relay_client.rs`)는 `PUSH_UNSEAL_FAILED`/`PUSH_TOKEN_DEAD` 둘 다 **eviction 을 수행하지 않는다** — 코드 주석 그대로: "no eviction (no frontendId on this frame); app re-registers on next relay reconnect." 즉 daemon 은 dead token 을 store 에서 지우지 못하고, 매 notify-eligible hook event 마다 실패할 push 를 계속 재전송하다가 **frontend 가 다음 relay 재연결 시 `relay.push.register` 로 재등록**해야 self-heal 된다 (TS 레퍼런스 시절의 "legacy relay" 폴백 브랜치와 동일 동작이 지금은 **상시** 경로). Frontend 가 앱 재설치 또는 재연결 시에도 새 `relay.push.register`로 재등록한다. APNs JWT 토큰(`ApnsJwtSigner`)은 50분마다 자동 갱신된다. **결정론적 회귀 가드는 relay 송신측에만 있다** (`RelayErr` 가 `PUSH_TOKEN_DEAD`/`PUSH_UNSEAL_FAILED` 를 올바른 daemon conn 으로 보내는지 — `conn.rs` `map_delivery_result_errors_reply_to_daemon`); daemon 측 eviction 로직 자체가 no-op 이므로 그걸 검증하는 daemon-side 테스트는 존재하지 않는다(무엇을 재구현할지 결정 전까지는 정직하게 "미구현"으로 남겨둔다).

## Capacity invariants

- **Application-level rate limiting은 두 레이어**: per-client + per-daemon-group. 한 client만 미친듯이 보내거나 한 daemon group이 통째로 폭주하는 두 케이스 모두 차단. **`relay.push` 도 이 두 레이어를 통과해야 한다.** `tp-relay`(`conn.rs handle_push`)는 `relay.push` 를 `dispatch_locked` *앞*(`handle_inbound` 인터셉트)에서 가로채 async APNs 전송을 `tokio::spawn` 하므로, 명시적 게이트가 없으면 push 만 2-layer GCRA 를 우회한다 — authed daemon 이 `relay.push` 를 무한정 쏴 각각 동시성·rate 캡 0 의 APNs HTTP/2 task 를 spawn(메모리/fd/H2-stream exhaustion, 10k 규모). 그래서 `handle_push` 맨 앞에서 spawn *전* per-client → per-daemon GCRA 를 `dispatch_locked` 와 동일 순서·metric(`rate_limited_drops`/`daemon_rate_limited_drops`)·`RATE_LIMITED` 메시지로 체크하고, 초과 시 reply 후 no-spawn return. (`push.rs` 의 per-`daemonId:frontendId` dedup/rate-limit 는 spawn *후* 실행되고 frontend 단위라 daemon 의 aggregate spawn rate 를 못 막는다 — 이건 보완재가 아니라 별개 레이어.) 회귀 가드: `conn.rs` `push_over_per_client_rate_limit_is_dropped_before_spawn` (source-only revert → push 가 no-op 로 빠져 RATE_LIMITED reply 부재로 test fail = genuine 입증).
- **Slow consumer는 disconnect (drop이 아니라 close 1013).** Frontend는 reconnect 시 `relay.sub after=...`로 cached frame replay 받음. Frame drop은 sequence gap을 만들어 protocol invariant를 깨므로 금지. conn 당 bounded outbox(`mpsc::channel`, capacity=`outboxCap`=512)에 write task 가 못 따라가면 `try_send` 가 `Full` 을 반환하고 그 conn 을 1013 로 close. **close-code 전달은 결정론적이어야 한다.** out-of-band close(`close_conn` — backpressure 1013 / forced 1008·1009)는 close-frame 을 write task 에 cap-4 `close_rx` 로 신호한다 — `try_send` 면 `Full` 시 close-code 를 조용히 삼켜(slow consumer 가 90s idle-timeout 까지 잔존 + 1013 대신 idle close 로 오집계) 자기-close 경로(`connection_loop`)의 `send().await` 와 비대칭이 된다. `close_conn` 은 이미 `async` 이고 handle 은 이미 `core.conns` 에서 제거된 뒤라 at-most-one-slot send → 즉시 resolve(또는 write task 종료 시 `Closed` harmless)이므로 `send().await` 로 통일(`conn.rs` `close_conn`).
- **Idle close는 traffic이 전혀 없을 때만.** daemon ping (30s 간격)이나 사용자 활동이 있으면 절대 close되지 않는다. read loop 가 `tokio::time::Interval`(`WS_IDLE_TIMEOUT_S`=90s)을 매 inbound frame 마다 `reset()` — idle timeout은 dead TCP를 빨리 청소해서 fd/메모리 누수를 막는 안전망일 뿐.
- **Per-daemon 메모리는 상한이 있어야 한다.** `DaemonState.sessions` Set 은 `MAX_SESSIONS_PER_DAEMON` (256, `registry.rs`) 으로 캡 — sid 는 매 `relay.pub` 마다 추가되지만 online 동안 자연 만료가 없어 캡 없이는 무한 증가 (presence broadcast 마다 full Set 직렬화). 캡 초과 시 oldest sid drop (insertion-order); routing 은 `recentFrames`/live subscription 으로 하므로 영향 없음. **`lastSeen` refresh 는 daemon 자기 트래픽만** (`route_publish`/`route_ping` 둘 다 `client.role == Role::Daemon` gate, `server.rs`) — frontend 가 죽은 daemon 으로 계속 publish 해도 offline-eviction clock 을 리셋하지 못하게 해 dead DaemonState/recentFrames 누수 차단. 회귀 가드: `server.rs` `publish_daemon_role_tracks_session_and_lastseen` + `publish_frontend_role_does_not_track_session_or_lastseen`.
- **per-daemon-group GCRA limiter 의 라이프사이클 = 그룹과 함께 (no leak, no doubling).** `group_limiters: HashMap<daemonId, Arc<Limiter>>` (`server.rs`) 는 daemon + 그 frontend 들이 공유하는 단일 limiter 다 (`rate_per_daemon`, 기본 5000/s). 생성은 `group_limiter_for` 의 `or_insert_with` (authed attach). **제거는 두 경로에서 대칭이어야 한다**: (1) `stale_sweep` evicted-loop (`conn.rs`) 는 그룹이 **비었을 때만** 제거 — frontend 는 daemon eviction(~1h offline) 후에도 생존할 수 있고(eviction 은 presence 만 broadcast, group conn 을 close 하지 않음) 자기 `Arc` clone 을 쥔다. evict 시 무조건 제거하면, daemon 이 재등록할 때 `or_insert_with` 가 **두 번째 limiter** 를 만들어 survivor=구 limiter / daemon=신 limiter 로 per-daemon 그룹 예산이 2배가 된다 → 그래서 `if !core.groups.contains_key(daemon_id)` 가드로 그룹이 살아있으면 retain(재등록이 같은 Arc 재사용). (2) `remove_from_group` (`server.rs`) 의 group-empties 분기가 last-leaver cleanup — evicted daemon 의 `daemon_states` 는 이미 사라져(`evict_daemon`) 향후 sweep 이 그 daemonId 를 영영 못 보므로, retain 한 limiter 는 마지막 frontend 가 떠날 때 여기서 떨궈야 한다(안 그러면 ≤1h bounded retention 이 **영구 leak** 으로 악화). `Arc` 라 map strong-ref 제거는 live conn 에 안전(use-after-free 불가). 회귀 가드: `server.rs` `last_group_member_close_drops_the_group_limiter` + `conn.rs` `eviction_retains_group_limiter_while_a_frontend_remains` (각각 해당 source-only revert → fail 로 genuine 입증; 두 가드는 상호 격리 — 한쪽 revert 시 다른 쪽은 green 유지).
- **Pre-auth 소켓은 CPU 를 못 쓰게 한다.** `relay.ping` 은 rate-limit 면제이지만 그 면제는 인증된 client 에만 — 미인증 소켓의 ping 은 pong 없이 무시 (auth-timeout 창 안에서의 unauthenticated CPU amplifier 차단). registrations 의 proof sentinel 은 `""` 아닌 `null` — 빈 문자열은 진짜 `proof=""` 와 충돌해 different-credentials guard 우회 가능.
- **Relay 가 identity authority — wire-supplied identity 를 절대 신뢰하지 않는다.** `route_push_register`(`conn.rs`)는 `relay.push.token` 을 **인증된 `client.frontend_id`** 로 라우팅한다 (wire 의 `frontend_id` 필드는 명시적으로 버려진다 — 바인딩 `_` 로 "trust the wire value" 아님을 문서화). msg 값을 믿으면 한 daemon group 안의 인증된 frontend 가 victim 의 frontendId 로 자기 APNs 토큰을 등록해 victim 의 push 를 가로챌 수 있다 (cross-frontend push-token hijack — sealed credential 오배송). honest client 는 wire 값이 이미 `client.frontend_id` 와 같아 무변경. 회귀 가드: `conn.rs` `push_register_routes_under_authed_identity_not_wire_frontend_id`.
- **Auth 거부 path 는 소켓을 close 한다 (neither-map 누수 금지).** `finish_auth`(`conn.rs`)는 `role=Frontend && frontend_id.is_none()` 거부 시 `relay.auth.err` 송신 후 `Action::Close(1008, "frontendId required")` 를 reply **뒤에** push 한다(in-order: Send→Close) — conn 은 group 에 등록된 적이 없으므로(`auth` 필드가 계속 `None`), close 가 없으면 10s `AUTH_TIMEOUT_MS` 백스톱까지 `relay_pending_auth`/`relay_clients` 어느 카운터에도 안 잡히고 떠 있어(fd 누수 + 모니터링 사각) 자원을 묶는다. reject 즉시 close 해 fd 를 바로 회수한다. **invalid-token reject 는 일부러 close 안 함**(TS 레퍼런스 `relay-server.ts:937` 의 "return without close" 를 미러 — honest client 의 resume 재시도 여지, auth-deadline 이 처리). 회귀 가드: `conn.rs` `frontend_auth_without_frontend_id_is_rejected_and_closed` + `invalid_token_auth_does_not_force_close` (source-only revert → positive test fail 로 genuine 입증).
- **In-band push 전달은 APNs 설정과 독립이다.** `relay.push` 의 "ws" leg(타깃 frontend 가 소켓에 live → APNs 대신 `relay.notification` in-band)는 PushService/APNs 자격증명 없이 동작해야 한다. `tp-relay` 는 `push_service == None`(`APNS_*` unset) 일 때 `handle_push` 의 None arm 이 `is_frontend_connected` 면 `DeliveryResult::Ws` 매핑으로 in-band 전달을 직접 수행하고 **offline leg 만** clean silent no-op 로 남긴다. None 을 `?` 로 early-return 하면 APNs-less relay(모든 로컬/E2E relay + push 미설정 self-host)에서 라이브 frontend 의 모든 in-band 알림이 조용히 사라진다 — #41 PR2b 의 `TP_E2E_PUSH` 라이브 게이트가 실측으로 잡은 파리티 버그(당시 TS 레퍼런스는 PushService 를 무조건 만들고 "ws" verdict 가 APNs 없이도 동작했다). 회귀 가드: `conn.rs` `push_without_apns_delivers_in_band_when_frontend_connected` + `push_without_apns_is_noop_when_frontend_offline`.
- **Push dedup/rate-limit 은 "guard-check → await → commit-on-success" — TS 의 "reserve-then-rollback" 과 설계가 다르다(의도적 재설계, parity 주장 아님).** `PushService::send_or_deliver`(`push.rs`) 는 dedup/rate-limit 가드를 **await 전** 짧은 lock 안에서 체크만 하고(기록은 안 함), lock 을 놓은 뒤 APNs 를 await 하고, **성공했을 때만** 다시 lock 을 잡아 dedup timestamp 기록 + rate count 증가를 commit 한다. 실패(APNs error/dead-token)면 아무것도 기록되지 않아 다음 시도가 정상 진행된다(`no_dedup_after_failed_push` 로 검증). **알려진 잔여 레이스 (미해결, 코드 주석에 명시)**: rate-limit 의 "check-then-act" 는 guard-check 시점과 commit 시점 사이에 동시 요청이 끼면 카운트가 밀릴 수 있는 residual race 가 있고, 소스 주석 그대로 "closing the residual check-then-act race here is decision-gated ... intentionally left to a human design pass" — TS 레퍼런스의 reserve-before-await(요청 시점에 즉시 예약, 실패 시 rollback) 와는 다른 trade-off 다. 회귀 가드: `push.rs` `dedup_only_after_successful_push` + `no_dedup_after_failed_push`(성공/실패 각각의 commit 시점 검증) — 동시성 하 rate-limit 정확성 자체를 겨냥한 stress 테스트는 아직 없다(정직한 gap).
- **APNs 요청은 deadline 이 있다 — headers 뿐 아니라 response BODY read 까지 커버.** `apns.rs` `ApnsClient::send`(`send_once` 호출)는 `self.transport.post_dyn(req)` await 를 `tokio::time::timeout(request_timeout_ms, …)`(env `APNS_REQUEST_TIMEOUT_MS`, 기본 10000ms, `0`=비활성) 로 감싼다 — 이 timeout 은 HTTP transport 호출 전체(헤더+본문 read 포함)를 덮는다. `push.rs`(`conn.rs` `handle_push` 의 `tokio::spawn`)가 `send_or_deliver` 를 fire-and-forget 으로 띄우고 join 안 하므로, deadline 이 없으면 partition 시 detached task + H/2 stream 이 OS TCP keepalive 까지 무한 누적된다(10k 규모에서 fd/async-task 누수). Elapsed timeout 은 network error 와 같은 transient `Err { dead_token: false }` 로 매핑 → retry 루프가 재시도하고 device token 은 절대 dead 로 오분류 안 됨. 회귀 가드: `apns.rs` `request_timeout_cancels_hung_send`(reverted fix → 테스트가 무한 hang = timeout 으로 genuine 입증) + `request_timeout_zero_disables_deadline`.
- **`/health` + `/metrics` 는 capacity 모니터링의 SoT.** `/health` JSON 필드: `status` ("ok"), `buildSha` (compile-time git SHA, `TP_BUILD_SHA` define; `"unknown"` for local/uninstrumented builds), `buildTime` (ISO timestamp, `TP_BUILD_TIME` define; `"unknown"` for local builds), `protocolVersion` (2), `clients`, `pendingAuth`, `daemons`, `sessions`, `attached`, `uptime`, `metrics` (object). `framesIn`, `framesOut`, `rateLimitedDrops`, `daemonRateLimitedDrops`, `backpressureDisconnects`, `authTimeouts`, `oversizedDrops`, `unknownTypeDrops`, `evictions`, `resumesAttempted` / `resumesAccepted` / `resumesRejected` counter를 since-last-restart로 노출(`Arc<Metrics>`, `RelayCore` lock 밖 lock-free atomics — `metrics.rs`). Tuning 변경은 이 counter 추이로 검증. `resumesRejected`가 갑자기 튀면 secret 회전이나 token 만료 정책을 의심. `unknownTypeDrops`가 튀면 적대적/구버전 peer가 malformed frame을 보내고 있다는 신호. `buildSha`는 deploy pipeline이 `/health.buildSha == github.sha`를 assert해 stale 바이너리를 조기에 잡는다 (`deploy-relay.yml` "Verify deployed build is live" step, `build.rs` 가 컴파일타임에 `TP_BUILD_SHA`/`TP_BUILD_TIME` 주입). `/metrics` 는 Prometheus text v0.0.4 (`Content-Type: text/plain; version=0.0.4`) — **정확히 17 라인** (`relay_clients`…`relay_resumes_rejected` + `relay_uptime_seconds`) `\n` join + trailing `\n` (`http.rs` `render_metrics_text`).
- **`/admin` 은 bearer 게이트 필수.** `TP_RELAY_ADMIN_TOKEN` 미설정이면 `/admin` 은 **404 (closed by default — 무인증 대시보드를 절대 서빙하지 않음)**, 설정 시 `Authorization: Bearer <token>` 일치를 요구 (부재/불일치 → 401). 비교는 `subtle::ConstantTimeEq` 로 constant-time 인데, 단순 `ct_eq` 는 길이가 다르면 즉시 short-circuit 하는 한계가 있어(길이로 binary-search 당할 수 있음) 양쪽 값을 **per-process 랜덤 키로 keyed-BLAKE2b** 해 항상 32-byte 고정폭 digest 로 비교한다(`http.rs` `bearer_ok`/`keyed_digest`) — 길이도 값도 새지 않음. daemon id + 각 session id 는 stored-XSS 방어로 HTML-escape. `/admin` 경로에 의존하는 운영 자동화는 반드시 `TP_RELAY_ADMIN_TOKEN` 을 설정하고 `Authorization: Bearer` 헤더를 포함해야 한다. 회귀 가드: `http.rs` `bearer_ok_constant_time_match` + `bearer_ok_rejects_missing_and_wrong_scheme`.
- **OS-level**: `LimitNOFILE` 200000 권장 (systemd unit). `relay-harden.sh`의 hashlimit 규칙은 그대로 유효 (per-IP `connlimit` 없음 — CGNAT 사용자 보호).

### Known parity gap — push "ws" verdict is not re-checked post-await (TOCTOU)

`push.rs` `send_or_deliver` step 1 은 dispatch 시점에 **pre-sample 된** `is_frontend_connected` 로 즉시 `DeliveryResult::Ws` 를 반환한다 — 샘플링과 실제 in-band 전달 사이에 frontend 가 끊기면, 그 알림은 APNs fallback 없이 그냥 드랍된다. TS 레퍼런스(`relay-server.ts:1594-1618`, 삭제됨)는 unseal/sendOrDeliver await *뒤* `isFrontendWsLive` 로 stale `"ws"` verdict 를 재검증해 필요 시 APNs 로 re-deliver했지만, 그 post-await TOCTOU 재검증은 **Rust `tp-relay` 에 아직 이식되지 않았다**. 창은 pre-await 샘플링이라 TS 보다 훨씬 작지만 0 은 아니다. 수정 = Ws verdict 전달 직전 liveness 재확인 + 죽었으면 APNs arm 재진입 + 회귀 가드. **후속 작업으로 TODO.md 에 열려 있다** — 아래 "실 push E2E" flake caveat(`.claude/rules/native-testing.md`)도 이 창이 원인인 간헐 실패를 설명한다. 이 항목은 절대 "Rust 포트도 동일 보장"으로 뭉개지 않는다 — 미이식이 사실이다.

## Soak harness — the 10k capacity gate (ADR-0003 §6.9)

`rust/tp-relay/tests/soak_10k.rs` 가 **capacity gate** 의 SoT 다. Stage-1 Rust 재설계가 standing ~10k concurrent bar 를 낮추지 않음을 증명한다 (parity gate 아님 — 골든벡터가 byte-parity 담당). **ONE 파라미터화 하니스**: connection 수 + duration 을 env 로 받아 같은 코드 경로를 heavy(local)/light(CI) 두 tier 로 굴린다. `#[ignore]` 이라 일반 `cargo test --workspace` 는 절대 수천 소켓을 열지 않는다.

| Env | 기본 | 의미 |
|-----|------|------|
| `TP_SOAK_CONNS` | `10_000` | dimension 당 frontend conn 수 (heavy=10k, CI light=1500) |
| `TP_SOAK_SECS` | `60` | dimension 당 soft wall-clock 예산 (CI light=20) |
| `TP_SOAK_JSON` | (off) | `=1` 이면 마지막 줄에 single-line JSON 요약 emit |

**세 부하 차원 (각각 명확한 sub-phase):**
1. **PUB FAN-OUT** — daemon 1 + frontend N 이 모두 같은 sid 구독, daemon 이 M frame publish → 모든 frontend 가 M 전부 수신(0 drop) 어서션. 잘 drain 하는 well-behaved consumer 는 1013 backpressure close 당하면 안 됨. `/metrics framesOut` 이 fan-out 반영. **rate-knob 주의 (ADR caveat (b)):** daemon-publish fan-out 은 per-daemon-group GCRA(`rate_per_daemon`, 기본 5000/s)로 체크되므로 10k-wide publish burst 가 group limiter 를 trip 할 수 있다 — 이 phase 는 `SharedState` tweak 으로 `rate_per_client`/`rate_per_daemon` 을 effectively-unbounded 로 올려 *fan-out delivery* 만 격리 측정한다(rate-limit 자체는 통합테스트가 담당). `outbox_cap` 도 frame 수에 맞춰 키워 well-behaved consumer 의 일시적 scheduling hiccup 을 slow-consumer 로 오인하지 않게 한다.
2. **RESUME STORM** — N conn auth → 각 `auth.ok` 의 resumeToken 캡처 → 소켓 drop → 재연결 → `relay.auth.resume {token}` → ~100% `resumed:true` 어서션 (daemon 은 storm 내내 online 유지). `relay_resumes_rejected == 0`.
3. **PUSH UNDER LOAD** — WS Push 는 no-op(conn.rs 의 `Push { .. }` arm — 실 dispatch 는 `handle_push` 인터셉트 경로)이라 `PushService` API 레벨에서 구동. fake `TransportDyn`(HTTP 200) + 실 `ApnsSigner`(런타임 생성 p256 PKCS#8)로 commit-on-success 단계까지 도달 → 동시성 하 dedup/rate-limit guard mutex 가 leak/deadlock 없이 직렬화됨을 증명. **honest scope**: 네트워크/APNs 테스트 아님; concurrency 하 guard 정확성 검증(위 "TS 의 reserve-then-rollback 과 설계가 다르다" 항의 residual race 는 이 소크의 범위 밖).

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

`rust` job 은 required check 이지만(5개 required job 중 하나 — `.claude/rules/ci-workflows.md`), 소크 자체가 flaky 해도 그 job 안의 fmt/clippy/`cargo test --workspace` 는 이미 통과한 뒤의 마지막 step 이라 무관한 PR 을 소크 하나로 막지는 않는다 — relay capacity 경로를 건드리는 PR 에선 반드시 green 이어야 한다.

## Scale-out (10k → 100k+)

10k는 단일 노드 상한 근처. 그 이상 가야 할 때:
- **Sticky routing + 작은 KV** 가 first choice — daemonId 기반 consistent-hash LB로 daemon + 그 daemon의 모든 frontend가 같은 노드에 붙음. Token registry만 Redis/Postgres로 옮기고, frame fan-out은 backplane 없이 in-process 유지. Frame path latency 영향 0.
- **Full Redis pub/sub backplane 비추** — frame fan-out에 매번 pub/sub hop이 끼면 latency + Redis 부하가 단일 노드 이득보다 큼. Stateless ciphertext invariant도 약해짐.
- HTTP/3 / QUIC connection migration은 클라이언트 측(Swift 앱 / Rust `tp-daemon`) 모두 아직 지원이 없어 현재 비현실. roadmap watch만.
