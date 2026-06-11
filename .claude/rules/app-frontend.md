---
paths:
  - "apps/app/**"
---

# Frontend Conventions (apps/app)

## Zustand Store 패턴
- 생성: `create<Interface>((set, get) => ({...}))` — 미들웨어 없음 (immer, persist, devtools 미사용). Module-level `persist()` helper for explicit write-through.
- Interface: state 필드 + action 메서드를 단일 interface에 정의 (`<Name>Store` 또는 `<Name>State`)
- Private fields: `_` prefix. Current live examples: `_timer`, `_toastId` in `notification-store.ts`. Test stores may use other `_`-prefixed ids (`_id`, `_input`) to mirror protocol field names.
- Persistence: `secureGet`/`secureSet` from `lib/secure-storage` (Web: `tp_` prefix localStorage, Native: expo-secure-store)
  - Write-through: `set()` 먼저 → `persist()` async
  - Load: try/catch + 파싱 에러 시 silent fail
- Uint8Array 필드: `SerializedPairingInfo` interface로 base64 변환 (`toBase64`/`fromBase64`)
- Error: 스토어마다 적합한 방식으로 표현 — `session-store`는 discriminated-union `relayState` (`status: "error"` arm), `pairing-store`는 `error: string | null`. 공통 `lastError`/`setError()` 컨벤션은 없음. UI가 실제로 error state를 노출할 때만, 해당 스토어의 기존 필드명 스타일을 따라 추가.
- Reset: `session-store`, `pairing-store`만 `reset()` 보유
- Cross-store: `useXStore.getState()` (React 외부), `useXStore(s => s.field)` (React 내부) — store 간 직접 import 없음

## NativeWind / Tailwind
- **tp-* semantic token 강제** — raw Tailwind color 금지 (`bg-zinc-900` ❌, `bg-tp-bg` ✅)
- Background: `bg-tp-bg`, `bg-tp-bg-secondary`, `bg-tp-bg-tertiary`, `bg-tp-bg-elevated`, `bg-tp-bg-input`
- Surface: `bg-tp-surface`, `bg-tp-surface-hover`, `bg-tp-surface-active`
- Chat: `bg-tp-user-bubble`, `bg-tp-assistant-bubble`
- Text: `text-tp-text-primary`, `text-tp-text-secondary`, `text-tp-text-tertiary`, `text-tp-text-on-color`
- Border: `border-tp-border`, `border-tp-border-subtle`, `border-tp-border-focus`
- Accent/Status: `bg-tp-accent`, `bg-tp-accent-hover`, `bg-tp-success`, `bg-tp-warning`, `bg-tp-warning-soft`, `bg-tp-warning-on-soft`, `bg-tp-error`, `bg-tp-error-soft`, `bg-tp-error-on-soft`, `bg-tp-voice-active`, `bg-tp-overlay`
- Border radius: `rounded-badge`(6px), `rounded-btn`(10px), `rounded-search`(10px), `rounded-card`(12px), `rounded-bubble`(16px)
- Dark mode: CSS 변수 자동 전환 — `dark:` prefix 불필요, `useThemeStore.isDark`로 root class 토글
- Inline styles 지양 — NativeWind `className` 우선

## Component 패턴
- PascalCase 파일명, named export (`export function ChatCard()`) — default export 금지
- Props: 함수 시그니처에서 inline 타입 정의 (`{ msg }: { msg: ChatMessage }`)
- Platform 분기: `Platform.OS === "web"` 체크 후 conditional rendering
  - ghostty-web: Web-only — native에서 `null` 반환
  - GhosttyNative: native-only — web에서 `null` 반환

## Import 패턴
- Protocol: `@teleprompter/protocol/client` (crypto, pairing, types만 — codec/socket 제외)
- Type-only: 항상 `import type { ... }` 사용
- Native 모듈 (expo-secure-store 등): `Platform.OS !== "web"` 내에서 `require()` — 전역 import 시 Web 크래시
- Import 정렬: Biome organizeImports 위임

## Crypto & Security
- `await ensureSodium()` — 모든 crypto 연산 전 lazy init 필수. Provider 는 CryptoProvider seam (`@teleprompter/protocol/client` 의 `__setCryptoProviderFactory`) 으로 결정된다.
- Native (Hermes): react-native-quick-crypto provider (`lib/crypto-provider-native.ts`, `USE_NATIVE_CRYPTO` in `lib/crypto-flag.ts`). `index.ts` 가 module-eval 시 factory 를 설치 → libsodium-wrappers 는 native 에서 절대 evaluate 되지 않는다 (wasm2js 워크어라운드 전부 제거됨). Web/bun:test: libsodium-wrappers (WASM). Cross-provider oracle: `lib/crypto-provider-native.test.ts`, on-device 게이트: `docs/local-verification-queue.md` Q11.
- **RNQC plugin 은 반드시 `["react-native-quick-crypto", { "sodiumEnabled": true }]` 로 등록** (`app.json` plugins). XChaCha20-Poly1305 는 RNQC 네이티브 빌드에 libsodium 이 컴파일되어야 동작 (`BLSALLOC_SODIUM`) — bare 등록하면 빌드는 성공하지만 on-device 런타임에서 `Cipher.update(...): libsodium must be enabled (BLSALLOC_SODIUM)` 가 터져 모든 AEAD encrypt/decrypt 가 실패한다 (Q11 2026-06-11 실측). 플러그인이 iOS Podfile 에 `ENV['SODIUM_ENABLED']='1'` (pod install 시 libsodium 1.0.22 소스 빌드), Android 에 `sodiumEnabled` gradle property 를 주입한다. 단위 oracle 은 이걸 못 잡는다 (bun:test 의 AEAD 는 libsodium-backed) — 네이티브 빌드 플래그 회귀는 Q11 on-device 게이트가 유일한 검증선.
- `crypto-polyfill.ts`: `[tp-app boot]` boot marker (on-device 콘솔 검증용) + expo-crypto `getRandomValues` → `self.crypto.getRandomValues` polyfill
  - `apps/app/index.ts`에서 최초 import 필수
- Key storage: iOS/Android → expo-secure-store (Keychain/Keystore), Web → localStorage `tp_` prefix
- Uint8Array 저장 시 base64 변환 (`toBase64`/`fromBase64` from protocol)

## Global Keyboard Shortcuts (web)
- `useGlobalShortcuts(keyMap)` (`hooks/use-global-shortcuts.ts`) — document **capture-phase** keydown, web 전용 (native 는 no-op). keyMap 은 반드시 `useMemo` 로 만들 것 (identity 가 바뀌면 매 렌더 listener 재등록).
- **단일 printable key 만, modifier 조합 금지** (shift 는 예외 — `?` 가 필요). 브라우저/OS 코드를 절대 섀도잉하지 않는 GitHub/Linear 스타일.
- Eligibility guards: `lib/shortcut-guards.ts` `isShortcutEligible` — `defaultPrevented` / ctrl·meta·alt / `repeat` / editable target (INPUT·TEXTAREA·SELECT, `isContentEditable`, `[data-shortcuts-disabled]` 조상) 이면 스킵. 터미널은 `GhosttyTerminal` 컨테이너의 `data-shortcuts-disabled=""` 로 서브트리 전체 opt-out (ghostty 의 a11y mirror div 는 focusable 하지만 editable 이 아니라서 data-attr 가 필요).
- Modal 억제: `lib/modal-open-registry.ts` 모듈 카운터 — `ModalContainer` 가 visible 동안 `registerOpenModal()` 을 잡는다. `inert` 는 capture-phase document listener 를 막지 못하므로 레지스트리가 별도로 필요.
- 현재 바인딩: root `_layout.tsx` — `?` (help overlay), `1`/`2`/`3` (bottom tabs); `session/[sid].tsx` — `c`/`t` (Chat/Terminal), `[`/`]` (이웃 세션). **새 단축키 추가 시 `ShortcutHelpModal` SECTIONS 에도 같이 등록**할 것.
- 회귀 가드: `e2e/app-keyboard-shortcuts.spec.ts` + `lib/shortcut-guards.test.ts` / `lib/modal-open-registry.test.ts`.

## Relay Client Heartbeat
- `FrontendRelayClient`는 `relay.auth.ok` 후 15초 간격으로 자체 `relay.ping`을 보낸다 (`RELAY_PING_INTERVAL_MS`). 2회 연속 `relay.pong`이 없으면 (`RELAY_MAX_MISSED_PONGS`) 소켓을 강제 close 해서 reconnect를 트리거. 이 자체 핑이 없으면 모바일 슬립/캡티브 포털/Wi-Fi 핸드오프로 죽은 TCP는 relay의 90s idle-timeout이 만료될 때까지 "connected"로 남는다.
- 수치를 손대기 전에 `apps/app/src/lib/relay-client.test.ts`의 "client-side ping" describe 블록이 fake `setInterval`로 cadence + missed-pong force-close를 검증한다는 사실을 기억할 것.
