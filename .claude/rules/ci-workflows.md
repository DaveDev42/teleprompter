---
paths:
  - ".github/**"
  - "ios/**"
  - "scripts/**"
---

# CI/CD & Deployment Conventions

## GitHub Actions
- CI: Node 22 + Bun 1.3.13 + pnpm, 5개 독립 병렬 job (`lint`, `type-check`, `test`, `build-cli`, `rust`).
  - `rust` job = ubuntu-latest, `rust/rust-toolchain.toml` 핀(1.96). 3 step: `cargo fmt --all -- --check` (rustfmt.toml: edition 2021 / max_width 100) → `cargo clippy --workspace --all-targets` → `cargo test --workspace` (TS↔Rust 골든벡터 `wire_vectors.rs`/`message_vectors.rs` 포함).
    - **Lint 심각도는 CLI 플래그가 아니라 `rust/Cargo.toml`의 `[workspace.lints]` 테이블이 SoT** — `clippy::all = "deny"`(hard gate), `clippy::pedantic = "warn"`(non-blocking, 나중에 deny 로 ratchet). 그래서 로컬 `cargo clippy`와 CI 가 바이트 단위로 일치한다. **clippy step 에 `-- -D warnings` 를 절대 붙이지 않는다** — 그 플래그는 pedantic 그룹(~125 warning)까지 error 로 over-promote 해서 빌드를 깬다(테이블이 이미 정책을 인코딩하므로 redundant + harmful). `rust.unsafe_code = "forbid"` 로 all-safe-code 불변식이 컴파일러 강제(두 crate 모두 uniffi 0.28 scaffolding 포함 clean).
  - `type-check` job은 `packages/protocol` 포함 5개 tsconfig 병렬.
    - **TS strictness SoT = `packages/tsconfig/base.json`** (모든 패키지가 `bun.json`→`base.json` 체인으로 상속). 현행 켜짐: `strict`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, **`verbatimModuleSyntax`** (T4a — 타입 전용 import 를 `import type` 로 강제; bundler 모드라 런타임 무영향, 도입 시 0 error). 아직 안 켠 것: `exactOptionalPropertyTypes` (도입 시 ~278 error → 전용 PR 필요), `noUnusedLocals`/`noUnusedParameters` (Biome `noUnusedVariables` warn 으로 커버 중). flag 추가 전 항상 5개 패키지에 `tsc --noEmit -p <pkg> --<flag>` 로 blast radius 실측.
    - **Biome lint 심각도 = `biome.json` `linter.rules` SoT** — `suspicious.noExplicitAny = "error"` (T4a; 프로덕션 코드에 `any` 0개, 테스트 2곳은 `biome-ignore` 처리됨), **`style.noNonNullAssertion = "error"`** (T4b; 110개 `!` non-null assertion 사이트를 전부 제거 — prod 는 loop/regex 불변식에 맞춘 방어적 guard-throw, test 는 local + expect 패턴. override 없이 prod/test 동일 적용). 둘 다 hard gate. `biome ci .` 는 error 에서만 non-zero exit — warn/info(예: `useLiteralKeys` 639 infos)는 CI 통과. **non-null assertion 을 새로 도입하지 말 것** — `arr[i]`/`map.get(k)` 는 `noUncheckedIndexedAccess` 로 `T | undefined`; local const + `if (x === undefined) throw`(불변식) 또는 optional chaining 으로 narrow.
- **Required status checks** (Ruleset 14604664): `lint`/`type-check`/`test`/`build-cli` 가 필수 merge gate. `rust`(및 추후 `swift`)는 main에서 green 확인 후 required 목록에 추가한다 (없는 context를 required로 걸면 모든 PR이 wedge). **merge method = squash-only** (ruleset 강제 — 3종 merge 중 squash만 허용).
- Secrets: `RELAY_HOST`, `RELAY_USER`, `RELAY_SSH_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`

## Release (`release.yml`, triggered on `v*` tag push or manual `workflow_dispatch -f tag=vX.Y.Z`)
- tag-push event 는 GitHub API tag-creation 시 누락되는 케이스가 잦아 (#172) **항상 manual dispatch 로 트리거**: `gh workflow run release.yml -f tag=vX.Y.Z`
- Release Please: Conventional Commits → 자동 version bump + CHANGELOG → PR
- Tag prefix: `v*` (e.g. `v0.1.13`) — `release/v*` is legacy, removed in PR #96
- 수동 편집 금지: version 필드는 Release Please가 관리
- `build-darwin` job runs on `macos-latest` and **does not codesign**. Bun's `--compile` already embeds a linker-signed ad-hoc signature (`Identifier=a.out`, `flags=adhoc,linker-signed`); we ship that as-is. brew/curl install paths don't apply the `com.apple.quarantine` xattr, so Gatekeeper never fires on our distribution channels. Previous re-sign (removed in v0.1.33) only changed `Identifier` and added the Hardened Runtime flag, neither of which affected user-facing behavior. If GUI download distribution is ever added (browser, .dmg), Developer ID Application certificate + notarization (`notarytool submit --wait` + `stapler staple`) will be needed at that point.
- `build-cross` job runs on `ubuntu-latest`, then `apt-get install upx-ucl` + `upx -1 dist/tp-*` to shrink linux binaries (-55% typical). macOS is deliberately **not** UPX-compressed — Gatekeeper/Hardened Runtime SIGKILLs packed Mach-O even with `--force-macos`.
- `release` job signs `checksums.txt` via cosign keyless OIDC + attest-build-provenance, then publishes via `softprops/action-gh-release@v2`.

## Relay Deploy
- SSH 기반: SCP + systemctl restart (tp-relay)
- Health check: `https://relay.tpmt.dev/health`
- Port: 7090

## Scripts
- `scripts/build.ts`: multi-platform `bun build --compile --minify` (darwin/linux × arm64/x64). Always passes `--minify`; `--bytecode` is deliberately off (+9 MB for -20 ms warm start is a bad trade; download size dominates install UX). Native Windows is unsupported — Windows users run the Linux build under WSL.
- `scripts/install.sh`: curl-pipe-sh installer (macOS/Linux; Windows users run inside WSL)
- `scripts/deploy-relay.sh`: SSH 배포 (arch 자동 감지)
