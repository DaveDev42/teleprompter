---
paths:
  - ".github/**"
  - ".eas/**"
  - "scripts/**"
---

# CI/CD & Deployment Conventions

## GitHub Actions
- CI: Node 22 + Bun 1.3.12 + pnpm, 5개 독립 병렬 job (lint, type-check, test, build-cli, e2e)
- 캐시: Playwright browsers (`playwright-{os}-`), Expo web build (`expo-web-{os}-`)
- EAS 게이트: 5개 job 전부 pass + `dorny/paths-filter`로 app/protocol 변경 감지 → `expo-doctor` → `eas build`
- Secrets: `RELAY_HOST`, `RELAY_USER`, `RELAY_SSH_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `EXPO_TOKEN` (EAS gate)

## EAS Workflows
- Fingerprint 기반: 네이티브 코드 해시로 기존 빌드 재사용 판단
- JS만 변경 → OTA 업데이트 (~2분, $0), 네이티브 변경 → 풀빌드 + 스토어 제출
- Channels: development, preview, production

## Release
- Release Please: Conventional Commits → 자동 version bump + CHANGELOG
- Tag prefix: `release/v*`
- 수동 편집 금지: version 필드는 Release Please가 관리

## Relay Deploy
- SSH 기반: SCP + systemctl restart (tp-relay)
- Health check: `https://relay.tpmt.dev/health`
- Port: 7090

## Scripts
- `scripts/build.ts`: multi-platform `bun build --compile` (darwin/linux × arm64/x64)
- `scripts/install.sh`: curl-pipe-sh installer
- `scripts/deploy-relay.sh`: SSH 배포 (arch 자동 감지)
