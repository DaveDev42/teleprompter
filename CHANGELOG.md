# Changelog

## [0.1.20](https://github.com/DaveDev42/teleprompter/compare/v0.1.19...v0.1.20) (2026-05-02)


### Features

* **app:** wire resume token + kx skip into FrontendRelayClient ([#173](https://github.com/DaveDev42/teleprompter/issues/173)) ([4058d38](https://github.com/DaveDev42/teleprompter/commit/4058d38a026d6ca2e9daff45a7554c8773e799f4))
* automate Homebrew tap updates + add /release command ([#174](https://github.com/DaveDev42/teleprompter/issues/174)) ([e7d2506](https://github.com/DaveDev42/teleprompter/commit/e7d2506208af60f7adc63d5acdeedb257de06556))
* encode pairing QR as teleprompter:// deep link ([#177](https://github.com/DaveDev42/teleprompter/issues/177)) ([7a544b7](https://github.com/DaveDev42/teleprompter/commit/7a544b72a7765119b15661e56ca5af0004169868))


### Bug Fixes

* notify on Notification hook + forward all hooks during spawning ([#175](https://github.com/DaveDev42/teleprompter/issues/175)) ([ecb0da6](https://github.com/DaveDev42/teleprompter/commit/ecb0da66cc155c3d1e91696e1d2135afbc04d6b3))

## [0.1.19](https://github.com/DaveDev42/teleprompter/compare/v0.1.18...v0.1.19) (2026-05-02)


### Features

* **relay:** tune for 10k connections + HMAC resume tokens + kx skip ([#170](https://github.com/DaveDev42/teleprompter/issues/170)) ([04c93de](https://github.com/DaveDev42/teleprompter/commit/04c93deb612d061041cdfb55f691a65e705cf097))


### Bug Fixes

* **cli:** inject fetchLatest into checkForUpdates to kill Windows flake ([86360b6](https://github.com/DaveDev42/teleprompter/commit/86360b63d7ffbb1dd2717f8601669f5f26bbc383))
* **cli:** inject fetchLatest into checkForUpdates to kill Windows flake ([e372274](https://github.com/DaveDev42/teleprompter/commit/e372274eebd68b53f9a047e6bc630ab2cb731fbd))


### Refactor

* route bare tp to claude passthrough and combine help/version/doctor/upgrade output ([#168](https://github.com/DaveDev42/teleprompter/issues/168)) ([6cd7189](https://github.com/DaveDev42/teleprompter/commit/6cd71890a3de2a290c5d8b8146e40b906bab8fac))

## [0.1.18](https://github.com/DaveDev42/teleprompter/compare/v0.1.17...v0.1.18) (2026-04-25)


### Bug Fixes

* **cli:** make daemon-status test tolerate installed service ([8f06e3e](https://github.com/DaveDev42/teleprompter/commit/8f06e3ed8670d0a8eaddfd24efcb351c0b65f1a3))
* **cli:** make daemon-status test tolerate installed service ([91abf0b](https://github.com/DaveDev42/teleprompter/commit/91abf0b3817178b79163668c096b292b95372eca))


### Refactor

* **ipc:** binary sidecar for PTY io records — Runner ↔ Daemon IPC frames now carry raw PTY bytes in an optional sidecar (`u32 jsonLen | u32 binLen | JSON | binary`) instead of base64'ing the payload into the JSON body. Eliminates the ~33% base64 overhead and removes one encode + one decode per record. Daemon ↔ Relay WebSocket protocol unchanged. Wire format note: a stale runner that survives a `tp upgrade` cannot decode the new frames; `SessionManager` kills and respawns runners on daemon startup, so the normal upgrade path is unaffected. ([#136](https://github.com/DaveDev42/teleprompter/pull/136))

## [0.1.17](https://github.com/DaveDev42/teleprompter/compare/v0.1.16...v0.1.17) (2026-04-23)


### Bug Fixes

* **app:** align Expo SDK 55 packages with expo-doctor ([cdbb7de](https://github.com/DaveDev42/teleprompter/commit/cdbb7def82868105f8a669e4eb893dd4b964deb3))
* **app:** bump Expo SDK 55 packages to expo-doctor 'expected' versions ([f8ca6b8](https://github.com/DaveDev42/teleprompter/commit/f8ca6b8318bd6f560b6c9f693574d69fe1ee071e))
* **app:** clarify optimistic chat dedup comments and test wording ([4cffb80](https://github.com/DaveDev42/teleprompter/commit/4cffb806560f733b2c32453e524abc036d4efeb7))
* **app:** extend control-plane decrypt silence to __meta__ and harden tests ([44f8e1b](https://github.com/DaveDev42/teleprompter/commit/44f8e1b2f51b1eed68386d410e9d12e05cb7b32c))
* **app:** harden optimistic chat dedup against streaming + voice paths ([953bda0](https://github.com/DaveDev42/teleprompter/commit/953bda0abc9ce0fa5b6d9aee992e46494e0b33a6))
* **app:** queue encrypted frames until relay kx completes ([14e504d](https://github.com/DaveDev42/teleprompter/commit/14e504d72146bdddec7c627e099d96b13c002b3f))
* **app:** queue encrypted frames until relay kx completes ([a73b409](https://github.com/DaveDev42/teleprompter/commit/a73b4095ffc4ede2a75b677f59569a027a80bfb9))
* **app:** render optimistic user bubble on chat send ([44fd04f](https://github.com/DaveDev42/teleprompter/commit/44fd04f78e68cab8205fd855cb2461436c0e066a))
* **app:** render optimistic user bubble on chat send ([aaddbf3](https://github.com/DaveDev42/teleprompter/commit/aaddbf3cc944a73c01b606f4fbe741c26a923c4c))
* **app:** silence per-frontend decrypt failures on __control__ sid ([e045780](https://github.com/DaveDev42/teleprompter/commit/e0457804c8f307f6ed084df43326521445c041db))
* **app:** silence per-frontend decrypt failures on __control__ sid ([6f3846b](https://github.com/DaveDev42/teleprompter/commit/6f3846b04d72b72fd5b16637c998d6983f060844))
* **app:** surface stopped-session state with banner, disabled inputs, and terminal fallback ([c66e016](https://github.com/DaveDev42/teleprompter/commit/c66e0162220953bafec41cb9a4c3754b54c9604b))
* **app:** surface stopped-session state with banner, disabled inputs, and terminal fallback ([70ee3f2](https://github.com/DaveDev42/teleprompter/commit/70ee3f28c58845ccad83677d9051ba6e11d91403))
* **cli:** add `tp session list/delete/prune` for zombie cleanup ([d033126](https://github.com/DaveDev42/teleprompter/commit/d033126f9012ac7cc6b3b9ebb9129037440b0d9c))
* **cli:** add tp session list/delete/prune for zombie cleanup ([95a52d1](https://github.com/DaveDev42/teleprompter/commit/95a52d1b4a12e22b5477129dab2fc4ec0ce3490d))
* **protocol:** accept session.delete/prune frames in IPC guard ([ba1032f](https://github.com/DaveDev42/teleprompter/commit/ba1032f4259eefcb2cf96f746da2ab4c8fd22bfe))
* **protocol:** accept session.delete/prune frames in IPC guard ([8670c0e](https://github.com/DaveDev42/teleprompter/commit/8670c0ef77823292230036e3eba551ca4f450671))

## [0.1.16](https://github.com/DaveDev42/teleprompter/compare/v0.1.15...v0.1.16) (2026-04-22)


### Features

* **cli:** route tp pair delete/rename through the running daemon ([6d31788](https://github.com/DaveDev42/teleprompter/commit/6d31788fac18375ee9128c0b4a2f45d17a597b0f))
* **daemon:** handle pair.remove/pair.rename IPC via RelayConnectionManager ([f5b061e](https://github.com/DaveDev42/teleprompter/commit/f5b061e6b6365012261b59b6e693c61c111b2b8f))
* **pair:** route tp pair delete/rename through daemon IPC ([91f208b](https://github.com/DaveDev42/teleprompter/commit/91f208b50069763fe040de982239a7434765045b))
* **protocol:** add pair.remove/pair.rename IPC message types ([6b2b3bd](https://github.com/DaveDev42/teleprompter/commit/6b2b3bdd7844e2879e01f73e03b02db77a7e3c41))


### Performance Improvements

* fix hot-path bottlenecks and long-running memory leaks ([1ac583b](https://github.com/DaveDev42/teleprompter/commit/1ac583be40856035929c8742cd1adc5251644969))

## [0.1.15](https://github.com/DaveDev42/teleprompter/compare/v0.1.14...v0.1.15) (2026-04-22)


### Miscellaneous Chores

* trigger v0.1.15 release ([9f607cd](https://github.com/DaveDev42/teleprompter/commit/9f607cdee8662d13cdd835373561d599b44694da))

## [0.1.14](https://github.com/DaveDev42/teleprompter/compare/v0.1.13...v0.1.14) (2026-04-22)


### Bug Fixes

* **cli:** harden download lifecycle (timers, abort reasons, drain race) ([785a04b](https://github.com/DaveDev42/teleprompter/commit/785a04bff31c70acc481d28127bcb1efad2e2ec4))
* **cli:** stream tp upgrade download with live progress ([0b47f22](https://github.com/DaveDev42/teleprompter/commit/0b47f223fc44bfbfe5c739b3205da735271a9be5))
* **cli:** stream tp upgrade download with live progress ([94580e3](https://github.com/DaveDev42/teleprompter/commit/94580e32bd9996763151b31c2926f43faf10a2e5))


### Performance Improvements

* **cli:** shrink binary ~4MB via --minify and prep for bytecode ([231f221](https://github.com/DaveDev42/teleprompter/commit/231f221ad5af04f7460ebc4cec06a44bdaee4753))
* **cli:** shrink binary ~4MB via --minify and prep for bytecode ([d177223](https://github.com/DaveDev42/teleprompter/commit/d17722335b3922b8594abecb8a653874c8819d7b))
* **cli:** UPX-compress linux/windows binaries; drop libsodium sumo ([30f2534](https://github.com/DaveDev42/teleprompter/commit/30f253441133be74e29bbe1a6eec2840cc78f41b))
* **cli:** UPX-compress linux/windows binaries; drop libsodium sumo ([2fbe898](https://github.com/DaveDev42/teleprompter/commit/2fbe8983c2200a112dd841606a391e9c0923d86a))

## [0.1.13](https://github.com/DaveDev42/teleprompter/compare/v0.1.12...v0.1.13) (2026-04-21)


### Features

* block tp pair new until frontend completes kx ([6f7dc1f](https://github.com/DaveDev42/teleprompter/commit/6f7dc1f2841f1cf419cf1cd9fac3eb7026b0c7dd))
* **cli:** add IPC client utility for pair flow ([0ea7ff2](https://github.com/DaveDev42/teleprompter/commit/0ea7ff22489f7a9b62b10c2d3e600f4c52e6c423))
* **cli:** add pair-lock utility for tp pair new concurrency ([c5cff2d](https://github.com/DaveDev42/teleprompter/commit/c5cff2d1cc59f3f2767c6b3eff6ead7f6797a2de))
* **cli:** add shell detection utility for completion installer ([07f28e8](https://github.com/DaveDev42/teleprompter/commit/07f28e8d9cb7bcb64a7b3cd52135be80a6d512f0))
* **cli:** add tp completions install subcommand ([77a38d8](https://github.com/DaveDev42/teleprompter/commit/77a38d88e73b08bcaca174e50b5b7b521cea18b9))
* **cli:** add tp completions install with auto-wiring ([f055c5e](https://github.com/DaveDev42/teleprompter/commit/f055c5ec7a435ea0b44b63af2521836d6d9b635c))
* **cli:** block tp pair new until kx completes via daemon IPC ([0e9a461](https://github.com/DaveDev42/teleprompter/commit/0e9a461b22bf4b8bb18277c973737afdeef298dc))
* **cli:** generate powershell completion script ([6c1aa0a](https://github.com/DaveDev42/teleprompter/commit/6c1aa0a0ad1fe218b87b5f26d12326c7d3cafc7b))
* **cli:** install bash/zsh completions with marker-block idempotency ([fc45033](https://github.com/DaveDev42/teleprompter/commit/fc450333e6a0f578ac9b9ad9eaa71b268d8b07e3))
* **cli:** install fish completions via managed file ([b9bd55e](https://github.com/DaveDev42/teleprompter/commit/b9bd55ea3d75f47836a2e4472bd742777b604c82))
* **cli:** install powershell completions via profile dot-source ([d30250a](https://github.com/DaveDev42/teleprompter/commit/d30250ad14f4f697e0ab62232080f1594a35598e))
* **cli:** offer interactive daemon service install on first run ([4d50b45](https://github.com/DaveDev42/teleprompter/commit/4d50b45c6f1aafef74f06ba009a056785d19706d))
* **cli:** offer interactive daemon service install on first run ([2590980](https://github.com/DaveDev42/teleprompter/commit/2590980d0dab007105ecd3eaa9889ff0d9bce5c5))
* **cli:** reject unknown flags, add --help, uninstall verb, and improve completions ([e6760d8](https://github.com/DaveDev42/teleprompter/commit/e6760d832ee502c52502262c5f8f639423227883))
* **cli:** shell-detect version-var fallback when \$SHELL unset or unrecognized ([cd4d677](https://github.com/DaveDev42/teleprompter/commit/cd4d677670d0f36b5630d8b470f1ff5cd46156ec))
* **daemon:** add beginPairing/cancelPendingPairing/promoteCompletedPairing ([66d994f](https://github.com/DaveDev42/teleprompter/commit/66d994fbe201aa32d31a500e16218b9650bd9da9))
* **daemon:** add PendingPairing module ([3f47af5](https://github.com/DaveDev42/teleprompter/commit/3f47af5171e8b71a9ae307372d2ea0043bde0e5b))
* **daemon:** wire pair.* IPC handlers + CLI disconnect cancellation ([8fcbce1](https://github.com/DaveDev42/teleprompter/commit/8fcbce17287b563ce99902b9eaf8006a8606db5e))
* **install:** auto-install shell completions in install.ps1 ([303786e](https://github.com/DaveDev42/teleprompter/commit/303786e68d4cf6ea8b764465151fe9da77c22806))
* **install:** auto-install shell completions in install.sh ([d97f6fe](https://github.com/DaveDev42/teleprompter/commit/d97f6fe75d3bf2979733683b09ab3f071eab851e))
* **protocol:** add pair.* IPC message types ([46794a7](https://github.com/DaveDev42/teleprompter/commit/46794a7a8fb6a94180faed9cf2412866fcc8256f))


### Bug Fixes

* **cli:** add fsync, explicit fchmod, export path helpers, and fix preservedMode ([812b424](https://github.com/DaveDev42/teleprompter/commit/812b4242cbe28f1571340361ebe6121000171ca2))
* **cli:** address review-fix loop pass 1 feedback ([bba7866](https://github.com/DaveDev42/teleprompter/commit/bba7866d05ccc48e4f45eb1e94188023f43d39e4))
* **cli:** address review-fix loop pass 2 feedback ([8e2b1a7](https://github.com/DaveDev42/teleprompter/commit/8e2b1a7d788afe89092925dee83eb61aef4eb7b8))
* **cli:** address review-fix loop pass 3 feedback ([75d8a87](https://github.com/DaveDev42/teleprompter/commit/75d8a870e09b011396362bde4d2b98ecec9f2cdf))
* **cli:** address review-fix loop pass 4 feedback ([ebddcab](https://github.com/DaveDev42/teleprompter/commit/ebddcaba2df53f37a6fe69d002aaefc0058aa55f))
* **cli:** atomic rc-file writes and preserve permissions in completions install ([e22c673](https://github.com/DaveDev42/teleprompter/commit/e22c6736745ce5c5090c0ea0ea5c291f499f343c))
* **cli:** close and notify handlers on IPC socket error ([e8c9008](https://github.com/DaveDev42/teleprompter/commit/e8c9008416ed1721a0be12d6343e002904110e8d))
* **cli:** defeat symlink attack in atomic write via O_CREAT|O_EXCL ([e49874a](https://github.com/DaveDev42/teleprompter/commit/e49874acefbec765ed6b9f244d825a0ced054e95))
* **cli:** handle SIGINT before pair.begin.ok and exhaust switch ([8f716a6](https://github.com/DaveDev42/teleprompter/commit/8f716a60a5375852c19dc3dcb994a504646cda7c))
* **cli:** implement Windows Named Pipe IPC client for pair flow ([5cd155e](https://github.com/DaveDev42/teleprompter/commit/5cd155e776bea570e697c34c4aceeb84dd2e55ab))
* **cli:** improve shell-detect typing, atomic write robustness, and exhaustive switches ([72ca2ef](https://github.com/DaveDev42/teleprompter/commit/72ca2ef802cc9fed7f6ca268c7ef06c86dd86fd6))
* **cli:** mention version-var fallback in shell detection hint ([f8d49ae](https://github.com/DaveDev42/teleprompter/commit/f8d49ae6edd433bbbc4b17d111c9b6cf765d8338))
* **cli:** relax --profile-dir value validation and document reordering ([a516950](https://github.com/DaveDev42/teleprompter/commit/a516950e7091d401e7a93324a68c278b0e0d729b))
* **cli:** typed Set and cleaner preservedMode ([1822059](https://github.com/DaveDev42/teleprompter/commit/182205996c962d3881caa5bd127401b3b6896d91))
* **cli:** validate --profile-dir value in tp completions install ([bff81ba](https://github.com/DaveDev42/teleprompter/commit/bff81bace1bb7b0ca264f9b873c790e2e0ffa990))
* **install:** honor NO_COMPLETIONS in install.ps1 and skip when not on PATH ([b698f45](https://github.com/DaveDev42/teleprompter/commit/b698f453c862137cf6a1c7e8cdab0d82349c17b1))
* **install:** normalize PATH comparison and add PATH gate to install.sh ([1d8ad69](https://github.com/DaveDev42/teleprompter/commit/1d8ad69a769a7c9f33e152ec70e607d3312099de))
* **install:** normalize trailing slashes in install.sh PATH check ([aa11613](https://github.com/DaveDev42/teleprompter/commit/aa11613d6ee36b884e0b0fa0a352f7204e5ed767))
* **install:** null-guard \$PROFILE and improve TTY-skip messaging ([a5a1ee3](https://github.com/DaveDev42/teleprompter/commit/a5a1ee34da0d2a6be820be817842e7c25950f8cc))
* **install:** skip completions on non-TTY curl-pipe-sh and pass PROFILE dir on Windows ([c9bb764](https://github.com/DaveDev42/teleprompter/commit/c9bb7647a0baeaa9ec4b846568ba4abbd36a9b83))
* **install:** stop swallowing stderr from completions install in install.sh ([31cec0d](https://github.com/DaveDev42/teleprompter/commit/31cec0df62aee3885069dc31d8a43a2116815282))

## [0.1.12](https://github.com/DaveDev42/teleprompter/compare/v0.1.11...v0.1.12) (2026-04-19)


### Features

* **cli:** add tp daemon status subcommand ([8b77361](https://github.com/DaveDev42/teleprompter/commit/8b7736145e649e1bf9ae4dca7dce9281dd5297b8))
* **cli:** add tp daemon status subcommand ([669821d](https://github.com/DaveDev42/teleprompter/commit/669821d848fe6c4f3e3a56bbbc4ffa362935f82e))


### Bug Fixes

* **cli:** inline version via static JSON import in compiled binary ([6e5319b](https://github.com/DaveDev42/teleprompter/commit/6e5319bb9b1e9a16ce7f3b0c40783e9165511867))
* **cli:** inline version via static JSON import so compiled binary reports correct version ([7127187](https://github.com/DaveDev42/teleprompter/commit/7127187e7e9d7ec2b1d7ff3a645ea219aeb1e3c2))
* **eas:** restore appVersionSource remote; keep runtimeVersion appVersion ([f18ed61](https://github.com/DaveDev42/teleprompter/commit/f18ed610e561c54744e2886cdc8f527354627544))
* **eas:** restore appVersionSource remote; keep runtimeVersion appVersion ([8600b0f](https://github.com/DaveDev42/teleprompter/commit/8600b0fcceec3d5d5ba78e062c6be7c19dc361d7))

## [0.1.11](https://github.com/DaveDev42/teleprompter/compare/v0.1.10...v0.1.11) (2026-04-19)


### Bug Fixes

* **release:** strip Bun's embedded signature before re-signing on macOS ([8ad9157](https://github.com/DaveDev42/teleprompter/commit/8ad9157babd015fbc9aa6ab70c698c36f911e6df))
* **release:** strip Bun's embedded signature before re-signing on macOS ([b30d016](https://github.com/DaveDev42/teleprompter/commit/b30d0162da61639f88a1ca2f78f291a030b3e0f2))

## [0.1.10](https://github.com/DaveDev42/teleprompter/compare/v0.1.9...v0.1.10) (2026-04-19)


### Bug Fixes

* **release:** ad-hoc codesign macOS + cosign keyless + stricter upgrade verify ([24d2ab0](https://github.com/DaveDev42/teleprompter/commit/24d2ab0d34e57ee45fa53574a67388fe50315284))
* **release:** ad-hoc codesign macOS + cosign keyless + stricter upgrade verify ([4f8dcf4](https://github.com/DaveDev42/teleprompter/commit/4f8dcf4f7634d96ec4d5ca806e45b604f27e1f61))

## [0.1.9](https://github.com/DaveDev42/teleprompter/compare/v0.1.8...v0.1.9) (2026-04-15)


### Features

* **cli:** getAssetName supports Windows .exe ([56afa52](https://github.com/DaveDev42/teleprompter/commit/56afa52f2177964c98c263ba73c61bc7cffc86d4))
* **cli:** tp upgrade handles Windows (tmp, fs ops, daemon restart) ([9bf232a](https://github.com/DaveDev42/teleprompter/commit/9bf232aede352ff628814cb62c6cee8ec159de23))
* **install:** PowerShell installer for Windows ([6d3791f](https://github.com/DaveDev42/teleprompter/commit/6d3791f717ad89ad0041a4320d9d79af466954c4))
* Windows install, upgrade, and docs ([3d4d0d0](https://github.com/DaveDev42/teleprompter/commit/3d4d0d098580940a19b666e0fe542863dd83a61a))


### Bug Fixes

* **cli:** address Windows review feedback (path reconciliation, CRLF, cache, rollback) ([92ea566](https://github.com/DaveDev42/teleprompter/commit/92ea566904c0c972371ae33f19c3d5bfbc9d1339))
* **cli:** resolveCurrentBinaryPath uses 'where' on Windows ([837edaf](https://github.com/DaveDev42/teleprompter/commit/837edaf459520ef1fca01d29084d2baffd72b1a0))
* **install:** cleanup temp on failure; arm64 via PROCESSOR_ARCHITEW6432; docs troubleshoot ([b7aa655](https://github.com/DaveDev42/teleprompter/commit/b7aa65557e5acc64fd69e038c8c63aa97ec5da87))

## [0.1.8](https://github.com/DaveDev42/teleprompter/compare/v0.1.7...v0.1.8) (2026-04-15)


### Features

* **release:** add Windows arm64 to v* release builds ([b86caf9](https://github.com/DaveDev42/teleprompter/commit/b86caf99b769b8bc7f8cfbe0ee92ba5c8d52d5d7))
* **release:** add Windows arm64 to v* release builds ([c5540c5](https://github.com/DaveDev42/teleprompter/commit/c5540c5522f7429fec05144068244c08fdab0cb9))
* **release:** add Windows x64 to v* release builds ([2e44e39](https://github.com/DaveDev42/teleprompter/commit/2e44e397d66f4bd676875e6a047873813d9780e5))
* **release:** add Windows x64 to v* release builds ([726c7c6](https://github.com/DaveDev42/teleprompter/commit/726c7c64351e2be567565d03e1fb08becdfa8696))

## [0.1.7](https://github.com/DaveDev42/teleprompter/compare/v0.1.6...v0.1.7) (2026-04-14)


### Features

* add --prune flag to daemon CLI for session cleanup on startup ([735269b](https://github.com/DaveDev42/teleprompter/commit/735269b48821fbb2c7d9bf1850bcb5067d8c5f12))
* add --verbose and --quiet flags to daemon CLI ([9f92492](https://github.com/DaveDev42/teleprompter/commit/9f924924385b26e94bc978fdc5f05be63b04ef11))
* add --watch flag for daemon auto-restart on crash ([d77e2f7](https://github.com/DaveDev42/teleprompter/commit/d77e2f702b0437653f02b4263ec6bbd1d5e7f943))
* add accessibility attributes to entire frontend ([5b79f14](https://github.com/DaveDev42/teleprompter/commit/5b79f146cab2670d58d27e52b398948c9bbb3d02))
* add accessibility attributes to entire frontend ([9e4bfb4](https://github.com/DaveDev42/teleprompter/commit/9e4bfb4d97657b05eb00433b3f2f2cf37b1372f6))
* add bun-windows-x64 build target ([f055714](https://github.com/DaveDev42/teleprompter/commit/f055714abd35bc26564d3ff6c8aefda61f5accbe))
* add Caddy TLS reverse proxy for relay.tpmt.dev ([cfa5905](https://github.com/DaveDev42/teleprompter/commit/cfa5905b57cc522d04e1ac1f86e4c50bae282eb6))
* add checksum verification, rollback, and daemon restart to tp upgrade ([8f15ca3](https://github.com/DaveDev42/teleprompter/commit/8f15ca3807fae53145c807ddb3bcd01c29f57bce))
* add checksum verification, rollback, and daemon restart to tp upgrade ([b4dff01](https://github.com/DaveDev42/teleprompter/commit/b4dff01c5bdf98698e63860d100818b6dc21b8e4))
* add export formatter with full event type support and ANSI-stripped IO ([c3018fb](https://github.com/DaveDev42/teleprompter/commit/c3018fb31271ce74212d0688d081595cb48e6da0))
* add filter options to WsSessionExport protocol type ([43c54e9](https://github.com/DaveDev42/teleprompter/commit/43c54e983e4eed417fee594626c93384cc2e2a9d))
* add frontend session.exported handler with Web download and native Share Sheet ([11b00ff](https://github.com/DaveDev42/teleprompter/commit/11b00ff7b28c308e05f523f57c89f17aa8420c8b))
* add getRecordsFiltered() to SessionDb with kind/time/limit filters ([483d552](https://github.com/DaveDev42/teleprompter/commit/483d55220107bc4242e33ae467c077007ea43faa))
* add keyboard focus to all screens (sessions, settings, daemons, session view, sidebar) ([f5bccfd](https://github.com/DaveDev42/teleprompter/commit/f5bccfd9445b11583a3da7f765fc4c9b9cef8f94))
* add keyboard navigation infrastructure (usePlatformProps, useKeyboard, ModalContainer) ([2b90e21](https://github.com/DaveDev42/teleprompter/commit/2b90e21ba22a0c3f6ef5028dbb0d8d07acd3b294))
* add OTA update UI and switch to fingerprint runtime version ([96a5417](https://github.com/DaveDev42/teleprompter/commit/96a54170544e917907955ebd3b2e07a33b7b78f2))
* add Playwright E2E tests for React Native Web + app-web-qa agent ([7c658a0](https://github.com/DaveDev42/teleprompter/commit/7c658a0bd291221bd1c2e45d0d28a2b67c354bec))
* add Playwright E2E to CI + daemon-connected browser tests ([b64d536](https://github.com/DaveDev42/teleprompter/commit/b64d536eddb8d81902c2eef556eb1e75cf0d063d))
* add Playwright MCP for web QA, fix Expo MCP connection ([5ec878f](https://github.com/DaveDev42/teleprompter/commit/5ec878f69abcaf1b6a9830f10c71c78ab285fbc3))
* add protocol versioning for relay, WS, and IPC ([b7da57d](https://github.com/DaveDev42/teleprompter/commit/b7da57ddb832df1b0bbc2c12a68f7fc0b2d9b8e5))
* add PTY host auto-installer for Windows ([5bfbc30](https://github.com/DaveDev42/teleprompter/commit/5bfbc30aba1a7a760b43db83e4cb9cbbd6dda7a2))
* add PtyWindows implementation with Node.js subprocess host ([9a5c28c](https://github.com/DaveDev42/teleprompter/commit/9a5c28c92864bcbbc26b543842aecfc33c049b38))
* add relay deploy script (scp + systemd) ([adc775f](https://github.com/DaveDev42/teleprompter/commit/adc775f627f8842e51f1b6fe04055638337af3dc))
* add relay ping, daemon service registration, native E2EE, fix tests ([297085e](https://github.com/DaveDev42/teleprompter/commit/297085e9989aea2f724f6469a500f86781207ae7))
* add rmRetry() helper for Windows EBUSY cleanup in tests ([f16ee59](https://github.com/DaveDev42/teleprompter/commit/f16ee594c7dc674dc6706976d5434daeef4da273))
* add tab bar testIDs and keyboard navigation E2E tests ([71c29d2](https://github.com/DaveDev42/teleprompter/commit/71c29d283a3248baab4bcd80dcf2e717ac7bdc45))
* add tp doctor command, relay health endpoint, v0.2.0 roadmap ([2762491](https://github.com/DaveDev42/teleprompter/commit/2762491f666d478b850e4d2dbdd4bbb7c38b219e))
* add tp logs command for live session record tailing ([f5c9348](https://github.com/DaveDev42/teleprompter/commit/f5c9348cdcbbcb70275bb7522d2474436972f377))
* add tp status command for daemon session overview ([c222903](https://github.com/DaveDev42/teleprompter/commit/c222903c18aaa38574a8c2c09f517f50b4aafdf6))
* add Vercel deployment config and privacy policy ([168bf11](https://github.com/DaveDev42/teleprompter/commit/168bf11b8d7c7faee475d08ccc0d504f20215720))
* add Windows Named Pipe IPC client ([d540c78](https://github.com/DaveDev42/teleprompter/commit/d540c78338bf2d33dd64b87114f46b7a691fbd19))
* add Windows Named Pipe IPC server ([88061b2](https://github.com/DaveDev42/teleprompter/commit/88061b296b85c35f6fb6bbf2ff9eb82af3ca1a38))
* add Windows Named Pipe path to socket-path ([02a792f](https://github.com/DaveDev42/teleprompter/commit/02a792fd666f429cdea14f28f03db935ef9d9432))
* add Windows PTY and IPC support ([498058a](https://github.com/DaveDev42/teleprompter/commit/498058a7cc3d5f0bc915ed5cbbba8a0c3158b625))
* add Windows PTY host script for ConPTY via @aspect-build/node-pty ([a55ba5b](https://github.com/DaveDev42/teleprompter/commit/a55ba5b93da50dad558cfa10fd14a8957e5c6db4))
* add Windows Task Scheduler service management ([b681f1d](https://github.com/DaveDev42/teleprompter/commit/b681f1d8524c4944751534fb2af06416c88e5ac9))
* add WS heartbeat (30s interval) for stale connection detection ([fb552b8](https://github.com/DaveDev42/teleprompter/commit/fb552b80aebae4b38849722e4ef782fcb20f5b7f))
* app deploy pipeline (preview → TestFlight/Internal, production → stores) ([994471f](https://github.com/DaveDev42/teleprompter/commit/994471f21127e81481b3344e10c4b2b23b87a306))
* **app:** add InAppToast component for relay notifications ([1526c05](https://github.com/DaveDev42/teleprompter/commit/1526c05f378b90b38ebb11a62ab5ca6b1743ff67))
* **app:** add sendPushToken, relay.notification handling, and notification store ([6344efa](https://github.com/DaveDev42/teleprompter/commit/6344efaa7905cc7a7178b744927461388c6552cd))
* **app:** add usePushNotifications hook for token registration ([6bacec8](https://github.com/DaveDev42/teleprompter/commit/6bacec846d84597fe6918203027dbd5cabe20d89))
* **app:** add usePushNotifications hook for token registration ([0afc235](https://github.com/DaveDev42/teleprompter/commit/0afc235fb99978629f2800d0baf0b19ab4e87384))
* **app:** install expo-notifications and configure plugins ([b31990f](https://github.com/DaveDev42/teleprompter/commit/b31990f940a4a66c29cede28099d9d3da849a337))
* **app:** send/receive control.unpair via relay ([c47815c](https://github.com/DaveDev42/teleprompter/commit/c47815c7bb4e657406f2b194d05cb553ebf80655))
* **app:** show pairing label and rename UI ([786e67c](https://github.com/DaveDev42/teleprompter/commit/786e67cf973b398d7195e4d06d23133592c49b3e))
* **app:** store label and handle control.rename ([1c2362d](https://github.com/DaveDev42/teleprompter/commit/1c2362d0ee7c2624dc8e3cb8fd7807fdc6351128))
* **app:** toast when peer removes pairing ([261ebce](https://github.com/DaveDev42/teleprompter/commit/261ebce397a5a38ef9dd16674bd6b21deea45c6f))
* **app:** wire push notifications and toast into root layout ([bd054ca](https://github.com/DaveDev42/teleprompter/commit/bd054cad8e5d533499196a298d3fb352447c9c96))
* auto-cleanup old sessions on daemon startup ([3b7abc5](https://github.com/DaveDev42/teleprompter/commit/3b7abc5b66493877441a6396c61b636271b91330))
* auto-cleanup old sessions on daemon startup and periodically ([a5dd8fc](https://github.com/DaveDev42/teleprompter/commit/a5dd8fcdc6ef1d643f71f49552970bf4169101e5))
* auto-detect WS URL when frontend is served by daemon ([3c6cf53](https://github.com/DaveDev42/teleprompter/commit/3c6cf53bd98e27b2662ea805bbfe9a7a147db6a7))
* auto-start daemon when tp status/logs is called ([d4a3ee8](https://github.com/DaveDev42/teleprompter/commit/d4a3ee8cf4058410233df2588541d3191cc9617a))
* **cli:** add pair subcommands (new/list/delete) ([afd0bc9](https://github.com/DaveDev42/teleprompter/commit/afd0bc9900925ecf9a61b4866caeddc07641d7cb))
* **cli:** add pair subcommands (new/list/delete) ([d80d330](https://github.com/DaveDev42/teleprompter/commit/d80d3308eccbb66d67ca07ba228f63c8359ac6e4))
* **cli:** pair --label, pair rename, label in list ([7e4b81b](https://github.com/DaveDev42/teleprompter/commit/7e4b81b70694b107008045a7fab013bea4dc29b6))
* **cli:** tp pair delete notifies peer via relay.unpair ([db2c809](https://github.com/DaveDev42/teleprompter/commit/db2c809e6b0d85649aba318e836f9dfc881794be))
* configurable daemon URL, turbo caching, pnpm scripts ([bf67dc6](https://github.com/DaveDev42/teleprompter/commit/bf67dc6b9cefc88d8f0350d3204b0576c8147fcd))
* configurable relay cache size and frame size limit ([d34612d](https://github.com/DaveDev42/teleprompter/commit/d34612db9fd3d9ecda60ed2f12a472a46ec37e8f))
* configurable relay frame cache size and WebSocket frame size limit ([5031279](https://github.com/DaveDev42/teleprompter/commit/5031279c9f5a02b79cf3df411637fec3b34d72dc))
* configure EAS Update for OTA deployments ([9092f7a](https://github.com/DaveDev42/teleprompter/commit/9092f7a2c50ceff501e8acfe52c8136cc4289cb7))
* daemon pairing persistence in vault DB, auto-reconnect on restart ([34c9478](https://github.com/DaveDev42/teleprompter/commit/34c947878c6d141682951f290edad2e623c69da5))
* daemon relay client v2 — multi-peer E2EE, self-registration, key exchange ([e58d909](https://github.com/DaveDev42/teleprompter/commit/e58d9090526460b9d021d58b4b47702b8212153d))
* **daemon:** add env option to SpawnRunnerOptions ([b28e5f8](https://github.com/DaveDev42/teleprompter/commit/b28e5f8d4c8c1bb77230e494c8b8aebe56f87d02))
* **daemon:** add passthrough helpers (onRecord, sendInput, resizeSession) ([c90353c](https://github.com/DaveDev42/teleprompter/commit/c90353ca65f9f6e5fe436a679f5f8416218e0d7c))
* **daemon:** add PushNotifier for hook event detection ([c8f4ea9](https://github.com/DaveDev42/teleprompter/commit/c8f4ea98c3ac1a2884ad65420bfee8cc25cb978f))
* **daemon:** add sendPush method to relay client ([ca3f4ed](https://github.com/DaveDev42/teleprompter/commit/ca3f4eda3be6c6d554e00817c5cf2aaf19d1c8f6))
* **daemon:** add sendUnpairNotice on RelayClient ([a99e1bf](https://github.com/DaveDev42/teleprompter/commit/a99e1bf2e8d2374eec3a55d2a0578a83dcd1d993))
* **daemon:** dispatch inbound control.unpair to remove pairing ([56e46e9](https://github.com/DaveDev42/teleprompter/commit/56e46e9d3d66672d3615e7ea99b60bd6559684d3))
* **daemon:** persist label on pairings ([ee034c0](https://github.com/DaveDev42/teleprompter/commit/ee034c040046ca7bbb874c5f2da882e2ba721584))
* **daemon:** send/receive control.rename ([4e171eb](https://github.com/DaveDev42/teleprompter/commit/4e171ebf5e4ec0802645b57e9be90a3bbb700161))
* **daemon:** wire PushNotifier into record pipeline and pushToken handling ([52b62fa](https://github.com/DaveDev42/teleprompter/commit/52b62fa3d44b1ec8b727a1b868e6e8461178bd66))
* default relay to wss://relay.tpmt.dev, keep local for dev ([61d8c04](https://github.com/DaveDev42/teleprompter/commit/61d8c0429b7c05380c8761be1a0d8b887de1323a))
* enhanced diagnostics panel per PRD section 18 ([b28d338](https://github.com/DaveDev42/teleprompter/commit/b28d3383212db1d06a2b8e6a48971001a418c62f))
* error handling UX — reconnect counter + daemon start hint ([115c3c0](https://github.com/DaveDev42/teleprompter/commit/115c3c02e176e4703e88d49ad0e2961ad6e07a3e))
* expand CI Playwright to 15 tests, fix session-switch locator ([db3ef46](https://github.com/DaveDev42/teleprompter/commit/db3ef4670f180de9d42d32dbef92f51ff349f742))
* Expo Push Notifications ([ea8465d](https://github.com/DaveDev42/teleprompter/commit/ea8465d21918f4a06dad5b8b57afd53d4943bf09))
* fingerprint-based conditional builds in EAS preview workflow ([45e1f11](https://github.com/DaveDev42/teleprompter/commit/45e1f1106852acaeae9c05769aa9aac27dd207e3))
* graceful shutdown, vault cleanup, relay rate limiting ([e569d1b](https://github.com/DaveDev42/teleprompter/commit/e569d1bf63687bd5e844c27f234be096fcbbce83))
* human-readable pairing labels ([4a0ea1d](https://github.com/DaveDev42/teleprompter/commit/4a0ea1d398e9e46ec9c3bd551bde2e1ab8c3e689))
* implement relay presence heartbeat for stale daemon detection ([e2ac639](https://github.com/DaveDev42/teleprompter/commit/e2ac639cb442d2a812698671777fb844c7a326e2))
* implement settings UI — font picker, API key modal, persistence ([940d7b7](https://github.com/DaveDev42/teleprompter/commit/940d7b7940daf06c3dcd694a4d8b3f4f250fcb43))
* implement settings UI — font picker, API key modal, theme & voice persistence ([68dedcd](https://github.com/DaveDev42/teleprompter/commit/68dedcdfd5c1f51fbcf655aac58fc85be012dce3))
* improve session export with full event types, IO records, filtering, and frontend delivery ([1c16384](https://github.com/DaveDev42/teleprompter/commit/1c163842aa363615f70df68ac7a05cb653c6581c))
* improve tp CLI usability ([247c991](https://github.com/DaveDev42/teleprompter/commit/247c9919340b6c256461657c47d50c76dfd06ec2))
* improve tp CLI usability ([ae6bcb9](https://github.com/DaveDev42/teleprompter/commit/ae6bcb973426d0ff49a2f0d6e649bfa86bc01ae2))
* keyboard navigation for Web ([296d5ea](https://github.com/DaveDev42/teleprompter/commit/296d5eaf7ab9a764d5d87588dd3839d5892005a7))
* migrate FontPickerModal, FontSizeModal, ApiKeyModal to ModalContainer ([d3244c3](https://github.com/DaveDev42/teleprompter/commit/d3244c38f4491f1c6c7cb58e78675246a331a590))
* migrate terminal from xterm.js to ghostty-web (libghostty WASM) ([#2](https://github.com/DaveDev42/teleprompter/issues/2)) ([4ca9e40](https://github.com/DaveDev42/teleprompter/commit/4ca9e401c72348ec43d4f7276442e82594e1e559))
* multi-frontend E2E test, daemon session switching UX ([f1b8a9d](https://github.com/DaveDev42/teleprompter/commit/f1b8a9da6e22bbbcc631993ee249ee68c1f40206))
* N:N frontend relay, multi-daemon pairing, persistence, docs ([1e5bc59](https://github.com/DaveDev42/teleprompter/commit/1e5bc59d1cbba44a248bb110068f2332dc5aaca2))
* N:N relay protocol v2 — self-registration, key exchange, frontendId ([ac53438](https://github.com/DaveDev42/teleprompter/commit/ac53438b39e05450166f9bbd76e50744e8eb3831))
* native E2EE crypto polyfill, relay wiring, diagnostics self-test ([85d247b](https://github.com/DaveDev42/teleprompter/commit/85d247bfb4e37208b42a0dc02bb7557d076b566f))
* Notification card, version compatibility check, protocol version ([111c6f3](https://github.com/DaveDev42/teleprompter/commit/111c6f33c62967bb526dc76f877a404eacb317a7))
* notify peer on pairing removal (control.unpair) ([1dc4ff8](https://github.com/DaveDev42/teleprompter/commit/1dc4ff80301e77795d4f8d10fc5e9cdc14c4bb4d))
* OTA update UI + fingerprint runtime version ([f677e40](https://github.com/DaveDev42/teleprompter/commit/f677e40be6943257c4459b973583e693658f3739))
* P2 quality — session restart, coverage, Playwright tests ([e35598e](https://github.com/DaveDev42/teleprompter/commit/e35598e5597e94f9eb4cf0c7b572e6a7aee47200))
* P3 — NativeWind cleanup, code blocks, session export, worktree UI ([c9eff1c](https://github.com/DaveDev42/teleprompter/commit/c9eff1c370d17da2db81e9b91bc7250db125f304))
* P3 complete — Android EAS, terminal copy, TODO update ([81eacf5](https://github.com/DaveDev42/teleprompter/commit/81eacf50451cb197c78d24cb1636de554d1c7a54))
* path-filtered EAS workflows, production tag trigger, remove EXPO_TOKEN dependency ([592269c](https://github.com/DaveDev42/teleprompter/commit/592269c7469de53e28bd437c374f797d3ddab6e8))
* PRD alignment — elicitation cards, permission cards, tp events, ([466f53f](https://github.com/DaveDev42/teleprompter/commit/466f53f69d0a966684ae09283802d60c8821a370))
* **protocol:** add control.rename message ([c1697a5](https://github.com/DaveDev42/teleprompter/commit/c1697a5b9b6626d864955e8316fdb13c25e4b362))
* **protocol:** add control.unpair message type ([dbd2de3](https://github.com/DaveDev42/teleprompter/commit/dbd2de3507ce4d8a65ea01b10451aaa9e5c6afc9))
* **protocol:** add RelayPush and RelayNotification types ([9e6ffa3](https://github.com/DaveDev42/teleprompter/commit/9e6ffa31572142f608673a6beec819d5fff33463))
* **protocol:** add WsPushToken type and pushToken frame type ([1ddcf06](https://github.com/DaveDev42/teleprompter/commit/1ddcf06e2322df331119ad3f8db0b8a3407e8163))
* **protocol:** carry label in pairing bundle ([91d5609](https://github.com/DaveDev42/teleprompter/commit/91d5609b027f7fa5cd2e17a833f2f340da11542d))
* redesign app UI with 3-tab navigation, theme system, and safe areas ([#3](https://github.com/DaveDev42/teleprompter/issues/3)) ([1549315](https://github.com/DaveDev42/teleprompter/commit/15493150e9fc75b42c4437f7b5512d16d9832a88))
* relay admin dashboard and daemon --watch auto-restart ([a8cbe55](https://github.com/DaveDev42/teleprompter/commit/a8cbe552cf0c4e5cade84e315479338e0b353a15))
* relay presence heartbeat for stale daemon detection ([49077ae](https://github.com/DaveDev42/teleprompter/commit/49077ae8905053015135b6ec1671e818230d896a))
* **relay:** add PushService with Expo Push API, rate limiting, and dedup ([4b824d1](https://github.com/DaveDev42/teleprompter/commit/4b824d14812c48fc90a46a7ddfd791eaba3832e9))
* **relay:** handle relay.push with WS notification delivery ([94b1d87](https://github.com/DaveDev42/teleprompter/commit/94b1d8781ad44cd42a71503a84559fad6c10c9a6))
* Terminal backlog replay on tab switch via onReady + resume ([ccc7e6b](https://github.com/DaveDev42/teleprompter/commit/ccc7e6b0df1dd5be92ef201eb8eb6a0745956d8d))
* terminal fallback banner for complex chat interactions ([1935ef8](https://github.com/DaveDev42/teleprompter/commit/1935ef899d611ddf8c40638ba9f2da2b6aac3d74))
* terminal search, session state persistence on restart ([635f1c1](https://github.com/DaveDev42/teleprompter/commit/635f1c1fcb3d229674838d28d5c1ee0694f8d5f0))
* theme toggle, session search, chat copy, tp init command ([1fa767a](https://github.com/DaveDev42/teleprompter/commit/1fa767a692ad46aa02a0a1585de425f94d71bd9d))
* tp upgrade, shell completions, version check on startup ([1cec1e5](https://github.com/DaveDev42/teleprompter/commit/1cec1e5638e0cbf58880b9991ae3a22ab9b0374a))
* unified release strategy with Release Please + EAS Workflow ([cc2c2ca](https://github.com/DaveDev42/teleprompter/commit/cc2c2ca88255dacc78dd60196413fec3230b9c93))
* wire daemon export handler with filtered queries and new formatter ([83618d2](https://github.com/DaveDev42/teleprompter/commit/83618d256db773972757c02e6df7b937fa4aabe0))


### Bug Fixes

* **a11y:** truncate long chat labels, conditional SettingsRow role ([5c73343](https://github.com/DaveDev42/teleprompter/commit/5c73343b726ccb1d96ae60985ee1266ef3149ea7))
* add bun install step to relay deploy workflow ([87440d8](https://github.com/DaveDev42/teleprompter/commit/87440d8a5148f957e448cf9dd88695ed22655094))
* add console.warn logging to silent catch blocks ([164a56b](https://github.com/DaveDev42/teleprompter/commit/164a56b0a50ee424187cbedc5bc5af90a3d92e5a))
* add console.warn logging to silent catch blocks in frontend ([658b95e](https://github.com/DaveDev42/teleprompter/commit/658b95e2d681108948335048e1ac33d691973f30))
* add explicit submit profile to EAS workflows ([5f706fb](https://github.com/DaveDev42/teleprompter/commit/5f706fb0cc5a90e2faf4dc043e9c5326f5525951))
* add explicit submit profile to EAS workflows ([6e43cc2](https://github.com/DaveDev42/teleprompter/commit/6e43cc2578f1eec377e80a4cc9acfb24cc295e12))
* add logging to Store.unlinkRetry, document sleepSync blocking ([5a7d871](https://github.com/DaveDev42/teleprompter/commit/5a7d87150503a748b80c567b7b0375483b3caa64))
* add missing v field to WsHelloReply assertion in test ([d7e3479](https://github.com/DaveDev42/teleprompter/commit/d7e34798198dd976c1625f76c469d7b3213adb16))
* add non-null assertion to bench test wsPort for consistency ([35dda62](https://github.com/DaveDev42/teleprompter/commit/35dda62b9ba0a9db35a5ef164640c551e7da956c))
* add submit profiles with ascAppId for TestFlight/App Store ([29447b1](https://github.com/DaveDev42/teleprompter/commit/29447b168e9fdf74961025c7bcd2399789732007))
* add worktree branch name and path permission validation ([15bb8fa](https://github.com/DaveDev42/teleprompter/commit/15bb8fab373fee2002bb2a0f7908a25a0854c63f))
* add worktree branch name and path permission validation ([2508bd5](https://github.com/DaveDev42/teleprompter/commit/2508bd5e2218c9944c96b1c153460977d7f33188))
* address all code review findings from pass 1 ([3b9a8b2](https://github.com/DaveDev42/teleprompter/commit/3b9a8b22af1a172bcf8b599bc749bb4f9be3df8a))
* address code review — biome format, ARIA tabs, cache props, missing focus targets ([0d8d5c2](https://github.com/DaveDev42/teleprompter/commit/0d8d5c2beefb989c1c805a1c1666a39597698d5d))
* address code review feedback (pass 1) ([ef4a3c1](https://github.com/DaveDev42/teleprompter/commit/ef4a3c1f44e7f986f3a7042e59c790b753642012))
* address code review feedback (pass 2) ([a4d2d6d](https://github.com/DaveDev42/teleprompter/commit/a4d2d6d7d56e90604e9ffbb7bbfb649627a48d19))
* address code review issues — cleanup bug, dead code, crypto tests ([167fa06](https://github.com/DaveDev42/teleprompter/commit/167fa0671fb979a5a8e3396c805d72674adb402c))
* address code review issues and add color/test infrastructure ([5c1d18f](https://github.com/DaveDev42/teleprompter/commit/5c1d18fbf63d0c11c4a5df45fd8d789fbeb7ffcb))
* address code review issues in E2EE relay wiring ([ae98f63](https://github.com/DaveDev42/teleprompter/commit/ae98f6305adf86a13bf324161100ff6362f4b364))
* address pass 2 review findings (toast ID, a11y, dedup guard, log noise) ([2131b89](https://github.com/DaveDev42/teleprompter/commit/2131b8906e4266ae8b4d0f38047cb2ae30af42b4))
* address remaining review nits ([84f266d](https://github.com/DaveDev42/teleprompter/commit/84f266d6a031b3e49f984fe92dd24c8ab80db358))
* address review feedback — use WsSessionMeta, add export timeout, collapse switch cases ([df436c8](https://github.com/DaveDev42/teleprompter/commit/df436c800452390e4a6d1abeaf2b3faec4e081ef))
* **app:** align expo SDK 55 patch versions ([acc516c](https://github.com/DaveDev42/teleprompter/commit/acc516c07b0c31d594d60b4f9dfaca9a1e5d7770))
* **app:** align expo SDK 55 patch versions ([3890f2a](https://github.com/DaveDev42/teleprompter/commit/3890f2a57759bd9a9977c9a0ecfcd17ecbe17e62))
* **app:** coerce empty label to null on rename ([2c708bd](https://github.com/DaveDev42/teleprompter/commit/2c708bd0493a110f47fc6b442644e4357a5127be))
* **app:** lint fixes for push notification files ([35bf97e](https://github.com/DaveDev42/teleprompter/commit/35bf97e8391f11182f63313a0ebd35e1fc5880ce))
* apply dark theme on native with inline style fallbacks ([7eab07a](https://github.com/DaveDev42/teleprompter/commit/7eab07ab6b37c3214415defbc9f4bc00365f1360))
* **app:** sync expo SDK 55 patch versions (v2) ([638cf84](https://github.com/DaveDev42/teleprompter/commit/638cf84149c8bbc70b07abbef8d62a1367c95039))
* **app:** sync expo SDK 55 patch versions (v2) ([63c101f](https://github.com/DaveDev42/teleprompter/commit/63c101fd9034d8bef9d25d0ce48b9b65dccfc896))
* **app:** use sendRelay for pushToken after unified transport refactor ([a266e5d](https://github.com/DaveDev42/teleprompter/commit/a266e5d19ada0353ac5f5e0ad3dd854597570da4))
* auto-detect daemon host from Expo Constants for native WS connection ([ad90ab9](https://github.com/DaveDev42/teleprompter/commit/ad90ab93a4584c8825316b7697fa5a896f2f3d33))
* biome format — break long getDaemonState signature ([e3c944c](https://github.com/DaveDev42/teleprompter/commit/e3c944c628b0416eaaf4d615c93f0cecb32360e2))
* biome format — wrap long line in daemon CLI ([4e435f6](https://github.com/DaveDev42/teleprompter/commit/4e435f6ed15a3bbccc3aba59b15a02f908640dff))
* biome format ModalContainer onClick spread ([8b31574](https://github.com/DaveDev42/teleprompter/commit/8b31574437c32f693c4ed5320f5fa7e453476196))
* biome formatting and import organization ([275f568](https://github.com/DaveDev42/teleprompter/commit/275f5688a9424253a0a1369dc652c25db9e4c6d0))
* biome import sort order in settings and FontPickerModal ([12e535b](https://github.com/DaveDev42/teleprompter/commit/12e535ba284c113e09ac97dbb4449bf191b3afdb))
* biome lint — replace non-null assertion with optional chain ([0e3f8ab](https://github.com/DaveDev42/teleprompter/commit/0e3f8abc1d3fb67d73430a36c05cb787540a9c83))
* biome lint — use template literal and fix formatting ([a42eee2](https://github.com/DaveDev42/teleprompter/commit/a42eee2974a978a132c4be584f560f648071aa89))
* biome lint and format fixes across project ([2503053](https://github.com/DaveDev42/teleprompter/commit/25030539eb88c547bcce9b7cd955fc6a7c34d56d))
* bump @expo/dom-webview 55.0.3 → 55.0.5 via pnpm override ([54991bb](https://github.com/DaveDev42/teleprompter/commit/54991bbf54e78458cce3b5cf7d1f75a9d74fd67b))
* bump @expo/dom-webview to fix iOS build ([a59454f](https://github.com/DaveDev42/teleprompter/commit/a59454faa8107927b568907fa7445b20c337b1eb))
* Chat record replay via resume on mount ([a448ee3](https://github.com/DaveDev42/teleprompter/commit/a448ee317bfd9d32076c327ecab71e771aea384a))
* **ci:** address review feedback on Bun cache step ([0242c05](https://github.com/DaveDev42/teleprompter/commit/0242c05c165e4321b5bd594a8c799ae9e59f6b3e))
* **ci:** check for (fail) prefix instead of broad error pattern ([d012f1b](https://github.com/DaveDev42/teleprompter/commit/d012f1b871d1d7c4c0804691777b0464179fab8f))
* **ci:** detect real test failures on Windows despite Bun panic ([eed9633](https://github.com/DaveDev42/teleprompter/commit/eed9633267bec8a25079a928c6bfea15d9043c91))
* **ci:** exclude daemon integration tests on Windows ([d6817f9](https://github.com/DaveDev42/teleprompter/commit/d6817f91e655586180c31ca719b33a683d5eb1f7))
* **ci:** mark test-windows as continue-on-error ([d89b51c](https://github.com/DaveDev42/teleprompter/commit/d89b51c0c46ef49c1c062c1f318d9e07362a4f1d))
* **ci:** narrow Windows test scope to compatible packages ([4c021e8](https://github.com/DaveDev42/teleprompter/commit/4c021e8ac631271cc5c9d1659ace516be628f144))
* **ci:** remove invalid 'on: manual' from EAS workflows — omit on: entirely ([08aefcf](https://github.com/DaveDev42/teleprompter/commit/08aefcfe9288e0bf0510b29686e94cdfb2497d11))
* **ci:** resolve lint + Windows-specific test failures ([790c2c1](https://github.com/DaveDev42/teleprompter/commit/790c2c1e3a1b91cd21be9c12569e146147174ed7))
* **ci:** use expo-doctor instead of deprecated expo doctor ([a4fb252](https://github.com/DaveDev42/teleprompter/commit/a4fb252a58d4b81ff102336285e6045dcac3c70b))
* **ci:** use expo-doctor instead of deprecated expo doctor ([7976710](https://github.com/DaveDev42/teleprompter/commit/797671076f0c830472f58937c874f7e7bad04aa4))
* **ci:** use tee + file for Bun panic workaround on Windows ([11545cd](https://github.com/DaveDev42/teleprompter/commit/11545cd4d866776e6788aceffad667af366a532f))
* **ci:** work around Bun 1.3.6 Windows panic after test completion ([3b6c6b2](https://github.com/DaveDev42/teleprompter/commit/3b6c6b259c57e2d4e63797c5d4f6f0fcc9f9d711))
* **cli:** biome format + windows rmSync retry for pair tests ([a73d73e](https://github.com/DaveDev42/teleprompter/commit/a73d73ec47a76893064bbf055a584f024a3e4f02))
* **cli:** clean up passthrough on spawn failure or missing runner process ([d52cb95](https://github.com/DaveDev42/teleprompter/commit/d52cb95388712c0b89d2a2837cf3ef443e6270ba))
* **cli:** handle SIGTERM in tp logs for symmetry with SIGINT ([613b3b7](https://github.com/DaveDev42/teleprompter/commit/613b3b7914356167e3ad77457d134519d1f5a4b7))
* **cli:** prevent upgrade-check cache from sliding on fresh-cache hits ([fbd3f65](https://github.com/DaveDev42/teleprompter/commit/fbd3f65838c6b6b4ed1cda96c98eb36055a1aace))
* **cli:** skip pair list/delete tests on Windows, bump completions timeout ([0271273](https://github.com/DaveDev42/teleprompter/commit/0271273ea1a65784392879f5107cccd53e11bb61))
* **cli:** stale socket detection, prefix parity, upgrade-notice rate limit ([eeab632](https://github.com/DaveDev42/teleprompter/commit/eeab632c382c23342d1b889d6158fe8b44025268))
* **cli:** stale socket detection, prefix parity, upgrade-notice rate limit ([f76b825](https://github.com/DaveDev42/teleprompter/commit/f76b825c98ae99fe454803ef502dfb4597456fd9))
* compiled tp binary fails to spawn runner ([87ebd57](https://github.com/DaveDev42/teleprompter/commit/87ebd57860f6542ed471fa4a4d7968cfe2246738))
* compiled tp binary fails to spawn runner (Module not found $bunfs) ([1c6b4f3](https://github.com/DaveDev42/teleprompter/commit/1c6b4f32bc0520e839da03a0b3eb88930e7be55c))
* deploy-relay job condition and missing WsHello version field ([31b84bd](https://github.com/DaveDev42/teleprompter/commit/31b84bd3b1f8f99a566f82031071261009e5a420))
* detect daemon host from Metro dev server URL (not just localhost) ([437a370](https://github.com/DaveDev42/teleprompter/commit/437a370410932b7def87f7b440ef48766e5c02b2))
* detect Metro dev server on port 8082+ (Expo MCP uses non-8081 ports) ([8772bb1](https://github.com/DaveDev42/teleprompter/commit/8772bb1a9b4055b5b0523fc89490aa44d1830822))
* E2E focus ring test — verify tabindex attribute instead of compiled class names ([fa5d6a3](https://github.com/DaveDev42/teleprompter/commit/fa5d6a3d2f8a5343cb38f27262136d046e9b1f23))
* E2E tests — handle disabled send button, use class check for focus ring ([0b42c76](https://github.com/DaveDev42/teleprompter/commit/0b42c769896773d24a422a844f35443356e2890e))
* **eas:** use draft release status for Android internal submit ([d9316a6](https://github.com/DaveDev42/teleprompter/commit/d9316a6f55aa08100fadf2467d8354433cf82100))
* **eas:** use draft release status for Android internal submit ([9e0dce6](https://github.com/DaveDev42/teleprompter/commit/9e0dce6a618a6546853c33180381463b267a8461))
* format settings.tsx to pass biome lint ([2bca370](https://github.com/DaveDev42/teleprompter/commit/2bca370b71a7908006515afbb1a52d88d8eb0831))
* format settings.tsx to pass biome lint ([fea42fd](https://github.com/DaveDev42/teleprompter/commit/fea42fda3484e33406339427695041194771320d))
* handle Windows bun.exe and URL path in spawn test ([b1531d5](https://github.com/DaveDev42/teleprompter/commit/b1531d519fbd91d8f2ccf2213643e94b3cac118a))
* improve Chat empty state UX + ANSI stripping ([44a95fd](https://github.com/DaveDev42/teleprompter/commit/44a95fdaa077329f1cca3ea8897c7efb36f75fb5))
* improve resume test reconnection detection reliability ([8d7de5b](https://github.com/DaveDev42/teleprompter/commit/8d7de5b0cdc022262e4f3e4e6bcbf40722f4b544))
* isolate full-stack tests with temp vault dir (no more UNIQUE errors) ([0e9d8c7](https://github.com/DaveDev42/teleprompter/commit/0e9d8c780233ad06ba850d4afc532c0e6ab87561))
* keep useDaemon always active for E2E compatibility ([ce9a9dc](https://github.com/DaveDev42/teleprompter/commit/ce9a9dce5179b43e3cc71d37c5e08f3a969472ff))
* make protocol client-safe for React Native / Expo Go ([f302860](https://github.com/DaveDev42/teleprompter/commit/f30286008071456d6612c71e65fcc971a2c07a0e))
* make rmRetry best-effort on final retry ([d5deb19](https://github.com/DaveDev42/teleprompter/commit/d5deb19a2b33bba8eafed17dc05b9102703e1371))
* make tests CI-compatible (branch name, socket path) ([3e0a35a](https://github.com/DaveDev42/teleprompter/commit/3e0a35abbfc7d74161b9ba2834438634df4fde07))
* move rmRetry to subpath import, fix Store TOCTOU, add protocol type-check ([0e0d074](https://github.com/DaveDev42/teleprompter/commit/0e0d0740e0170914dddefc92a4854b4e56debbcd))
* pass cwd to execFileSync in WorktreeManager git helpers ([1981e2d](https://github.com/DaveDev42/teleprompter/commit/1981e2d93036af98f8774d81b4da18612e66605a))
* pass cwd to execFileSync in WorktreeManager git helpers ([6700324](https://github.com/DaveDev42/teleprompter/commit/67003249246dc57dd8ffce4e41c9d76f17ad41b0))
* pass EXPO_TOKEN env to eas build and submit steps ([f6f3a86](https://github.com/DaveDev42/teleprompter/commit/f6f3a86eaee3cff68f675bdea09ba6b62ca8c03c))
* preview distribution to store (TestFlight/Play), add OTA to release ([dafe6c4](https://github.com/DaveDev42/teleprompter/commit/dafe6c4a9e563bdf75ade6a26ae8f6a29148d9a3))
* push last worktree entry in list() when output lacks trailing newline ([372b6b2](https://github.com/DaveDev42/teleprompter/commit/372b6b29ebe8fc44940b785f25e91df6e0cf9848))
* reduce unlinkRetry blocking time + increase backpressure test timeout ([c8b62a5](https://github.com/DaveDev42/teleprompter/commit/c8b62a56c81ba9c45448c2d224c71a4294f24e92))
* regenerate lockfile for expo-crypto specifier change ([b2bb931](https://github.com/DaveDev42/teleprompter/commit/b2bb931e3e2e5cd4f6f54a60bf416da67f399c28))
* relay connection state tracking in Diagnostics, complete Android QA ([edcfa1a](https://github.com/DaveDev42/teleprompter/commit/edcfa1a81007a157664baa1d5462ba069b00d567))
* relay data flow gaps — state, session list, hello for relay frontends ([6e1d7fb](https://github.com/DaveDev42/teleprompter/commit/6e1d7fbfb2f62df17ac910633acb6e6ff69d9950))
* relay workflow if-condition and WsHelloReply type in test ([8bcb81e](https://github.com/DaveDev42/teleprompter/commit/8bcb81efac54b51b71b4db6cc5e93f4b7ba4aadb))
* **relay:** add daemonId to rate limit key, catch handlePush promise, test non-200 response ([f63ee34](https://github.com/DaveDev42/teleprompter/commit/f63ee34f072bdfe20da123d48732b0f3ab11741e))
* **release:** restore release/v* tag prefix ([3a1e69b](https://github.com/DaveDev42/teleprompter/commit/3a1e69bf6577382d03878d403c74d7f9e0b3896c))
* **release:** restore release/v* tag prefix (disable component in tag) ([23f34ff](https://github.com/DaveDev42/teleprompter/commit/23f34ffde847b08fce1b4d018dc08c679d501a39))
* remove deprecated expo-barcode-scanner, fix build warnings ([2642b30](https://github.com/DaveDev42/teleprompter/commit/2642b30f41587d00928db68eb523a381b2cb8941))
* remove explicit pnpm version from CI/release (use packageManager) ([fe31b66](https://github.com/DaveDev42/teleprompter/commit/fe31b6637bbc42562c3883bb9f340259f8f22532))
* replace raw Tailwind colors with tp-* semantic tokens ([72b8701](https://github.com/DaveDev42/teleprompter/commit/72b870151e7035e8b0c507071f66a82a4668dacb))
* replace raw Tailwind colors with tp-* semantic tokens and clean up voice prompt ([3430428](https://github.com/DaveDev42/teleprompter/commit/3430428b9065ca28b637f6925b82fcf8bc11f66f))
* resolve biome ci errors — format and remove unused imports ([c2350f2](https://github.com/DaveDev42/teleprompter/commit/c2350f2101e4eaa523e7c5f1c22a1acc8d9448d5))
* resolve biome ci errors — replace any with unknown, apply formatting ([876428d](https://github.com/DaveDev42/teleprompter/commit/876428dac31f0cf22b29e22fa932b57a8db96386))
* resolve biome formatting error breaking CI ([9b3fbde](https://github.com/DaveDev42/teleprompter/commit/9b3fbde786e0e850221c2ca70e6a651554f1d92c))
* resolve biome formatting error in use-ota-update.ts ([fed334e](https://github.com/DaveDev42/teleprompter/commit/fed334eec0e75458f8326f70e0d12171d8bbaec8))
* resolve CLI subcommand conflicts between tp and claude ([63aa54f](https://github.com/DaveDev42/teleprompter/commit/63aa54f2716979fadd5c1d5aac4f231de76a5251))
* resolve CLI subcommand conflicts between tp and claude ([a13e393](https://github.com/DaveDev42/teleprompter/commit/a13e39383caeadb4fbd81dd0db99b0c1459d4309))
* resolve E2E locator collision in session-switch test ([06b6d8a](https://github.com/DaveDev42/teleprompter/commit/06b6d8ad307d18e34988d5d1b4fbdfbf9307e0f5))
* resolve E2E locator collision in session-switch test ([fac38ac](https://github.com/DaveDev42/teleprompter/commit/fac38acf22b572f38503bd069697eab5365a15de))
* resolve expo doctor and android gradlew build failures ([56d88dc](https://github.com/DaveDev42/teleprompter/commit/56d88dc7496251339996ace582bef73c1da2e059))
* resolve expo doctor version mismatches and android splash screen lint error ([1e60e38](https://github.com/DaveDev42/teleprompter/commit/1e60e3819e0ba1833885ee416b69503f14d47e18))
* resolve frontend type error and add frontend tsc to CI ([3ab91e3](https://github.com/DaveDev42/teleprompter/commit/3ab91e373da91861bc602b34c4d2b6936bd5f09f))
* resolve infinite render loop in DiagnosticsPanel ([8c7be91](https://github.com/DaveDev42/teleprompter/commit/8c7be9109ad39976d282b92d1f65222b71e72819))
* resolve macOS symlink paths in WorktreeManager ([82ac398](https://github.com/DaveDev42/teleprompter/commit/82ac398e063d607813a34165a1c01f4fe4216674))
* resolve macOS symlink paths in WorktreeManager ([8e5753a](https://github.com/DaveDev42/teleprompter/commit/8e5753aa01c1b3fdbe929e6dfa2465e56eeca1de))
* resolve worktree test failures under bun test from repo root ([bedbf7d](https://github.com/DaveDev42/teleprompter/commit/bedbf7d43e63b0df0ff88a92e6df1e4180f03f57))
* resolve worktree test failures under bun test from repo root ([e7300ec](https://github.com/DaveDev42/teleprompter/commit/e7300ec225a75f8babdb15a7f1aab148ac2d425e))
* revert app.json version to 0.0.1 (EAS manages store versions) ([8f7aaaa](https://github.com/DaveDev42/teleprompter/commit/8f7aaaaccd1279cde31221df36626017c01056b3))
* revert roving tabindex to simple tabIndex=0, fix MouseEvent type ([846d95a](https://github.com/DaveDev42/teleprompter/commit/846d95acf797a10e5c879dd5183e70bc0afb877a))
* set ITSAppUsesNonExemptEncryption to false ([5575bfd](https://github.com/DaveDev42/teleprompter/commit/5575bfd268fd51876e38b803e94bfe6514388dd2))
* set ITSAppUsesNonExemptEncryption to false for TestFlight submission ([60f1bd7](https://github.com/DaveDev42/teleprompter/commit/60f1bd738d93d183096c491031c8729986e1c415))
* skip PtyBun tests on Windows, fix hardcoded /tmp paths ([26ed3cc](https://github.com/DaveDev42/teleprompter/commit/26ed3cc00e7dc20fbcd52ebd0151bd4e389a1398))
* sort imports in index.ts for biome lint ([4c646ec](https://github.com/DaveDev42/teleprompter/commit/4c646ec6fe1db585c4903197c1cecacce043179a))
* sort imports per biome organizeImports rule ([323de2a](https://github.com/DaveDev42/teleprompter/commit/323de2a668f474776163d6d6768089ed0e2d3799))
* update E2E tests for redesigned UI and optimize CI ([#5](https://github.com/DaveDev42/teleprompter/issues/5)) ([ba0036a](https://github.com/DaveDev42/teleprompter/commit/ba0036acb0901ed782228fa555d7328c67f505a8))
* use jsonBlock helper in formatMetaRecord, re-register export handler on sessions change ([499bdf7](https://github.com/DaveDev42/teleprompter/commit/499bdf7686e84b92d84e8ffdb18f4975283b6b9f))
* use regex pattern for version check in E2E test ([02a8829](https://github.com/DaveDev42/teleprompter/commit/02a8829efd2ae708b5a514c0127b249fd0a99d8d))
* use rmRetry and tmpdir across all test files for Windows ([6b42d82](https://github.com/DaveDev42/teleprompter/commit/6b42d8295a95331946a77f33201dc859be409a9d))
* use sudo for relay deploy to /usr/local/bin ([0de244a](https://github.com/DaveDev42/teleprompter/commit/0de244a1360a1320696896f73b246f4601d7de99))
* UTF-8 decoding for PTY output in Chat and Terminal ([d0be008](https://github.com/DaveDev42/teleprompter/commit/d0be008b0931331dadfada98dc67fa7488381ba0))
* vault UNIQUE constraint on session re-create + E2E test stability ([f3a87b9](https://github.com/DaveDev42/teleprompter/commit/f3a87b97ae25987af3dea4519a7a22142c11f33f))
* Windows path backslash in integration stub runner + increase unlinkRetry ([6c5ab30](https://github.com/DaveDev42/teleprompter/commit/6c5ab3011ed89ea18d5d9bff2df00b2b5529884e))
* Windows path backslash in stub runner imports and Store.deleteSession EBUSY ([4dc6de1](https://github.com/DaveDev42/teleprompter/commit/4dc6de19f28929d5717263205f5fca9b826c5e44))
* **windows:** extend unlinkRetry backoff and normalize worktree paths ([a642f54](https://github.com/DaveDev42/teleprompter/commit/a642f5447fb1ff85854dfcedfe3c0ce6ec293a4c))
* **windows:** force Bun.gc() after sqlite close to release OS handles ([fdc67c0](https://github.com/DaveDev42/teleprompter/commit/fdc67c097c5bd6cccee95f325cfd5361eaf1a46a))
* **windows:** re-enable bun:sqlite cleanup tests via Bun 1.3.12 ([05ec97c](https://github.com/DaveDev42/teleprompter/commit/05ec97c6b5e6fc81e76602ca376e095ea0e6c756))
* **windows:** re-skip sqlite cleanup tests, keep underlying improvements ([4f8cff5](https://github.com/DaveDev42/teleprompter/commit/4f8cff5f2c88a11f591186cc7b23a47f3209dedd))
* **windows:** resolve root causes of Windows test failures ([1f5ae95](https://github.com/DaveDev42/teleprompter/commit/1f5ae95e357074a58566423b43a51e638048a452))
* **windows:** rmRetry for SQLite EBUSY in test teardowns ([db2d6f3](https://github.com/DaveDev42/teleprompter/commit/db2d6f30bb5568425e18619f3e774c0af70fa465))
* **windows:** strengthen Store.unlinkRetry for sqlite handle lag ([6ec22a1](https://github.com/DaveDev42/teleprompter/commit/6ec22a14e667c61c062bd0c688b0112172772b5b))
* wire up PTY host auto-installer and fix Windows compatibility issues ([004ce5a](https://github.com/DaveDev42/teleprompter/commit/004ce5adb3c5ceb3945b148aa602f67e6a4c8667))
* worktree list() drops last entry when output lacks trailing newline ([bff8dd5](https://github.com/DaveDev42/teleprompter/commit/bff8dd5390b41a8791b2d0401dccfd2e28b7b6c9))


### Performance Improvements

* **ci:** cache Bun binary download ([30b16c4](https://github.com/DaveDev42/teleprompter/commit/30b16c493ed46cb22c547ecb49521a2c1f71e650))
* **ci:** cache Bun binary download ([2ddc4bb](https://github.com/DaveDev42/teleprompter/commit/2ddc4bb1fc1bf212162ec2a5a2da932fbf411170))
* **ci:** sample Store tests on Windows only ([12074d9](https://github.com/DaveDev42/teleprompter/commit/12074d944f72dd0ace42ddc13e38d60b04188bcf))
* **ci:** sample Store tests on Windows only ([79e5906](https://github.com/DaveDev42/teleprompter/commit/79e5906a7feac670d5d99a4a3e8c729160c15ef9))
* **ci:** share Store/SessionDb test fixtures ([f6321ed](https://github.com/DaveDev42/teleprompter/commit/f6321edee317589dd6984220e224090306e9e77a))
* **ci:** share Store/SessionDb test fixtures ([8d26c91](https://github.com/DaveDev42/teleprompter/commit/8d26c9131ec2ffe430081f74c244135f340363b7))


### Reverts

* **ci:** remove node_modules cache — slower than pnpm install ([a4d9f83](https://github.com/DaveDev42/teleprompter/commit/a4d9f83205fa2ff2ac2112b1bebee402a1962236))
* **ci:** remove node_modules cache — slower than pnpm install ([34ddb23](https://github.com/DaveDev42/teleprompter/commit/34ddb230064bed15ecb076ae7a5e4f35b4db606a))
* **ci:** remove redundant Bun binary cache ([452e99f](https://github.com/DaveDev42/teleprompter/commit/452e99fca13cf3fbe28b8d83cc1f91612d4010b8))

## [0.1.6](https://github.com/DaveDev42/teleprompter/compare/teleprompter-v0.1.5...teleprompter-v0.1.6) (2026-04-14)


### Features

* add --prune flag to daemon CLI for session cleanup on startup ([735269b](https://github.com/DaveDev42/teleprompter/commit/735269b48821fbb2c7d9bf1850bcb5067d8c5f12))
* add --verbose and --quiet flags to daemon CLI ([9f92492](https://github.com/DaveDev42/teleprompter/commit/9f924924385b26e94bc978fdc5f05be63b04ef11))
* add --watch flag for daemon auto-restart on crash ([d77e2f7](https://github.com/DaveDev42/teleprompter/commit/d77e2f702b0437653f02b4263ec6bbd1d5e7f943))
* add accessibility attributes to entire frontend ([5b79f14](https://github.com/DaveDev42/teleprompter/commit/5b79f146cab2670d58d27e52b398948c9bbb3d02))
* add accessibility attributes to entire frontend ([9e4bfb4](https://github.com/DaveDev42/teleprompter/commit/9e4bfb4d97657b05eb00433b3f2f2cf37b1372f6))
* add bun-windows-x64 build target ([f055714](https://github.com/DaveDev42/teleprompter/commit/f055714abd35bc26564d3ff6c8aefda61f5accbe))
* add Caddy TLS reverse proxy for relay.tpmt.dev ([cfa5905](https://github.com/DaveDev42/teleprompter/commit/cfa5905b57cc522d04e1ac1f86e4c50bae282eb6))
* add checksum verification, rollback, and daemon restart to tp upgrade ([8f15ca3](https://github.com/DaveDev42/teleprompter/commit/8f15ca3807fae53145c807ddb3bcd01c29f57bce))
* add checksum verification, rollback, and daemon restart to tp upgrade ([b4dff01](https://github.com/DaveDev42/teleprompter/commit/b4dff01c5bdf98698e63860d100818b6dc21b8e4))
* add export formatter with full event type support and ANSI-stripped IO ([c3018fb](https://github.com/DaveDev42/teleprompter/commit/c3018fb31271ce74212d0688d081595cb48e6da0))
* add filter options to WsSessionExport protocol type ([43c54e9](https://github.com/DaveDev42/teleprompter/commit/43c54e983e4eed417fee594626c93384cc2e2a9d))
* add frontend session.exported handler with Web download and native Share Sheet ([11b00ff](https://github.com/DaveDev42/teleprompter/commit/11b00ff7b28c308e05f523f57c89f17aa8420c8b))
* add frontend web serving from daemon (--web-dir) ([c668465](https://github.com/DaveDev42/teleprompter/commit/c6684654e287362781bf05611a3ad75dcb7f6a68))
* add getRecordsFiltered() to SessionDb with kind/time/limit filters ([483d552](https://github.com/DaveDev42/teleprompter/commit/483d55220107bc4242e33ae467c077007ea43faa))
* add keyboard focus to all screens (sessions, settings, daemons, session view, sidebar) ([f5bccfd](https://github.com/DaveDev42/teleprompter/commit/f5bccfd9445b11583a3da7f765fc4c9b9cef8f94))
* add keyboard navigation infrastructure (usePlatformProps, useKeyboard, ModalContainer) ([2b90e21](https://github.com/DaveDev42/teleprompter/commit/2b90e21ba22a0c3f6ef5028dbb0d8d07acd3b294))
* add OTA update UI and switch to fingerprint runtime version ([96a5417](https://github.com/DaveDev42/teleprompter/commit/96a54170544e917907955ebd3b2e07a33b7b78f2))
* add Playwright E2E tests for React Native Web + app-web-qa agent ([7c658a0](https://github.com/DaveDev42/teleprompter/commit/7c658a0bd291221bd1c2e45d0d28a2b67c354bec))
* add Playwright E2E to CI + daemon-connected browser tests ([b64d536](https://github.com/DaveDev42/teleprompter/commit/b64d536eddb8d81902c2eef556eb1e75cf0d063d))
* add Playwright MCP for web QA, fix Expo MCP connection ([5ec878f](https://github.com/DaveDev42/teleprompter/commit/5ec878f69abcaf1b6a9830f10c71c78ab285fbc3))
* add protocol versioning for relay, WS, and IPC ([b7da57d](https://github.com/DaveDev42/teleprompter/commit/b7da57ddb832df1b0bbc2c12a68f7fc0b2d9b8e5))
* add PTY host auto-installer for Windows ([5bfbc30](https://github.com/DaveDev42/teleprompter/commit/5bfbc30aba1a7a760b43db83e4cb9cbbd6dda7a2))
* add PtyWindows implementation with Node.js subprocess host ([9a5c28c](https://github.com/DaveDev42/teleprompter/commit/9a5c28c92864bcbbc26b543842aecfc33c049b38))
* add relay deploy script (scp + systemd) ([adc775f](https://github.com/DaveDev42/teleprompter/commit/adc775f627f8842e51f1b6fe04055638337af3dc))
* add relay ping, daemon service registration, native E2EE, fix tests ([297085e](https://github.com/DaveDev42/teleprompter/commit/297085e9989aea2f724f6469a500f86781207ae7))
* add rmRetry() helper for Windows EBUSY cleanup in tests ([f16ee59](https://github.com/DaveDev42/teleprompter/commit/f16ee594c7dc674dc6706976d5434daeef4da273))
* add tab bar testIDs and keyboard navigation E2E tests ([71c29d2](https://github.com/DaveDev42/teleprompter/commit/71c29d283a3248baab4bcd80dcf2e717ac7bdc45))
* add tp doctor command, relay health endpoint, v0.2.0 roadmap ([2762491](https://github.com/DaveDev42/teleprompter/commit/2762491f666d478b850e4d2dbdd4bbb7c38b219e))
* add tp logs command for live session record tailing ([f5c9348](https://github.com/DaveDev42/teleprompter/commit/f5c9348cdcbbcb70275bb7522d2474436972f377))
* add tp status command for daemon session overview ([c222903](https://github.com/DaveDev42/teleprompter/commit/c222903c18aaa38574a8c2c09f517f50b4aafdf6))
* add Vercel deployment config and privacy policy ([168bf11](https://github.com/DaveDev42/teleprompter/commit/168bf11b8d7c7faee475d08ccc0d504f20215720))
* add Windows Named Pipe IPC client ([d540c78](https://github.com/DaveDev42/teleprompter/commit/d540c78338bf2d33dd64b87114f46b7a691fbd19))
* add Windows Named Pipe IPC server ([88061b2](https://github.com/DaveDev42/teleprompter/commit/88061b296b85c35f6fb6bbf2ff9eb82af3ca1a38))
* add Windows Named Pipe path to socket-path ([02a792f](https://github.com/DaveDev42/teleprompter/commit/02a792fd666f429cdea14f28f03db935ef9d9432))
* add Windows PTY and IPC support ([498058a](https://github.com/DaveDev42/teleprompter/commit/498058a7cc3d5f0bc915ed5cbbba8a0c3158b625))
* add Windows PTY host script for ConPTY via @aspect-build/node-pty ([a55ba5b](https://github.com/DaveDev42/teleprompter/commit/a55ba5b93da50dad558cfa10fd14a8957e5c6db4))
* add Windows Task Scheduler service management ([b681f1d](https://github.com/DaveDev42/teleprompter/commit/b681f1d8524c4944751534fb2af06416c88e5ac9))
* add WS heartbeat (30s interval) for stale connection detection ([fb552b8](https://github.com/DaveDev42/teleprompter/commit/fb552b80aebae4b38849722e4ef782fcb20f5b7f))
* app deploy pipeline (preview → TestFlight/Internal, production → stores) ([994471f](https://github.com/DaveDev42/teleprompter/commit/994471f21127e81481b3344e10c4b2b23b87a306))
* **app:** add InAppToast component for relay notifications ([1526c05](https://github.com/DaveDev42/teleprompter/commit/1526c05f378b90b38ebb11a62ab5ca6b1743ff67))
* **app:** add sendPushToken, relay.notification handling, and notification store ([6344efa](https://github.com/DaveDev42/teleprompter/commit/6344efaa7905cc7a7178b744927461388c6552cd))
* **app:** add usePushNotifications hook for token registration ([6bacec8](https://github.com/DaveDev42/teleprompter/commit/6bacec846d84597fe6918203027dbd5cabe20d89))
* **app:** add usePushNotifications hook for token registration ([0afc235](https://github.com/DaveDev42/teleprompter/commit/0afc235fb99978629f2800d0baf0b19ab4e87384))
* **app:** install expo-notifications and configure plugins ([b31990f](https://github.com/DaveDev42/teleprompter/commit/b31990f940a4a66c29cede28099d9d3da849a337))
* **app:** send/receive control.unpair via relay ([c47815c](https://github.com/DaveDev42/teleprompter/commit/c47815c7bb4e657406f2b194d05cb553ebf80655))
* **app:** show pairing label and rename UI ([786e67c](https://github.com/DaveDev42/teleprompter/commit/786e67cf973b398d7195e4d06d23133592c49b3e))
* **app:** store label and handle control.rename ([1c2362d](https://github.com/DaveDev42/teleprompter/commit/1c2362d0ee7c2624dc8e3cb8fd7807fdc6351128))
* **app:** toast when peer removes pairing ([261ebce](https://github.com/DaveDev42/teleprompter/commit/261ebce397a5a38ef9dd16674bd6b21deea45c6f))
* **app:** wire push notifications and toast into root layout ([bd054ca](https://github.com/DaveDev42/teleprompter/commit/bd054cad8e5d533499196a298d3fb352447c9c96))
* auto-cleanup old sessions on daemon startup ([3b7abc5](https://github.com/DaveDev42/teleprompter/commit/3b7abc5b66493877441a6396c61b636271b91330))
* auto-cleanup old sessions on daemon startup and periodically ([a5dd8fc](https://github.com/DaveDev42/teleprompter/commit/a5dd8fcdc6ef1d643f71f49552970bf4169101e5))
* auto-detect WS URL when frontend is served by daemon ([3c6cf53](https://github.com/DaveDev42/teleprompter/commit/3c6cf53bd98e27b2662ea805bbfe9a7a147db6a7))
* auto-start daemon when tp status/logs is called ([d4a3ee8](https://github.com/DaveDev42/teleprompter/commit/d4a3ee8cf4058410233df2588541d3191cc9617a))
* **cli:** add pair subcommands (new/list/delete) ([afd0bc9](https://github.com/DaveDev42/teleprompter/commit/afd0bc9900925ecf9a61b4866caeddc07641d7cb))
* **cli:** add pair subcommands (new/list/delete) ([d80d330](https://github.com/DaveDev42/teleprompter/commit/d80d3308eccbb66d67ca07ba228f63c8359ac6e4))
* **cli:** pair --label, pair rename, label in list ([7e4b81b](https://github.com/DaveDev42/teleprompter/commit/7e4b81b70694b107008045a7fab013bea4dc29b6))
* **cli:** tp pair delete notifies peer via relay.unpair ([db2c809](https://github.com/DaveDev42/teleprompter/commit/db2c809e6b0d85649aba318e836f9dfc881794be))
* configurable daemon URL, turbo caching, pnpm scripts ([bf67dc6](https://github.com/DaveDev42/teleprompter/commit/bf67dc6b9cefc88d8f0350d3204b0576c8147fcd))
* configurable relay cache size and frame size limit ([d34612d](https://github.com/DaveDev42/teleprompter/commit/d34612db9fd3d9ecda60ed2f12a472a46ec37e8f))
* configurable relay frame cache size and WebSocket frame size limit ([5031279](https://github.com/DaveDev42/teleprompter/commit/5031279c9f5a02b79cf3df411637fec3b34d72dc))
* configure EAS Update for OTA deployments ([9092f7a](https://github.com/DaveDev42/teleprompter/commit/9092f7a2c50ceff501e8acfe52c8136cc4289cb7))
* daemon pairing persistence in vault DB, auto-reconnect on restart ([34c9478](https://github.com/DaveDev42/teleprompter/commit/34c947878c6d141682951f290edad2e623c69da5))
* daemon relay client v2 — multi-peer E2EE, self-registration, key exchange ([e58d909](https://github.com/DaveDev42/teleprompter/commit/e58d9090526460b9d021d58b4b47702b8212153d))
* **daemon:** add env option to SpawnRunnerOptions ([b28e5f8](https://github.com/DaveDev42/teleprompter/commit/b28e5f8d4c8c1bb77230e494c8b8aebe56f87d02))
* **daemon:** add passthrough helpers (onRecord, sendInput, resizeSession) ([c90353c](https://github.com/DaveDev42/teleprompter/commit/c90353ca65f9f6e5fe436a679f5f8416218e0d7c))
* **daemon:** add PushNotifier for hook event detection ([c8f4ea9](https://github.com/DaveDev42/teleprompter/commit/c8f4ea98c3ac1a2884ad65420bfee8cc25cb978f))
* **daemon:** add sendPush method to relay client ([ca3f4ed](https://github.com/DaveDev42/teleprompter/commit/ca3f4eda3be6c6d554e00817c5cf2aaf19d1c8f6))
* **daemon:** add sendUnpairNotice on RelayClient ([a99e1bf](https://github.com/DaveDev42/teleprompter/commit/a99e1bf2e8d2374eec3a55d2a0578a83dcd1d993))
* **daemon:** dispatch inbound control.unpair to remove pairing ([56e46e9](https://github.com/DaveDev42/teleprompter/commit/56e46e9d3d66672d3615e7ea99b60bd6559684d3))
* **daemon:** persist label on pairings ([ee034c0](https://github.com/DaveDev42/teleprompter/commit/ee034c040046ca7bbb874c5f2da882e2ba721584))
* **daemon:** send/receive control.rename ([4e171eb](https://github.com/DaveDev42/teleprompter/commit/4e171ebf5e4ec0802645b57e9be90a3bbb700161))
* **daemon:** wire PushNotifier into record pipeline and pushToken handling ([52b62fa](https://github.com/DaveDev42/teleprompter/commit/52b62fa3d44b1ec8b727a1b868e6e8461178bd66))
* default relay to wss://relay.tpmt.dev, keep local for dev ([61d8c04](https://github.com/DaveDev42/teleprompter/commit/61d8c0429b7c05380c8761be1a0d8b887de1323a))
* enhanced diagnostics panel per PRD section 18 ([b28d338](https://github.com/DaveDev42/teleprompter/commit/b28d3383212db1d06a2b8e6a48971001a418c62f))
* error handling UX — reconnect counter + daemon start hint ([115c3c0](https://github.com/DaveDev42/teleprompter/commit/115c3c02e176e4703e88d49ad0e2961ad6e07a3e))
* expand CI Playwright to 15 tests, fix session-switch locator ([db3ef46](https://github.com/DaveDev42/teleprompter/commit/db3ef4670f180de9d42d32dbef92f51ff349f742))
* Expo Push Notifications ([ea8465d](https://github.com/DaveDev42/teleprompter/commit/ea8465d21918f4a06dad5b8b57afd53d4943bf09))
* fingerprint-based conditional builds in EAS preview workflow ([45e1f11](https://github.com/DaveDev42/teleprompter/commit/45e1f1106852acaeae9c05769aa9aac27dd207e3))
* graceful shutdown, vault cleanup, relay rate limiting ([e569d1b](https://github.com/DaveDev42/teleprompter/commit/e569d1bf63687bd5e844c27f234be096fcbbce83))
* human-readable pairing labels ([4a0ea1d](https://github.com/DaveDev42/teleprompter/commit/4a0ea1d398e9e46ec9c3bd551bde2e1ab8c3e689))
* implement relay presence heartbeat for stale daemon detection ([e2ac639](https://github.com/DaveDev42/teleprompter/commit/e2ac639cb442d2a812698671777fb844c7a326e2))
* implement settings UI — font picker, API key modal, persistence ([940d7b7](https://github.com/DaveDev42/teleprompter/commit/940d7b7940daf06c3dcd694a4d8b3f4f250fcb43))
* implement settings UI — font picker, API key modal, theme & voice persistence ([68dedcd](https://github.com/DaveDev42/teleprompter/commit/68dedcdfd5c1f51fbcf655aac58fc85be012dce3))
* improve session export with full event types, IO records, filtering, and frontend delivery ([1c16384](https://github.com/DaveDev42/teleprompter/commit/1c163842aa363615f70df68ac7a05cb653c6581c))
* improve tp CLI usability ([247c991](https://github.com/DaveDev42/teleprompter/commit/247c9919340b6c256461657c47d50c76dfd06ec2))
* improve tp CLI usability ([ae6bcb9](https://github.com/DaveDev42/teleprompter/commit/ae6bcb973426d0ff49a2f0d6e649bfa86bc01ae2))
* keyboard navigation for Web ([296d5ea](https://github.com/DaveDev42/teleprompter/commit/296d5eaf7ab9a764d5d87588dd3839d5892005a7))
* migrate FontPickerModal, FontSizeModal, ApiKeyModal to ModalContainer ([d3244c3](https://github.com/DaveDev42/teleprompter/commit/d3244c38f4491f1c6c7cb58e78675246a331a590))
* migrate terminal from xterm.js to ghostty-web (libghostty WASM) ([#2](https://github.com/DaveDev42/teleprompter/issues/2)) ([4ca9e40](https://github.com/DaveDev42/teleprompter/commit/4ca9e401c72348ec43d4f7276442e82594e1e559))
* multi-frontend E2E test, daemon session switching UX ([f1b8a9d](https://github.com/DaveDev42/teleprompter/commit/f1b8a9da6e22bbbcc631993ee249ee68c1f40206))
* N:N frontend relay, multi-daemon pairing, persistence, docs ([1e5bc59](https://github.com/DaveDev42/teleprompter/commit/1e5bc59d1cbba44a248bb110068f2332dc5aaca2))
* N:N relay protocol v2 — self-registration, key exchange, frontendId ([ac53438](https://github.com/DaveDev42/teleprompter/commit/ac53438b39e05450166f9bbd76e50744e8eb3831))
* native E2EE crypto polyfill, relay wiring, diagnostics self-test ([85d247b](https://github.com/DaveDev42/teleprompter/commit/85d247bfb4e37208b42a0dc02bb7557d076b566f))
* Notification card, version compatibility check, protocol version ([111c6f3](https://github.com/DaveDev42/teleprompter/commit/111c6f33c62967bb526dc76f877a404eacb317a7))
* notify peer on pairing removal (control.unpair) ([1dc4ff8](https://github.com/DaveDev42/teleprompter/commit/1dc4ff80301e77795d4f8d10fc5e9cdc14c4bb4d))
* OTA update UI + fingerprint runtime version ([f677e40](https://github.com/DaveDev42/teleprompter/commit/f677e40be6943257c4459b973583e693658f3739))
* P2 quality — session restart, coverage, Playwright tests ([e35598e](https://github.com/DaveDev42/teleprompter/commit/e35598e5597e94f9eb4cf0c7b572e6a7aee47200))
* P3 — NativeWind cleanup, code blocks, session export, worktree UI ([c9eff1c](https://github.com/DaveDev42/teleprompter/commit/c9eff1c370d17da2db81e9b91bc7250db125f304))
* P3 complete — Android EAS, terminal copy, TODO update ([81eacf5](https://github.com/DaveDev42/teleprompter/commit/81eacf50451cb197c78d24cb1636de554d1c7a54))
* path-filtered EAS workflows, production tag trigger, remove EXPO_TOKEN dependency ([592269c](https://github.com/DaveDev42/teleprompter/commit/592269c7469de53e28bd437c374f797d3ddab6e8))
* PRD alignment — elicitation cards, permission cards, tp events, ([466f53f](https://github.com/DaveDev42/teleprompter/commit/466f53f69d0a966684ae09283802d60c8821a370))
* **protocol:** add control.rename message ([c1697a5](https://github.com/DaveDev42/teleprompter/commit/c1697a5b9b6626d864955e8316fdb13c25e4b362))
* **protocol:** add control.unpair message type ([dbd2de3](https://github.com/DaveDev42/teleprompter/commit/dbd2de3507ce4d8a65ea01b10451aaa9e5c6afc9))
* **protocol:** add RelayPush and RelayNotification types ([9e6ffa3](https://github.com/DaveDev42/teleprompter/commit/9e6ffa31572142f608673a6beec819d5fff33463))
* **protocol:** add WsPushToken type and pushToken frame type ([1ddcf06](https://github.com/DaveDev42/teleprompter/commit/1ddcf06e2322df331119ad3f8db0b8a3407e8163))
* **protocol:** carry label in pairing bundle ([91d5609](https://github.com/DaveDev42/teleprompter/commit/91d5609b027f7fa5cd2e17a833f2f340da11542d))
* redesign app UI with 3-tab navigation, theme system, and safe areas ([#3](https://github.com/DaveDev42/teleprompter/issues/3)) ([1549315](https://github.com/DaveDev42/teleprompter/commit/15493150e9fc75b42c4437f7b5512d16d9832a88))
* relay admin dashboard and daemon --watch auto-restart ([a8cbe55](https://github.com/DaveDev42/teleprompter/commit/a8cbe552cf0c4e5cade84e315479338e0b353a15))
* relay presence heartbeat for stale daemon detection ([49077ae](https://github.com/DaveDev42/teleprompter/commit/49077ae8905053015135b6ec1671e818230d896a))
* **relay:** add PushService with Expo Push API, rate limiting, and dedup ([4b824d1](https://github.com/DaveDev42/teleprompter/commit/4b824d14812c48fc90a46a7ddfd791eaba3832e9))
* **relay:** handle relay.push with WS notification delivery ([94b1d87](https://github.com/DaveDev42/teleprompter/commit/94b1d8781ad44cd42a71503a84559fad6c10c9a6))
* Terminal backlog replay on tab switch via onReady + resume ([ccc7e6b](https://github.com/DaveDev42/teleprompter/commit/ccc7e6b0df1dd5be92ef201eb8eb6a0745956d8d))
* terminal fallback banner for complex chat interactions ([1935ef8](https://github.com/DaveDev42/teleprompter/commit/1935ef899d611ddf8c40638ba9f2da2b6aac3d74))
* terminal search, session state persistence on restart ([635f1c1](https://github.com/DaveDev42/teleprompter/commit/635f1c1fcb3d229674838d28d5c1ee0694f8d5f0))
* theme toggle, session search, chat copy, tp init command ([1fa767a](https://github.com/DaveDev42/teleprompter/commit/1fa767a692ad46aa02a0a1585de425f94d71bd9d))
* tp upgrade, shell completions, version check on startup ([1cec1e5](https://github.com/DaveDev42/teleprompter/commit/1cec1e5638e0cbf58880b9991ae3a22ab9b0374a))
* unified release strategy with Release Please + EAS Workflow ([cc2c2ca](https://github.com/DaveDev42/teleprompter/commit/cc2c2ca88255dacc78dd60196413fec3230b9c93))
* wire daemon export handler with filtered queries and new formatter ([83618d2](https://github.com/DaveDev42/teleprompter/commit/83618d256db773972757c02e6df7b937fa4aabe0))


### Bug Fixes

* **a11y:** truncate long chat labels, conditional SettingsRow role ([5c73343](https://github.com/DaveDev42/teleprompter/commit/5c73343b726ccb1d96ae60985ee1266ef3149ea7))
* add bun install step to relay deploy workflow ([87440d8](https://github.com/DaveDev42/teleprompter/commit/87440d8a5148f957e448cf9dd88695ed22655094))
* add console.warn logging to silent catch blocks ([164a56b](https://github.com/DaveDev42/teleprompter/commit/164a56b0a50ee424187cbedc5bc5af90a3d92e5a))
* add console.warn logging to silent catch blocks in frontend ([658b95e](https://github.com/DaveDev42/teleprompter/commit/658b95e2d681108948335048e1ac33d691973f30))
* add explicit submit profile to EAS workflows ([5f706fb](https://github.com/DaveDev42/teleprompter/commit/5f706fb0cc5a90e2faf4dc043e9c5326f5525951))
* add explicit submit profile to EAS workflows ([6e43cc2](https://github.com/DaveDev42/teleprompter/commit/6e43cc2578f1eec377e80a4cc9acfb24cc295e12))
* add logging to Store.unlinkRetry, document sleepSync blocking ([5a7d871](https://github.com/DaveDev42/teleprompter/commit/5a7d87150503a748b80c567b7b0375483b3caa64))
* add missing v field to WsHelloReply assertion in test ([d7e3479](https://github.com/DaveDev42/teleprompter/commit/d7e34798198dd976c1625f76c469d7b3213adb16))
* add non-null assertion to bench test wsPort for consistency ([35dda62](https://github.com/DaveDev42/teleprompter/commit/35dda62b9ba0a9db35a5ef164640c551e7da956c))
* add submit profiles with ascAppId for TestFlight/App Store ([29447b1](https://github.com/DaveDev42/teleprompter/commit/29447b168e9fdf74961025c7bcd2399789732007))
* add worktree branch name and path permission validation ([15bb8fa](https://github.com/DaveDev42/teleprompter/commit/15bb8fab373fee2002bb2a0f7908a25a0854c63f))
* add worktree branch name and path permission validation ([2508bd5](https://github.com/DaveDev42/teleprompter/commit/2508bd5e2218c9944c96b1c153460977d7f33188))
* address all code review findings from pass 1 ([3b9a8b2](https://github.com/DaveDev42/teleprompter/commit/3b9a8b22af1a172bcf8b599bc749bb4f9be3df8a))
* address code review — biome format, ARIA tabs, cache props, missing focus targets ([0d8d5c2](https://github.com/DaveDev42/teleprompter/commit/0d8d5c2beefb989c1c805a1c1666a39597698d5d))
* address code review feedback (pass 1) ([ef4a3c1](https://github.com/DaveDev42/teleprompter/commit/ef4a3c1f44e7f986f3a7042e59c790b753642012))
* address code review feedback (pass 2) ([a4d2d6d](https://github.com/DaveDev42/teleprompter/commit/a4d2d6d7d56e90604e9ffbb7bbfb649627a48d19))
* address code review issues — cleanup bug, dead code, crypto tests ([167fa06](https://github.com/DaveDev42/teleprompter/commit/167fa0671fb979a5a8e3396c805d72674adb402c))
* address code review issues and add color/test infrastructure ([5c1d18f](https://github.com/DaveDev42/teleprompter/commit/5c1d18fbf63d0c11c4a5df45fd8d789fbeb7ffcb))
* address code review issues in E2EE relay wiring ([ae98f63](https://github.com/DaveDev42/teleprompter/commit/ae98f6305adf86a13bf324161100ff6362f4b364))
* address pass 2 review findings (toast ID, a11y, dedup guard, log noise) ([2131b89](https://github.com/DaveDev42/teleprompter/commit/2131b8906e4266ae8b4d0f38047cb2ae30af42b4))
* address remaining review nits ([84f266d](https://github.com/DaveDev42/teleprompter/commit/84f266d6a031b3e49f984fe92dd24c8ab80db358))
* address review feedback — use WsSessionMeta, add export timeout, collapse switch cases ([df436c8](https://github.com/DaveDev42/teleprompter/commit/df436c800452390e4a6d1abeaf2b3faec4e081ef))
* **app:** align expo SDK 55 patch versions ([acc516c](https://github.com/DaveDev42/teleprompter/commit/acc516c07b0c31d594d60b4f9dfaca9a1e5d7770))
* **app:** align expo SDK 55 patch versions ([3890f2a](https://github.com/DaveDev42/teleprompter/commit/3890f2a57759bd9a9977c9a0ecfcd17ecbe17e62))
* **app:** coerce empty label to null on rename ([2c708bd](https://github.com/DaveDev42/teleprompter/commit/2c708bd0493a110f47fc6b442644e4357a5127be))
* **app:** lint fixes for push notification files ([35bf97e](https://github.com/DaveDev42/teleprompter/commit/35bf97e8391f11182f63313a0ebd35e1fc5880ce))
* apply dark theme on native with inline style fallbacks ([7eab07a](https://github.com/DaveDev42/teleprompter/commit/7eab07ab6b37c3214415defbc9f4bc00365f1360))
* **app:** sync expo SDK 55 patch versions (v2) ([638cf84](https://github.com/DaveDev42/teleprompter/commit/638cf84149c8bbc70b07abbef8d62a1367c95039))
* **app:** sync expo SDK 55 patch versions (v2) ([63c101f](https://github.com/DaveDev42/teleprompter/commit/63c101fd9034d8bef9d25d0ce48b9b65dccfc896))
* **app:** use sendRelay for pushToken after unified transport refactor ([a266e5d](https://github.com/DaveDev42/teleprompter/commit/a266e5d19ada0353ac5f5e0ad3dd854597570da4))
* auto-detect daemon host from Expo Constants for native WS connection ([ad90ab9](https://github.com/DaveDev42/teleprompter/commit/ad90ab93a4584c8825316b7697fa5a896f2f3d33))
* biome format — break long getDaemonState signature ([e3c944c](https://github.com/DaveDev42/teleprompter/commit/e3c944c628b0416eaaf4d615c93f0cecb32360e2))
* biome format — wrap long line in daemon CLI ([4e435f6](https://github.com/DaveDev42/teleprompter/commit/4e435f6ed15a3bbccc3aba59b15a02f908640dff))
* biome format ModalContainer onClick spread ([8b31574](https://github.com/DaveDev42/teleprompter/commit/8b31574437c32f693c4ed5320f5fa7e453476196))
* biome formatting and import organization ([275f568](https://github.com/DaveDev42/teleprompter/commit/275f5688a9424253a0a1369dc652c25db9e4c6d0))
* biome import sort order in settings and FontPickerModal ([12e535b](https://github.com/DaveDev42/teleprompter/commit/12e535ba284c113e09ac97dbb4449bf191b3afdb))
* biome lint — replace non-null assertion with optional chain ([0e3f8ab](https://github.com/DaveDev42/teleprompter/commit/0e3f8abc1d3fb67d73430a36c05cb787540a9c83))
* biome lint — use template literal and fix formatting ([a42eee2](https://github.com/DaveDev42/teleprompter/commit/a42eee2974a978a132c4be584f560f648071aa89))
* biome lint and format fixes across project ([2503053](https://github.com/DaveDev42/teleprompter/commit/25030539eb88c547bcce9b7cd955fc6a7c34d56d))
* bump @expo/dom-webview 55.0.3 → 55.0.5 via pnpm override ([54991bb](https://github.com/DaveDev42/teleprompter/commit/54991bbf54e78458cce3b5cf7d1f75a9d74fd67b))
* bump @expo/dom-webview to fix iOS build ([a59454f](https://github.com/DaveDev42/teleprompter/commit/a59454faa8107927b568907fa7445b20c337b1eb))
* Chat record replay via resume on mount ([a448ee3](https://github.com/DaveDev42/teleprompter/commit/a448ee317bfd9d32076c327ecab71e771aea384a))
* **ci:** address review feedback on Bun cache step ([0242c05](https://github.com/DaveDev42/teleprompter/commit/0242c05c165e4321b5bd594a8c799ae9e59f6b3e))
* **ci:** check for (fail) prefix instead of broad error pattern ([d012f1b](https://github.com/DaveDev42/teleprompter/commit/d012f1b871d1d7c4c0804691777b0464179fab8f))
* **ci:** detect real test failures on Windows despite Bun panic ([eed9633](https://github.com/DaveDev42/teleprompter/commit/eed9633267bec8a25079a928c6bfea15d9043c91))
* **ci:** exclude daemon integration tests on Windows ([d6817f9](https://github.com/DaveDev42/teleprompter/commit/d6817f91e655586180c31ca719b33a683d5eb1f7))
* **ci:** mark test-windows as continue-on-error ([d89b51c](https://github.com/DaveDev42/teleprompter/commit/d89b51c0c46ef49c1c062c1f318d9e07362a4f1d))
* **ci:** narrow Windows test scope to compatible packages ([4c021e8](https://github.com/DaveDev42/teleprompter/commit/4c021e8ac631271cc5c9d1659ace516be628f144))
* **ci:** remove invalid 'on: manual' from EAS workflows — omit on: entirely ([08aefcf](https://github.com/DaveDev42/teleprompter/commit/08aefcfe9288e0bf0510b29686e94cdfb2497d11))
* **ci:** resolve lint + Windows-specific test failures ([790c2c1](https://github.com/DaveDev42/teleprompter/commit/790c2c1e3a1b91cd21be9c12569e146147174ed7))
* **ci:** use expo-doctor instead of deprecated expo doctor ([a4fb252](https://github.com/DaveDev42/teleprompter/commit/a4fb252a58d4b81ff102336285e6045dcac3c70b))
* **ci:** use expo-doctor instead of deprecated expo doctor ([7976710](https://github.com/DaveDev42/teleprompter/commit/797671076f0c830472f58937c874f7e7bad04aa4))
* **ci:** use tee + file for Bun panic workaround on Windows ([11545cd](https://github.com/DaveDev42/teleprompter/commit/11545cd4d866776e6788aceffad667af366a532f))
* **ci:** work around Bun 1.3.6 Windows panic after test completion ([3b6c6b2](https://github.com/DaveDev42/teleprompter/commit/3b6c6b259c57e2d4e63797c5d4f6f0fcc9f9d711))
* **cli:** biome format + windows rmSync retry for pair tests ([a73d73e](https://github.com/DaveDev42/teleprompter/commit/a73d73ec47a76893064bbf055a584f024a3e4f02))
* **cli:** clean up passthrough on spawn failure or missing runner process ([d52cb95](https://github.com/DaveDev42/teleprompter/commit/d52cb95388712c0b89d2a2837cf3ef443e6270ba))
* **cli:** handle SIGTERM in tp logs for symmetry with SIGINT ([613b3b7](https://github.com/DaveDev42/teleprompter/commit/613b3b7914356167e3ad77457d134519d1f5a4b7))
* **cli:** prevent upgrade-check cache from sliding on fresh-cache hits ([fbd3f65](https://github.com/DaveDev42/teleprompter/commit/fbd3f65838c6b6b4ed1cda96c98eb36055a1aace))
* **cli:** skip pair list/delete tests on Windows, bump completions timeout ([0271273](https://github.com/DaveDev42/teleprompter/commit/0271273ea1a65784392879f5107cccd53e11bb61))
* **cli:** stale socket detection, prefix parity, upgrade-notice rate limit ([eeab632](https://github.com/DaveDev42/teleprompter/commit/eeab632c382c23342d1b889d6158fe8b44025268))
* **cli:** stale socket detection, prefix parity, upgrade-notice rate limit ([f76b825](https://github.com/DaveDev42/teleprompter/commit/f76b825c98ae99fe454803ef502dfb4597456fd9))
* compiled tp binary fails to spawn runner ([87ebd57](https://github.com/DaveDev42/teleprompter/commit/87ebd57860f6542ed471fa4a4d7968cfe2246738))
* compiled tp binary fails to spawn runner (Module not found $bunfs) ([1c6b4f3](https://github.com/DaveDev42/teleprompter/commit/1c6b4f32bc0520e839da03a0b3eb88930e7be55c))
* deploy-relay job condition and missing WsHello version field ([31b84bd](https://github.com/DaveDev42/teleprompter/commit/31b84bd3b1f8f99a566f82031071261009e5a420))
* detect daemon host from Metro dev server URL (not just localhost) ([437a370](https://github.com/DaveDev42/teleprompter/commit/437a370410932b7def87f7b440ef48766e5c02b2))
* detect Metro dev server on port 8082+ (Expo MCP uses non-8081 ports) ([8772bb1](https://github.com/DaveDev42/teleprompter/commit/8772bb1a9b4055b5b0523fc89490aa44d1830822))
* E2E focus ring test — verify tabindex attribute instead of compiled class names ([fa5d6a3](https://github.com/DaveDev42/teleprompter/commit/fa5d6a3d2f8a5343cb38f27262136d046e9b1f23))
* E2E tests — handle disabled send button, use class check for focus ring ([0b42c76](https://github.com/DaveDev42/teleprompter/commit/0b42c769896773d24a422a844f35443356e2890e))
* **eas:** use draft release status for Android internal submit ([d9316a6](https://github.com/DaveDev42/teleprompter/commit/d9316a6f55aa08100fadf2467d8354433cf82100))
* **eas:** use draft release status for Android internal submit ([9e0dce6](https://github.com/DaveDev42/teleprompter/commit/9e0dce6a618a6546853c33180381463b267a8461))
* format settings.tsx to pass biome lint ([2bca370](https://github.com/DaveDev42/teleprompter/commit/2bca370b71a7908006515afbb1a52d88d8eb0831))
* format settings.tsx to pass biome lint ([fea42fd](https://github.com/DaveDev42/teleprompter/commit/fea42fda3484e33406339427695041194771320d))
* handle Windows bun.exe and URL path in spawn test ([b1531d5](https://github.com/DaveDev42/teleprompter/commit/b1531d519fbd91d8f2ccf2213643e94b3cac118a))
* improve Chat empty state UX + ANSI stripping ([44a95fd](https://github.com/DaveDev42/teleprompter/commit/44a95fdaa077329f1cca3ea8897c7efb36f75fb5))
* improve resume test reconnection detection reliability ([8d7de5b](https://github.com/DaveDev42/teleprompter/commit/8d7de5b0cdc022262e4f3e4e6bcbf40722f4b544))
* isolate full-stack tests with temp vault dir (no more UNIQUE errors) ([0e9d8c7](https://github.com/DaveDev42/teleprompter/commit/0e9d8c780233ad06ba850d4afc532c0e6ab87561))
* keep useDaemon always active for E2E compatibility ([ce9a9dc](https://github.com/DaveDev42/teleprompter/commit/ce9a9dce5179b43e3cc71d37c5e08f3a969472ff))
* make protocol client-safe for React Native / Expo Go ([f302860](https://github.com/DaveDev42/teleprompter/commit/f30286008071456d6612c71e65fcc971a2c07a0e))
* make rmRetry best-effort on final retry ([d5deb19](https://github.com/DaveDev42/teleprompter/commit/d5deb19a2b33bba8eafed17dc05b9102703e1371))
* make tests CI-compatible (branch name, socket path) ([3e0a35a](https://github.com/DaveDev42/teleprompter/commit/3e0a35abbfc7d74161b9ba2834438634df4fde07))
* move rmRetry to subpath import, fix Store TOCTOU, add protocol type-check ([0e0d074](https://github.com/DaveDev42/teleprompter/commit/0e0d0740e0170914dddefc92a4854b4e56debbcd))
* pass cwd to execFileSync in WorktreeManager git helpers ([1981e2d](https://github.com/DaveDev42/teleprompter/commit/1981e2d93036af98f8774d81b4da18612e66605a))
* pass cwd to execFileSync in WorktreeManager git helpers ([6700324](https://github.com/DaveDev42/teleprompter/commit/67003249246dc57dd8ffce4e41c9d76f17ad41b0))
* pass EXPO_TOKEN env to eas build and submit steps ([f6f3a86](https://github.com/DaveDev42/teleprompter/commit/f6f3a86eaee3cff68f675bdea09ba6b62ca8c03c))
* preview distribution to store (TestFlight/Play), add OTA to release ([dafe6c4](https://github.com/DaveDev42/teleprompter/commit/dafe6c4a9e563bdf75ade6a26ae8f6a29148d9a3))
* push last worktree entry in list() when output lacks trailing newline ([372b6b2](https://github.com/DaveDev42/teleprompter/commit/372b6b29ebe8fc44940b785f25e91df6e0cf9848))
* reduce unlinkRetry blocking time + increase backpressure test timeout ([c8b62a5](https://github.com/DaveDev42/teleprompter/commit/c8b62a56c81ba9c45448c2d224c71a4294f24e92))
* regenerate lockfile for expo-crypto specifier change ([b2bb931](https://github.com/DaveDev42/teleprompter/commit/b2bb931e3e2e5cd4f6f54a60bf416da67f399c28))
* relay connection state tracking in Diagnostics, complete Android QA ([edcfa1a](https://github.com/DaveDev42/teleprompter/commit/edcfa1a81007a157664baa1d5462ba069b00d567))
* relay data flow gaps — state, session list, hello for relay frontends ([6e1d7fb](https://github.com/DaveDev42/teleprompter/commit/6e1d7fbfb2f62df17ac910633acb6e6ff69d9950))
* relay workflow if-condition and WsHelloReply type in test ([8bcb81e](https://github.com/DaveDev42/teleprompter/commit/8bcb81efac54b51b71b4db6cc5e93f4b7ba4aadb))
* **relay:** add daemonId to rate limit key, catch handlePush promise, test non-200 response ([f63ee34](https://github.com/DaveDev42/teleprompter/commit/f63ee34f072bdfe20da123d48732b0f3ab11741e))
* remove deprecated expo-barcode-scanner, fix build warnings ([2642b30](https://github.com/DaveDev42/teleprompter/commit/2642b30f41587d00928db68eb523a381b2cb8941))
* remove explicit pnpm version from CI/release (use packageManager) ([fe31b66](https://github.com/DaveDev42/teleprompter/commit/fe31b6637bbc42562c3883bb9f340259f8f22532))
* replace raw Tailwind colors with tp-* semantic tokens ([72b8701](https://github.com/DaveDev42/teleprompter/commit/72b870151e7035e8b0c507071f66a82a4668dacb))
* replace raw Tailwind colors with tp-* semantic tokens and clean up voice prompt ([3430428](https://github.com/DaveDev42/teleprompter/commit/3430428b9065ca28b637f6925b82fcf8bc11f66f))
* resolve biome ci errors — format and remove unused imports ([c2350f2](https://github.com/DaveDev42/teleprompter/commit/c2350f2101e4eaa523e7c5f1c22a1acc8d9448d5))
* resolve biome ci errors — replace any with unknown, apply formatting ([876428d](https://github.com/DaveDev42/teleprompter/commit/876428dac31f0cf22b29e22fa932b57a8db96386))
* resolve biome formatting error breaking CI ([9b3fbde](https://github.com/DaveDev42/teleprompter/commit/9b3fbde786e0e850221c2ca70e6a651554f1d92c))
* resolve biome formatting error in use-ota-update.ts ([fed334e](https://github.com/DaveDev42/teleprompter/commit/fed334eec0e75458f8326f70e0d12171d8bbaec8))
* resolve CLI subcommand conflicts between tp and claude ([63aa54f](https://github.com/DaveDev42/teleprompter/commit/63aa54f2716979fadd5c1d5aac4f231de76a5251))
* resolve CLI subcommand conflicts between tp and claude ([a13e393](https://github.com/DaveDev42/teleprompter/commit/a13e39383caeadb4fbd81dd0db99b0c1459d4309))
* resolve E2E locator collision in session-switch test ([06b6d8a](https://github.com/DaveDev42/teleprompter/commit/06b6d8ad307d18e34988d5d1b4fbdfbf9307e0f5))
* resolve E2E locator collision in session-switch test ([fac38ac](https://github.com/DaveDev42/teleprompter/commit/fac38acf22b572f38503bd069697eab5365a15de))
* resolve expo doctor and android gradlew build failures ([56d88dc](https://github.com/DaveDev42/teleprompter/commit/56d88dc7496251339996ace582bef73c1da2e059))
* resolve expo doctor version mismatches and android splash screen lint error ([1e60e38](https://github.com/DaveDev42/teleprompter/commit/1e60e3819e0ba1833885ee416b69503f14d47e18))
* resolve frontend type error and add frontend tsc to CI ([3ab91e3](https://github.com/DaveDev42/teleprompter/commit/3ab91e373da91861bc602b34c4d2b6936bd5f09f))
* resolve infinite render loop in DiagnosticsPanel ([8c7be91](https://github.com/DaveDev42/teleprompter/commit/8c7be9109ad39976d282b92d1f65222b71e72819))
* resolve macOS symlink paths in WorktreeManager ([82ac398](https://github.com/DaveDev42/teleprompter/commit/82ac398e063d607813a34165a1c01f4fe4216674))
* resolve macOS symlink paths in WorktreeManager ([8e5753a](https://github.com/DaveDev42/teleprompter/commit/8e5753aa01c1b3fdbe929e6dfa2465e56eeca1de))
* resolve type errors in IPC server and hook receiver tests ([6c62408](https://github.com/DaveDev42/teleprompter/commit/6c62408538cc94e3afa92efe0244bd6add20bcf0))
* resolve worktree test failures under bun test from repo root ([bedbf7d](https://github.com/DaveDev42/teleprompter/commit/bedbf7d43e63b0df0ff88a92e6df1e4180f03f57))
* resolve worktree test failures under bun test from repo root ([e7300ec](https://github.com/DaveDev42/teleprompter/commit/e7300ec225a75f8babdb15a7f1aab148ac2d425e))
* revert app.json version to 0.0.1 (EAS manages store versions) ([8f7aaaa](https://github.com/DaveDev42/teleprompter/commit/8f7aaaaccd1279cde31221df36626017c01056b3))
* revert roving tabindex to simple tabIndex=0, fix MouseEvent type ([846d95a](https://github.com/DaveDev42/teleprompter/commit/846d95acf797a10e5c879dd5183e70bc0afb877a))
* set ITSAppUsesNonExemptEncryption to false ([5575bfd](https://github.com/DaveDev42/teleprompter/commit/5575bfd268fd51876e38b803e94bfe6514388dd2))
* set ITSAppUsesNonExemptEncryption to false for TestFlight submission ([60f1bd7](https://github.com/DaveDev42/teleprompter/commit/60f1bd738d93d183096c491031c8729986e1c415))
* skip PtyBun tests on Windows, fix hardcoded /tmp paths ([26ed3cc](https://github.com/DaveDev42/teleprompter/commit/26ed3cc00e7dc20fbcd52ebd0151bd4e389a1398))
* sort imports in index.ts for biome lint ([4c646ec](https://github.com/DaveDev42/teleprompter/commit/4c646ec6fe1db585c4903197c1cecacce043179a))
* sort imports per biome organizeImports rule ([323de2a](https://github.com/DaveDev42/teleprompter/commit/323de2a668f474776163d6d6768089ed0e2d3799))
* update E2E tests for redesigned UI and optimize CI ([#5](https://github.com/DaveDev42/teleprompter/issues/5)) ([ba0036a](https://github.com/DaveDev42/teleprompter/commit/ba0036acb0901ed782228fa555d7328c67f505a8))
* use jsonBlock helper in formatMetaRecord, re-register export handler on sessions change ([499bdf7](https://github.com/DaveDev42/teleprompter/commit/499bdf7686e84b92d84e8ffdb18f4975283b6b9f))
* use regex pattern for version check in E2E test ([02a8829](https://github.com/DaveDev42/teleprompter/commit/02a8829efd2ae708b5a514c0127b249fd0a99d8d))
* use rmRetry and tmpdir across all test files for Windows ([6b42d82](https://github.com/DaveDev42/teleprompter/commit/6b42d8295a95331946a77f33201dc859be409a9d))
* use sudo for relay deploy to /usr/local/bin ([0de244a](https://github.com/DaveDev42/teleprompter/commit/0de244a1360a1320696896f73b246f4601d7de99))
* UTF-8 decoding for PTY output in Chat and Terminal ([d0be008](https://github.com/DaveDev42/teleprompter/commit/d0be008b0931331dadfada98dc67fa7488381ba0))
* vault UNIQUE constraint on session re-create + E2E test stability ([f3a87b9](https://github.com/DaveDev42/teleprompter/commit/f3a87b97ae25987af3dea4519a7a22142c11f33f))
* Windows path backslash in integration stub runner + increase unlinkRetry ([6c5ab30](https://github.com/DaveDev42/teleprompter/commit/6c5ab3011ed89ea18d5d9bff2df00b2b5529884e))
* Windows path backslash in stub runner imports and Store.deleteSession EBUSY ([4dc6de1](https://github.com/DaveDev42/teleprompter/commit/4dc6de19f28929d5717263205f5fca9b826c5e44))
* **windows:** extend unlinkRetry backoff and normalize worktree paths ([a642f54](https://github.com/DaveDev42/teleprompter/commit/a642f5447fb1ff85854dfcedfe3c0ce6ec293a4c))
* **windows:** force Bun.gc() after sqlite close to release OS handles ([fdc67c0](https://github.com/DaveDev42/teleprompter/commit/fdc67c097c5bd6cccee95f325cfd5361eaf1a46a))
* **windows:** re-enable bun:sqlite cleanup tests via Bun 1.3.12 ([05ec97c](https://github.com/DaveDev42/teleprompter/commit/05ec97c6b5e6fc81e76602ca376e095ea0e6c756))
* **windows:** re-skip sqlite cleanup tests, keep underlying improvements ([4f8cff5](https://github.com/DaveDev42/teleprompter/commit/4f8cff5f2c88a11f591186cc7b23a47f3209dedd))
* **windows:** resolve root causes of Windows test failures ([1f5ae95](https://github.com/DaveDev42/teleprompter/commit/1f5ae95e357074a58566423b43a51e638048a452))
* **windows:** rmRetry for SQLite EBUSY in test teardowns ([db2d6f3](https://github.com/DaveDev42/teleprompter/commit/db2d6f30bb5568425e18619f3e774c0af70fa465))
* **windows:** strengthen Store.unlinkRetry for sqlite handle lag ([6ec22a1](https://github.com/DaveDev42/teleprompter/commit/6ec22a14e667c61c062bd0c688b0112172772b5b))
* wire up PTY host auto-installer and fix Windows compatibility issues ([004ce5a](https://github.com/DaveDev42/teleprompter/commit/004ce5adb3c5ceb3945b148aa602f67e6a4c8667))
* worktree list() drops last entry when output lacks trailing newline ([bff8dd5](https://github.com/DaveDev42/teleprompter/commit/bff8dd5390b41a8791b2d0401dccfd2e28b7b6c9))


### Performance Improvements

* **ci:** cache Bun binary download ([30b16c4](https://github.com/DaveDev42/teleprompter/commit/30b16c493ed46cb22c547ecb49521a2c1f71e650))
* **ci:** cache Bun binary download ([2ddc4bb](https://github.com/DaveDev42/teleprompter/commit/2ddc4bb1fc1bf212162ec2a5a2da932fbf411170))
* **ci:** sample Store tests on Windows only ([12074d9](https://github.com/DaveDev42/teleprompter/commit/12074d944f72dd0ace42ddc13e38d60b04188bcf))
* **ci:** sample Store tests on Windows only ([79e5906](https://github.com/DaveDev42/teleprompter/commit/79e5906a7feac670d5d99a4a3e8c729160c15ef9))
* **ci:** share Store/SessionDb test fixtures ([f6321ed](https://github.com/DaveDev42/teleprompter/commit/f6321edee317589dd6984220e224090306e9e77a))
* **ci:** share Store/SessionDb test fixtures ([8d26c91](https://github.com/DaveDev42/teleprompter/commit/8d26c9131ec2ffe430081f74c244135f340363b7))


### Reverts

* **ci:** remove node_modules cache — slower than pnpm install ([a4d9f83](https://github.com/DaveDev42/teleprompter/commit/a4d9f83205fa2ff2ac2112b1bebee402a1962236))
* **ci:** remove node_modules cache — slower than pnpm install ([34ddb23](https://github.com/DaveDev42/teleprompter/commit/34ddb230064bed15ecb076ae7a5e4f35b4db606a))
* **ci:** remove redundant Bun binary cache ([452e99f](https://github.com/DaveDev42/teleprompter/commit/452e99fca13cf3fbe28b8d83cc1f91612d4010b8))

## v0.1.5

### Monorepo Restructure
- daemon/relay/runner moved to `packages/` (libraries bundled into CLI)
- `apps/frontend` renamed to `apps/app`
- Removed Docker files (relay deployment via binary on Hetzner/OCI)

### Critical Bug Fixes
- **Terminal empty screen**: backlog replay via `onReady` + `resume(sid, 0)` on tab switch
- **Chat missing events**: record replay via `resume` on Chat mount (catches pre-handler batch)
- **UTF-8 decoding**: `atob()` → `Uint8Array` + `TextDecoder` for PTY output
- **Vault UNIQUE constraint**: `INSERT OR REPLACE` for session re-create
- **Metro port detection**: 8081-8099 range for Expo MCP compatibility
- **DiagnosticsPanel infinite loop**: fixed `useOfflineStore` selector

### New Features
- `tp upgrade` — check + download latest release + claude update
- `tp completions <bash|zsh|fish>` — shell completion scripts
- Version check on startup (passthrough mode)
- Auto-start daemon when `tp status` / `tp logs` is called
- Reconnect counter + daemon start hint in Chat UI
- Improved Chat empty state: "Listening to Claude Code..."
- Improved ANSI stripping (CSI, OSC, charset, control chars)

### Testing
- Playwright E2E: 16 tests (smoke, daemon-connected, real PTY, resume)
- CI/local project split (CI runs without `claude` CLI)
- QA agents: `app-ios-qa` (Expo MCP), `app-web-qa` (Playwright)
- P0 fully verified: Terminal ANSI rendering, Chat streaming, Session resume

### Verified via Playwright Screenshots
- Terminal: Claude Code rich TUI (colors, vim, prompt) — 1540 chars
- Chat: PTY streaming + SessionStart card
- Session resume: daemon restart → auto-reconnect → content restored

---

## v0.1.4

### iOS / Expo Go Support
- Full E2E pipeline verified on iOS simulator via Expo Go
- Protocol client entrypoint (`@teleprompter/protocol/client`) without Node.js deps
- Lazy libsodium loading for React Native compatibility
- Auto-detect daemon host from Metro dev server URL
- Dark theme with inline style fallbacks for native
- NativeWind babel preset configuration
- EAS project linked, Expo Go v55.0.27

### Verified on iOS
- Chat tab: real-time Claude PTY output as streaming bubbles
- Session ID display in header
- Dark theme rendering
- WebSocket connection to daemon via auto-detected host IP
- Full pipeline: Claude Code → Runner → Daemon → WS → Expo Go

---

## v0.1.3

### PRD Alignment
- Elicitation cards with parsed choice options (indigo theme)
- Permission request cards with tool name and input preview (amber theme)
- Notification events rendered with message text
- Terminal fallback banner for complex interactions (Switch to Terminal / Dismiss)
- Claude version displayed in session list
- TP-namespace internal event system (Collector.tpEvent, Daemon.emitTpEvent)

### Enhanced Diagnostics (PRD Section 18)
- Relay/pairing status section
- Session summary (running/stopped/error counts, worktrees)
- Per-session cached frames count
- Relay attached frontend tracking per session

### Other
- Version compatibility checking (MIN_CLAUDE_VERSION, PROTOCOL_VERSION)
- Performance benchmarks: 10K rec/s pipeline, 476K codec, 62K crypto
- 203 tests across 41 files

---

## v0.1.2

### Improvements
- Configurable daemon URL in Settings (auto-detect or manual override)
- Frontend type checking added to CI (all 5 packages now checked)
- Turbo caching optimized with proper input definitions
- Root pnpm scripts for common workflows (test, type-check:all, build:web)

---

## v0.1.1

### New Commands
- `tp doctor` — environment diagnostics (Bun, Node, pnpm, Claude CLI, Git, daemon, vault)
- `tp init` — quick project setup guide with detected configuration

### UX Improvements
- Theme toggle (dark/light/system) in Settings
- Session search/filter by sid, cwd, worktree, state
- Chat message copy (long-press) and selectable text
- Terminal scrollback search via @xterm/addon-search

### Reliability
- Relay `/health` JSON endpoint and `/admin` HTML dashboard
- WebSocket heartbeat (30s interval) for stale connection detection
- Daemon `--watch` flag for auto-restart on uncaught exceptions
- Session state persistence across daemon restart (stale sessions marked stopped)
- MIT LICENSE file

---

## v0.1.0 — Initial Release

### Core Architecture
- **Runner**: PTY spawn via `Bun.spawn({ terminal })`, hooks collection, IPC client
- **Daemon**: Session manager, Vault (SQLite append-only), IPC server, WebSocket server, relay client, worktree manager, static web serving, graceful shutdown, session pruning
- **Relay**: Token-based auth, bidirectional ciphertext frame routing, session caching (recent 10), online/offline presence, rate limiting (100 msg/sec)
- **Protocol**: Framed JSON codec (u32_be + UTF-8), shared types (IPC/WS/Relay), level-based logger

### E2EE
- X25519 key exchange (ECDH)
- XChaCha20-Poly1305 AEAD encryption
- Per-session ephemeral key ratchet
- QR-based pairing with BLAKE2b-derived relay tokens
- Zero-trust: relay sees only ciphertext

### Frontend (Expo)
- **Chat tab**: Hook event cards (UserPromptSubmit, Stop, PreToolUse, PostToolUse, PermissionRequest, Elicitation), PTY streaming bubbles, chat input
- **Terminal tab**: xterm.js (web), WebView bridge (native), terminal resize forwarding
- **Sessions tab**: Worktree-grouped session list, session switching, stop button
- **Settings tab**: OpenAI API key (secure storage), relay endpoint management, diagnostics panel with RTT
- **Voice**: OpenAI Realtime API (STT + TTS + prompt refinement), terminal context injection
- **Responsive**: Mobile (tabs), tablet (split), desktop (sidebar + split)
- **QR pairing**: Camera scan (native) + manual paste (web)
- **Offline**: Recent 10 frame cache, connection badge with relative time

### CLI (`tp` binary)
- `tp <claude args>` — Passthrough mode (default)
- `tp daemon start` — Full-featured daemon with `--ws-port`, `--repo-root`, `--relay-url`, `--web-dir`, `--prune`, `--verbose`/`--quiet`
- `tp relay start` — Relay server
- `tp pair` — QR pairing data generation with terminal QR display
- `tp status` — Daemon status and session overview
- `tp logs` — Live session record tailing
- `tp version` — Version info

### Infrastructure
- Turborepo + pnpm monorepo
- GitHub Actions CI (type-check, test, build, web export)
- GitHub Actions release (4-platform binary: darwin arm64/x64, linux x64/arm64)
- Relay Dockerfile + docker-compose
- curl-pipe-sh installer (`install.sh`)
- EAS Build configuration (iOS/Android)

### Testing
- 193 tests across 38 files
- Full-stack E2E: Runner → IPC → Daemon → WS/Relay → Frontend
- Crypto E2E: QR pairing → key exchange → ratchet → encrypt/decrypt
- Edge cases: partial frames, unicode, 1MB payloads, tampered ciphertext, rate limiting
