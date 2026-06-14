# Native Terminal (libghostty / SwiftTerm) — 설계 맵 & 증분 사다리

> Future track "libghostty 네이티브 RN 모듈" (TODO.md)의 착수 전 설계 문서.
> 2026-06-12 기준 HEAD 워킹트리 + upstream 조사를 바탕으로 작성 — 모든 file:line 은
> 당시 HEAD 기준이며, 코드가 바뀌면 이 문서가 아니라 코드가 진실이다.
> **엔진 결정 완료 (2026-06-15, §6 + `docs/adr/0001`): SwiftTerm now (Rung 3) →
> libghostty 태그 릴리즈 후 스왑 (Rung 6).** 이 문서는 피봇 결정(ADR-0001) 트랙 A 의
> 실행 SoT 다 — 앱은 full Swift 재작성이 아니라 RN 셸 유지 + 터미널만 네이티브 Expo Module.

## 1. 현재 터미널 아키텍처 (web) — 네이티브 구현이 꽂혀야 할 seam

- **컴포넌트 seam**: `SessionTerminalView.tsx` 가 require-time 에 `Platform.OS === "web"`
  → `GhosttyTerminal`, 아니면 `GhosttyNative` 로 분기. **네이티브 모듈은 이 분기 뒤에
  세 번째 구현으로 들어간다** (또는 `GhosttyNative` 대체). `termRef` 는
  `MutableRefObject<any>` — 공유 `TermHandle` 인터페이스 추출이 선행 정리 작업 (Rung 0).
- **Props 계약**: `onData(data)` (키 입력 out) · `onResize(cols, rows)` · `termRef` ·
  `onReady` (→ `client.resume(sid, 0)` 리플레이 게이트) · `searchRef`.
- **Ref 표면 (web)**: `write(data)` 외에 search (`terminal-search.ts`) 가
  `term.buffer.active` / `scrollToLine()` / `select()` 를, voice context
  (`voice/terminal-context.ts`) 가 `term.buffer.active` 를 duck-type 으로 소비.
- **출력 경로**: relay frame → decrypt → `session-store.dispatchRec` →
  SessionTerminalView 에서 `rec.k === "io"` 필터 → `atob(rec.d)` → `term.write(bytes)`.
  **네이티브 모듈은 이미 복호화된 PTY 바이트만 받는다 — protocol/crypto 인지 불필요.**
  브릿지는 base64 string 대신 ArrayBuffer 를 받는 편이 JS 스레드 부하가 적다.
- **입력 경로**: `term.onData` → `sendTermInput(sid, encodeUtf8Base64(data))` (multi-byte
  안전 — PR #455 가 UTF-8 크래시 회귀 클래스) → `{ t: "in.term" }` → daemon → PTY stdin.
- **리사이즈**: web 은 custom fit (FitAddon 의 15px 스크롤바 gutter 회피) + 100ms 디바운스
  ResizeObserver + **즉시 initial resize** — runner 가 120×40 하드코딩으로 시작하므로 첫
  PTY 바이트 전에 실측 크기를 보내야 TUI 스플래시가 어긋나지 않는다. 네이티브 구현도
  initial-size 송신 / 디바운스 refit / 동일 치수여도 명시 emit 을 재현해야 한다.
- **설정**: fontSize 15 · terminalFont "JetBrains Mono" · `TERMINAL_COLORS`
  (bg #000, fg #fff, cursor #fff) · scrollback 10000 · cursorBlink.
- **이식 안 되는 부분**: `data-shortcuts-disabled` opt-out / Tab-trap 은 DOM 전용 —
  네이티브는 iOS 소프트 키보드 + 하드웨어 키보드 처리를 따로 설계.

## 2. 네이티브 현재 상태

**있는 것**: `GhosttyNative.tsx` = react-native-webview 안 inline HTML. ghostty-web
UMD 빌드가 **로컬 Metro 에셋으로 번들** (`assets/ghostty-web.umd.txt` — 설치 패키지와
SHA-256 동일성을 `ghostty-web-asset.test.ts` 가 핀, WASM 은 UMD 내부 data URL 이라
오프라인 동작, Rung 1 출시). 브릿지: RN→WebView `postMessage({type:"write", b64})`
(모든 write 가 base64 bytes — 바이너리 PTY 출력이 JSON 경계 무손실 통과), WebView→RN
`data`/`resize`/`ready`/`error`. E2EE 복호화 파이프라인은 네이티브에서도 전부 동작 —
마지막 hop 만 다름.

**없는 것 / 열화**: 네이티브 터미널 모듈 스캐폴딩 일절 없음. 네이티브 `TermHandle` 은
`{ write }` 만 — search 와 voice `getTerminalLines` 는 iOS/Android 에서 조용히 no-op.
WebView ready 전 도착한 io record 는 드랍 (resume 풀 리플레이로만 복구).

## 3. 빌드/검증/배포 하드 제약

- Expo Go 드롭 완료 (dev build 전용) — JSI/커스텀 네이티브 모듈 unblock 의 전제.
- 네이티브 빌드 = EAS 클라우드 기본. **네이티브 모듈 추가 = fingerprint runtimeVersion
  변경 = OTA 단절 = 전 사용자 TestFlight/Internal 재설치.** Rung 2+ 는 다른 네이티브 변경
  (예: Apple Watch 타깃)과 배칭할 것.
- pod install 시 자기 패키지 디렉토리에 쓰는 dep (xcframework 다운로드/추출 류) 은
  `fingerprint.config.js` `ignorePaths` 등록 필수 — 아니면 EAS "Runtime version mismatch".
- 로컬 일상 QA (RN Web) 로는 **이 기능을 전혀 검증할 수 없다** — 증분마다
  `docs/local-verification-queue.md` 큐 항목 + web 경로 비회귀 가드가 필요.
- EAS 워커 안에서 Zig 로 libghostty 소스 빌드는 비현실적 — prebuilt xcframework vendoring
  (커밋 또는 pod 다운로드 + ignorePaths) 이 현실적 형태.

## 4. Upstream 현실 점검 (2026-06 기준)

**libghostty**: standalone 태그 릴리즈 전무 (Ghostty 앱은 1.3.1). C API 공식 "not yet
stabilized". iOS 는 공식적으로 experimental — 팀 입장은 "no plan to have direct support
for iPhone or iPad" (Discussion #9285), 모바일은 커뮤니티 위임. 단 CI 가 iOS 빌드를
보장하고, 커뮤니티 wrapper (`GhosttyKit`/`libghostty-spm`) 경유로 8개+ 상용 iOS 앱이
출시됨 (VVTerm 은 GPL-3.0 — 코드 복사 금지, 패턴 참고만). **RN wrapper 는 어디에도 없다 —
우리가 최초가 된다.** MIT.

**SwiftTerm (대안)**: v1.13.0, 활발히 유지보수, MIT, iOS UIKit 일급 지원. xterm-class
충실도 (TrueColor, OSC 8, Sixel/Kitty graphics, CSI 2026). CoreText 렌더링 — Metal 아님.
Secure Shellfish / La Terminal 등 프로덕션 검증. RN wrapper 는 역시 없지만 아래 레이어가
순수 Swift 한 층뿐.

| 차원 | libghostty (GhosttyKit) | SwiftTerm |
|---|---|---|
| 안정성 | 알파, 무태그, API 유동 | v1.13.0 태그 |
| iOS | experimental, 커뮤니티 위임 | 일급 UIKit |
| 렌더링 | Metal (TODO 목표 부합) | CoreText/CG |
| web 과 엔진 일치 | 동일 VT 엔진 (탭 간 동작 일치) | 다른 엔진 (렌더 분기 위험) |
| RN 아래 레이어 | Swift → 비공식 XCF → 불안정 C API | Swift (완성) |
| Android | 이론상 OpenGL, 출시 사례 0 | 없음 |
| EAS 리스크 | XCF vendoring 또는 Zig 빌드 | SPM resolve, 표준 |

## 5. 증분 사다리 (각 rung 독립 출시 가능)

- **Rung 0 — 결정 + seam 정리** (JS-only, OTA 가능): 엔진 결정 기록, `TermHandle` 공유
  인터페이스 추출 (search/voice 가 platform check 아닌 capability check 로 열화).
  검증: `bun test ./apps/app` + RN Web 비회귀.
- **Rung 1 — WebView 경로 de-risk** ✅ (2026-06-12 출시, JS-only/OTA): ghostty-web
  UMD(WASM 내장 data URL)를 로컬 에셋 `assets/ghostty-web.umd.txt` 로 번들 — esm.sh
  런타임 의존 + 0.3/0.4 skew 제거, write 브릿지 base64 화로 Uint8Array-over-JSON 버그도
  수정. 에셋 신선도는 `ghostty-web-asset.test.ts` SHA-256 oracle 이 핀.
  검증: verify-native 큐 Q13 (오프라인 렌더, 리플레이, 한글/이모지 write 라운드트립).
- **Rung 2 — 플래그 뒤 네이티브 모듈 스캐폴드** (**첫 fingerprint break — 배칭**): Expo
  Module (Swift) 로 trivial `TPTerminalView` (단색 UIView + write→onEcho 라운드트립),
  dev 설정 게이트, WebView 기본 유지. `ignorePaths` 정비. 파이프라인 증명이 목적.
- **Rung 3 — 엔진 연결, write/input/resize parity**: 선택 엔진을 `TPTerminalView` 에 연결
  — `write(bytes)` (ArrayBuffer 선호), `onData`, `onResize` + initial-size (120×40 시작
  의미론 재현), 설정 props, `onReady` 리플레이 게이트, ready 전 버퍼링 (현재 드랍 수정).
  검증 큐: TUI 스플래시 앵커 / 한글·이모지 라운드트립 (PR #455 회귀 클래스) / SIGWINCH /
  리플레이 / 오프라인. 소프트·하드웨어 키보드는 Dave 실기기.
- **Rung 4 — search + voice + 라이프사이클 parity**: `buffer.active` 동등 읽기 또는
  네이티브 search, voice `getTerminalLines` 복원, bg/fg + 메모리 압박, scrollback 10000.
- **Rung 5 — 기본 전환 + WebView 은퇴 (iOS)**: 네이티브 기본, WebView 는 한 릴리즈 escape
  hatch 후 삭제. Android 는 Android 엔진 결정 전까지 (Rung-1 강화된) WebView 유지.
- **Rung 6 (선택) — 엔진 스왑 / Android**: Rung 3 이 SwiftTerm 이었다면 libghostty 태그
  릴리즈 후 재평가 (엔진 parity + Metal 회복).

## 6. Dave 결정 (2026-06-15 확정 — ADR-0001)

> 아래는 피봇 결정(`docs/adr/0001-rust-backend-incremental-native-app.md`) 트랙 A 와 4개
> 미지수 검증(워크플로우 `wf_cdc4d2d2-578`) 의 결과다. 근거는 ADR §4 참조.

1. **엔진 베팅** ✅ → **SwiftTerm now (Rung 3) → libghostty 후 스왑 (Rung 6).** 이유:
   libghostty iOS 는 실제로 출시 사례 다수지만 C API unstable + 무태그 + 자체 Zig 빌드 부담.
   SwiftTerm 은 안정적·iOS 일급·SPM 표준. 엔진 스왑은 `TPTerminalView` 한 컴포넌트로 국소화돼
   나머지 사다리 작업이 재사용된다. 이미 ghostty-web 을 쓰므로 libghostty 로 가면 엔진 패리티 보장.
2. **libghostty 아티팩트 전략** (Rung 6 시점) → **공식 태그 릴리즈 대기 후 prebuilt XCF
   vendoring** (커밋 또는 pod 다운로드 + `ignorePaths`). 자체 Zig 빌드 파이프라인은 태그 전까지 보류.
   EAS 워커 내 Zig 소스 빌드는 비현실적(§3).
3. **Android 범위** ✅ → **iOS-only 네이티브 + Android 는 (Rung-1 강화된) WebView 유지.**
   iOS > Web > Android 우선순위와 일관. Android 엔진 결정은 무기한 보류 (Rung 6 선택).
4. **타이밍** ✅ → **Rung 2+ fingerprint break 를 Apple Watch 타깃과 배칭하지 않는다.**
   watchOS 는 별도 Swift WatchKit 앱이며 Phase 1(iOS/iPadOS/macOS 점진화) 후로 연기(ADR §4-④).
   터미널 네이티브화가 watchOS 를 기다릴 이유 없음 — Rung 2 는 준비되는 대로 단독 fingerprint break.
5. ~~**Rung 1 단독 승인 여부**~~ — **승인·출시 완료** (2026-06-12, §5 Rung 1).
6. **WebView fallback 유지 기간** → **Rung 5(기본 전환) 시 한 릴리즈 escape hatch 후 삭제(iOS).**
   토글은 dev-only (user-visible 옵션으로 노출하지 않음 — 유지보수 표면 최소화). Android 는 WebView 가 기본이므로 해당 없음.

## 7. 트랙 B(Rust 백엔드)와의 관계

이 사다리(트랙 A, 앱)는 **트랙 B(Rust 코어/백엔드)와 독립**이다 (ADR-0001 §3). 네이티브 터미널
모듈은 이미 복호화된 PTY 바이트만 받으므로(§1 출력 경로) protocol/crypto 를 인지하지 않는다 —
백엔드가 Bun 이든 Rust 든 무관하다. 따라서 Rung 2–5 는 Phase 0(crypto 스파이크)·Rust 백엔드와
어느 순서로든 병행 가능. 단 `TPTerminalView` 의 write 브릿지는 향후 Rust `tp-core` 가 노출할
디코딩 결과와 계약이 겹치지 않게 "디코딩된 바이트 in" 경계를 유지한다.
