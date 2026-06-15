---
paths:
  - ".github/**"
  - "release-please-config.json"
  - ".release-please-manifest.json"
---

# Deployment Pipeline & Release

평상시는 `/release` 슬래시 커맨드가 전 과정을 자동화한다. 아래는 그 SoT.

## main push
| Target | Workflow | Condition |
|--------|----------|-----------|
| CI | GitHub Actions `ci.yml` | 항상 (parallel jobs: lint, type-check, test, build-cli) |
| Relay | GitHub Actions `deploy-relay.yml` | packages/relay,protocol,daemon 변경 시 |

## v* 태그 release
| Target | Workflow | 설명 |
|--------|----------|------|
| tp 바이너리 | GitHub Actions `release.yml` | darwin-arm64 + linux × {arm64, x64} 빌드 → GitHub Release. `release.yml`은 `push: tags: [v*]` 와 `workflow_dispatch -f tag=...` 둘 다 받지만, GitHub API tag-creation 의 push event firing 이 누락되는 케이스가 잦아 (#172) **항상 manual dispatch 로 트리거** 한다. |
| Homebrew tap | GitHub Actions `release.yml` (tap bump step, `DaveDev42/homebrew-tap-release@v1` reusable action — PR #185) | `checksums.txt`에서 darwin sha256 추출 → `Formula/tp.rb` 렌더 → `davedev42/homebrew-tap` repo에 직접 push (PR 없음, commit subject = `tp <VERSION>`). `HOMEBREW_TAP_TOKEN` secret 미설정 또는 push 실패 시 `::warning::`로 swallow되어 release 자체는 성공으로 끝남 — 이 경우 `/release` 명령이 catch함. |

## 수동 dispatch only
| Workflow | 역할 |
|----------|------|
| `release-please.yml` (dispatch) | **두 가지 동작 중 하나** — main 상태에 따라 자동으로 결정: (a) release-able commit 이 쌓여 있으면 Release PR 생성/갱신, (b) 직전 dispatch 가 만든 PR 이 main 에 squash merge 되어 있으면 `vX.Y.Z` tag 을 push. 즉 한 번의 patch release 마다 dispatch 두 번 (PR 생성용 + tag push용) 이 필요하다. push trigger 는 일부러 제거 — main 의 모든 commit 마다 PR update 시도가 워크플로우를 잡아먹는 것을 회피. |
| `release.yml` (dispatch) | tag push event 가 누락된 케이스의 fallback (#172). `-f tag=vX.Y.Z` 로 기존 tag 을 재빌드. **현행 운영상 default 트리거 경로** — `release-please.yml` 두 번째 dispatch 가 tag 을 push 한 후 항상 이 dispatch 로 release.yml 을 깨운다. |
| `deploy-relay.yml` (dispatch) | 수동 relay 배포 |

## 릴리즈 절차 (수동)

```bash
# 1. 개발: main에 Conventional Commits로 push.
#    Relay (변경 시 `deploy-relay.yml`)는 main push 트리거로 자동 진행.

# 2. Release PR 생성: release-please.yml dispatch (#1).
gh workflow run release-please.yml --ref main
# → "chore(main): release X.Y.Z" PR 생성. 이 PR 에는 main `ci.yml`
#   의 path filter 가 안 맞아 lint/test/build-cli 가 붙지 않는다 —
#   `gh pr view --json mergeable,mergeStateStatus` 로 MERGEABLE/CLEAN
#   여부만 확인하면 된다.

# 3. PR squash merge.
gh api repos/DaveDev42/teleprompter/pulls/<num>/merge -X PUT \
  -f merge_method=squash

# 4. tag push: release-please.yml dispatch (#2).
gh workflow run release-please.yml --ref main
# → main 의 release commit 을 인식해 vX.Y.Z tag 을 push.
#   (release-please.yml 은 workflow_dispatch only 이므로 자동 트리거 없음.
#    한 번의 dispatch 가 PR 생성 또는 tag push 중 하나만 하므로 두 번 필요.)

# 5. release.yml dispatch: 빌드 + GitHub Release + tap bump.
gh workflow run release.yml -f tag=vX.Y.Z
# → release.yml 은 `push: tags: [v*]` 트리거도 있지만 GitHub API
#   tag-creation 이 push event 를 항상 firing 하지는 않으므로 (#172)
#   manual dispatch 가 안전한 default.

# 6. tap repo + brew 검증 (SLA 보장 step):
gh api repos/DaveDev42/homebrew-tap/commits/main --jq '.commit.message'
brew update && brew upgrade davedev42/tap/tp && tp version
```

## Infrastructure
- **Relay**: Vultr Seoul `relay.tpmt.dev` (wss://, Caddy TLS + systemd: `tp-relay`)
- **CLI**: GitHub Releases → `bun build --compile` (darwin/linux × arm64/x64; Windows users run the linux build under WSL)
- **iOS App**: 로컬 Simulator 하네스 (`scripts/ios.sh` / `ios/`) — EAS 클라우드 빌드 제거됨. 네이티브 앱은 리라이트 진행 중 (ADR-0001 참조).

## GitHub Secrets
| Secret | 용도 |
|--------|------|
| `RELAY_HOST` | Relay 서버 IP |
| `RELAY_USER` | Relay SSH 사용자 |
| `RELAY_SSH_KEY` | Relay SSH 키 |
| `HOMEBREW_TAP_TOKEN` | `davedev42/homebrew-tap`에 push할 PAT (fine-grained, Contents: R/W). 미설정 시 release.yml의 tap update step이 `::warning::HOMEBREW_TAP_TOKEN not set`로 swallow하고 통과. |

# Version Management

- **NEVER bump versions** (package.json) unless the user explicitly requests it.
- Pre-1.0: only patch bumps (0.0.x).
- Release Please handles version bumps automatically via Conventional Commits — `bump-patch-for-minor-pre-major` is enabled so `feat:` commits stay patch-level while pre-1.0.
- Do not manually edit `version` fields in any package.json or `.release-please-manifest.json`.
