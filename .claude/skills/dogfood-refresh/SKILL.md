---
name: dogfood-refresh
description: Use when refreshing the local dogfood `tp` install — right after a PR touching rust/tp-{cli,daemon,runner,relay,proto,core} merges to main, at the start of a local dev session, or on any explicit request to reinstall/update/"최신으로 깔아줘" `tp`. Rebuilds and reinstalls the CLI + daemon + runner + relay prefix-tree bundle.
allowed-tools: Bash, Read
---

# Dogfood `tp` 바이너리 재빌드 & 재설치

이 skill 은 CLAUDE.md `## Dog-fooding (tp 백엔드 파이프라인)` 섹션(§ Local `tp` Binary Freshness)의 절차를 그대로 보존한 실행 가이드다. 이 repo 에서 Claude Code 는 **항상 `tp` 로 실행**한다(`claude ...` 아님) — 모든 세션이 로컬 daemon → relay 파이프라인을 타게 해 백엔드(daemon/relay/runner)를 매일 dogfood 한다. 그래서 **main 에 머지된 내 변경은 즉시 사용자의 로컬 `tp`/daemon 에 반영되어 있어야 한다.**

## 언제 실행하는가 (묻지 말고 실행)

1. **PR squash merge 직후** — `rust/tp-cli/**`, `rust/tp-daemon/**`, `rust/tp-runner/**`, `rust/tp-relay/**`, `rust/tp-proto/**`, `rust/tp-core/**` 중 하나라도 건드린 PR이 main 에 merge 됐을 때.
2. **로컬 dev 세션 시작 시** — 아래 시퀀스 한 번 돌려 PATH `tp` + daemon 을 `origin/main` 최신에 맞춘다.
3. **"최신으로 깔아줘" 명시 요청 시** — 확인 없이 실행한다.

## 번들 구조 (#5 PR6 이후 순수 Rust)

> **#5 PR6 이후: dogfood `tp` 는 순수 Rust 번들이다.** 출하 아티팩트 = `bin/tp`(Rust CLI) + `libexec/tp/{tp-daemon, tp-runner, tp-relay}` (= `scripts/build-bundle.sh` 가 조립하는 릴리즈 레이아웃과 동일; 릴리즈 tarball 은 pre-PR6 `tp upgrade`/install.sh 호환용 **`tpd` sh stub** 을 추가로 실을 뿐 — Bun blob 은 삭제됐고 로컬 dogfood 조립엔 tpd 가 아예 불필요). `tp daemon start` → `locate_tp_daemon()`→`libexec/tp/tp-daemon`, daemon 이 세션마다 `locate_tp_runner()`→`libexec/tp/tp-runner` 스폰. **symlink 만 깔고 `tp-daemon` 이 없으면 `bundled tp-daemon not found` 로 daemon 이 안 뜬다**(#922 flip 직후 실제 P0).

자식 바이너리 탐색 규칙(`locate_tp_*`)의 상세는 아래 "세부 사항" 을 보라.

## 재빌드 + 재설치 절차 (verbatim — 순서/문구 임의 변경 금지)

아래 bash 블록은 CLAUDE.md 원문을 그대로 옮긴 것이다. codesign 순서와 "반드시 전부" 요구사항은 load-bearing 이므로 절대 축약하거나 "개선"하지 말 것.

```bash
# Rust CLI + daemon + runner + relay (release) — rustup shim 이 cargo 인자를
# mis-parse 하므로 real toolchain bin 을 PATH 앞에.
TC_BIN="$(dirname "$(cd rust && rustup which cargo)")"
( cd rust && PATH="$TC_BIN:$PATH" cargo build --release \
    --bin tp --bin tp-daemon --bin tp-runner --bin tp-relay )      # → rust/target/release/{tp,tp-daemon,tp-runner,tp-relay}
# prefix-tree 조립 (레이아웃 = bin/tp + libexec/tp/{tp-daemon,tp-relay,tp-runner})
TP_PREFIX="$HOME/.local/share/tp"
mkdir -p "$TP_PREFIX/bin" "$TP_PREFIX/libexec/tp"
cp rust/target/release/tp        "$TP_PREFIX/bin/tp"
cp rust/target/release/tp-daemon "$TP_PREFIX/libexec/tp/tp-daemon"  # 필수 (daemon)
cp rust/target/release/tp-runner "$TP_PREFIX/libexec/tp/tp-runner"  # 필수 (세션 스폰)
cp rust/target/release/tp-relay  "$TP_PREFIX/libexec/tp/tp-relay"   # `tp relay start` 용
chmod +x "$TP_PREFIX/bin/tp" "$TP_PREFIX"/libexec/tp/{tp-daemon,tp-runner,tp-relay}
# cp 가 서명을 깨뜨려(`codesign -v` → "code or signature have been modified")
# Rust tp→{tp-daemon,tp-runner} exec 가 AMFI 에 SIGKILL(exit 137) 당한다.
# Rust tp 가 exec 하는 모든 자식 + parent(bin/tp) 를 전부 adhoc 재서명해 서명을
# 일관되게 맞춘다 (일부만 재서명하면 parent/child 불일치로 여전히 kill — 반드시 전부).
for b in libexec/tp/tp-daemon libexec/tp/tp-runner libexec/tp/tp-relay bin/tp; do
  codesign --force --sign - "$TP_PREFIX/$b"
done
ln -sf "$TP_PREFIX/bin/tp" ~/.local/bin/tp                          # dogfood symlink → Rust tp
~/.local/bin/tp daemon install                                      # 재등록 (Rust tp → Rust tp-daemon)
```

## 세부 사항 (모두 load-bearing — 생략 금지)

- **dogfood = `~/.local/bin/tp`(→ `~/.local/share/tp/bin/tp` Rust), brew(릴리즈) = `/opt/homebrew/bin/tp` 로 분리.** `~/.zprofile` 이 `~/.local/bin` 을 앞에 둬 `tp` 는 dogfood 를 가리킨다. **brew symlink 를 절대 덮지 않는다** (덮으면 `brew upgrade` 무력화 — 복구는 `brew link --overwrite tp`). dogfood 를 끄려면 `rm ~/.local/bin/tp`.

- **Rust `tp` 는 3개 자식 바이너리를 `canonicalize(current_exe())/../../libexec/tp/<name>` 로 찾는다**: `locate_tp_daemon()`→`tp-daemon`(daemon start), `locate_tp_runner()`→`tp-runner`(daemon 이 세션마다 스폰), `locate_tp_relay()`→`tp-relay`(`tp relay start`). (`locate_bun_blob()`→`tpd` passthrough fallback 은 #5 PR6 에서 삭제 — passthrough 는 native terminal-proxy.) 그래서 `bin/tp` + `libexec/tp/{tp-daemon,tp-runner,tp-relay}` prefix-tree 레이아웃이 필수다 — **symlink 만 깔고 `tp-daemon` 이 없으면 `tp daemon start` 가 `bundled tp-daemon not found` 로 실패**(#922 flip 직후 실제 P0), `tp-runner` 가 없으면 세션 스폰이 실패한다.

- `daemon install` 은 plist 바이너리 경로를 `which tp` 로 고르므로 **`~/.local/bin/tp` 로 직접 실행**해야 한다. 새 로그인 셸 전이면 `PATH="$HOME/.local/bin:$PATH" ~/.local/bin/tp daemon install`. #4 flip 이후 **daemon 프로세스는 `tp-daemon` 으로 뜬다** (Rust — `pgrep -fl tp-daemon` 로 확인; 옛 `tpd` 트램폴린 아님).

- **adhoc 재서명은 dogfood 조립에서 필수** (macOS 로컬): `cargo build` 산출물은 linker-adhoc 서명을 갖는데, `cp` 가 payload 레이아웃/해시를 바꿔 그 서명을 무효화한다 (`codesign -v` → "code or signature have been modified"). 바이너리를 **직접 실행**하면 통과하지만, Rust `tp` 가 자식(`tp-daemon`/`tp-runner`/`tp-relay`)을 **exec** 하면 AMFI 가 SIGKILL(exit 137, 간헐적으로 보이지만 실제로는 일관 실패) 한다. 해결 = **`bin/tp` + Rust `tp` 가 exec 하는 모든 `libexec/tp/*` 자식을 전부** `codesign --force --sign -` 로 plain-adhoc 재서명(서명 일관성 — 일부만 재서명하면 parent/child 서명 불일치로 여전히 kill). `install.sh` 릴리즈 경로는 macOS 러너에서 빌드+서명된 tarball 을 `tar` 추출하므로 이 문제가 없다(로컬 `cp` 조립에서만 발생). 재서명 후 `tp version` + `tp status`(daemon running) 로 검증한다.

- **재기동은 `tp daemon install` 한 번** (`pkill` 후 수동 재시작 금지 — 서비스 미등록 프로세스로 살아남아 OTA 안 됨). 재기동 후 `tp status` 로 daemon running 확인 + daemon.log 에서 `[RelayClient] authenticated to relay`(wss:// 연결 성공) 확인.

- **Subagent worktree 가 active 인 동안 install 금지** — 모든 subagent 완료 알림 도착 + 메인 worktree `git status` clean 후 한꺼번에 실행한다. 옛 `/usr/local/bin/tp` 잔재 발견 시 `rm`.

## 검증 (실행 후 반드시 확인)

재빌드/재설치 시퀀스가 끝나면 아래 세 가지로 성공을 확인한다:

1. `tp version` — dogfood 바이너리가 정상 실행되는지 (exec 이 AMFI 에 죽지 않고) 확인.
2. `tp status` — daemon 이 running 상태인지 확인 (daemon 자동 시작 포함).
3. daemon.log 에서 `[RelayClient] authenticated to relay` 라인 확인 — wss:// relay 연결이 실제로 성공했는지 확인 (daemon 이 떠 있어도 relay 인증이 실패할 수 있으므로 이 라인 없이는 dogfood 파이프라인이 완전히 살아있다고 보지 않는다).

추가로 `pgrep -fl tp-daemon` 로 daemon 프로세스가 (옛 `tpd` 트램폴린이 아니라) Rust `tp-daemon` 으로 떠 있는지 확인할 수 있다.

