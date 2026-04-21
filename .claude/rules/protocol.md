---
paths:
  - "packages/protocol/**"
---

# Protocol Package Conventions

## Export 구조
- `./src/index.ts` (메인): codec, socket, crypto, logger, types 전체 — 서버 전용 (Node/Bun)
- `./src/client.ts` (`/client`): crypto, pairing, logger, types만 — 프론트엔드 안전 (RN/Expo)
- 새 유틸 추가 시: 서버 전용이면 index.ts에만, 프론트엔드에도 필요하면 client.ts에도 export

## Type 파일 구조 (`src/types/`)
- 도메인당 1파일: `envelope.ts`, `event.ts`, `ipc.ts`, `record.ts`, `relay.ts`, `session.ts`, `ws.ts`, `control.ts` (E2EE control messages riding the `__control__` sid — `control.unpair`, `control.rename`, etc.)
- Namespace prefix: `Ipc*` (Runner↔Daemon), `Relay*` (Daemon↔Relay), `Ws*` (Frontend↔Daemon), `Control*` (peer-to-peer control messages)
- index.ts에서 re-export

## Envelope 필드명
`t`, `sid`, `seq`, `k`, `ns`, `n`, `d`, `c`, `ts`, `e`, `m` — 의도적 축약 (wire 효율). 리네이밍 금지.

## Framed JSON Codec
`u32_be length` + `utf-8 JSON payload` — IPC와 WS 모두 동일 포맷.

## Crypto
- Key exchange: X25519 via `crypto_kx` (daemon=server, frontend=client)
- Encryption: XChaCha20-Poly1305, random nonce per frame
- Key derivation: BLAKE2b (`crypto_generichash`), domain-separated (kxKey, registrationProof)
- Secret key 로깅 금지
