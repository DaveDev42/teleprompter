# Push Notifications Design

## Overview

Runner hooks 이벤트(`Elicitation`, `PermissionRequest`) 발생 시, frontend가 해당 세션을 보고 있지 않으면 Expo push notification 또는 인앱 toast로 알림. Daemon이 알림 판단, Relay가 delivery 방식 결정 및 발송.

## Scope

- **Phase 1 (이번)**: iOS/Android native push (Expo Push API)
- **Phase 2 (이후)**: Web Push API (Service Worker, VAPID)

## Architecture

### Data Flow

```
Runner → Daemon (hook event: Elicitation, PermissionRequest)
  → Daemon: relay.push { frontendId, token, title, body, data } 전송
  → Relay: frontendId WS 연결 확인
    ├─ 연결 중 → relay.notification WS 메시지 → Frontend toast
    └─ 미연결 → Expo Push API 호출 → OS push notification
```

### Push Token Flow

```
Frontend 시작 → expo-notifications로 Expo push token 획득
  → pushToken WS 메시지로 daemon에 전달 (relay 경유)
  → Daemon이 frontendId별로 push token 저장
```

## Protocol Changes

### New WS Message: `pushToken` (frontend → daemon, relay 경유)

Frontend가 push token을 daemon에 등록/갱신할 때 사용.

```typescript
interface WsPushToken {
  t: "pushToken";
  token: string;      // Expo push token (e.g., "ExponentPushToken[xxx]")
  platform: "ios" | "android";
}
```

FrameType에 `"pushToken"` 추가.

### New Relay Message: `relay.push` (daemon → relay)

Daemon이 relay에 push 발송을 요청할 때 사용.

```typescript
interface RelayPush {
  t: "relay.push";
  frontendId: string;
  token: string;        // Expo push token
  title: string;
  body: string;
  data?: {              // Notification payload for navigation
    sid: string;
    daemonId: string;
    event: string;      // "Elicitation" | "PermissionRequest"
  };
}
```

### New Relay → Frontend Message: `relay.notification` (relay → frontend via WS)

Frontend가 WS 연결 중일 때 인앱 toast용.

```typescript
interface RelayNotification {
  t: "relay.notification";
  title: string;
  body: string;
  data?: {
    sid: string;
    daemonId: string;
    event: string;
  };
}
```

## Component Details

### 1. Frontend (apps/app)

**Dependencies:**
- `expo-notifications` 추가

**app.json config:**
- iOS: APNs entitlement (Expo managed)
- Android: FCM (Expo managed, google-services.json via EAS)
- Plugin: `expo-notifications`

**Push token registration:**
- 앱 시작 시 (`_layout.tsx`) permission 요청 + token 획득
- `usePushNotifications` hook 생성
- Token을 daemon에 `pushToken` 메시지로 전달 (relay client 경유)
- Token 갱신 listener 등록 (드물지만 앱 재설치 등)

**Notification handling:**
- Push notification 수신 시: `data.sid`로 해당 세션 화면으로 navigation
- WS `relay.notification` 수신 시: 인앱 toast 표시, 탭하면 세션 이동
- 해당 세션에 이미 attach 중이면 toast 스킵 (Relay가 WS 연결 여부를 판단하지만, attach 여부는 frontend에서 추가 필터링)

**Notification content:**
- Title: session name (또는 daemon name)
- Body: 이벤트별 메시지
  - `Elicitation`: "Claude가 질문에 대한 답변을 기다리고 있습니다"
  - `PermissionRequest`: "도구 사용 권한 승인이 필요합니다"

### 2. Daemon (packages/daemon)

**Hook event 감지:**
- `handleRec()`에서 `k === "event"` && `n === "Elicitation" | "PermissionRequest"` 확인
- 해당 세션의 모든 paired frontend에 대해 `relay.push` 발송

**Push token 저장:**
- Frontend에서 `pushToken` 메시지 수신 시 frontendId별로 저장
- 저장 위치: 기존 pairing DB 또는 별도 in-memory map
- Relay client를 통해 수신한 경우 복호화 후 처리

**relay.push 발송:**
- 각 relay client에 `relay.push` 메시지 전송
- Token, title, body, data(sid, daemonId, event) 포함

### 3. Relay (packages/relay)

**relay.push 처리:**
1. `frontendId`의 현재 WS 연결 확인
2. 연결 중 → `relay.notification` WS 메시지로 전달
3. 미연결 → Expo Push API 호출

**Expo Push API 호출:**
- Endpoint: `https://exp.host/--/api/v2/push/send`
- Method: POST
- Body: `{ to: token, title, body, data, sound: "default" }`
- No auth required for Expo Push API

**Rate limiting:**
- Per daemonId+frontendId: 분당 최대 N회 (예: 5회)
- In-memory counter, relay 재시작 시 리셋 (안전한 방향)

**Dedup:**
- 동일 (frontendId, sid, event) 조합: 최근 M초 내 중복 방지 (예: 60초)
- In-memory Set with TTL

### 4. `relay.push` is plaintext (not E2EE)

`relay.push`는 daemon → relay 직접 전송이므로 E2EE 대상이 아님. Relay가 내용을 읽어야 Expo Push API를 호출할 수 있으므로 의도적으로 plaintext. TLS(wss://)로 전송 암호화는 보장됨.

## Testing Strategy

**Unit tests:**
- Daemon: hook event 감지 → relay.push 발송 로직
- Relay: relay.push 수신 → WS/Expo Push 분기, rate limiting, dedup
- Protocol: 새 메시지 타입 encode/decode

**Integration tests:**
- Daemon → Relay → Expo Push API (mock) 파이프라인
- Frontend push token 등록 → daemon 저장 → relay.push 발송

**Manual QA:**
- iOS Simulator (push는 실기기만 가능 — simulator에서는 toast만 테스트)
- 실기기 TestFlight 빌드로 push notification 수신 확인

## Files to Create/Modify

### New files:
- `apps/app/src/hooks/use-push-notifications.ts` — push token 관리 + notification handling hook
- `apps/app/src/components/InAppToast.tsx` — 인앱 toast UI 컴포넌트
- `packages/relay/src/push.ts` — Expo Push API 호출 + rate limiting + dedup
- `packages/daemon/src/push/push-notifier.ts` — hook event 감지 + relay.push 발송

### Modified files:
- `apps/app/package.json` — expo-notifications 추가
- `apps/app/app.json` — expo-notifications plugin + permissions
- `apps/app/app/_layout.tsx` — usePushNotifications hook 호출
- `packages/protocol/src/types/envelope.ts` — FrameType에 "pushToken" 추가
- `packages/protocol/src/types/ws.ts` — WsPushToken 타입 추가
- `packages/protocol/src/types/relay.ts` — RelayPush, RelayNotification 타입 추가
- `packages/daemon/src/daemon.ts` — handleRec에서 push 트리거, pushToken 수신 처리
- `packages/relay/src/relay-server.ts` — relay.push 핸들러 추가
- `TODO.md` — push notification 항목 완료 처리
- `CLAUDE.md` — 관련 문서 업데이트
