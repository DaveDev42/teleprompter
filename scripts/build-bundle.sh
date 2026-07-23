#!/usr/bin/env bash
set -euo pipefail

# Assemble one per-platform release bundle tarball (Rust-only — #5 PR6).
# Replaces the retired `bun run scripts/build.ts --bundle` release path.
#
# Usage: scripts/build-bundle.sh <suffix> <rust-target>
#   suffix       release asset suffix: darwin_arm64 | linux_x64 | linux_arm64
#   rust-target  cargo target triple:  aarch64-apple-darwin | x86_64-unknown-linux-gnu | ...
#
# Output: dist/tp-<suffix>.tar.gz containing
#   tp-<suffix>/bin/tp                  Rust CLI entrypoint
#   tp-<suffix>/libexec/tp/tp-daemon    Rust daemon  (locate_tp_daemon)
#   tp-<suffix>/libexec/tp/tp-relay     Rust relay   (locate_tp_relay, `tp relay start`)
#   tp-<suffix>/libexec/tp/tp-runner    Rust runner  (locate_tp_runner, spawned per session)
#   tp-<suffix>/libexec/tp/tpd          STUB sh script — see below
#
# tpd stub: the Bun SEA blob (`tpd`, the last Bun artifact) was retired in PR6
# (#5 zero-Bun cascade) together with its exec route (Route::Forward /
# locate_bun_blob) — nothing in the current CLI execs tpd. Two consumers still
# hard-expect the tarball MEMBER to exist, so we ship a tiny placeholder:
#   1. upgrade.rs of already-installed pre-PR6 versions dies with
#      "tarball did not contain libexec/tp/tpd" during self-update unpack.
#   2. pre-PR6 install.sh revisions `cp` the member unconditionally under
#      `set -e`.
# The stub can only ever run mid-upgrade on a pre-#925 install (post-upgrade
# trees never exec it); it fails loudly instead of silently doing nothing.
# Drop the stub once pre-PR6 installs no longer need a self-update path.
#
# Each target builds on its native runner in CI (no cross-linker):
#   darwin_arm64 → macos-latest, linux_x64 → ubuntu-latest,
#   linux_arm64 → ubuntu-24.04-arm. `rustup target add` runs before this script.

SUFFIX="${1:?usage: scripts/build-bundle.sh <suffix> <rust-target>}"
RUST_TARGET="${2:?usage: scripts/build-bundle.sh <suffix> <rust-target>}"

cd "$(dirname "$0")/.."

# The Homebrew rustup shim mis-parses cargo subcommand args; prepend the active
# toolchain's real bin dir (honors rust/rust-toolchain.toml — works on CI too,
# where dtolnay/rust-toolchain also provides rustup).
if command -v rustup >/dev/null 2>&1; then
  PATH="$(dirname "$(cd rust && rustup which cargo)"):$PATH"
fi

cargo build --release --manifest-path rust/Cargo.toml --target "$RUST_TARGET" \
  --bin tp --bin tp-daemon --bin tp-relay --bin tp-runner

BUNDLE_DIR="dist/bundles/tp-${SUFFIX}"
rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR/bin" "$BUNDLE_DIR/libexec/tp"

cp "rust/target/${RUST_TARGET}/release/tp"        "$BUNDLE_DIR/bin/tp"
cp "rust/target/${RUST_TARGET}/release/tp-daemon" "$BUNDLE_DIR/libexec/tp/tp-daemon"
cp "rust/target/${RUST_TARGET}/release/tp-relay"  "$BUNDLE_DIR/libexec/tp/tp-relay"
cp "rust/target/${RUST_TARGET}/release/tp-runner" "$BUNDLE_DIR/libexec/tp/tp-runner"

printf '%s\n' \
  '#!/bin/sh' \
  '# tpd stub — the Bun runtime blob was retired in the Rust rewrite (#5 PR6).' \
  '# This member exists only so pre-PR6 `tp upgrade` unpack checks and old' \
  '# install.sh revisions (which hard-require libexec/tp/tpd) keep working.' \
  '# Nothing in the current CLI execs it.' \
  'echo "tp: tpd was retired in the Rust rewrite — this stub should never run." >&2' \
  'echo "    Reinstall tp: https://github.com/DaveDev42/teleprompter" >&2' \
  'exit 1' \
  > "$BUNDLE_DIR/libexec/tp/tpd"

chmod +x "$BUNDLE_DIR/bin/tp" "$BUNDLE_DIR"/libexec/tp/*

TARBALL="dist/tp-${SUFFIX}.tar.gz"
tar -czf "$TARBALL" -C dist/bundles "tp-${SUFFIX}"
echo "built ${TARBALL}:" >&2
tar -tzf "$TARBALL" >&2
