//! In-crate UniFFI bindings generator.
//!
//! Run via `cargo run --bin uniffi-bindgen -- generate --library <dylib> \
//!   --language swift --out-dir <dir>` to emit the Swift bindings + modulemap
//! for the Teleprompter app. Driven by `scripts/ios.sh rust` (see rust/README.md).
fn main() {
    uniffi::uniffi_bindgen_main()
}
