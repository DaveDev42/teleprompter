# Pairing Redesign — Local-ECDH Commit Certificate + Idempotent Convergence

Status: **DRAFT for adversarial review** (design only, no implementation)
Supersedes: the REJECTED relay-HMAC design (verdict: REDESIGN)
Grounded against: `origin/main` HEAD working tree, every claim cited file:line.

---

## 0. Why the prior design was rejected (and what changes)

The prior design made the **relay** issue an HMAC "signature" over a daemon-supplied
public-key fingerprint and treated that as the pairing commit certificate. Two fatal
flaws, both confirmed against live code:

1. **The relay is zero-trust and never holds the daemon's real pubkey.** The relay only
   ever sees ciphertext (`.claude/rules/protocol.md` "Relay는 ciphertext만 전달";
   CLAUDE.md Architecture Invariants). The daemon's X25519 pubkey travels *offline* in
   the QR (`packages/protocol/src/pairing.ts:74-79` `pk` field; delivered to the app as
   `Pairing.daemonPublicKey`, `ios/Sources/Pairing/PairingStore.swift:16-17`) and its
   *current* pubkey travels **in-band but kx-key-encrypted** (`relay.kx`, sealed with
   `deriveKxKey(pairingSecret)` — `packages/daemon/src/transport/relay-client.ts:512-523`).
   The relay can decrypt neither. A relay HMAC over a fingerprint the relay cannot verify
   attests nothing — it is a tautology.
2. **daemonId ownership at the relay is first-come self-assertion, not proof.** Registration
   is `relay.register` with a `registrationProof = H(pairingSecret || "relay-register")`
   (`packages/protocol/src/crypto.ts:315-321`, Rust
   `rust/tp-core/src/crypto.rs:70-72`). Anyone with the pairing secret can register; a
   malicious daemon could obtain a relay signature over an arbitrary fingerprint.
3. **It also mis-modeled the live app flow.** It assumed "app commits only on
   `control.pair-committed`", but the LIVE app **persists to the Keychain at QR-decode
   time**, synchronously, inside `ingest()`: `PairingStore.ingest()` calls `persist(pairing)`
   at `ios/Sources/Pairing/PairingStore.swift:141`, and `persist()` writes the secret to
   the Keychain at `:148` and the metadata at `:155`. This happens **before any kx**.

**The decision (this doc):** replace the relay MAC with a **commit certificate both sides
derive LOCALLY** from the real ECDH they already perform. No relay signature. This:

- satisfies **req-1** (mutual recognition + key exchange + relay registration) *more*
  strongly — the certificate is unforgeable proof the ECDH actually completed;
- achieves the **spirit of req-6** (a pairing's validity is verifiable) via **local
  verification** instead of a relay-issued token;
- keeps the relay **stateless / ciphertext-only** (adds zero relay state, zero new
  hot-path relay crypto — see §F).

Requirements still satisfied: (1) valid only on mutual-recognize + key-exchange +
relay-register; (2) transactional establishment (reinterpreted as **idempotent
convergence** — see §B, the adversary correctly showed true 2PC is impossible over a
lossy stateless relay); (3) apps share pairings via iCloud Keychain; (4) every pairing
has a UUID id; (5) a `hostname` property; (7) **no expiry**. Requirement (6) is
reinterpreted: **not** a relay-issued signature, but a **locally-derivable, verifiable
pairing-validity proof** (the "pairing confirmation tag", §A).

---

## A. The Local Commit Certificate ("Pairing Confirmation Tag", PCT)

### A.1 What it must prove

Possession of the PCT must prove that **both sides completed the ECDH** — i.e. both
derived the shared session keys. That is exactly the property req-6 asks for: a pairing
is valid *iff* mutual key exchange happened, and the PCT is derivable ONLY after a
successful ECDH. It is computed independently on each side and compared; no third party
(relay) is involved.

### A.2 The crypto we already have (cited)

The kx already produces per-frontend session keys via libsodium `crypto_kx` / its
byte-exact Rust port:

- **Daemon side** (server role): `deriveSessionKeys(keyPair, frontendPubKey, "daemon")`
  → `kxServerSessionKeys` (`packages/protocol/src/crypto.ts:80-102`;
  `relay-client.ts:551-555`).
- **Frontend side** (client role): `kxClientSessionKeys(pk, sk, daemonPk)`
  (`ios/Sources/Relay/RelayClient.swift:721-730`); FFI at
  `rust/tp-core/src/lib.rs:215-227`.
- The KDF is BLAKE2b-512 over `shared || client_pk || server_pk`
  (`rust/tp-core/src/crypto.rs:261-271`); server tx = keys[0..32], server rx = keys[32..64];
  client rx = keys[0..32], client tx = keys[32..64] (`:280-301`). Cross-derivation
  invariant `ds.rx == fc.tx && ds.tx == fc.rx` is unit-tested (`:378-386`).

Crucially: **both sides end up holding the identical unordered key pair** {tx, rx}. The
daemon's `tx` equals the frontend's `rx`, and vice-versa (`crypto.rs:384-385`). So a
value computed from the *sorted* pair of session keys is **identical on both sides** and
is derivable ONLY after ECDH. This is the seam the PCT rides.

We also already have a domain-separated BLAKE2b KDF exposed on all three stacks:

- TS: `deriveBlake2b(p, secret, domain)` → `genericHash32` (`crypto.ts:212-222`);
  public `genericHash32`-based helpers `deriveRelayToken`/`deriveKxKey`/
  `deriveRegistrationProof` (`crypto.ts:228-321`).
- Rust: `generic_hash_32` (`crypto.rs:37-42`), `derive_blake2b` (`:47-52`), FFI
  `generic_hash_32` (`lib.rs:155-158`).
- Swift: calls the FFI `genericHash32` / `derive*` (used throughout
  `RelayClient.swift`).

So a PCT defined as `BLAKE2b-256` over a canonical byte layout is **byte-exact
reproducible on TS, Rust and Swift today** — no new primitive is required, only a new
domain string and a new pure function wrapping the existing `generic_hash_32`.

### A.3 PCT definition (byte layout)

```
PCT_INPUT :=
    "tp-pairing-confirm\x01"          (18-byte ASCII domain tag + 1-byte version = 19 bytes)
  || pairingId            (16 bytes, raw UUID — see §C.1)
  || daemonIdBytes        (utf-8, variable; length-prefixed: u8 len || bytes)
  || hostnameBytes        (utf-8, variable; length-prefixed: u8 len || bytes)
  || daemonPubKey         (32 bytes, X25519 — the pubkey used in THIS kx)
  || frontendPubKey       (32 bytes, X25519 — the pubkey used in THIS kx)
  || kSort0               (32 bytes) = min(sessionKeys.tx, sessionKeys.rx) lexicographic
  || kSort1               (32 bytes) = max(sessionKeys.tx, sessionKeys.rx) lexicographic

PCT := generic_hash_32(PCT_INPUT)          (BLAKE2b-256, 32-byte digest)
```

Notes on each binding:

- **Domain tag + version byte**: domain-separates from `relay-auth` / `kx-envelope` /
  `relay-register` / `relay-push-seal` (`crypto.ts:228-321`) and lets us rev the layout
  later without ambiguity. The version byte is `\x01`.
- **pairingId / daemonId / hostname**: bind the certificate to *this named pairing*, so a
  PCT computed for pairing A cannot be replayed as proof for pairing B even if the same
  device keys were reused. Length-prefix the two variable fields (u8 length, matching the
  existing `did_len`/`relay_len` u8 convention in `pairing.rs:120-128`) so the
  concatenation is unambiguous (no delimiter injection).
- **daemonPubKey / frontendPubKey**: the two X25519 pubkeys that actually participated in
  this kx. The frontend pubkey is ephemeral (`startKeyExchange` generates a fresh keypair
  from 32 random bytes each kx — `RelayClient.swift:653-657`), and the daemon pubkey is
  the *authoritative current* pubkey the frontend recovered from the daemon's `relay.kx`
  (`RelayClient.swift:694-698`), NOT the stale bundle pubkey. Both sides know both
  pubkeys after kx.
- **kSort0 / kSort1**: the sorted session-key pair. `min`/`max` (lexicographic byte
  compare) makes the input order-independent so daemon and frontend produce the SAME
  bytes despite the tx/rx crossover. This is the load-bearing "ECDH actually happened"
  term — the session keys are the direct output of `crypto_kx` over the DH shared secret
  (`crypto.rs:280-301`) and are unknowable to the relay (which only sees ciphertext) or
  to anyone lacking a private key that participated in the DH. The existing ratchet
  already uses exactly this `min/max` canonicalization idiom (`crypto.ts:163-165`,
  `crypto.rs:315-320`), so it is a proven, byte-exact pattern.

### A.4 Why this is the validity proof (req-6 spirit)

- **Unforgeable without ECDH.** To compute PCT you must know `kSort0`/`kSort1`, which are
  `crypto_kx` outputs derivable only by a party holding a private key that took part in
  the X25519 DH. The relay cannot (ciphertext-only). A MITM without a participating
  private key cannot.
- **Mutually recognized.** Both sides compute it independently; if they match, both agree
  on {pairingId, daemonId, hostname, both pubkeys, shared keys}. A mismatch means the kx
  did not agree on the same material → the pairing is NOT valid and must not be committed.
- **Locally verifiable, no relay token.** Validity is re-checkable at any time by
  recomputing PCT from stored material (see §C.3 for what each side stores). No expiry,
  no server round-trip. This is the reinterpreted req-6: a *locally-derivable* validity
  proof.

### A.5 Where each side derives it

- **Daemon (TS)**: immediately after `deriveSessionKeys(..., "daemon")` in
  `handleKxFrame` (`relay-client.ts:551-555`), it now also has `frontendPubKey`
  (`:550`), its own `keyPair.publicKey` (config), `daemonId` (config), `pairingId` +
  `hostname` (new config fields, §C), and the freshly derived `sessionKeys`. Compute
  `PCT_daemon = genericHash32(PCT_INPUT)`.
- **Frontend (Swift)**: in `onKeyExchangeFrame`, immediately after
  `kxClientSessionKeys(...)` sets `sessionKeys` (`RelayClient.swift:728-730`). It has the
  daemon pubkey (`:695`), its own ephemeral pubkey (`kp.publicKey`, `:729`), `pairingId`
  + `hostname` (new fields carried in the kx payload / QR, §C), `daemonId` (pairing), and
  `sessionKeys`. Compute `PCT_app` via the FFI `genericHash32`.
- **Rust (`tp-core`)**: add one pure function `derive_pairing_confirmation_tag(...)`
  (input = the fields above) → `generic_hash_32(...)`, exported over UniFFI (mirrors the
  existing `derive_kx_key` export shape, `lib.rs:140-143`). Swift calls this; a TS twin
  (`derivePairingConfirmationTag` in `crypto.ts`) is the reference. A **golden vector**
  in `rust/tp-core/tests/` (alongside `wire_vectors.rs`) pins TS↔Rust byte-equality — the
  same mechanism that already guards `deriveKxKey`/`kx_*`.

### A.6 Feasibility confirmation (byte-exact TS ↔ Rust ↔ Swift)

Confirmed feasible with zero new primitives:
- BLAKE2b-256 `generic_hash_32` is identical on all three (`crypto.rs:37-42` = TS
  `genericHash32` = Swift FFI).
- `min`/`max` lexicographic byte compare already has a byte-exact three-way
  implementation (ratchet `compareBytes`/`compare_bytes`, `crypto.ts:184-194`,
  `crypto.rs:305-307`).
- u8-length-prefixed utf-8 fields already round-trip byte-exact across TS↔Rust in the
  pairing codec (`pairing.ts:191-195`, `pairing.rs:123-126`).
- The session keys are byte-identical across stacks (kx golden vectors + cross test
  `crypto.rs:378-386`).

---

## B. Transactional Commit → **Idempotent Convergence** (state machine)

### B.1 Honesty: this is NOT atomic 2-phase commit

The adversary is correct: you **cannot** get true 2PC atomicity across the daemon's
SQLite (`packages/daemon/src/store/store.ts` `savePairing`, `:374-415`) and the app's
Keychain (`PairingStore.persist`, `:147-161`) over a **lossy, stateless relay** (relay
caches only 10 frames, `control.unpair` is fire-and-forget and lost if the peer is
offline — `.claude/rules/protocol.md` `control.unpair` line: "Stateless: if the peer is
offline, the message is lost and the pairing heals on the next connect attempt").
Therefore we design for **idempotent convergence with a no-permanent-orphans guarantee
under no-expiry**, and we say so explicitly. We do NOT claim atomicity.

### B.2 The core inversion: app must STOP persisting the full record at QR-decode

Live flow (the bug): `ingest()` decodes and *immediately* persists the full pairing
(secret + metadata) at QR-decode, **before kx** (`PairingStore.swift:113-142`,
`persist` at `:147-161`). If kx never completes (wrong QR, daemon offline, user cancels),
the app is left with a committed-looking pairing that never exchanged keys — an
app-ahead orphan indistinguishable from a valid pairing.

**Change:** split ingestion into two phases.

- **PENDING (at QR-decode)**: `ingest()` decodes via `decodePairingData`
  (`PairingStore.swift:114-140`) and writes a **pending record** (a separate,
  device-local, **non-synced** Keychain/UserDefaults namespace, e.g.
  `tp.pairing.<pairingId>.pending`) holding {pairingSecret, daemonPublicKey, relayURL,
  daemonId, pairingId, hostname, frontendId, v}. It does NOT write the committed
  namespace and does NOT set `synchronizable=true`. This is enough to drive kx.
- **COMMITTED (on kx completion + PCT match)**: only when `onKeyExchangeFrame` derives
  session keys AND `PCT_app == PCT_daemon` (see B.4 for how the app learns
  `PCT_daemon`), the app promotes the pending record to the committed, **synced** namespace
  (the current `persist()` shape, now keyed by `pairingId` and with `synchronizable=true`
  per §D) and deletes the pending record. `TP_PAIR_OK` (`DeepLinkHandler.swift:40`) is
  re-anchored to this COMMITTED transition, not to QR-decode.

This makes the app-side commit **gated on ECDH**, exactly as req-1 demands, and removes
the inverse-order bug the prior review flagged.

### B.3 Daemon side (already close; small change)

The daemon already defers its commit to kx completion: `savePairing` runs in
`PairingOrchestrator.promote()` (`pairing-orchestrator.ts:172-189`), which runs only
after `awaitPending()` resolves `completed`, which is set by `__markCompleted(frontendId)`
(`pending-pairing.ts:163-180`), fired from the wrapped `onFrontendJoined`
(`pairing-orchestrator.ts:104-123`), which fires from `handleKxFrame`
(`relay-client.ts:600`). So the daemon **already commits on kx**, not on QR-generation.
The only additions: the daemon computes `PCT_daemon` in `handleKxFrame` and includes it
in the confirm frame (B.4), and persists it (§C.3).

### B.4 Confirm handshake (one extra frame, E2EE, no relay state)

The PCT is symmetric, so we do NOT strictly need to send it — both sides could compute
and each trust its own. But to converge deterministically (and to let the app *detect* a
mismatch rather than silently commit a bad pairing), the daemon sends its PCT to the app
inside the **already-encrypted data channel** it already uses for `hello`:

- Daemon: in the `onFrontendJoined` hello (`relay-manager.ts:143-147`), add a
  `pct` field (32-byte digest, base64) to the encrypted `hello` payload published via
  `publishToPeer(frontendId, RELAY_CHANNEL_META, helloMsg)` (`:148`). This rides the
  E2EE data frame — the relay sees only ciphertext (invariant preserved).
- App: on decrypting `hello` (`RelayClient.swift` hello path), it compares the daemon's
  `pct` against its locally computed `PCT_app`. **Match → promote pending→committed
  (B.2), emit `TP_PAIR_OK`.** Mismatch → discard pending, emit `TP_PAIR_FAIL`, do NOT
  commit (the kx agreed on divergent material — a bug or an attack).

No new relay message type, no relay state, no relay crypto. `hello` is an existing
encrypted frame.

### B.5 Reconcile-on-reconnect (self-healing, no-expiry-safe)

The daemon already re-broadcasts its pubkey when a frontend first joins
(`relay-client.ts:596-598`, the "kx delivery race fix") and re-announces sessions +
`daemonLabel` in the hello on every `onFrontendJoined` (`relay-manager.ts:133-162`). We
extend this into a **reconcile path**:

1. **Daemon re-announces un-confirmed / all pairings on kx.** The daemon always sends the
   hello (with `pct`) on every frontend join, including reconnects — this is already the
   behavior. So an app that committed-ahead OR is still pending will, on its next kx,
   receive the daemon's `pct` again and can (re)confirm idempotently.
2. **App confirms on every kx.** The app's `onKeyExchangeFrame` runs on every daemon kx
   (including daemon-restart re-exchange, `RelayClient.swift:699-723`). It recomputes
   `PCT_app` and, if it holds a *pending* record for this pairingId, promotes it on match.
   If it already holds a *committed* record, the recompute is a cheap idempotent re-verify
   (and, if it ever mismatched, surfaces a warning — a divergence detector).
3. **Both converge.** Because the app never commits without a matching daemon `pct`, and
   the daemon commits on kx and re-announces on every join, a daemon-ahead or app-ahead
   state self-heals the next time both are online. With **no expiry**, "the next time both
   are online" is unbounded but eventual — there is no TTL that could silently drop a
   valid-but-idle pairing (the dead-pairing throttle only slows reconnect cadence, it
   never deletes — `relay-client.ts:92-124`, `isThrottled()` `:1039-1041`).

### B.6 Interim state + which event flips each side to COMMITTED

| Side | interim (pre-commit) state | flips to COMMITTED on |
|---|---|---|
| Daemon | `PendingPairing` in memory (single-slot, `pairing-orchestrator.ts:42`), RelayClient authed | `promote()` (`pairing-orchestrator.ts:172`) after `__markCompleted` (`pending-pairing.ts:163`) → `savePairing` writes the row |
| App | pending record (device-local, non-synced) written at QR-decode | daemon `hello.pct == PCT_app` → promote to committed synced record + `TP_PAIR_OK` |

### B.7 Failure-window table (every crash/disconnect → converged outcome)

Let D = daemon, A = app. "orphan" = one side committed, the other did not.

| # | Window (what happened) | Immediate state | Converged outcome (no expiry) |
|---|---|---|---|
| 1 | App scans QR, kx never starts (wrong QR / daemon offline forever) | A: pending only. D: nothing (never saw a frontend). | No orphan. A holds a **pending** record; it is NOT a committed pairing (never synced, not shown as active). Cleaned by A's local pending-GC on next launch if it never completes (see B.8). D never created anything. |
| 2 | kx completes on D (`__markCompleted`), D crashes **before** `promote()`/`savePairing` | D: in-memory pending lost on crash → **no row**. A: pending, and got the hello `pct` → **committed**. | App-ahead orphan. Heals: on D restart there is no saved pairing, so D does not reconnect it; but A keeps retrying its saved pairing (reconnect loop, `relay-client.ts` app side). D has no record → cannot re-issue `pct`. **Resolution: A cannot confirm what D never saved, but A already committed.** This is the one genuinely tricky window — see B.9 (daemon persists the row *before* signalling completion to close it). |
| 3 | D `savePairing` succeeds, hello `pct` frame lost in relay (app offline / 10-frame cache evicted) | D: **committed** row. A: pending. | Daemon-ahead orphan. Heals: A reconnects → D `onFrontendJoined` re-sends hello + `pct` (B.5.1) → A promotes. Converged. |
| 4 | Both commit, then A deletes locally (device-drop, §D) | D: committed. A: gone on that device (but present on other synced devices). | Not an orphan by design — see §D delete-disambiguation (local-drop ≠ mesh-unpair). D still valid; A re-pairs via iCloud sync or re-scan. |
| 5 | Both commit, A sends `control.unpair` (mesh-remove), D offline | A: removed everywhere (synced delete). D: still committed until it reconnects. | Heals: D reconnects, but the app is gone; the pairing is dead. D self-prunes via the dead-pairing throttle (never storms) and the operator can `tp pair delete`. `control.unpair` is retried on the app's next connect attempt if still relevant. |
| 6 | kx completes, PCT MISMATCH (kx agreed on divergent material) | Both derived keys but tags differ. | A does NOT commit (B.4), emits `TP_PAIR_FAIL`, discards pending. D committed its row (it cannot know the app rejected — the app just never uses it). D's row becomes a dead pairing → throttled reconnect → operator prunes. No usable pairing exists (correct: the kx was not mutually agreed). |
| 7 | A committed, later app reinstall wipes device Keychain but iCloud-synced copy survives | A: recovered from iCloud sync (committed record synced, §D). D: committed. | Converged with no action (that is the point of req-3 sync). frontendId is device-local and regenerated (§D) → the reinstalled device does a fresh kx under a new frontendId (N:N, daemon keys per frontendId — `PairingStore.swift:90-98`). |

### B.8 App-side pending GC (bounds window #1)

Pending records are device-local and cheap. To avoid unbounded pending accumulation from
repeated failed scans, the app GCs pending records that are older than a short local
threshold **and have never reached COMMITTED** (e.g. on app launch, drop pendings whose
`createdAt` is > 24h and which have no committed twin). This is a **local cleanup, not an
expiry of a valid pairing** — a pending record is by definition one that never completed
kx, so dropping it violates neither req-7 (no expiry applies to *valid* pairings) nor the
no-permanent-orphan guarantee (a pending is not an orphan; nothing on the daemon depends
on it).

### B.9 Closing window #2 (daemon crash between kx and savePairing)

To make window #2 self-heal instead of stranding an app-ahead orphan, **the daemon
persists the pairing row before it signals completion**. Concretely: move the
`store.savePairing(...)` so it runs inside `__markCompleted`'s effect path *before* the
promise resolves the RelayClient handoff — i.e. persist first, hand off second. Today
`promote()` does `savePairing` then `registerClient` (`pairing-orchestrator.ts:173-186`),
which is already "persist before handoff"; the residual risk is only a crash in the tiny
window *between* `__markCompleted` setting `completed` and `promote()` running. We tighten
by having the daemon treat a saved-but-never-reconfirmed pairing as reconcilable: on
startup `reconnectSaved` (`relay-manager.ts` `reconnectSaved`, referenced
`.claude/rules/backend-services.md`) already reconnects every saved pairing, so a
committed daemon row will re-issue `pct` on the app's next join. The only unrecoverable
sub-case is "kx completed, daemon crashed before `savePairing`, app committed" — here the
app is app-ahead. Because the app re-verifies on every kx (B.5.2) and the daemon has no
row, the app will keep retrying and never receive a matching `pct`; the app surfaces this
as a **"pairing unconfirmed — re-pair"** state (not a silent broken pairing) after N
failed reconnect+confirm cycles. This is the honest limit (see §F): we converge to a
*detectable* re-pair prompt, not to a silent orphan.

---

## C. Wire / DB / Keychain schema changes (UUID id + hostname)

### C.1 UUID id (raw 16 bytes) + hostname in the QR

**Layout bump to v4** in `packages/protocol/src/pairing.ts` + `rust/tp-core/src/pairing.rs`
(byte-exact twins). Current v3 layout (`pairing.ts:144-149`, `pairing.rs:6-12`):

```
magic(2) | version(1) | did_len(1) | did | relay_len(1) | relay | ps(32) | pk(32)
```

**v4 (additive, appended after pk):**

```
magic(2) | version(1)=4 | did_len(1) | did | relay_len(1) | relay | ps(32) | pk(32)
  | pairingId(16 raw UUID) | hostname_len(1) | hostname_bytes
```

Decoder compatibility (confirmed against live decoders):
- The v3/v2 decoders read a **fixed** trailing `ps(32)|pk(32)` and then STOP (v3) or read
  a trailing label (v2) (`pairing.ts:283-301`, `pairing.rs:206-224`). They do NOT tolerate
  extra trailing bytes as "ignore" — v3 simply doesn't read past pk, and the length
  checks are `o + N > buf.len` style, so **appending bytes after pk does not break v3/v2
  decode of a v3/v2 payload** (a v3 payload still decodes as v3). The additive fields are
  gated on `version == 4`. This is the same pattern by which v3 added/removed fields vs
  v2.
- **New decoders accept v2, v3, v4** (extend the `version != 2 && version != 3` guard at
  `pairing.ts:260` / `pairing.rs:175` to also allow 4). v4 reads the two new fields; v2/v3
  synthesize a **pairingId deterministically** from the daemonId+pubkey for back-compat
  (so req-4's "every pairing has a UUID" holds for legacy bundles too — a stable
  `UUIDv5(namespace, daemonId||pk)`), and hostname falls back to the daemonId suffix.
- **`MAX_PAIRING_B64_LEN` unchanged (2048).** v4 adds 16 (UUID) + 1 (len) + ≤255
  (hostname) ≈ ≤272 raw bytes → ≤~363 more base64url chars. A v4 bundle is
  ~772 + ~363 ≈ ~1135 chars, still far under the 2048 cap (`pairing.ts:44-51`,
  `pairing.rs:21-24`). No cap change needed; the pre-cap still bounds allocation.
- The **encoder always emits v4**; hostname defaults to the machine hostname
  (daemon-side, at bundle creation — `createPairingBundle`, `pairing.ts:103-122`, add a
  `hostname` field; the daemon passes `os.hostname()`), pairingId is a fresh `randomUUID()`
  (16 raw bytes).
- The FFI `FfiPairingData` (`rust/tp-core/src/lib.rs:65-72`) gains `pairing_id: String`
  (canonical UUID string form for Swift ergonomics) and `hostname: String`; the Swift
  `Pairing` struct (`PairingStore.swift:12-26`) gains `pairingId: UUID` and
  `hostname: String`.

pairingId is also threaded into the **kx payload** (both directions) so the PCT can bind
it and so the daemon knows which pairingId the app is confirming: extend `KxPayload`
(`ios/Sources/Relay/RelayMessages.swift:78-84`) and the daemon's `broadcastDaemonPublicKey`
payload (`relay-client.ts:515-520`) and its `handleKxFrame` parse (`relay-client.ts:536-548`)
with `pairingId` + `hostname`. These are inside the kx-key-sealed ct — relay never sees them.

### C.2 DB columns (daemon `pairings` table)

Current DDL (`packages/daemon/src/store/schema.ts:25-37`) has `daemon_id TEXT PRIMARY KEY`.
**Keep `daemon_id` as PK** (it is the routing/registration identity and the pubkey owner).
Add nullable columns via `PAIRINGS_MIGRATIONS` (`schema.ts:39-41`, same additive pattern as
the `label` migration):

```sql
ALTER TABLE pairings ADD COLUMN pairing_id TEXT;   -- canonical UUID string
ALTER TABLE pairings ADD COLUMN hostname TEXT;
ALTER TABLE pairings ADD COLUMN pct BLOB;          -- 32-byte confirmation tag (§A)
```

`savePairing` (`store.ts:374-415`) and its SQL (`:390-414`) gain the three fields; the
upsert's `DO UPDATE SET` list adds them (leaving `created_at` intact, as today). The
`StoredPairing` type + `parseStoredPairing` guard (`store.ts:424-450`) narrow the new
columns (pairing_id: optional string; pct: optional 32-byte BLOB). For rows migrated from
pre-v4 (no pairing_id), derive the deterministic UUIDv5 on read (matching the decoder
fallback) so every pairing exposes a UUID (req-4). `pct` is recomputed on the next kx if
null, so an old row self-populates.

### C.3 Keychain record shape (app)

Committed record (promoted, synced): keep the current split — secret in Keychain
(`keychainSet`, `PairingStore.swift:191-223`), metadata in UserDefaults
(`persist`, `:147-161`). **Re-key everything from `daemonId` to `pairingId`** (the stable
UUID) so a daemon that rotates its `daemonId` (rare, but the id is `daemon-<base36ts>`,
`pairing-orchestrator.ts:77`) does not fork the record, and so the synced key is a stable
UUID. Metadata dict (`:149-154`) gains `pairingId`, `hostname`, and `pct` (base64). The
index (`Key.daemonIndex`, `:76`) becomes a pairingId index; `load`/`remove`/`daemonIds`
(`:164-187`) are re-keyed accordingly (keep a `daemonId → pairingId` lookup for the
inbound `control.unpair`/`control.rename` paths, which arrive keyed by daemonId —
`TeleprompterApp.swift:264,280`).

Pending record (device-local, non-synced): a parallel namespace
(`tp.pairing.<pairingId>.pending` in `UserDefaults` + non-synced Keychain secret) holding
the same fields minus `pct`, with `synchronizable=false` and a `createdAt` for GC (B.8).

**frontendId stays device-local and non-synced** — unchanged
(`PairingStore.swift:88-106`; the doc-comment there explicitly forbids syncing it because
the daemon keys `peers` by frontendId — `relay-client.ts:205,566`; two devices sharing a
frontendId would clobber session keys). Confirmed correct; the redesign must NOT move it.

---

## D. iCloud Keychain sync (req-3) — true baseline + delta + threat model

### D.1 True baseline (cited)

iOS **already** syncs the pairing secret today: `keychainSet` sets
`kSecAttrSynchronizable = kCFBooleanTrue` on non-macOS and `kCFBooleanFalse` on macOS
(`PairingStore.swift:198-202`), with `kSecAttrAccessibleAfterFirstUnlock`
(`:218-220`). So on iOS/iPadOS a user who pairs once already gets the secret on other iOS
devices. The delta is **not** "add sync" — it is:

1. **macOS joins the sync** (drop the `#if os(macOS)` false branch — but gated, D.4).
2. **Re-key the synced item from daemonId to pairingId** (§C.3), so the synced credential
   is keyed by the stable UUID.
3. **Only the COMMITTED record syncs** (pending is non-synced, B.2/C.3).

### D.2 Threat model — the synced secret is a synced ROOT credential

The code comment at `PairingStore.swift:206-212` calls the synced secret "orthogonal to
the daemon↔frontend E2EE". **That comment is misleading and this design corrects the
mental model:** possession of the pairing secret lets a *new* device bootstrap kx from
scratch — it derives `kxKey = deriveKxKey(pairingSecret)` (`RelayClient.swift:661`,
`crypto.ts:243-248`), seals a fresh frontend pubkey, completes ECDH, and gets full session
keys. So:

> **Threat statement:** the iCloud-synced pairing secret is a **root credential** for the
> pairing. An iCloud account compromise ⇒ the attacker can add a device, bootstrap kx, and
> gain a live E2EE session to the daemon (= session compromise). It is NOT orthogonal to
> E2EE; it is the seed the E2EE is bootstrapped from.

Mitigations we adopt (design-level, not new crypto):
- Keep `kSecAttrAccessibleAfterFirstUnlock` (already, `:220`) — the item is not
  accessible before first unlock, so a stolen locked device does not leak it trivially.
- Document that sync inherits iCloud Keychain's own protection (end-to-end encrypted
  keychain syncing gated on the user's iCloud security). We do NOT weaken it.
- The PCT does **not** help here (an attacker with the secret completes a *real* kx, so
  the PCT matches — the PCT proves "a real kx happened", not "a trusted device did it").
  We state this plainly in §F: **the PCT is a validity proof, not an anti-theft device
  authorization.** Per-device authorization/attestation is future work, out of scope.
- The old comment at `:206-212` MUST be rewritten to the threat statement above.

### D.3 frontendId stays device-local (re-confirmed)

Non-negotiable and unchanged (`PairingStore.swift:88-106`). Each synced device generates
its own frontendId (`frontendId()` `:99-106`) and does its own kx → its own session keys.
Synced secret + per-device frontendId is the correct multi-device combination (as the
code comment at `:207-212` correctly notes, even though its "orthogonal to E2EE" framing is
wrong). N:N is supported: the daemon keys peers by frontendId (`relay-client.ts:205,566`).

### D.4 macOS sync entitlement gate (no silent degrade)

macOS iCloud Keychain sync for a generic password requires the
`keychain-access-groups` entitlement; ad-hoc local builds lack it and hit
`errSecMissingEntitlement (-34018)` (documented in the code comment,
`PairingStore.swift:192-197`; the local macOS harness even strips entitlements —
`CODE_SIGN_ENTITLEMENTS=""`, `.claude/rules/native-testing.md` macOS entitlements note).
Signed TestFlight/App Store macOS builds DO carry entitlements
(`ios/Teleprompter-macOS.entitlements`, `.claude/rules/ci-workflows.md` macOS
entitlements). Design:

- Replace the `#if os(macOS)` **compile-time** false with a **runtime capability probe**:
  attempt a `SecItemAdd` with `synchronizable=true` once at startup (or first pair) into a
  throwaway probe account; if it returns `-34018`, set an in-memory
  `syncAvailable = false` and use non-synced storage for this run, **and surface a visible
  "iCloud sync unavailable on this build" state** (a settings row / toast) rather than
  silently degrading. Signed builds probe-succeed and sync; ad-hoc local builds
  probe-fail and clearly say so.
- iOS/iPadOS unchanged (already sync).

---

## E. Delete-disambiguation (req: no data loss)

### E.1 The hazard (cited)

With `synchronizable=true`, a Keychain **delete propagates to all synced devices**
(`keychainDelete` uses `kSecAttrSynchronizableAny`, `PairingStore.swift:242-251`). And the
app's `remove(daemonId:)` also fires `control.unpair` to the daemon *before* teardown
(`TeleprompterApp.swift:298-306`; `PairingRelayOps.swift:65-66`), which the daemon
auto-removes (`.claude/rules/protocol.md` `control.unpair`: "The receiving peer
auto-removes the matching pairing"). So **one tap can unpair the entire mesh** — every
synced device loses the pairing AND the daemon deletes its side. That is correct for
"unpair" but catastrophic if the user only meant "remove from *this* iPhone".

### E.2 Two distinct operations

Split the single destructive action into two, with different scopes:

1. **"Unpair" (remove from the mesh — intentional, destructive):**
   - Sends `control.unpair` to the daemon (daemon auto-removes its row).
   - Deletes the **synced** committed record → propagates to all devices.
   - This is the current `remove()` path (`TeleprompterApp.swift:297-307`), kept but
     relabeled "Unpair" in the UI (`DaemonsTab.swift:317` "Unpair" button →
     `confirmUnpair`, `:75`). Requires explicit confirmation (already
     `confirmUnpair`).

2. **"Remove from this device" (local-only, non-destructive to the mesh):**
   - Does NOT send `control.unpair`.
   - Deletes only a **device-local, non-synced** copy — which requires that the committed
     record be stored such that a *local drop* is expressible without touching the synced
     item. Implementation: on "remove from this device", write a small **device-local
     tombstone** (non-synced UserDefaults flag `tp.pairing.<pairingId>.localHidden = true`)
     and tear down the local RelayClient, but do NOT `SecItemDelete` the synced secret and
     do NOT send `control.unpair`. The pairing list filters out locally-tombstoned
     pairingIds on this device. Other devices and the daemon are untouched; the user can
     "unhide" or it re-appears after a reinstall+resync (acceptable — it is a *local* hide,
     not a delete).
   - Rationale: a true per-device *delete* of a synced item is not possible without either
     (a) propagating the delete or (b) racing sync to re-add it. A local tombstone is the
     only lossless way to express "hide here, keep in the mesh".

### E.3 Inbound `control.unpair` (the mesh case) stays as-is but re-keyed

The inbound handler (`TeleprompterApp.swift:263-277`) currently does
`store.remove(daemonId: did)` — a synced delete. Under the redesign it deletes the synced
committed record keyed by pairingId (resolved via the daemonId→pairingId lookup, §C.3).
This is correct: an inbound `control.unpair` is a genuine mesh-remove initiated by the
daemon/other side, so propagating the synced delete is the intended behavior. The tombstone
path is ONLY for the local "remove from this device" affordance.

---

## F. No new relay state / capacity (confirmed)

The whole point of dropping the relay signature is that the relay stays exactly as it is.
Confirmed against `.claude/rules/relay-capacity.md` invariants and the code:

- **Zero new per-connection relay state.** The PCT is derived on daemon+app and carried
  inside the **existing** encrypted `hello` frame (`relay-manager.ts:143-148`, published
  via `publishToPeer` → `relay.pub` ciphertext). No new relay message type, no new
  registry, no per-frontend server entry. The relay's only state remains the 10-frame
  cache (CLAUDE.md: "Relay is stateless — 10-frame cache only").
- **Zero new relay hot-path crypto.** The relay does no PCT work — it forwards ciphertext.
  The prior design's relay HMAC (per-commit signing on the relay hot path) is deleted.
- **Ciphertext-only / zero-trust preserved.** pairingId, hostname, and pct all travel
  inside kx-key-sealed or session-key-sealed frames; the relay decrypts none of them.
- **~10k concurrent bar preserved.** No new connection, no new per-conn allocation, no new
  crypto per connection. The kx re-broadcast on first join already exists
  (`relay-client.ts:596-598`); we add one BLAKE2b-256 hash per kx on daemon+app (not
  relay), which is negligible.
- **daemon still opens no WS server, is relay's only client, frontend↔daemon still via
  relay** — untouched. **frontendId remains the N:N per-device routing key and stays
  device-local** (§C.3, §D.3).

---

## G. Compat / rollout + downgrade safety

### G.1 Version gate on the kx `v` field

Both sides advertise a WS protocol version in the kx payload: frontend `KxPayload.v`
(`RelayMessages.swift:82-83`, currently `RelayProtocol.version`), daemon
`broadcastDaemonPublicKey` `v: WS_PROTOCOL_VERSION` (`relay-client.ts:518`;
`WS_PROTOCOL_VERSION = 2`, `packages/protocol/src/compat.ts:43`); parsed on both sides
(`relay-client.ts:560-561`, `DaemonKxPayload.v` `RelayMessages.swift:183`). Bump
`WS_PROTOCOL_VERSION` to `3` for the PCT/confirm-handshake. Gate:

- **New daemon + new app (v≥3 both):** full PCT confirm handshake (B.4). App defers commit
  to kx (B.2).
- **New daemon + old app (app v<3):** old app persists at scan (legacy) and never sends/
  reads `pct`. The new daemon still `savePairing`s on kx (its existing behavior). The
  pairing works but is unconfirmed on the app side (no PCT). This is the transitional
  state; acceptable read-only.
- **Old daemon (v<3) + new app:** the new app receives a hello with no `pct`. **It must NOT
  silently fall back to persist-at-scan** (see G.2). Instead it commits on kx-completion
  *without* PCT verification (kx succeeded = keys agreed) and marks the record
  `confirmed=false` / `legacyDaemon=true`, surfacing "unverified pairing (update daemon)"
  rather than a hard fail. This preserves function while flagging the missing proof.

### G.2 The legacy persist-at-scan path is REMOVED, not left as a forceable fallback

The prior review's concern: a malicious peer must not be able to force the weak path by
advertising a low `v`. Under this design there is nothing to force — **the new app never
persists a committed record at scan** (B.2 makes scan write only a non-synced *pending*
record; commit is unconditionally gated on kx completion). A malicious peer advertising
`v=1` gets, at best, the "old daemon" branch (G.1): the app still requires a completed kx
before committing (which the attacker cannot fake without a participating private key),
and marks it unverified. The downgrade cannot reinstate persist-at-scan because that code
path is deleted from `ingest()` (the QR-decode → full-committed-persist call chain
`PairingStore.swift:141` → `persist` `:147-161` is replaced by pending-write). So there is
no low-`v` lever a peer can pull to make the app commit a secret without ECDH.

### G.3 Migration for already-persisted pairings

Existing committed records (written by the current build at scan time, keyed by daemonId,
synced on iOS) are honored:

- On first launch of the new app, a one-time migration re-keys existing
  `tp.pairing.<daemonId>.*` records to `tp.pairing.<pairingId>.*`, synthesizing the
  pairingId deterministically (UUIDv5 over daemonId+daemonPublicKey, matching the decoder
  fallback §C.1) so the id is stable and identical to what a v4 QR would carry for the
  same daemon. hostname defaults to the daemonId suffix until the next kx delivers a real
  hostname (via the extended kx payload / hello, §C.1). `pct` is null until recomputed on
  the next kx.
- Daemon-side: `loadPairings` (`store.ts:424-450`) tolerates null `pairing_id`/`hostname`/
  `pct` (derive/recompute lazily, §C.2). No data migration is destructive; the `label`
  migration precedent (`schema.ts:39-41`) shows additive nullable columns are safe.
- No re-pairing is required for existing pairings; they upgrade to confirmed on their next
  successful kx (the daemon re-issues `pct` in every hello, B.5.1; the app promotes on
  match).

---

## H. What this does NOT guarantee (honesty section)

1. **Not atomic (no 2-phase commit).** Convergence is *eventual and idempotent*, not
   atomic. There exist crash windows (B.7 #2, closed to a *detectable re-pair prompt* in
   B.9, not to silent success) where one side is briefly ahead. We converge or we surface
   an actionable state; we never silently ship a half-committed secret as a valid pairing.
2. **The PCT proves ECDH happened, not that a *trusted device* did it.** An attacker who
   holds the pairing secret (e.g. via iCloud compromise, §D.2) completes a real kx and
   produces a matching PCT. The PCT is a **validity proof (req-6)**, NOT device
   authorization / attestation. Per-device trust is future work.
3. **The synced pairing secret is a root credential.** iCloud Keychain compromise ⇒
   session compromise. We do not add a second factor; we correct the misleading
   "orthogonal to E2EE" comment and gate/surface sync availability, but we do not eliminate
   the root-credential nature of a synced secret (that is inherent to req-3's "share via
   iCloud Keychain").
4. **No expiry (req-7) means dead pairings linger.** A daemon-committed pairing whose app
   is gone forever is not auto-deleted; it is only reconnect-throttled
   (`relay-client.ts:92-124`) and must be pruned by the operator (`tp pair delete`). This
   is by design (req-7) and is not an orphan (nothing depends on it), but it is not
   garbage-collected.
5. **macOS sync only on signed builds.** Ad-hoc/local macOS builds cannot sync
   (-34018, §D.4); they run non-synced and say so. This is a build-capability limit, not a
   design choice we can lift in local dev.
6. **`control.unpair` delivery is best-effort.** If the peer is offline, the mesh-unpair
   frame is lost and heals on next connect (stateless relay). A user who unpairs while the
   daemon is offline will see the daemon reappear-then-remove on its next reconnect.
7. **Legacy (v<3) counterparts get function without proof.** New-app↔old-daemon pairings
   commit on kx but carry no PCT; they are marked unverified, not blocked.

---

## I. File-by-file implementation checklist (ordered as small landable PRs)

Each PR is independently reviewable, keeps CI green, and preserves all architecture
invariants. Order minimizes cross-stack coupling and lands the byte-exact core first.

**PR 1 — Rust core: PCT primitive + v4 pairing fields (no callers yet).**
- `rust/tp-core/src/crypto.rs`: add `derive_pairing_confirmation_tag(pairing_id: &[u8;16],
  daemon_id: &str, hostname: &str, daemon_pk: &[u8;32], frontend_pk: &[u8;32],
  session_keys: &SessionKeys) -> [u8;32]` (domain `tp-pairing-confirm\x01`, sorted keys,
  §A.3). Reuse `generic_hash_32` + the existing `compare_bytes` sort idiom (`:305-307`).
- `rust/tp-core/src/pairing.rs`: v4 encode/decode (append `pairingId(16)|hostname_len(1)|
  hostname`), extend version guard to accept 4 (`:175`), keep `MAX_PAIRING_B64_LEN`.
- `rust/tp-core/src/lib.rs`: FFI `derive_pairing_confirmation_tag` (`:140-143` shape);
  extend `FfiPairingData` with `pairing_id`, `hostname` (`:65-72`).
- Tests: golden vector for the PCT + v4 round-trip in `rust/tp-core/tests/` (mirror
  `wire_vectors.rs`); a v3-payload-decodes-as-v3-under-v4-decoder back-compat test.

**PR 2 — TS protocol twin (byte-exact reference for PR 1).**
- `packages/protocol/src/crypto.ts`: `derivePairingConfirmationTag(...)` (reference impl,
  §A.5).
- `packages/protocol/src/pairing.ts`: v4 encode/decode (`:160-310`), bump
  `PAIRING_BINARY_VERSION` to 4, accept 2/3/4 (`:260`), add `hostname` to `PairingData` +
  `createPairingBundle` (`:69-122`).
- Tests: `pairing.test.ts` v4 cases + `crypto.test.ts` PCT cross-check against the Rust
  golden vector (the existing TS↔Rust golden mechanism).

**PR 3 — Daemon: persist pairingId/hostname/pct; compute PCT on kx.**
- `packages/daemon/src/store/schema.ts`: `PAIRINGS_MIGRATIONS` += `pairing_id`, `hostname`,
  `pct` (`:39-41`).
- `packages/daemon/src/store/store.ts`: `savePairing` (`:374-415`) + SQL + `StoredPairing`
  + `parseStoredPairing` (`:424-450`) for the 3 columns; lazy UUIDv5 + recompute-null-pct
  on read.
- `packages/daemon/src/transport/relay-client.ts`: in `handleKxFrame` (`:529-604`) compute
  `PCT_daemon` after `deriveSessionKeys` (`:551`); thread pairingId/hostname into
  `RelayClientConfig` (`:140-155`) and into `broadcastDaemonPublicKey` payload (`:515-520`)
  + `handleKxFrame` parse (`:536-548`).
- `packages/daemon/src/transport/relay-manager.ts`: add `pct` to the hello payload
  (`:143-147`).
- `packages/daemon/src/pairing/pending-pairing.ts` / `pairing-orchestrator.ts`: carry
  pairingId/hostname through `PendingPairingResult` (`pending-pairing.ts:45-57`) →
  `promote()`/`savePairing` (`pairing-orchestrator.ts:172-189`).
- Tests: `relay-client.test.ts` (PCT computed + in hello), `store.test.ts` (new columns +
  migration), `pairing-orchestrator.test.ts` (threading).

**PR 4 — App: two-phase ingest (pending → committed), PCT verify, re-key to pairingId.**
- `ios/Sources/Pairing/PairingStore.swift`: split `ingest`/`persist` (`:113-161`) into
  pending-write (non-synced) + committed-promote (synced, keyed by pairingId); add
  `pairingId`/`hostname`/`pct` to `Pairing` (`:12-26`) and metadata (`:149-154`); re-key
  index/load/remove (`:164-187`); one-time daemonId→pairingId migration (G.3); pending GC
  (B.8). Rewrite the misleading `:206-212` comment to the §D.2 threat statement.
- `ios/Sources/Relay/RelayMessages.swift`: extend `KxPayload` (`:78-84`) + `DaemonKxPayload`
  (`:176-183`) with `pairingId`/`hostname`; add `pct` to the hello decodable.
- `ios/Sources/Relay/RelayClient.swift`: compute `PCT_app` after `kxClientSessionKeys`
  (`:728-730`); on hello, compare with daemon `pct` → promote pending→committed + emit
  `TP_PAIR_OK`, else `TP_PAIR_FAIL` (B.4). Re-anchor `TP_PAIR_OK`.
- `ios/Sources/Pairing/DeepLinkHandler.swift`: move the `TP_PAIR_OK` emission
  (`:38-41`) out of decode-time; decode-time now only writes pending (a `TP_PAIR_PENDING`
  diagnostic, optional).
- Tests: XCTest for two-phase ingest + PCT match/mismatch; smoke marker `TP_PAIR_OK` now
  fires on kx-confirm (update `scripts/ios.sh` marker semantics doc in
  `.claude/rules/native-testing.md` — same commit).

**PR 5 — macOS sync gate + delete-disambiguation.**
- `ios/Sources/Pairing/PairingStore.swift`: replace `#if os(macOS)` (`:198-202`) with a
  runtime `-34018` probe → `syncAvailable`; surface "sync unavailable" state (§D.4).
- `ios/Sources/TeleprompterApp.swift` + `ios/Sources/Nav/DaemonsTab.swift`: split the
  destructive action into "Unpair" (mesh, current `remove()` `:297-307` +
  `control.unpair`) and "Remove from this device" (local tombstone, no `control.unpair`,
  no synced delete) — §E. Inbound `control.unpair` (`:263-277`) stays a synced delete,
  re-keyed to pairingId.
- Tests: XCTest for local-tombstone (mesh untouched) vs unpair (synced delete +
  `control.unpair`).

**PR 6 — Version gate + docs.**
- `packages/protocol/src/compat.ts`: bump `WS_PROTOCOL_VERSION` to 3 (`:43`); add
  helpers if needed for v<3 handling.
- Gate the confirm handshake on `v>=3` on both sides (G.1); app marks v<3-daemon pairings
  `unverified` (G.1) — no persist-at-scan fallback exists to force (G.2).
- Docs: this design doc → ADR (or link from `docs/adr/`), update CLAUDE.md pairing
  bullet + `.claude/rules/protocol.md` (kx payload gains pairingId/hostname/pct; hello
  gains pct) in the same commit as the code (per the repo's doc-maintenance rule).

**Verification gates (per existing harness):**
- Backend: `bun test ./packages/protocol ./packages/daemon ./apps/cli ./packages/relay`.
- Rust: `( cd rust && cargo test -p tp-core )` (golden vectors gate TS↔Rust↔Swift PCT +
  v4).
- App: `scripts/ios.sh smoke` (8 markers; `TP_PAIR_OK` now = kx-confirm) + XCTest;
  `TP_E2E_CLAUDE_M5` for the full app→relay→daemon path.

---

## Appendix: fact-check ledger (every load-bearing claim → file:line)

- App persists at QR-decode inside `ingest`: `ios/Sources/Pairing/PairingStore.swift:113-161`
  (`persist` at `:141`, keychain write `:148`, meta `:155`).
- Relay is ciphertext-only / zero-trust / 10-frame cache: CLAUDE.md Architecture
  Invariants; `.claude/rules/protocol.md`; `.claude/rules/relay-capacity.md`.
- Daemon pubkey delivered offline (QR) + in-band kx-sealed:
  `packages/protocol/src/pairing.ts:74-79`; `relay-client.ts:512-523`.
- registrationProof = H(secret||"relay-register") (self-assertion, not proof):
  `packages/protocol/src/crypto.ts:315-321`; `rust/tp-core/src/crypto.rs:70-72`.
- crypto_kx session keys + cross-derivation invariant: `crypto.ts:80-102`;
  `crypto.rs:261-301,378-386`; Swift `RelayClient.swift:721-730`; FFI `lib.rs:201-227`.
- BLAKE2b KDF domain-separated + genericHash32 available all 3 stacks: `crypto.ts:207-321`;
  `crypto.rs:37-72`; FFI `lib.rs:135-158`.
- min/max byte-sort idiom (byte-exact): `crypto.ts:163-194`; `crypto.rs:305-320`.
- daemon commits on kx (promote→savePairing after __markCompleted from onFrontendJoined
  from handleKxFrame): `pairing-orchestrator.ts:104-189`; `pending-pairing.ts:163-180`;
  `relay-client.ts:596-600`.
- kx re-broadcast on first join (race fix): `relay-client.ts:563-598`.
- hello (sessions + daemonLabel) via publishToPeer on every join:
  `relay-manager.ts:133-162`.
- pairing DDL/PK + additive migration precedent: `schema.ts:25-41`.
- savePairing upsert / loadPairings guard / deletePairing txn: `store.ts:374-461`.
- QR v2/v3 layout + decoders + version guard + MAX_PAIRING_B64_LEN:
  `pairing.ts:33-51,144-310`; `pairing.rs:6-28,79-233`.
- FfiPairingData shape: `lib.rs:64-84`.
- Swift Pairing struct / frontendId device-local / keychain sync flags / delete scope:
  `PairingStore.swift:12-26,88-106,191-251`; misleading comment `:206-212`.
- kx payload structs (frontend/daemon): `RelayMessages.swift:66-84,163-190`;
  `RelayClient.swift:653-734`.
- WS_PROTOCOL_VERSION: `compat.ts:43`; used `relay-client.ts:518`, `RelayMessages.swift:82`.
- app inbound control.unpair auto-remove (synced delete): `TeleprompterApp.swift:263-277`;
  outbound remove sends control.unpair before teardown `:297-307`; `PairingRelayOps.swift:65-66`.
- control.unpair best-effort/stateless + daemon auto-remove: `.claude/rules/protocol.md`
  (control.unpair line).
- dead-pairing throttle never deletes: `relay-client.ts:92-124,1039-1041`.
