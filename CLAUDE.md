# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Teleprompter is a remote Claude Code session controller. An Expo frontend (React Native + RN Web) connects to a Bun-based Daemon via encrypted relay to control Claude Code sessions with a dual Chat/Terminal UI.

## Tech Stack

- **Language**: TypeScript (single stack across all components)
- **Runtime**: Bun v1.3.5+ (Runner, Daemon, Relay), Expo (Frontend)
- **Monorepo**: Turborepo + pnpm
- **Frontend**: Expo (React Native + RN Web), Zustand, NativeWind (Tailwind), xterm.js
- **Encryption**: libsodium (X25519 + XChaCha20-Poly1305)
- **Voice**: OpenAI Realtime API

## Monorepo Layout

```
apps/
  cli/         # @teleprompter/cli — unified `tp` binary (subcommand router)
  app/         # @teleprompter/app — Expo app (iOS > Web > Android)
packages/
  daemon/      # @teleprompter/daemon — Bun long-running service (session mgmt, vault, E2EE, worktree)
  runner/      # @teleprompter/runner — Bun per-session process (PTY via Bun.spawn terminal, hooks collection)
  relay/       # @teleprompter/relay — Bun WebSocket ciphertext-only relay server
  protocol/    # @teleprompter/protocol — shared types, framed JSON codec, envelope types
  tsconfig/    # Shared TS configs (base.json, bun.json)
  eslint-config/
scripts/
  build.ts     # Multi-platform `bun build --compile` script
  install.sh   # curl-pipe-sh installer for GitHub Releases
```

## Architecture

- **Runner** spawns Claude Code in a PTY (`Bun.spawn({ terminal })`), collects io streams and hooks events, sends Records to Daemon via Unix domain socket IPC
- **Daemon** manages sessions, stores Records in Vault (append-only per session, with session delete/prune support), encrypts with libsodium, connects to Relay(s)
- **Relay** is a stateless ciphertext forwarder — holds only recent 10 encrypted frames per session
- **Frontend** decrypts and renders: Terminal tab (xterm.js) + Chat tab (hooks events + PTY parsing hybrid)
- Data flow: Runner → Daemon → Relay → Frontend (and reverse for input)

## Protocol

All components use the same framed JSON protocol: `u32_be length` + `utf-8 JSON payload`. The Envelope type has fields: `t` (frame type), `sid`, `seq`, `k` (io|event|meta), `ns`, `n`, `d`, `c`, `ts`, `e`, `m`.

### Relay Protocol v2
- `relay.register` — daemon self-registers token+proof (derived from pairing secret)
- `relay.auth` — authenticate with token, includes `frontendId` for frontend role
- `relay.kx` / `relay.kx.frame` — in-band pubkey exchange (encrypted with `deriveKxKey(pairingSecret)`)
- `relay.pub` / `relay.frame` — encrypted data frames, includes `frontendId` for N:N routing
- `relay.presence` — daemon online/offline with session list
- Connection flow: daemon `register → auth → broadcast pubkey via kx`; frontend `auth → send pubkey via kx → subscribe`

## Key Design Decisions

- Chat UI uses **hybrid** data: hooks events for structured cards (primary) + PTY output parsing for streaming text (secondary). hooks Stop event finalizes responses.
- Worktree management is done directly by Daemon (`git worktree add/remove/list`), no external tool dependency. N:1 relationship — multiple sessions per worktree allowed.
- E2EE pairing via QR code containing pairing secret + daemon pubkey + relay URL + daemon ID. Daemon pubkey is delivered offline via QR; Frontend pubkey is exchanged in-band via `relay.kx` (encrypted with kxKey derived from pairing secret). Both sides perform ECDH (X25519 `crypto_kx`) → per-frontend session keys → XChaCha20-Poly1305 encryption. Relay token is self-registered via `relay.register` (proof-based, no pre-registration needed). N:N supported — one app connects to multiple daemons, one daemon serves multiple frontends, each with independent E2EE keys identified by `frontendId`.
- Platform priority: iOS > Web > Android. Responsive layout required for mobile/tablet/desktop.
- Deployment: `bun build --compile` for `tp` binary (subcommands: daemon, run, relay) and separate `tp-relay` binary for standalone relay deployment.
- Passthrough mode: `tp <claude args>` runs claude directly through tp pipeline. `--tp-*` flags are consumed by tp, rest forwarded to claude.

## Testing Strategy

4계층 테스트, 모두 `bun:test` 사용 (Tier 4는 Expo MCP).

### Tier 1: Unit Tests
외부 의존성 없이 빠르게 실행.
- `packages/protocol/src/codec.test.ts` — framed JSON encode/decode
- `packages/protocol/src/codec-edge.test.ts` — partial frames, unicode, 100KB payloads
- `packages/protocol/src/queued-writer.test.ts` — backpressure queue
- `packages/protocol/src/crypto.test.ts` — E2EE encrypt/decrypt, key exchange, ratchet
- `packages/protocol/src/crypto-edge.test.ts` — empty/large payloads, tampered ciphertext
- `packages/protocol/src/pairing.test.ts` — QR pairing bundle, encode/decode
- `packages/daemon/src/vault/vault.test.ts` — append-only Record 저장
- `packages/daemon/src/transport/client-registry.test.ts` — WS client 추적
- `packages/daemon/src/session/session-manager.test.ts` — register/unregister, spawn, kill
- `packages/daemon/src/ipc/server.test.ts` — connection lifecycle, framed messaging, findBySid
- `packages/runner/src/hooks/settings-builder.test.ts` — settings merge
- `packages/runner/src/hooks/hook-receiver.test.ts` — unix socket event reception
- `packages/runner/src/hooks/capture-hook.test.ts` — hook command generation
- `packages/runner/src/collector.test.ts` — io/event/meta record creation
- `packages/daemon/src/vault/session-db.test.ts` — append, cursor, payloads
- `packages/daemon/src/vault/vault-cleanup.test.ts` — deleteSession, pruneOldSessions
- `packages/protocol/src/socket-path.test.ts` — path format
- `packages/protocol/src/logger.test.ts` — level filtering, prefix formatting
- `apps/cli/src/args.test.ts` — `--tp-*` 인자 분리
- `apps/cli/src/spawn.test.ts` — runner command resolution
- `apps/cli/src/commands/version.test.ts` — version output
- `apps/cli/src/commands/status.test.ts` — daemon status display
- `apps/cli/src/commands/pair.test.ts` — pairing data generation
- `apps/cli/src/commands/passthrough.test.ts` — arg splitting
- `packages/protocol/src/compat.test.ts` — protocol version compatibility
- `packages/runner/src/pty/pty-manager.test.ts` — PTY spawn, resize, lifecycle
- `apps/cli/src/lib/service.test.ts` — OS service plist/unit generation

### Tier 2: Integration Tests (stub runner)
Stub 프로세스로 전체 파이프라인 검증.
- `packages/daemon/src/integration.test.ts` — IPC 파이프라인 (mock Runner→Daemon→Vault)
- `packages/daemon/src/e2e.test.ts` — 동시 세션, crash, resume, streaming, input relay
- `packages/daemon/src/transport/ws-server.test.ts` — WebSocket 서버 동작
- `packages/daemon/src/transport/relay-client.test.ts` — Daemon→Relay E2E with encryption
- `packages/relay/src/relay-server.test.ts` — Relay auth, routing, caching, presence
- `packages/relay/src/relay-edge.test.ts` — malformed JSON, multi-frontend, unsubscribe
- `packages/daemon/src/worktree/worktree-manager.test.ts` — git worktree add/remove/list
- `packages/daemon/src/worktree-ws.test.ts` — worktree/session WS protocol handlers
- `apps/cli/src/relay.test.ts` — relay CLI integration
- `packages/protocol/src/pairing-e2e.test.ts` — full QR pairing → ratchet → E2E encrypt
- `packages/runner/src/ipc/client.test.ts` — Runner↔Daemon IPC client connection
- `apps/cli/src/full-stack.test.ts` — Runner→Daemon→Relay→Frontend complete pipeline

### Tier 3: Real E2E Tests (requires claude CLI)
실제 claude PTY를 통한 전체 tp 파이프라인. `claude`가 PATH에 없으면 skip.
- `apps/cli/src/e2e.test.ts` — PTY ANSI output, hooks 이벤트, WS 스트리밍, resume

### Benchmarks
- `packages/daemon/src/bench.test.ts` — pipeline throughput benchmark
- `packages/relay/src/bench.test.ts` — relay throughput benchmark

### Tier 4: QA Agent Tests (Expo MCP)
`/qa` 커맨드로 QA agent에 위임:
- `app-ios-qa` — iOS Simulator (Expo MCP + Maestro)
- `app-web-qa` — React Native Web (Playwright)
- Playwright E2E: `pnpm test:e2e`
  - `e2e/app-web.spec.ts` — smoke tests
  - `e2e/app-roundtrip.spec.ts` — input/output roundtrip
  - `e2e/app-resume.spec.ts` — daemon restart recovery
  - `e2e/app-real-e2e.spec.ts` — real Claude PTY E2E
  - `e2e/app-daemon.spec.ts` — daemon-connected tests
  - `e2e/app-chat-roundtrip.spec.ts` — chat input/output roundtrip

### 명령어
```bash
bun test packages/protocol packages/daemon packages/runner apps/cli packages/relay  # 전체 Tier 1-3
pnpm type-check:all    # 전체 타입 체크 (daemon, cli, relay, runner, app)
```

## Documentation Maintenance

CLAUDE.md, PRD.md, TODO.md, ARCHITECTURE.md must always be kept up to date.
When implementing features, fixing bugs, or making architectural changes,
update the relevant documentation files in the same commit.

## Commit Discipline

- 논리적 작업 단위(기능, 테스트 스위트, 버그 수정) 완료 후 커밋
- 다른 영역으로 컨텍스트 전환 전에 커밋
- 전체 테스트 통과 확인 후에만 커밋
- 깨진 코드나 미완성 코드를 커밋하지 않음
- 문서 업데이트(CLAUDE.md, TODO.md 등)는 해당 코드 변경과 같은 커밋에 포함

## Deployment Pipeline

### main push
| Target | Workflow | Condition |
|--------|----------|-----------|
| CI | GitHub Actions `ci.yml` | 항상 |
| Relay | GitHub Actions `deploy-relay.yml` | packages/relay,protocol,daemon 변경 시 |
| Web | Vercel (자동) | 항상 → `tpmt.dev` |
| iOS TestFlight | EAS Workflow `preview.yaml` | apps/app, packages/protocol 변경 시 |
| Android Internal | EAS Workflow `preview.yaml` | apps/app, packages/protocol 변경 시 |

### release/v* 태그 (Release Please PR merge)
| Target | Workflow | 설명 |
|--------|----------|------|
| tp + tp-relay 바이너리 | GitHub Actions `release.yml` | 4 플랫폼 빌드 → GitHub Release |
| iOS App Store | EAS Workflow `production.yaml` | Fingerprint → 빌드/OTA → 제출 |
| Android Play Store | EAS Workflow `production.yaml` | Fingerprint → 빌드/OTA → 제출 |

### 수동
| Workflow | 역할 |
|----------|------|
| `release-please.yml` (dispatch) | Release PR 생성 (version bump + CHANGELOG) |
| `deploy-relay.yml` (dispatch) | 수동 relay 배포 |

### EAS 빌드 최적화
- **Fingerprint**: 네이티브 코드 해시로 기존 빌드 재사용 여부 판단
- **JS만 변경**: OTA 업데이트 발행 (~2분, 빌드 비용 $0)
- **네이티브 변경**: 풀빌드 + 스토어 제출
- **paths 필터**: 앱 무관한 변경 시 EAS 트리거 안 됨

### 릴리즈 절차
```bash
# 1. 개발: main에 Conventional Commits로 push (자동 배포)
# 2. 릴리즈 준비: GitHub Actions > Release Please > Run workflow
# 3. 릴리즈: Release PR merge → release/v0.0.1 태그 자동 생성
```

### Infrastructure
- **Relay**: Vultr Seoul `relay.tpmt.dev` (wss://, Caddy TLS + systemd: `tp-relay`)
- **Web**: Vercel → `tpmt.dev`
- **App**: EAS Build → TestFlight / Google Internal / App Store / Play Store
- **CLI**: GitHub Releases → `bun build --compile` (darwin/linux × arm64/x64)

### GitHub Secrets
| Secret | 용도 |
|--------|------|
| `RELAY_HOST` | Relay 서버 IP |
| `RELAY_USER` | Relay SSH 사용자 |
| `RELAY_SSH_KEY` | Relay SSH 키 |

### EAS Credentials (Expo 서버 저장)
- iOS: Distribution Certificate + App Store Connect API Key (ascAppId: 6761056150)
- Android: Keystore + Google Play Service Account Key

## Expo Go Compatibility

앱은 Expo Go에서 구동 가능해야 하므로 커스텀 네이티브 모듈 사용 불가.
- ✗ react-native-quick-crypto (JSI 네이티브 모듈)
- ✗ react-native-libsodium (Rust FFI)
- ✓ libsodium-wrappers-sumo (WASM on Web/Bun, asm.js fallback on Hermes)
- ✓ expo-crypto (Expo SDK 내장 — `getRandomValues` polyfill 제공)
- ✓ 순수 JavaScript 라이브러리

### Hermes Crypto Polyfill
libsodium은 `window.crypto.getRandomValues`를 요구하나 Hermes에는 없음.
`apps/app/src/lib/crypto-polyfill.ts`에서 expo-crypto의 네이티브 `getRandomValues`를
`self.crypto.getRandomValues`로 polyfill. 앱 진입점(`index.ts`)에서 최초 import 필수.

## CLI Commands

```bash
tp daemon start          # Daemon 포그라운드 실행
tp daemon install        # OS 서비스 등록 (macOS: launchd, Linux: systemd)
tp daemon uninstall      # OS 서비스 해제
tp relay start           # Relay 서버 실행
tp relay ping            # Relay RTT 측정 + E2EE 검증
  --relay-url URL        #   relay 주소 (기본: 저장된 pairing 데이터)
  --count N              #   ping 횟수 (기본: 10)
  --verify-e2ee          #   E2EE encrypt/decrypt round-trip 검증
tp pair                  # QR 페어링 데이터 생성
tp status                # Daemon 상태 확인 (자동 시작)
tp run                   # Runner 프로세스 실행
```

## Language

PRD and internal docs are written in Korean. Code, comments, and commit messages should be in English.
