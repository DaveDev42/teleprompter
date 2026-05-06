---
paths:
  - ".github/**"
  - ".eas/**"
  - "scripts/**"
---

# CI/CD & Deployment Conventions

## GitHub Actions
- CI: Node 22 + Bun 1.3.13 + pnpm, 5개 독립 병렬 job (`lint`, `type-check`, `test`, `build-cli`, `e2e`) + 1 gate (`eas-gate`)
- 캐시: Playwright browsers (`playwright-{os}-`), Expo web build (`expo-web-{os}-`)
- EAS 게이트: 5개 병렬 job 전부 pass + `dorny/paths-filter`로 app/protocol 변경 감지 → `expo-doctor` → `eas build`
- Secrets: `RELAY_HOST`, `RELAY_USER`, `RELAY_SSH_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `EXPO_TOKEN` (EAS gate)

## EAS Workflows
- Fingerprint 기반: 네이티브 코드 해시로 기존 빌드 재사용 판단
- JS만 변경 → OTA 업데이트 (~2분, $0), 네이티브 변경 → 풀빌드 + 스토어 제출
- Channels: development, preview, production

## Release (`release.yml`, triggered on `v*` tag push)
- Release Please: Conventional Commits → 자동 version bump + CHANGELOG → PR
- Tag prefix: `v*` (e.g. `v0.1.13`) — `release/v*` is legacy, removed in PR #96
- 수동 편집 금지: version 필드는 Release Please가 관리
- `build-darwin` job runs on `macos-latest`; Bun embeds an ad-hoc signature, so we `codesign --remove-signature` + re-sign with Hardened Runtime options.
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
