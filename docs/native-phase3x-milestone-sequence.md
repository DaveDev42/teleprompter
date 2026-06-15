# Phase 3.x — Unified Milestone Sequence (ANSI terminal × Multiplatform Apple)

> Merge of two design workflows (2026-06-15): the **ANSI terminal milestone** (#42)
> and the **multiplatform expansion** (#43, iOS/iPadOS/macOS/visionOS full + watchOS
> limited). Both designs were independently grounded in live HEAD and adversarially
> critiqued (both verdicts: `needs-revision`). This doc is the reconciled sequence —
> corrections from both critiques are already folded in. **Not yet approved for
> implementation.**

## The one fact that drives the whole ordering

The multiplatform critique **ran `rustup target add` live** on the build host
(rustc 1.92.0 stable) and got a hard failure:

```
$ rustup target add aarch64-apple-visionos
error: toolchain stable-aarch64-apple-darwin has no prebuilt artifacts
       available for target aarch64-apple-visionos ...
```

rustup does not even *list* `visionos`/`xros`/`watchos` on this toolchain. The
upstream rustc book says visionOS is now Tier 2 (PR #152021), but that lives in a
**newer stable than what's installed** — and watchOS `arm64_32` has historically
been build-std-only. macOS triples (`aarch64-apple-darwin`, `x86_64-apple-darwin`)
are **already installed and unblocked**.

**Consequence:** the work splits into two phases.

- **Phase A — proven-now:** ANSI terminal + iOS/iPadOS/macOS. Every triple installed,
  every mechanism verified. Ships today.
- **Phase B — toolchain-gated:** visionOS + watchOS. Blocked behind a `rustup update
  stable` (and possibly a nightly + `-Z build-std` branch in the xcframework script).
  Do **not** sequence these as if they were recompiles.

The two original tracks (ANSI render internals vs. platform shells/harness/xcframework)
touch **disjoint surfaces**, so within Phase A they can land in either order or in
parallel — the only overlap is a trivial merge of `project.yml` / `ios.sh`.

---

## PHASE A — ships now (all toolchain prereqs satisfied)

### A0 — gate: confirm the current green baseline
- `scripts/ios.sh smoke` green on iOS sim (8 markers `TP_BOOT_OK … TP_INPUT_OK`).
- `scripts/ios.sh test` = full XCTest suite green.
- This is the regression floor every later milestone must hold.

### A1 — ANSI terminal emulator via SwiftTerm (was #42)
**Goal:** real VT100/xterm render (cursor, SGR color, erase/clear, alt-screen,
scrollback) in the Terminal tab — display-only, no local PTY.

**Decision:** adopt **SwiftTerm** (MIT, SPM, iOS 14+, mature, ships in commercial
SSH apps). libghostty has no stable iOS embedding path; hand-rolled carries a
perpetual VT-conformance tail.

**Load-bearing constraint (verified):** `SessionStore.terminalOutput[sid]` (the raw
`String` accumulator) is **kept verbatim**. `RelayClient.checkInputEcho`
(`RelayClient.swift:529`) scans it with `.contains("tp-input-probe")` to fire
`TP_INPUT_OK`. The loopback echoes the probe as plain text with zero ANSI
(`local-relay-loopback.ts:230`), so the String path is structurally untouched.
SwiftTerm integration is **purely additive** — a new byte sink runs in parallel.

**Steps (critique-corrected):**
1. **`project.yml`** — add top-level `packages: { SwiftTerm: { url: …, from: "1.13.0" } }`
   + `- package: SwiftTerm` under the app target deps, **and unconditionally** under
   `TeleprompterTests` deps (verified: `@testable import` does NOT re-export SwiftTerm,
   so `HeadlessTerminal` is otherwise unreachable → first-build compile failure).
2. **BLOCKING pre-step** — after `scripts/ios.sh gen`, read the resolved package source
   under `DerivedData/SourcePackages/checkouts/SwiftTerm/` to pin the **exact**
   `feed` signature, the full `TerminalViewDelegate` required-method set, the
   `HeadlessTerminal` initializer, and the cell-attribute accessor. **Do not author
   any Swift against the GitHub-doc signatures** — treat those as hints only.
3. **`SessionStore.swift`** — add `static func ioData(from:) -> Data?`, refactor
   `ioText` to call it (preserves nil-on-bad-base64). Add
   `@MainActor var terminalByteSink: ((String, Data) -> Void)?` (NOT `@Published`).
   In `appendRec` case `"io"`: **keep** `terminalOutput[rec.sid, default: ""] += text`
   verbatim, then add `if let d = Self.ioData(from: rec) { terminalByteSink?(rec.sid, d) }`
   (fires only on successful decode, only after the String append).
4. **New `SwiftTermView.swift`** — `UIViewRepresentable` wrapping a SwiftTerm
   `TerminalView` subclass. Register the byte sink, **re-register on sid change**
   (`onChange(of: sid)` / `updateUIView`), clear on disappear. Keyboard input stays
   **disabled** for A1 — the existing `TextField` composer (`onSend`) is the sole
   input path (smoke-neutral). **No back-fill from the lossy accumulated String**
   (critique: String.utf8 vs raw Data can diverge on split multibyte → U+FFFD);
   emulator starts empty and renders go-forward bytes (documented limitation), or
   seeds from a raw-`Data`-per-sid buffer with a `fed-through-seq` marker if we want
   history. **A1 default: go-forward only.**
5. **`TerminalView.swift`** — swap the `ScrollView`+`Text` for `SwiftTermView`, keep
   the `accessibilityIdentifier "terminal-output"` (cosmetic — no test reads it),
   keep the composer + `onSend` + `sid` computed property unchanged.
6. **New `TerminalEmulatorTests.swift`** (`import SwiftTerm`) — offline XCTest
   (runs **in the Simulator** via `scripts/ios.sh test`; there is no host-only
   `swift test` path in this repo): SGR-color cell, CUP+EL overwrite, and the
   **probe-survives** test (feed `tp-input-probe\n` through `store.appendRec`, assert
   `terminalOutput[sid].contains("tp-input-probe")` — the exact `checkInputEcho`
   predicate — AND assert the byte sink does not mutate `terminalOutput`).
7. **Gates:** `scripts/ios.sh gen → test → smoke`; all 8 markers green incl.
   `TP_INPUT_OK sid=sess-smoketest`; all pre-existing tests stay green.
8. **Docs:** `ios/README.md` + this doc; mark #42 done. PR title:
   `feat: ANSI terminal emulation via SwiftTerm (Phase 3.x)`.

**A1 risks fenced:** probe regression (structurally impossible while the String append
stays; Test 3 catches a future feed-only refactor offline); SwiftTerm has no SwiftUI
view (hand-written bridge, signatures pinned in step 2); cols/rows not yet negotiated
→ alt-screen TUI may misrender until A-resize lands (documented; not overclaimed).

### A2 — multiplatform restructure to ONE target (iOS + iPadOS + macOS)
**Goal:** a single `Teleprompter` target compiles for iOS sim, iPadOS, and **native
macOS** (NOT Catalyst) from the same Sources, with **zero iOS behavioral change**.

**Mechanism (verified live):** XcodeGen 2.45.4 `supportedDestinations`. On the target,
replace `platform: iOS` with `platform: auto` + `supportedDestinations: [iOS, macOS]`
(visionOS added in Phase B). Per-platform deployment targets as sibling keys under
`options.deploymentTarget`: iOS `"17.0"` (keep), macOS `"14.0"`. **Drop** the
hardcoded `TARGETED_DEVICE_FAMILY: "1,2"` — presets inject it per destination (the
union becomes `1,2` for iOS, none for macOS; do not re-add a target-base value or it
clobbers the union). Native macOS = SwiftUI App lifecycle → AppKit automatically with
`SDKROOT=macosx` and **no** Catalyst flag. iPadOS is covered by the iOS destination +
device-family `2` automatically.

**Source portability: CONFIRMED** — all 10 Swift files are platform-neutral (zero
`import UIKit`/`AVFoundation`, zero `#if os()`; only SwiftUI/Foundation/Security/
URLSession/os, all available on macOS 14+). No source changes required to compile on
macOS beyond the project/plist/entitlements plumbing below.

**The three pre-M de-risks the critique demands BEFORE declaring "macOS compiles":**
1. **Info.plist split** — the single checked-in plist carries iOS-only keys
   (`UILaunchScreen`, `UIApplicationSceneManifest`, `UIApplicationSupportsIndirectInputEvents`).
   Decide & prove one: (a) keep the shared plist and verify macOS tolerates the extra
   UI* keys by actually building `platform=macOS`, or (b) move scene/launch keys to
   `INFOPLIST_KEY_*` per-platform settings + keep a minimal plist **solely** for
   `CFBundleURLTypes` (which has **no** `INFOPLIST_KEY_` form). Pick one, prove it.
2. **Per-destination entitlements** — macOS needs a NEW `Teleprompter-macOS.entitlements`
   (`com.apple.security.app-sandbox` + `com.apple.security.network.client` — without
   the latter the localhost WS won't open and `TP_RELAY_AUTH_OK` never fires —
   + `keychain-access-groups`). Verify XcodeGen 2.45.4 can express per-supportedDestination
   `CODE_SIGN_ENTITLEMENTS`; if it can't, that's the one fact that could force per-platform
   targets-sharing-Sources instead of a single target. **De-risk this first.**
3. **macOS deep-link delivery** — harness injects `tp://` via LaunchServices
   `open 'tp://…'` (not `simctl openurl`); may need `lsregister -f Teleprompter.app`
   first. Prove in isolation.

**iPadOS:** covered for free by the iOS destination. Decide whether a distinct
multi-column iPad layout is in-scope for "full experience" or the shared layout
suffices (open question — recommend: shared layout for A2, iPad polish later if needed).

**Verify:** iOS `scripts/ios.sh smoke` still green (no regression); macOS
`xcodebuild … -destination 'platform=macOS' build` succeeds and produces
`Teleprompter.app`.

### A3 — harness: per-destination build/test/smoke (macOS-native fast path)
**Goal:** `scripts/ios.sh` gains `TP_PLATFORM` (`ios`|`macos`, default `ios` →
**byte-for-byte current behavior when unset**). macOS bypasses simctl: launch via
`open` / exec the binary, inject deep link via LaunchServices, scrape markers from
the **host** unified log (`log show --predicate 'subsystem == "dev.tpmt.teleprompter"'`,
likely with `--debug --info` since host OSLog drops Debug/Info by default).

**Critique guardrail:** the shared simctl marker-polling loop (`ios.sh:247-296`) is
**never refactored** in a way that changes the iOS path. macOS is a separate
non-default branch. Prove host `log show` scrape + sandbox `network.client` +
`lsregister` deep-link in isolation before wiring into `smoke`'s assert chain. The
loopback relay is transport-only and unchanged.

**Verify:** `TP_PLATFORM=ios smoke` unchanged; `TP_PLATFORM=macos smoke` → all 8
markers green from the host log; `scripts/ios.sh test` runs XCTest per platform.
**macOS-native is the FAST regression path** (no sim boot) — good default for non-UI
logic.

### A4 — macOS-native UX polish ✅ (shipped)
**Goal:** a complete native-Mac experience, not a stretched iPad app: window min-size
+ restoration, a Commands menu (New Pairing / Disconnect / Copy daemon id), keyboard-
first nav, and a macOS-idiomatic `NavigationSplitView` sidebar where the bottom
`TabView` doesn't fit. Platform branches live in a dedicated `MacCommands.swift`
(`#if os(macOS)`) to keep core views neutral and avoid `#if os()` sprawl on the iOS path.

**Shipped as:**
- `MacCommands.swift` (`#if os(macOS)`) — `Commands` replacing the File→New slot:
  New Pairing… (⌘N, guidance alert — pairing is out-of-band via `tp pair`), Copy
  Daemon ID (⌘⇧C), Disconnect (⌘⌫). All operate on the single active daemon
  (matching the current single-daemon flow); disabled when no pairing exists.
- `RootView` split: iOS/iPadOS keep the bottom `TabView`; macOS uses
  `NavigationSplitView` (sidebar selection, keyboard-navigable) via `MacRootView`.
  Both render the **same** `SectionView` bodies (shared `AppSection` enum) so the
  shells can never drift — the only divergence is the chrome.
- Window scene: `.defaultSize(980×680)` + `.windowResizability(.contentMinSize)` +
  a `640×480` content floor (`#if os(macOS)`), so the window can't collapse below a
  usable size.
- **Boot/core markers moved to `TeleprompterApp.init`** (was `ContentView.onAppear`).
  The macOS `NavigationSplitView` detail pane mounts lazily and its appearance hook
  does NOT fire for a window launched in the background (`open -gn`, as the headless
  smoke does), so `TP_BOOT_OK`/`TP_CORE_OK` must emit at process launch, independent
  of view appearance. This is also simply more correct (an app-launch fact, not a
  per-tab one).

**Verified:** `TP_PLATFORM=macos smoke` 8/8 green (0 orphans), iOS smoke 8/8 green,
51/51 XCTest (+3 `AppSectionTests` pinning the shared navigation model). A dedicated
macOS test target was deferred — the test bundle is `platform: iOS`, so a
`MacWindowTests` (`#if os(macOS)`) would not run there; the macOS shell is instead
exercised end-to-end by the macOS smoke, and the shared `AppSection` model (the real
new logic) is unit-tested on the iOS target.

### A5 — ADR-0002 + doc sweep (lands with the A-track, not after)
- **CREATE `docs/adr/0002-multiplatform-apple-expansion.md`** (new ADR — Accepted ADRs
  are never silently edited; supersede + new ADR per `docs/adr/README.md:17`). Decision:
  promote iOS/iPadOS/macOS(native, not Catalyst)/visionOS to full + watchOS limited;
  ground it in Dave's verbatim multiplatform directive (mirror 0001:16-21). Record the
  Phase A/B split and the toolchain gate. Status Accepted (2026-06-15).
- **`docs/adr/0001`** — add a status line "Superseded by 0002 (platform scope)"; leave
  body intact (historical record).
- **`CLAUDE.md`** — overview (7), rewrite note (9), Tech-Stack App entry (13), Platform
  priority (80), QA dispatch (102-103), Testing/commands (117,124-125), Dogfood (141),
  Deployment (228), "iOS / Native Build" heading → "Native App Build (Multiplatform)"
  (328-344). Keep the Web/Android demotion clause.
- **`scripts/ios.sh` header**, **`project.yml` header**, **`ios/README.md`**,
  **`.claude/rules/release-deploy.md:68`**, **`.claude/rules/ci-workflows.md`** `paths:`
  — make platform-aware; document `TP_PLATFORM`.
- **Dir name:** KEEP `ios/` (rename = 66 lines across 13 files for zero functional
  benefit; `ios.sh` abstracts via `IOS_DIR`, the xcframework relative path is dir-name-
  independent). Cosmetic rename, if ever, = isolated `git mv` chore PR.

---

## PHASE B — toolchain-gated (do NOT start until the gate passes)

### B0 — HARD GATE: Rust toolchain for visionOS / watchOS ✅ (PASSED 2026-06-15)
```
rustup update stable            # 1.92.0 → 1.96.0 (ac68faa20 2026-05-25)
rustup target list | grep -E 'visionos|watchos'
```
**Result — UNBLOCKED, better than predicted.** On stable **1.96.0**, BOTH platforms
are stable rustup targets with **prebuilt `rust-std`** — no nightly, no `-Z build-std`:
- `aarch64-apple-visionos` + `aarch64-apple-visionos-sim`
- `aarch64-apple-watchos` + `aarch64-apple-watchos-sim`

`rustup target add aarch64-apple-visionos-sim aarch64-apple-watchos-sim` succeeded
(downloaded prebuilt std), and **`tp-core` compiles cleanly for both sim targets**
(`cargo build -p tp-core --target …` — full UniFFI + crypto stack: x25519-dalek,
chacha20poly1305, blake2). So the watchOS Rust core — the part feared to need
build-std for `arm64_32` — is a straight recompile on the *current* triples.

**Implication for B1–B3:** the original "watchOS `arm64_32` is build-std-only" caveat
is **superseded for the simulator/`aarch64` device path** — Phase B's Rust side is a
recompile, not a research project. The lone remaining build-std risk is the legacy
**watchOS `arm64_32`** device triple (older Apple Watch hardware); the modern
`aarch64-apple-watchos` device slice is stable. Decide at B3 whether to ship
`arm64_32` at all (it only matters for Series 3-era 32-bit watches).

Until this gate passed, visionOS/watchOS were kept entirely out of
`supportedDestinations` and the xcframework so an absent slice couldn't fail the
Phase-A iOS/macOS smoke at link time. That constraint is now lifted for B1+.

### B1 — tp-core xcframework: add visionOS slices (5 total)
After B0 passes: add `aarch64-apple-visionos` (device) + `aarch64-apple-visionos-sim`
(arm64-only, no lipo) to `build-xcframework.sh`. Final `-create-xcframework` = 5
`-library` slices (ios-device, ios-sim-fat, macos-fat, visionos-device, visionos-sim).
UniFFI bindings stay single-gen (host build, platform-agnostic). tp-core is pure
portable Rust (zero `cfg(target_os)`) → straight recompiles. Verify:
`plutil -p …/Info.plist | grep -c LibraryIdentifier == 5`.

### B2 — visionOS destination + adaptation
Add `visionOS` to `supportedDestinations`, `visionOS "1.0"` deployment target.
`TP_PLATFORM=visionos` harness branch (visionOS Simulator, `Debug-xrsimulator`,
simctl on the xrOS runtime). Complete spatial experience: glass-background
`WindowGroup`, ornament toolbar for tab switching, hover affordances; terminal in a
flat readable panel. Branches in `VisionAdaptations.swift` (`#if os(visionOS)`).
Verify: `TP_PLATFORM=visionos smoke` → 8 markers on Apple Vision Pro sim.

### B3 — watchOS limited target (SEPARATE target)
A separate `TeleprompterWatch` target (NOT in `supportedDestinations` — watch app +
WidgetKit model differs), reusing tp-core (watchOS xcframework slices: device
`aarch64-apple-watchos` + `aarch64-apple-watchos-sim` — **both stable targets, plain
recompile, NO build-std**, confirmed at B0; legacy 32-bit `arm64_32` is the ONLY
build-std-needing triple and is optional, Series 3-era hardware only) + the
platform-neutral Swift (RelayClient,
RelayMessages, SessionStore, PairingStore, TpCoreCheck — all UIKit-free, cross-compile
free). **Standalone** (own frontendId, own kx, pairing secret via synced iCloud
Keychain — `kSecAttrSynchronizable` already set, `PairingStore.swift:183`).

**Limited scope (read-mostly glance):** session list w/ status; the Stop event's
`last_assistant_message` as one readable card; lightweight approve/deny when a session
awaits input; optional short voice-dictation reply. **Explicitly OUT:** Terminal
tab / PTY io (no `TP_INPUT_OK` on watch), multi-tab nav, full chat scrollback.

Verify: `TP_PLATFORM=watchos smoke` asserts the **reduced** marker subset
`TP_BOOT_OK + TP_CORE_OK + TP_RELAY_AUTH_OK + TP_KX_OK + TP_FRAME_OK + TP_SESSION_OK`
(no `TP_INPUT_OK`). xcframework slice count → 7.

---

## Dependency graph (what blocks what)

```
A0 (baseline) ─┬─→ A1 (ANSI / SwiftTerm) ──────────────┐
               │                                        ├─→ A5 (ADR-0002 + docs)
               └─→ A2 (multiplatform target, iOS+mac) ──┤
                        └─→ A3 (harness TP_PLATFORM) ────┤
                                 └─→ A4 (mac UX polish) ─┘

                    [ rustup update gate: B0 ]
                              │
                    ┌─────────┴─────────┐
                    ↓                   ↓
              B1 (visionOS xcfw)   (watch xcfw via build-std)
                    ↓                   ↓
              B2 (visionOS UX)     B3 (watchOS limited)
```

- **A1 and A2 are independent** (disjoint surfaces) — either order or parallel; only a
  trivial `project.yml`/`ios.sh` merge. If parallel, the ANSI track owns TerminalView
  render internals, the platform track owns shells/harness/xcframework.
- **ANSI (A1) is implemented ONCE** and rides on top of the multiplatform structure —
  no double implementation across platforms (per the "병행, ANSI once" decision).
- **Phase B is fully gated on B0.** macOS does not wait on B0.

## Open questions to settle at approval time
1. iPadOS: shared iOS layout for "full experience," or a distinct multi-column iPad UI?
   (Recommend shared for A2.)
2. A1 terminal: go-forward-only render (simplest, recommended) vs. raw-Data history
   back-fill with a `fed-through-seq` marker?
3. Cols/rows resize negotiation (`in.term` resize → daemon): in A1, or a follow-up
   after alt-screen render is proven? (Recommend follow-up; document the limitation.)
4. SwiftTerm version pinning: commit `Package.resolved` via a `.gitignore` exception
   now, or defer (the `.xcodeproj` is gitignored wholesale)?
