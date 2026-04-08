# Push Notification Manual Test Checklist

Push notifications require a real device — Simulator and Expo Go cannot receive actual APNs push.

## Prerequisites

- iPhone/iPad with TestFlight build installed (build #27+, includes PR #52)
- `tp` CLI installed on your Mac
- Both devices on a network (relay or local)

## Setup

### 1. Pair your device

```bash
tp pair
```

Scan the QR code or paste the JSON in the app (Settings > Pair with Daemon).

### 2. Verify connection

```bash
tp status
```

Confirm the app shows sessions. Check the Diagnostics panel (Settings > Diagnostics) for relay/E2EE status.

### 3. Allow notifications

When the app first connects, it should prompt for notification permissions. Tap **Allow**.

If you missed the prompt: Settings > Teleprompter > Notifications > Allow Notifications.

## Test Cases

### Test 1: Permission Request Push

**Trigger:** Start a Claude session that requires tool permission.

```bash
tp -p "read the contents of /etc/hosts"
```

Claude will request permission to use the Bash tool. If the app is in the background, you should receive a push notification:

> **Permission needed**
> Tool permission approval required

**Verify:**
- [ ] Push notification appears on lock screen / notification center
- [ ] Sound plays
- [ ] Tapping notification opens the app to the correct session

### Test 2: Elicitation Push

**Trigger:** Start a Claude session that asks a question requiring user input.

```bash
tp -p "ask me what programming language I prefer, then explain why it's great"
```

When Claude asks the question and waits, if the app is in background:

> **Response needed**
> Claude is waiting for your answer

**Verify:**
- [ ] Push notification appears
- [ ] Tapping opens the correct session

### Test 3: In-App Toast (Foreground)

With the app **open** in the foreground, trigger the same events above.

**Verify:**
- [ ] No system push notification (suppressed in foreground)
- [ ] In-app toast appears at top of screen
- [ ] Toast auto-dismisses after 5 seconds
- [ ] Tapping toast navigates to session

### Test 4: Multiple Devices

If you have a second device paired:

**Verify:**
- [ ] Both devices receive push notifications
- [ ] Each device has independent push tokens

### Test 5: Deduplication

Trigger the same permission event rapidly (within 60 seconds).

**Verify:**
- [ ] Only one push notification received (deduplicated)

### Test 6: Rate Limiting

Trigger more than 5 push-worthy events in 1 minute.

**Verify:**
- [ ] Max 5 notifications per minute per device
- [ ] Subsequent events silently dropped (no error)

## Troubleshooting

### No push received

1. Check notification permissions: Settings > Teleprompter > Notifications
2. Check pairing: App > Settings > Diagnostics > RELAY/PAIRING
3. Check daemon is running: `tp status`
4. Check relay connectivity: `tp doctor`
5. Check push token was sent: App logs should show "Push token registered"

### Push received but wrong content

Check daemon logs: `tp logs <session>` — look for `[PushNotifier]` entries.

### Push received but tap doesn't navigate

Verify `sessionId` is in the push payload. Check app logs for navigation errors.
