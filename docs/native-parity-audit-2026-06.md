# Native Parity + Correctness Audit (2026-06)

> Source: multi-agent audit (`wf_696c161d-cb1`, 54 agents) comparing live HEAD Swift
> app (`ios/Sources/**`) against the Expo baseline at git `93ee41d` (parent of the
> rewrite). Every finding was adversarially re-verified against HEAD source on disk.
> **39 confirmed, 10 rejected** (rejected = documented-deferred or non-issues).
>
> This audit corrects the overstated "Phase 3 parity 완료 / 옛 Expo 컴포넌트 전부
> 네이티브 대응" claim in TODO.md:71 — the app compiles + boots (8-marker smoke green)
> but several intended-live features are broken or unwired. The smoke harness only
> exercises the boot/encrypt/decrypt happy path; it cannot catch UI wiring bugs.

## HIGH severity (real, user-facing breakage)

| # | Title | Native ref | Fix |
|---|-------|-----------|-----|
| H1 | ChatComposer never shown — `onSend` not passed to ChatView | SessionDetailView.swift:39 | pass `onSend: onSend` |
| H2 | User bubble never renders — `PrePrompt` vs `UserPromptSubmit` | ChatEventCardKind.swift:26 | rename case + decode `prompt` field |
| H3 | `upsertSessions` never removes daemon-deleted sessions (ghost rows, persisted) | SessionStore.swift:99 | per-daemon bucket; replace-on-hello |
| H4 | Optimistic `pending-` placeholder never replaced (ghost on every create) | SessionListViewModel.swift:32 | track pending set, strip on hello |
| H5 | Daemon restart breaks E2EE permanently — no kx re-exchange | RelayClient.swift:372 | re-send kx on daemon kx broadcast even when keyed |
| H6 | No auto-reconnect — socket drop permanent until relaunch | RelayClient.swift:213-229 | exponential backoff reconnect (cap 30s) |
| H7 | Inbound `control.unpair` never handled — peer unpair ignored | RelayClient.swift:408-434 | branch on `__control__` sid, decode + remove pairing |
| H8 | Inbound `control.rename` never handled — daemon label sync dropped | RelayClient.swift:417-434 | decode Label union, setLabel + UI refresh |
| H9 | ConnectionBanner + SessionStoppedBanner dead code (never instantiated) | LiveRegion.swift:19,111 | instantiate in SessionDetailView |
| H10 | Diagnostics relay/session state all stubbed `TODO — not yet wired` | DiagnosticsView.swift:54-55,74-75,151-153 | inject PairingViewModel + SessionStore |

## MEDIUM severity (parity gaps; infra often already present)

- M1 No pull-to-refresh on session list — `SessionsTab.swift:155-205` (add `.refreshable` → public `sendHello()`)
- M2 `stoppedSessions` filter uses `!= running` (captures `error`); Expo uses `== stopped` — `SessionsTab.swift:64`
- M3 Terminal in-buffer search absent — `SwiftTermView.swift` (vendored SwiftTerm already ships `findNext/findPrevious` API)
- M4 Inline markdown links `[text](url)` not rendered — `ChatMarkdown.swift:128-173`
- M5 PermissionRequest + Elicitation hook events fall to `.system` pill — `ChatEventCardKind.swift:40-42`
- M6 Chat auto-scroll always fires, yanks user reading history to bottom — `ChatView.swift:82-91` (add near-bottom guard)
- M7 `relay.auth.resume` defined but never sent (fast-path skipped) — `RelayMessages.swift:41-47` (documented-deferred but real)
- M8 `relay.presence` not wired to status dots — dots never go grey — `RelayClient.swift:250-253`
- M9 DaemonRow label `@State` only refreshes on `.onAppear`, not reactive — `DaemonsTab.swift:260,314`
- M10 daemon kx/hello `label` not adopted — daemon name never synced — `RelayMessages.swift:151-153,177-179`
- M11 `KxPayload` omits `v` — daemon can't version-gate Label union (moot until H8) — `RelayMessages.swift:76-80`
- M12 Diagnostics RTT/Ping capability absent — `DiagnosticsView.swift` + record RTT on ping/pong
- M13 Notification tap does not navigate to session — `NotificationService.swift:174-184`, `TeleprompterApp.swift:106`

## LOW / INFO

- L1 No post-create failure feedback (3s timeout toast) — NewSessionSheet.swift:65
- L2 No post-delete toast / a11y announcement — SessionsTab.swift:278
- L3 Session sort pins running first; Expo sorts pure `updatedAt` desc — SessionsTab.swift:40 (arguably better UX)
- L4 `session.create` omits cols/rows — PTY spawns at daemon defaults — RelaySessionOps.swift:13-17
- L5 Missed-pong force-close not implemented — RelayClient.swift:711-723
- L6 StopFailure shows empty `last_assistant_message` not `error` — ChatEventCardKind.swift:32-35
- L7 Chat cards don't consume user `chatFont`/`fontSize` from SettingsStore — ChatMarkdown.swift:224-231
- L8 OSC 52 clipboard copy silently dropped — SwiftTermView.swift:300
- L9 Terminal tab no empty-state fallback for stopped/no-io sessions — TerminalView.swift:48-51
- L10 PcmAudioPlayer first-chunk `nextPlayTime` from `lastRenderTime` (timing anchor) — VoiceAudio.swift:202-205
- L11 Voice live transcript text not displayed in VoiceButton — VoiceButton.swift:79-85
- L12 Voice WS 401 routes to onDisconnected not onError (no lastError) — RealtimeClient.swift:274-283
- I1 PostToolUse tool_input/tool_result not decoded/displayed — RelayMessages.swift:327-331
- I2 Font picker defaults differ (System vs Inter) — info-only, no action (Inter unavailable on Apple)
- I3/I4 Architecture invariants CONFIRMED HOLDING: no ws://localhost direct-daemon; relay URL from bundle; kx in-band

## Rejected (verified NOT actionable — documented-deferred or non-issue)

multi-daemon session picker (deferred, native-phase3-plan.md:430), worktreePath field
(DEFER, TODO.md:52), pending-send queue during kx (race can't occur natively),
OSC 8 hyperlink (no portable prior impl), resize debounce (SwiftTerm coalesces internally),
receive() main-actor hop (safe under Swift 5; delegateQueue=.main), offline-store ring buffer
(diagnostics-only counter; relay's 10-frame cache is the real primitive), APNs token forwarding
(device-gated scaffold), foreground push suppression (APNs entitlement intentionally absent),
theme-change VoiceOver announcement (native Picker announces selection itself).

## Post-merge correctness review (2026-06) — 12 additional bugs in the parity fixes themselves

After Batch A–E merged, a second adversarial review (`wf_070e82cf-95b`, 17 agents) of the
~1,650 lines of newly-merged Swift found **12 confirmed defects, 0 false-positives** — bugs
that compiled and passed the 8-marker smoke but broke at runtime (the exact failure class
the smoke harness cannot catch). Notably, several of the *first-pass fixes were themselves
broken*. Fixed across #677–#680, then a third review of the fix diffs confirmed **12/12 OK,
no new regressions**. Integrated main: iOS Simulator smoke 8/8 + XCTest 98/98 green.

HIGH:
- **#677** kx re-exchange (RelayClient) derived session keys from the OLD frontend keypair
  while sending the NEW one to the daemon → guaranteed AEAD mismatch on every daemon restart
  (the H5 fix itself was broken). Fix: generate+send new keypair first, derive keys from it.
- **#678/#679** `removeSession`/`removeSessions` left stale entries in `sessionsByDaemon` →
  deleted sessions reappeared on the next hello from any daemon (H3 ghost-row class, via the
  delete path). Fix: purge the sid from every daemon bucket + 2 regression tests.
- **#678/#679** M13 `pendingSid` set on notification tap but never consumed → session detail
  never opened + leaked (spurious tab switches). Fix: controlled `NavigationStack(path:)`.
- **#678/#679** M9 local daemon rename never refreshed the observable `labels` cache →
  DaemonRow showed the stale name. Fix: `refreshLabels()` after persist.

MEDIUM: #677 resume-auth double `scheduleReconnect` (orphaned timer, ineffective disconnect);
#677 `helloReceived` never reset on reconnect (dead hello-fallback) — split into sticky
`frameOkEmitted` marker-guard; #677 RTT props data race (→ main-actor confined);
#680 chat near-bottom auto-scroll guard self-defeated on working-indicator insertion (→
GeometryReader); #678/#679 create-failure toast false-positive on concurrent delete (→ sid-set diff).

LOW: #680 UserChatCard ignored SettingsStore font; dead `@Environment(\.openURL)`; voice PCM
50 ms fallback gap between chunks 1–2.
