# Push Notification Manual Test Checklist

> **Note:** The iOS app is being rewritten in Swift/SwiftUI (see `ios/` and ADR-0001). Push notification infrastructure has not yet been ported to the Swift app (Phase 0 is a boot-marker shell). This checklist documents the target behaviour for when push notifications are implemented in a later phase.

Push notifications require a real device — iOS Simulator cannot receive actual APNs push.

## Backend: Direct APNs (HTTP/2, token-based auth)

The relay now delivers pushes **directly to APNs** (Apple Push Notification service) via HTTP/2, using ES256 JWT token authentication (`ApnsJwtSigner`). The Expo Push API is no longer involved.

### Required relay environment variables

| Var | Example | Description |
|-----|---------|-------------|
| `APNS_KEY` | `/etc/tp/AuthKey_XXXXXXXXXX.p8` or inline PEM | ES256 P-256 private key from Apple Developer Portal |
| `APNS_KEY_ID` | `XXXXXXXXXX` | 10-char Key ID from Apple Developer Portal |
| `APNS_TEAM_ID` | `YYYYYYYYYY` | 10-char Apple Team ID |
| `APNS_BUNDLE_ID` | `dev.tpmt.teleprompter` | App bundle ID (= APNs topic) |
| `APNS_ENV` | `sandbox` or `prod` | `sandbox` for development; `prod` for distribution builds |

JWT tokens are cached for 50 minutes and automatically refreshed. The relay signs with ES256 (P-256 curve) and converts the DER signature to P1363 (RFC 7518 §3.4) before encoding.

## Prerequisites

- iPhone/iPad with the current development build installed
- `tp` CLI installed on your Mac
- Relay deployed with `APNS_*` env vars set
- Both devices connected to the relay

## Setup

### 1. Pair your device

```bash
tp pair
```

Scan the QR code or paste the pairing URL in the app (Settings > Pair with Daemon).

### 2. Verify connection

```bash
tp status
```

Confirm the app shows sessions. Check Diagnostics panel (Settings > Diagnostics) for relay/E2EE status.

### 3. Allow notifications

On first launch the app will prompt for notification permissions. Tap **Allow**.

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
- [ ] Each device has independent APNs device tokens

### Test 5: Deduplication

Trigger the same permission event rapidly (within 60 seconds).

**Verify:**
- [ ] Only one push notification received (deduplicated)

### Test 6: Rate Limiting

Trigger more than 5 push-worthy events in 1 minute.

**Verify:**
- [ ] Max 5 notifications per minute per device
- [ ] Subsequent events silently dropped (no error to end-user)

## Troubleshooting

### No push received

1. Check notification permissions: Settings > Teleprompter > Notifications
2. Check pairing: App > Settings > Diagnostics > RELAY/PAIRING
3. Check daemon is running: `tp status`
4. Check relay connectivity: `tp doctor`
5. Check push token was received by daemon: `tp logs <session>` — look for `[PushNotifier] registered push token`
6. Check relay logs for APNs errors: look for `PUSH_DELIVERY_ERROR` or `PUSH_TOKEN_DEAD`

### APNs 400 BadDeviceToken / 410 Unregistered

APNs returns 400 `BadDeviceToken` when the device token is syntactically invalid. It returns 410 `Unregistered` when the app has been uninstalled or the user has revoked push permissions.

When the relay receives either of these, it sends `relay.err { e: "PUSH_TOKEN_DEAD" }` to the daemon. The daemon deletes the push token row from its database. The next time the app connects, it will re-register a fresh APNs token via `relay.push.register`.

**If you see `PUSH_TOKEN_DEAD` in relay logs:**
- The device token is stale (app reinstalled, device restored from backup, OS upgrade)
- Re-launch the app — it will re-register automatically on the next relay connect

### Wrong APNs environment (sandbox vs prod)

`APNS_ENV=sandbox` sends to `api.sandbox.push.apple.com`. Development builds (.xcarchive / Simulator direct install) use the sandbox APNs environment. Distribution builds (App Store / TestFlight) use `api.push.apple.com` (`APNS_ENV=prod`).

Sending a sandbox token to the production APNs endpoint (or vice versa) results in a `BadDeviceToken` error.

### APNs JWT auth failures

- Verify `APNS_KEY_ID` matches the key ID in Apple Developer Portal (Key > View)
- Verify `APNS_TEAM_ID` matches your team (Membership page)
- Verify `APNS_KEY` points to the correct `.p8` file (or inline PEM is not truncated)
- The JWT is valid for 1 hour; the relay refreshes at 50 minutes automatically

### Push received but wrong content

Check daemon logs: `tp logs <session>` — look for `[PushNotifier]` entries.

### Push received but tap doesn't navigate

Verify `sessionId` is in the push payload. Check app logs for navigation errors.
