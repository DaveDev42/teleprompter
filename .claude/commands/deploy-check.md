---
description: CI와 동일한 로컬 사전 검증
---

## Deploy Check

CI(`ci.yml` — lint/type-check/test/build-cli/rust 5 job)와 동일한 검증을 로컬에서 순차 실행.
하나라도 실패 시 중단. 전부 `cd rust` + rustup-shim-safe PATH
(`TC_BIN="$(dirname "$(rustup which cargo)")"; PATH="$TC_BIN:$PATH"`) 에서:

1. `cargo fmt --all -- --check` — 포맷 검증 (CI `lint` job)
2. `cargo check --workspace --all-targets` — 타입/컴파일 체크 (CI `type-check` job)
3. `cargo clippy --workspace --all-targets` — 린트 (CI `rust` job; 심각도는 `[workspace.lints]` 가 SoT — `-- -D warnings` 절대 금지)
4. `cargo test --workspace` — 전체 테스트 + TS-era 골든벡터 (CI `test`/`rust` job)
5. `cargo build --release --bin tp` — CLI 바이너리 빌드 (CI `build-cli` job)
6. `target/release/tp version && target/release/tp --help` — smoke test
7. Runner-exec seam smoke (CI `build-cli` job 과 동일):
   ```bash
   TMP=$(mktemp -d) && printf '#!/bin/sh\necho "RUNNER_GOT: $@"\n' > "$TMP/tp-runner" && chmod +x "$TMP/tp-runner"
   TP_RUNNER_BIN="$TMP/tp-runner" target/release/tp run --sid x | grep -q "RUNNER_GOT: --sid x" || { echo "FATAL: tp run → tp-runner exec seam broken"; exit 1; }
   ```

각 단계 pass/fail 리포트. 전체 통과 시 push ready 보고.
