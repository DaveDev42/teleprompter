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
| CI | GitHub Actions `ci.yml` | 항상 (parallel jobs: lint, type-check, test, build-cli, rust) |
| Relay | GitHub Actions `deploy-relay.yml` | **Rust `tp-relay` 변경 시** (`rust/tp-relay,tp-proto,tp-core`, `rust/Cargo.lock`, 자기자신; ADR-0003 Step 8b 이후 — 구 `packages/relay,protocol,daemon` 트리거는 TS relay 퇴역과 함께 제거). **flip-live-on-merge** = 머지가 곧 `relay.tpmt.dev` 자동 cutover(downtime-OK). |

## v* 태그 release
| Target | Workflow | 설명 |
|--------|----------|------|
| tp 바이너리 | GitHub Actions `release.yml` | darwin-arm64 + linux × {arm64, x64} 빌드 → GitHub Release. `release.yml`은 `push: tags: [v*]` 와 `workflow_dispatch -f tag=...` 둘 다 받지만, GitHub API tag-creation 의 push event firing 이 누락되는 케이스가 잦아 (#172) **항상 manual dispatch 로 트리거** 한다. |
| Homebrew tap | GitHub Actions `release.yml` (tap bump step, `DaveDev42/homebrew-tap-release@v1` reusable action — PR #185) | `checksums.txt`에서 darwin sha256 추출 → `Formula/tp.rb` 렌더 → `davedev42/homebrew-tap` repo에 직접 push (PR 없음, commit subject = `tp <VERSION>`). `HOMEBREW_TAP_TOKEN` secret 미설정 또는 push 실패 시 `::warning::`로 swallow되어 release 자체는 성공으로 끝남 — 이 경우 `/release` 명령이 catch함. |
| TestFlight (5 플랫폼) | GitHub Actions `release.yml` `testflight` job (CD) → `testflight.yml` dispatch | **첫 수동 업로드(Task #122) 이후의 continuous deployment.** `release` + `bump-tap` 둘 다 성공하면 `testflight` job 이 `gh workflow run testflight.yml --ref <tag> -f tag=<tag>` 로 같은 태그의 5플랫폼 TestFlight 업로드를 **별도 run** 으로 깨운다. **별도 run 인 이유**: TestFlight 서명/업로드 실패가 이미 바이너리 publish + tap bump 를 끝낸 CLI release 를 red 로 만들지 않게 격리. `GITHUB_TOKEN` 으로 dispatch 가능 (`workflow_dispatch` 는 recursion 가드의 명시적 예외 — "workflow_dispatch events always create workflow runs", 공식 docs) — `actions: write` permission 만 필요. **#172-safe**: 태그를 push event 가 아니라 `-f tag`/`--ref` 로 **명시 전달**하므로 GitHub 의 push-event 누락에 영향받지 않음. **load-bearing 제약**: `--ref <tag>` 는 `testflight.yml` 을 그 *태그 트리* 에서 찾으므로(main 아님), testflight.yml 이 main 에 있는 한 앞으로 자르는 모든 태그는 이를 포함한다 — testflight.yml 존재 *이전* 의 옛 태그를 재릴리즈하면 이 dispatch 가 실패하지만, CD 는 항상 현재 main ≤ 태그에만 발화하고 첫 업로드는 수동이라 해당 없음. |

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

# 5. release.yml dispatch: 빌드 + GitHub Release + tap bump (+ TestFlight CD dispatch).
gh workflow run release.yml -f tag=vX.Y.Z
# → release.yml 은 `push: tags: [v*]` 트리거도 있지만 GitHub API
#   tag-creation 이 push event 를 항상 firing 하지는 않으므로 (#172)
#   manual dispatch 가 안전한 default.
# → release + bump-tap 성공 후 `testflight` job 이 자동으로
#   `testflight.yml` 을 같은 태그로 dispatch (CD — Task #122 첫 수동
#   업로드 이후). 별도 run 이라 release run 자체는 TestFlight 결과와
#   무관하게 green.

# 5b. (선택, read-only) TestFlight CD dispatch 발화 확인:
gh run list --workflow=testflight.yml --limit=3 \
  --json databaseId,event,headBranch,status,conclusion,createdAt
# → 가장 최근 run 의 event=workflow_dispatch + headBranch=vX.Y.Z 확인.
#   시크릿 미설정이면 guard job 들이 clean-skip (::notice::) — red 아님.

# 6. tap repo + brew 검증 (SLA 보장 step):
gh api repos/DaveDev42/homebrew-tap/commits/main --jq '.commit.message'
brew update && brew upgrade davedev42/tap/tp && tp version
```

## Infrastructure
- **Relay**: Vultr Seoul `relay.tpmt.dev` (wss://, Caddy TLS + systemd: `tp-relay`). **Rust 바이너리** `/usr/local/bin/tp-relay`(ADR-0003 Stage 1 Step 8b 이후; base unit `ExecStart=/usr/local/bin/tp-relay`, 시크릿은 drop-in `/etc/systemd/system/tp-relay.service.d/secrets.conf` — `TP_RELAY_RESUME_SECRET`/`TP_RELAY_PUSH_SEAL_SECRET[_PREV]`/APNs, deploy 가 안 건드림). 구 TS `tp relay start` 경로는 퇴역.
- **CLI**: GitHub Releases → `bun build --compile` (darwin/linux × arm64/x64; Windows users run the linux build under WSL)
- **Native App (iOS/iPadOS/macOS)**: 로컬 하네스 (`scripts/ios.sh`, `TP_PLATFORM=ios|macos` / `ios/`) — EAS 클라우드 빌드 제거됨. 단일 멀티플랫폼 SwiftUI 타깃; visionOS/watchOS 는 toolchain 게이트 뒤 Phase B (ADR-0001 재작성 + ADR-0002 플랫폼 범위 참조).

## GitHub Secrets
| Secret | 용도 |
|--------|------|
| `RELAY_HOST` | Relay 서버 IP |
| `RELAY_USER` | Relay SSH 사용자 |
| `RELAY_SSH_KEY` | Relay SSH 키 |
| `HOMEBREW_TAP_TOKEN` | `davedev42/homebrew-tap`에 push할 PAT (fine-grained, Contents: R/W). 미설정 시 release.yml의 tap update step이 `::warning::HOMEBREW_TAP_TOKEN not set`로 swallow하고 통과. |
| `APNS_KEY` | APNs HTTP/2 ES256 P-256 private key. `.p8` 파일 경로 또는 PEM 문자열 (인라인). Relay 서버 env에 주입. |
| `APNS_KEY_ID` | APNs Key ID (10자 대문자). Apple Developer Console에서 발급. |
| `APNS_TEAM_ID` | Apple Team ID (10자 대문자). |
| `APNS_BUNDLE_ID` | APNs topic (app bundle ID, e.g. `dev.tpmt.app`). |
| `APNS_ENV` | APNs 환경: `"sandbox"` (개발 relay) 또는 `"prod"` (배포 relay). Per-deployment — not on wire. |

# Version Management

- **NEVER bump versions** (package.json) unless the user explicitly requests it.
- Pre-1.0: only patch bumps (0.0.x).
- Release Please handles version bumps automatically via Conventional Commits — `bump-patch-for-minor-pre-major` is enabled so `feat:` commits stay patch-level while pre-1.0.
- Do not manually edit `version` fields in any package.json or `.release-please-manifest.json`.
