#!/usr/bin/env bash
# Build TpCore.xcframework from the tp-core crate (ADR-0001 Phase 2).
#
# Produces a binary xcframework containing static libs for (7 slices):
#   - aarch64-apple-ios            (device)
#   - aarch64-apple-ios-sim        (Apple-silicon Simulator)
#   - x86_64-apple-ios-sim         (Intel Simulator)   [lipo'd with arm64-sim]
#   - aarch64-apple-darwin         (Apple-silicon macOS)
#   - x86_64-apple-darwin          (Intel macOS)        [lipo'd with arm64 → macOS fat]
#   - aarch64-apple-visionos       (Apple Vision Pro device)              [B1, ADR-0002]
#   - aarch64-apple-visionos-sim   (visionOS Simulator, arm64-only — no lipo) [B1]
#   - aarch64-apple-watchos        (watchOS device, arm64-only — no lipo) [B3, ADR-0002]
#   - aarch64-apple-watchos-sim    (watchOS Simulator, arm64-only — no lipo) [B3]
# plus the UniFFI-generated Swift bindings (tp_core.swift) and the C
# header/modulemap the xcframework needs.
#
# visionOS and watchOS targets are stable on Rust ≥1.96 with prebuilt std (B0
# gate, no build-std). tp-core is pure portable Rust (zero cfg(target_os)) →
# straight recompiles.
#
# Output:
#   rust/target/TpCore.xcframework   (gitignored binary artifact)
#   ios/Generated/tp_core.swift      (checked in? no — generated, gitignored)
#
# Usage: rust/build-xcframework.sh [--debug]
#
# IMPORTANT (toolchain shim): this repo's PATH puts a rustup shim ahead of the
# real rustc, which makes cargo's internal `rustc -vV` read rustup's banner and
# fail with "didn't have a line for `host:`". We prepend the resolved toolchain
# bin dir so the real rustc/cargo win.

set -euo pipefail

RUST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$RUST_DIR/.." && pwd)"
TARGET_DIR="$RUST_DIR/target"
XCF="$TARGET_DIR/TpCore.xcframework"
GEN_DIR="$REPO_ROOT/ios/Generated"

PROFILE="release"
PROFILE_FLAG="--release"
if [ "${1:-}" = "--debug" ]; then PROFILE="debug"; PROFILE_FLAG=""; fi

log() { printf '\033[1;35m[rust]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[rust] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Resolve the real toolchain bin and put it FIRST on PATH (see header note).
ensure_toolchain() {
  command -v rustup >/dev/null 2>&1 || die "rustup not found"
  local tc; tc="$(rustup which cargo 2>/dev/null)" || die "cannot resolve cargo via rustup"
  TC_BIN="$(dirname "$tc")"
  export PATH="$TC_BIN:$PATH"
  # Sanity: cargo must now see a real host triple. Capture first — piping
  # `rustc -vV` straight into `grep -q` makes grep close the pipe early, which
  # SIGPIPEs rustc and trips `pipefail` (rc=141) even on a successful match.
  local vv; vv="$(rustc -vV)"
  case "$vv" in
    *$'\n'host:\ *) : ;;
    *) die "rustc host line missing — PATH shim not fixed" ;;
  esac
}

ensure_targets() {
  local needed=(
    aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
    aarch64-apple-darwin x86_64-apple-darwin
    aarch64-apple-visionos aarch64-apple-visionos-sim   # B1 (ADR-0002)
    aarch64-apple-watchos aarch64-apple-watchos-sim     # B3 (ADR-0002)
  )
  local installed; installed="$(rustup target list --installed)"
  for t in "${needed[@]}"; do
    echo "$installed" | grep -qx "$t" || die "missing rust target: $t (rustup target add $t)"
  done
}

build_target() {
  local triple="$1"
  log "building libtp_core.a for $triple ($PROFILE)"
  ( cd "$RUST_DIR" && cargo build -p tp-core $PROFILE_FLAG --target "$triple" )
}

gen_bindings() {
  # Generate Swift bindings from a built library (host dylib is fine — it has
  # the same UniFFI metadata as the cross-compiled archives).
  log "building host dylib for bindgen introspection"
  ( cd "$RUST_DIR" && cargo build -p tp-core $PROFILE_FLAG )
  local lib="$TARGET_DIR/$PROFILE/libtp_core.dylib"
  [ -f "$lib" ] || die "host dylib not found: $lib"
  rm -rf "$GEN_DIR" && mkdir -p "$GEN_DIR"
  log "generating Swift bindings → $GEN_DIR"
  ( cd "$RUST_DIR" && cargo run $PROFILE_FLAG --bin uniffi-bindgen -- generate \
      --library "$lib" --language swift --out-dir "$GEN_DIR" )
  # Swift 6 fix: UniFFI 0.28 emits `private var initializationResult` — a mutable
  # global the Swift-6 concurrency checker flags as non-Sendable shared state
  # (error under SWIFT_VERSION=6.0). It's a lazily-evaluated init-once constant
  # (Swift guarantees the closure runs exactly once, single-threaded), so it is
  # genuinely race-free; `nonisolated(unsafe)` is the correct annotation. UniFFI
  # fixed this upstream in 0.29 — drop this patch when the crate is bumped. We
  # own ios/Generated (gitignored, regenerated every build), so patching the
  # emitted file here is safe and reproducible.
  local gen_swift="$GEN_DIR/tp_core.swift"
  if [ -f "$gen_swift" ] && grep -q '^private var initializationResult' "$gen_swift"; then
    # BSD sed (macOS) in-place edit; the pattern is anchored and idempotent.
    sed -i '' 's/^private var initializationResult:/private nonisolated(unsafe) var initializationResult:/' "$gen_swift"
    log "patched tp_core.swift: initializationResult → nonisolated(unsafe) (Swift 6)"
  fi
  # The xcframework's headers dir needs the C header + a modulemap NAMED
  # `module.modulemap` (Xcode convention). UniFFI emits `<name>FFI.modulemap`.
  mkdir -p "$TARGET_DIR/headers"
  cp "$GEN_DIR/tp_coreFFI.h" "$TARGET_DIR/headers/"
  cp "$GEN_DIR/tp_coreFFI.modulemap" "$TARGET_DIR/headers/module.modulemap"
}

assemble_xcframework() {
  log "assembling TpCore.xcframework (7 slices: ios-device, ios-sim-fat, macos-fat, visionos-device, visionos-sim, watchos-device, watchos-sim)"
  # Combine the two iOS simulator slices (arm64 + x86_64) into one fat archive —
  # an xcframework allows at most one library per (platform, variant).
  local sim_fat="$TARGET_DIR/libtp_core-sim-fat.a"
  lipo -create \
    "$TARGET_DIR/aarch64-apple-ios-sim/$PROFILE/libtp_core.a" \
    "$TARGET_DIR/x86_64-apple-ios/$PROFILE/libtp_core.a" \
    -output "$sim_fat" 2>/dev/null || die "lipo failed combining simulator slices"

  # Combine the two macOS slices (arm64 + x86_64) into one fat archive.
  local macos_fat="$TARGET_DIR/libtp_core-macos-fat.a"
  lipo -create \
    "$TARGET_DIR/aarch64-apple-darwin/$PROFILE/libtp_core.a" \
    "$TARGET_DIR/x86_64-apple-darwin/$PROFILE/libtp_core.a" \
    -output "$macos_fat" 2>/dev/null || die "lipo failed combining macOS slices"

  # visionOS device + simulator are both arm64-only (no Intel Vision Pro / no
  # x86_64 xrOS sim), so each is a single-arch archive — no lipo needed.
  local visionos_dev="$TARGET_DIR/aarch64-apple-visionos/$PROFILE/libtp_core.a"
  local visionos_sim="$TARGET_DIR/aarch64-apple-visionos-sim/$PROFILE/libtp_core.a"

  # watchOS device + simulator are both arm64-only — no lipo needed (mirrors visionOS).
  local watchos_dev="$TARGET_DIR/aarch64-apple-watchos/$PROFILE/libtp_core.a"
  local watchos_sim="$TARGET_DIR/aarch64-apple-watchos-sim/$PROFILE/libtp_core.a"

  rm -rf "$XCF"
  xcodebuild -create-xcframework \
    -library "$TARGET_DIR/aarch64-apple-ios/$PROFILE/libtp_core.a" -headers "$TARGET_DIR/headers" \
    -library "$sim_fat" -headers "$TARGET_DIR/headers" \
    -library "$macos_fat" -headers "$TARGET_DIR/headers" \
    -library "$visionos_dev" -headers "$TARGET_DIR/headers" \
    -library "$visionos_sim" -headers "$TARGET_DIR/headers" \
    -library "$watchos_dev" -headers "$TARGET_DIR/headers" \
    -library "$watchos_sim" -headers "$TARGET_DIR/headers" \
    -output "$XCF" >&2
  log "✅ xcframework: $XCF"
}

main() {
  ensure_toolchain
  ensure_targets
  build_target aarch64-apple-ios
  build_target aarch64-apple-ios-sim
  build_target x86_64-apple-ios      # x86_64 sim slice (target triple is x86_64-apple-ios)
  build_target aarch64-apple-darwin  # Apple-silicon macOS
  build_target x86_64-apple-darwin   # Intel macOS
  build_target aarch64-apple-visionos       # Apple Vision Pro device (B1)
  build_target aarch64-apple-visionos-sim   # visionOS Simulator, arm64 (B1)
  build_target aarch64-apple-watchos        # watchOS device, arm64 (B3)
  build_target aarch64-apple-watchos-sim    # watchOS Simulator, arm64 (B3)
  gen_bindings
  assemble_xcframework
}

main "$@"
