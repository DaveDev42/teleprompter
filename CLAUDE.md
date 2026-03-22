# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Teleprompter is a remote Claude Code session controller. An Expo frontend (React Native + RN Web) connects to a Bun-based Daemon via encrypted relay to control Claude Code sessions with a dual Chat/Terminal UI.

## Tech Stack

- **Language**: TypeScript (single stack across all components)
- **Runtime**: Bun v1.3.5+ (Runner, Daemon, Relay), Expo (Frontend)
- **Monorepo**: Turborepo + pnpm
- **Frontend**: Expo (React Native + RN Web), Zustand, NativeWind (Tailwind), xterm.js
- **Encryption**: libsodium (X25519 + AES-256-GCM)
- **Voice**: OpenAI Realtime API

## Monorepo Layout

```
apps/
  frontend/    # Expo app (iOS > Web > Android)
  daemon/      # Bun long-running service (session mgmt, vault, E2EE, worktree)
  runner/      # Bun per-session process (PTY via Bun.spawn terminal, hooks collection)
  relay/       # Bun WebSocket ciphertext-only relay server
packages/
  protocol/    # @teleprompter/protocol — shared types, framed JSON codec, envelope types
  tsconfig/    # Shared TS configs (base.json, bun.json, expo.json)
  eslint-config/
```

## Architecture

- **Runner** spawns Claude Code in a PTY (`Bun.spawn({ terminal })`), collects io streams and hooks events, sends Records to Daemon via Unix domain socket IPC
- **Daemon** manages sessions, stores Records in Vault (append-only), encrypts with libsodium, connects to Relay(s)
- **Relay** is a stateless ciphertext forwarder — holds only recent 10 encrypted frames per session
- **Frontend** decrypts and renders: Terminal tab (xterm.js) + Chat tab (hooks events + PTY parsing hybrid)
- Data flow: Runner → Daemon → Relay → Frontend (and reverse for input)

## Protocol

All components use the same framed JSON protocol: `u32_be length` + `utf-8 JSON payload`. The Envelope type has fields: `t` (frame type), `sid`, `seq`, `k` (io|event|meta), `ns`, `n`, `d`, `c`, `ts`, `e`, `m`.

## Key Design Decisions

- Chat UI uses **hybrid** data: hooks events for structured cards (primary) + PTY output parsing for streaming text (secondary). hooks Stop event finalizes responses.
- Worktree management is done directly by Daemon (`git worktree add/remove/list`), no external tool dependency. N:1 relationship — multiple sessions per worktree allowed.
- E2EE pairing via QR code containing pairing secret + daemon pubkey + relay URL. ECDH → HKDF → AES-256-GCM.
- Platform priority: iOS > Web > Android. Responsive layout required for mobile/tablet/desktop.
- Deployment: `bun build --compile` for single binary (Daemon, Runner, Relay).

## Language

PRD and internal docs are written in Korean. Code, comments, and commit messages should be in English.
