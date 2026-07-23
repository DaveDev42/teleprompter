---
description: 변경 파일 기반 스마트 테스트 실행
argument-hint: '<auto | core | proto | cli | daemon | runner | relay | app | unit | all>'
---

## 테스트 실행: $ARGUMENTS

> 백엔드/CLI 는 Rust 워크스페이스가 유일 구현이다 (#5 zero-Bun PR6 이후 —
> Bun/TS 백엔드와 `bun test` 는 삭제됨). cargo 는 rustup shim 이 인자를
> mis-parse 하므로 real toolchain bin 을 PATH 앞에 둔다:
> `TC_BIN="$(dirname "$(cd rust && rustup which cargo)")"` 후
> `PATH="$TC_BIN:$PATH" cargo …` (상세 rust/README.md).

### Step 1: 변경 범위 감지

`auto` 또는 인자 없음일 때, `git diff --name-only main`으로 변경 파일을 분석하여 아래 매핑에 따라 테스트 대상을 결정한다.

| 변경 경로 | 테스트 대상 | 명령어 (cwd = `rust/`) |
|-----------|------------|--------|
| `rust/tp-core/` | core | `cargo test -p tp-core` |
| `rust/tp-proto/` | proto | `cargo test -p tp-proto` |
| `rust/tp-cli/` | cli | `cargo test -p tp-cli` |
| `rust/tp-daemon/` | daemon | `cargo test -p tp-daemon` |
| `rust/tp-runner/` | runner | `cargo test -p tp-runner` |
| `rust/tp-relay/` | relay | `cargo test -p tp-relay` |
| `ios/` | app (Swift) | `scripts/ios.sh test` |

**의존성 전파 규칙:**
- `tp-core`/`tp-proto` 변경 → 전 crate 가 의존하므로 `cargo test --workspace`
- 그 외 crate 변경 → 해당 crate + 이를 의존하는 crate (`tp-daemon` 변경 → daemon + cli)
- 변경 없음 → "변경된 파일이 없습니다" 보고

### Step 2: 실행

1. `cargo check --workspace --all-targets` (fail-fast — 실패 시 테스트 실행하지 않음)
2. 감지된 대상별 테스트 순차 실행
3. 결과 요약 (passed/failed/ignored 카운트)

### 명시적 대상 지정

| 인자 | 명령어 |
|------|--------|
| `core`/`proto`/`cli`/`daemon`/`runner`/`relay` | `cargo test -p tp-<name>` |
| `app` | `scripts/ios.sh test` (Swift XCTest on Simulator) |
| `unit` | `cargo test --workspace` |
| `all` | check → `cargo test --workspace` → app(Swift) 순차 실행 |

여러 대상 지정 가능: `/test core daemon` → tp-core + tp-daemon 테스트.
