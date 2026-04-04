---
paths:
  - "apps/app/**"
---

# Frontend Conventions (apps/app)

## Zustand Store 패턴
- 생성: `create<Interface>((set, get) => ({...}))` — 미들웨어 없음 (immer, persist, devtools 미사용)
- Interface: state 필드 + action 메서드를 단일 interface에 정의 (`<Name>Store` 또는 `<Name>State`)
- Private fields: `_` prefix (`_recHandlers`, `_onPromptReady`)
- Persistence: `secureGet`/`secureSet` from `lib/secure-storage` (Web: `tp_` prefix localStorage, Native: expo-secure-store)
  - Write-through: `set()` 먼저 → `persist()` async
  - Load: try/catch + 파싱 에러 시 silent fail
- Uint8Array 필드: `SerializedPairingInfo` interface로 base64 변환 (`toBase64`/`fromBase64`)
- Error: `lastError: string | null` + `setError()` (session, pairing만)
- Reset: session-store, pairing-store만 `reset()` 보유
- Cross-store: `useXStore.getState()` (React 외부), `useXStore(s => s.field)` (React 내부) — store 간 직접 import 없음

## NativeWind / Tailwind
- **tp-* semantic token 강제** — raw Tailwind color 금지 (`bg-zinc-900` ❌, `bg-tp-bg` ✅)
- Background: `bg-tp-bg`, `bg-tp-bg-secondary`, `bg-tp-bg-tertiary`, `bg-tp-bg-elevated`, `bg-tp-bg-input`
- Surface: `bg-tp-surface`, `bg-tp-surface-hover`, `bg-tp-surface-active`
- Chat: `bg-tp-user-bubble`, `bg-tp-assistant-bubble`
- Text: `text-tp-text-primary`, `text-tp-text-secondary`, `text-tp-text-tertiary`
- Border: `border-tp-border`, `border-tp-border-subtle`, `border-tp-border-focus`
- Accent/Status: `bg-tp-accent`, `bg-tp-accent-hover`, `bg-tp-success`, `bg-tp-warning`, `bg-tp-error`
- Border radius: `rounded-badge`(6px), `rounded-btn`(10px), `rounded-search`(10px), `rounded-card`(12px), `rounded-bubble`(16px)
- Dark mode: CSS 변수 자동 전환 — `dark:` prefix 불필요, `useThemeStore.isDark`로 root class 토글
- Inline styles 지양 — NativeWind `className` 우선

## Component 패턴
- PascalCase 파일명, named export (`export function ChatCard()`) — default export 금지
- Props: 함수 시그니처에서 inline 타입 정의 (`{ msg }: { msg: ChatMessage }`)
- Platform 분기: `Platform.OS === "web"` 체크 후 conditional rendering
  - ghostty-web: Web-only — native에서 `null` 반환
  - TerminalToolbar: native-only — web에서 `null` 반환

## Import 패턴
- Protocol: `@teleprompter/protocol/client` (crypto, pairing, types만 — codec/socket 제외)
- Type-only: 항상 `import type { ... }` 사용
- Native 모듈 (expo-secure-store 등): `Platform.OS !== "web"` 내에서 `require()` — 전역 import 시 Web 크래시
- Import 정렬: Biome organizeImports 위임

## Crypto & Security
- `await ensureSodium()` — 모든 crypto 연산 전 lazy init 필수
- `crypto-polyfill.ts`: expo-crypto `getRandomValues` → `self.crypto.getRandomValues` polyfill
  - `apps/app/index.ts`에서 최초 import 필수
- Key storage: iOS/Android → expo-secure-store (Keychain/Keystore), Web → localStorage `tp_` prefix
- Uint8Array 저장 시 base64 변환 (`toBase64`/`fromBase64` from protocol)
