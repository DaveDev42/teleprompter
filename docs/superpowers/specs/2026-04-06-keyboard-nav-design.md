# Keyboard Navigation Design

## Goal

Web (React Native Web)에서 키보드로 모든 주요 UI 요소를 탐색할 수 있도록 한다.
모바일/태블릿/데스크톱 모든 레이아웃 대응. 향후 글로벌 단축키 확장을 위한 인프라 포함.

## Scope

- Tab 키로 탭 바, 세션 목록, Chat/Terminal 탭, Chat input, 사이드바 요소 탐색
- Enter/Space로 버튼/링크 활성화
- Escape로 모달 닫기 + 포커스 트랩
- 포커스 ring 스타일 (`focus:ring-2 ring-tp-border-focus`)
- Playwright E2E 테스트 (`e2e/app-keyboard-nav.spec.ts`)

## Out of Scope

- 글로벌 키보드 단축키 (Cmd+K, Cmd+1/2/3 등) — 향후 `useKeyboard` 훅 확장으로 대응
- Arrow 키 리스트 내비게이션 — Tab 순회로 충분, 향후 필요 시 추가
- 네이티브 (iOS/Android) 키보드 내비게이션 — Web 전용

## Architecture

### Infrastructure Layer

3개의 새 파일로 키보드 내비게이션 인프라를 구성한다.

#### 1. `usePlatformProps` Hook (`src/hooks/use-platform-props.ts`)

Web에서만 `tabIndex`와 포커스 ring 클래스를 반환. 네이티브에서는 빈 객체.

```ts
interface PlatformPropsOptions {
  focusable?: boolean;   // default true
  tabIndex?: number;     // default 0
}

function usePlatformProps(options?: PlatformPropsOptions): {
  tabIndex?: number;
  className?: string;
}
```

- Web: `{ tabIndex: 0, className: "focus:ring-2 focus:ring-tp-border-focus focus:outline-none" }`
- Native: `{}`
- `focus:ring-2`는 `focus-visible` 기반이므로 마우스 클릭 시에는 표시되지 않고 키보드 포커스 시에만 표시

#### 2. `useKeyboard` Hook (`src/hooks/use-keyboard.ts`)

전역 키보드 이벤트 리스너. 키 이름 → 핸들러 매핑.

```ts
type KeyMap = Record<string, () => void>;

function useKeyboard(keyMap: KeyMap): void
```

- Web: `useEffect`에서 `document.addEventListener("keydown", handler)` + cleanup
- Native: no-op
- 키 이름은 `KeyboardEvent.key` 값 사용 (e.g., "Escape", "Enter")
- 향후 확장: modifier 조합 지원 ("Meta+k", "Meta+1" 등)

#### 3. `ModalContainer` Component (`src/components/ModalContainer.tsx`)

기존 React Native Modal을 감싸는 래퍼.

```tsx
interface ModalContainerProps {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
}
```

- `useKeyboard({ Escape: onClose })` 내장
- Web: 포커스 트랩 — 모달 열릴 때 첫 포커스 가능 요소에 포커스, Tab이 모달 내부에서만 순환
- 모달 닫힐 때 이전 포커스 요소로 복원
- 기존 Modal의 `transparent`, `animationType` 등은 그대로 전달

### Component Changes

각 컴포넌트에서 `usePlatformProps`를 적용하고, 기존 `className`과 병합한다.

| Component | File | Changes |
|-----------|------|---------|
| Tab bar buttons | `(tabs)/_layout.tsx` | `tabBarButton` 커스텀으로 `usePlatformProps` 적용 |
| SessionRow | `(tabs)/index.tsx` | Pressable에 `usePlatformProps` 적용 |
| Search input | `(tabs)/index.tsx` | 포커스 ring 클래스 추가 |
| DaemonCard buttons | `(tabs)/daemons.tsx` | Pressable에 `usePlatformProps` 적용 |
| SettingsRow | `(tabs)/settings.tsx` | onPress 있는 행에 `usePlatformProps` 적용 |
| Chat/Terminal tabs | `session/[sid].tsx` | Pressable에 `usePlatformProps` 적용 |
| Chat input | `session/[sid].tsx` | 포커스 ring 클래스 추가 |
| Send button | `session/[sid].tsx` | `usePlatformProps` 적용 |
| SessionDrawer items | `SessionDrawer.tsx` | Pressable에 `usePlatformProps` 적용 |
| FontPickerModal | `FontPickerModal.tsx` | Modal → ModalContainer 교체, 내부 버튼에 `usePlatformProps` |
| FontSizeModal | `FontSizeModal.tsx` | Modal → ModalContainer 교체, 내부 버튼에 `usePlatformProps` |
| ApiKeyModal | `ApiKeyModal.tsx` | Modal → ModalContainer 교체, 내부 버튼에 `usePlatformProps` |

### Focus Style

`focus:ring-2 focus:ring-tp-border-focus focus:outline-none`

- `tp-border-focus`는 이미 `#3b82f6`(blue-500)으로 정의됨 (light/dark 동일)
- ring은 box-shadow 기반이므로 레이아웃 시프트 없음
- `focus-visible` 의사 클래스 사용 — 키보드 포커스만 표시, 마우스 클릭 시 미표시

### className Merge Strategy

`usePlatformProps`가 반환하는 `className`을 기존 className과 병합:

```tsx
const platformProps = usePlatformProps();
<Pressable
  {...platformProps}
  className={`existing-classes ${platformProps.className ?? ""}`}
/>
```

NativeWind는 className 병합을 지원하므로 충돌 없음.

## E2E Tests

### `e2e/app-keyboard-nav.spec.ts`

모바일 뷰포트(390x844) 기준. Daemon 연결 불필요 — CI 프로젝트 포함.

| Test | Description |
|------|-------------|
| Tab navigates tab bar | Tab 키로 Sessions/Daemons/Settings 탭 순회, Enter로 활성화 |
| Tab navigates session list | 세션 목록 항목 포커스 + Enter로 세션 열기 (daemon 필요 시 skip) |
| Tab reaches Chat/Terminal tabs | tab-chat, tab-terminal 포커스 + Enter 활성화 |
| Tab reaches Chat input | TextInput에 Tab 도달 + 텍스트 입력 가능 |
| Escape closes modal | Settings에서 Font Picker 열고 Escape로 닫기 |
| Focus ring visible | 포커스된 요소에 box-shadow(ring) 존재 확인 |

### Playwright Config

`playwright.config.ts`의 CI 프로젝트 목록에 `app-keyboard-nav` 추가.

## testID Additions

E2E 테스트 셀렉터를 위해 추가할 testID:

| Element | testID |
|---------|--------|
| Sessions tab | `tab-sessions` |
| Daemons tab | `tab-daemons` |
| Settings tab | `tab-settings` |
| Session search input | `session-search` |
| Chat input | `chat-input` |
| Send button | `chat-send` |

기존 `tab-chat`, `tab-terminal`은 유지.

## TODO.md Update

```diff
- [ ] 키보드 내비게이션 미검증
+ [x] 키보드 내비게이션 검증 및 수정 — Web에서 Tab/Enter/Escape 키보드 내비게이션 지원
```

Future 섹션에 추가:
```
- [ ] 글로벌 키보드 단축키 (Cmd+K, Cmd+1/2/3 등) — useKeyboard 훅 확장
```
