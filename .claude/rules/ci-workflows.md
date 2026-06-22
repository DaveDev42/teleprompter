---
paths:
  - ".github/**"
  - "ios/**"
  - "scripts/**"
---

# CI/CD & Deployment Conventions

## GitHub Actions
- CI: Node 22 + Bun 1.3.13 + pnpm, 6개 독립 병렬 job (`lint`, `type-check`, `test`, `build-cli`, `rust`, `swift-build`). 앞 4개는 ubuntu-latest, `rust`도 ubuntu-latest, `swift-build`만 macos-26.
  - `rust` job = ubuntu-latest, `rust/rust-toolchain.toml` 핀(1.96). 3 step: `cargo fmt --all -- --check` (rustfmt.toml: edition 2021 / max_width 100) → `cargo clippy --workspace --all-targets` → `cargo test --workspace` (TS↔Rust 골든벡터 `wire_vectors.rs`/`message_vectors.rs` 포함).
    - **Lint 심각도는 CLI 플래그가 아니라 `rust/Cargo.toml`의 `[workspace.lints]` 테이블이 SoT** — `clippy::all = "deny"`(hard gate), `clippy::pedantic = "warn"`(non-blocking, 나중에 deny 로 ratchet). 그래서 로컬 `cargo clippy`와 CI 가 바이트 단위로 일치한다. **clippy step 에 `-- -D warnings` 를 절대 붙이지 않는다** — 그 플래그는 pedantic 그룹(~125 warning)까지 error 로 over-promote 해서 빌드를 깬다(테이블이 이미 정책을 인코딩하므로 redundant + harmful). `rust.unsafe_code = "forbid"` 로 all-safe-code 불변식이 컴파일러 강제(두 crate 모두 uniffi 0.28 scaffolding 포함 clean).
  - `swift-build` job = **macos-26** (B4, ADR-0002). Apple 멀티플랫폼 SwiftUI 타깃이 **개발자 머신 없이도** 컴파일됨을 증명하는 결정론적 CI 게이트 — `TP_PLATFORM=macos scripts/ios.sh build` (네이티브 macOS destination, **compile-only**: Simulator 부팅·XCTest·실 claude E2E 없음, 그건 로컬 `scripts/ios.sh smoke` 담당). step: `dtolnay/rust-toolchain@1.96.0` + **9 Apple 타깃 전부** `rustup target add`(`build-xcframework.sh ensure_targets` 가 누락 시 hard-die, subset 플래그 없음 — visionOS/watchOS 포함 9개 모두 stable 1.96 Tier 2) → `Swatinem/rust-cache` → `brew install xcodegen`(러너 미제공, `cmd_gen` 가 `require xcodegen` 로 hard-die) → `scripts/ios.sh build`(= `ensure_xcframework`[9슬라이스 xcframework+UniFFI bindgen, `TP_SKIP_RUST`/`TP_FORCE_RUST` 둘 다 unset] → `ensure_project`[xcodegen generate] → `xcodebuild -destination platform=macOS`). **러너는 반드시 macos-26 핀** (bare `macos-latest` 는 macos-15→macos-26 migration 중; 앱이 iOS/macOS 26 SDK + Swift 6.0 모드, 로컬 dev = Xcode 26.5). cold rust-cache 시 ~20-25m 가능 → `timeout-minutes: 40`. **non-required** (아래 required 목록 참조) — flaky macOS 러너/SDK drift 가 무관 PR 을 wedge 하지 않게; main 에서 안정 green 확인 후 required 승격.
  - `type-check` job은 `packages/protocol` 포함 5개 tsconfig 병렬.
    - **TS strictness SoT = `packages/tsconfig/base.json`** (모든 패키지가 `bun.json`→`base.json` 체인으로 상속). 현행 켜짐: `strict`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, **`verbatimModuleSyntax`** (T4a), **`exactOptionalPropertyTypes`** (T4c — `{x: T|undefined}` 를 `x?: T` 에 할당 금지, present-undefined vs absent 구분). 아직 안 켠 것: `noUnusedLocals`/`noUnusedParameters` (Biome `noUnusedVariables` warn 으로 커버 중). flag 추가 전 항상 5개 패키지에 `tsc --noEmit -p <pkg> --<flag>` 로 blast radius 실측.
    - **exactOptionalPropertyTypes 수정 정책 (T4c, 향후 위반 처리 규칙):** 기본은 **타입 정의 widen** (`x?: T` → `x?: T | undefined`) — behavior-preserving, TS 공식 권장. **wire 객체(`SessionMeta`/`SessionRec`/relay·ipc 메시지)에서는 절대 키를 조건부 omit 하지 말 것** — 프론트엔드/테스트가 안정적 키셋을 기대하므로 wire 타입을 widen 하고 값은 항상 present(`field: val ?? undefined`). 조건부 omit(`...(x !== undefined && {x})`)은 **non-wire constructor option-bag·React/Ink prop·`Bun.spawn` option** 에만 허용(`?? default` 로 읽혀 absent==undefined). guard(`*-guard.ts`) 검증 로직은 손대지 말 것. (회귀 사례: `toSessionMeta` 가 wire 키를 omit 해서 "all wire-format keys" 테스트가 깨짐 → widen+always-present 로 수정.)
    - **Biome lint 심각도 = `biome.json` `linter.rules` SoT** — `suspicious.noExplicitAny = "error"` (T4a; 프로덕션 코드에 `any` 0개, 테스트 2곳은 `biome-ignore` 처리됨), **`style.noNonNullAssertion = "error"`** (T4b; 110개 `!` non-null assertion 사이트를 전부 제거 — prod 는 loop/regex 불변식에 맞춘 방어적 guard-throw, test 는 local + expect 패턴. override 없이 prod/test 동일 적용). 둘 다 hard gate. `biome ci .` 는 error 에서만 non-zero exit — warn/info(예: `useLiteralKeys` 639 infos)는 CI 통과. **non-null assertion 을 새로 도입하지 말 것** — `arr[i]`/`map.get(k)` 는 `noUncheckedIndexedAccess` 로 `T | undefined`; local const + `if (x === undefined) throw`(불변식) 또는 optional chaining 으로 narrow.
- **Required status checks** (Ruleset 14604664, live): `lint`/`type-check`/`test`/`build-cli`/`rust` 5개가 필수 merge gate (`rust` 는 안정 green 확인 후 이미 승격됨). `swift-build` 는 아직 **non-required** — main에서 안정적으로 green 확인 후 required 목록에 추가한다 (없는 context를 required로 걸면 모든 PR이 wedge — 그래서 신규 job 은 항상 non-required 로 먼저 들어간다). **merge method = squash-only** (ruleset 강제 — 3종 merge 중 squash만 허용).
- Secrets: `RELAY_HOST`, `RELAY_USER`, `RELAY_SSH_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`

## Release (`release.yml`, triggered on `v*` tag push or manual `workflow_dispatch -f tag=vX.Y.Z`)
- tag-push event 는 GitHub API tag-creation 시 누락되는 케이스가 잦아 (#172) **항상 manual dispatch 로 트리거**: `gh workflow run release.yml -f tag=vX.Y.Z`
- Release Please: Conventional Commits → 자동 version bump + CHANGELOG → PR
- Tag prefix: `v*` (e.g. `v0.1.13`) — `release/v*` is legacy, removed in PR #96
- 수동 편집 금지: version 필드는 Release Please가 관리
- `build-darwin` job runs on `macos-latest` and **does not codesign**. Bun's `--compile` already embeds a linker-signed ad-hoc signature (`Identifier=a.out`, `flags=adhoc,linker-signed`); we ship that as-is. brew/curl install paths don't apply the `com.apple.quarantine` xattr, so Gatekeeper never fires on our distribution channels. Previous re-sign (removed in v0.1.33) only changed `Identifier` and added the Hardened Runtime flag, neither of which affected user-facing behavior. If GUI download distribution is ever added (browser, .dmg), Developer ID Application certificate + notarization (`notarytool submit --wait` + `stapler staple`) will be needed at that point.
- `build-cross` job runs on `ubuntu-latest`, then `apt-get install upx-ucl` + `upx -1 dist/tp-*` to shrink linux binaries (-55% typical). macOS is deliberately **not** UPX-compressed — Gatekeeper/Hardened Runtime SIGKILLs packed Mach-O even with `--force-macos`.
- `release` job signs `checksums.txt` via cosign keyless OIDC + attest-build-provenance, then publishes via `softprops/action-gh-release@v2`.

## Relay Deploy (`deploy-relay.yml`, ADR-0003 Step 8b — Rust 바이너리)
- **빌드**: `ubuntu-latest` 에서 `dtolnay/rust-toolchain@1.96.0`+`Swatinem/rust-cache` 로 `cargo build --release --target x86_64-unknown-linux-gnu --bin tp-relay`(x86_64 Vultr = native build). `TP_BUILD_SHA=${{ github.sha }}` 를 **build env** 로 주입 → `build.rs` 가 읽어 `/health.buildSha` 로 verbatim 노출(full 40-char).
- **배포**: SCP `/tmp/tp-relay` → 호스트, base unit `ExecStart=/usr/local/bin/tp-relay`+`RELAY_PORT=7090` 설치, `systemctl restart tp-relay`. **on-disk `sha256(/usr/local/bin/tp-relay)` 검증** + `/health.buildSha==github.sha` assert(`curl --retry`).
- **시크릿은 base unit 이 아니라 drop-in `/etc/systemd/system/tp-relay.service.d/secrets.conf`**(`TP_RELAY_RESUME_SECRET`/`TP_RELAY_PUSH_SEAL_SECRET[_PREV]`/APNs) — deploy 가 base unit 을 rewrite 해도 systemd 가 drop-in 을 merge 하므로 시크릿 안 지워짐. deploy 워크플로우는 시크릿을 읽지/쓰지 않는다.
- **트리거**: `rust/tp-relay,tp-proto,tp-core`, `rust/Cargo.lock`, `deploy-relay.yml` 자기자신 (구 `packages/relay,protocol,daemon` 제거 — TS relay 퇴역). **flip-live-on-merge** = 머지가 곧 `relay.tpmt.dev` 자동 cutover(downtime-OK, Amendment 1). 시크릿 reissue 는 머지 *전에* 호스트에서.
- Health check: `https://relay.tpmt.dev/health` · Port: 7090 · `timeout-minutes: 30`
- **arm64 호스트 전환 시 주의**: `ubuntu-latest`(x86_64)에서 `aarch64-unknown-linux-gnu` 링크는 `gcc-aarch64-linux-gnu` 크로스 링커가 필요(현 워크플로우 미설치) — 현 Vultr 가 x86_64 라 dead path 지만 전환 시 `cross`/링커 추가 필요.

## Scripts
- `scripts/build.ts`: multi-platform `bun build --compile --minify` (darwin/linux × arm64/x64). Always passes `--minify`; `--bytecode` is deliberately off (+9 MB for -20 ms warm start is a bad trade; download size dominates install UX). Native Windows is unsupported — Windows users run the Linux build under WSL.
- `scripts/install.sh`: curl-pipe-sh installer (macOS/Linux; Windows users run inside WSL)
- `scripts/deploy-relay.sh`: SSH 배포 (arch 자동 감지)
