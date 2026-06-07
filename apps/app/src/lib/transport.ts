/**
 * Transport interface for frontend ↔ daemon communication via E2EE relay.
 *
 * Frontend must always use FrontendRelayClient (direct WS to daemon is
 * forbidden by Architecture Invariants — see CLAUDE.md).
 */

import type {
  RecordKind,
  SessionClientMessage,
  SessionMeta,
  SessionRec,
  SessionWorktreeInfo,
} from "@teleprompter/protocol/client";

/**
 * Discriminated union for a round-trip time measurement.
 * Use `{ measured: false }` when no pong has been received yet, so callers
 * never compare against a magic -1 sentinel.
 */
export type Rtt = { measured: true; ms: number } | { measured: false };

export type TransportEventHandler = {
  onSessionList?: (sessions: SessionMeta[]) => void;
  onRec?: (rec: SessionRec) => void;
  onState?: (sid: string, meta: SessionMeta) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: string) => void;
  onWorktreeList?: (worktrees: SessionWorktreeInfo[]) => void;
  onWorktreeCreated?: (info: SessionWorktreeInfo, sid?: string) => void;
  onSessionExported?: (sid: string, format: string, content: string) => void;
};

export interface TransportClient {
  // ── Connection lifecycle ──
  connect(): void | Promise<void>;
  dispose(): void;
  /** Returns true when the transport is ready to send/receive messages. */
  isConnected(): boolean;

  // ── Session attachment ──
  attach(sid: string): void;
  detach(sid: string): void;
  resume(sid: string, cursor: number): void;

  // ── Input ──
  sendChat(sid: string, text: string): void;
  sendTermInput(sid: string, data: string): void;
  send(msg: SessionClientMessage): void;

  // ── Session management ──
  /**
   * Ask the daemon to (re)send its full session list. The daemon replies with
   * a `hello` frame on RELAY_CHANNEL_META carrying every session it knows.
   * Used both as a resume catch-up (the kx-triggered `onFrontendJoined` hello
   * does not re-fire on a resume reconnect) and to back a manual refresh /
   * pull-to-refresh in the UI.
   */
  requestSessionList(): void;
  createSession(
    cwd: string,
    sid?: string,
    size?: { cols: number; rows: number },
  ): void;
  stopSession(sid: string): void;
  restartSession(sid: string): void;
  exportSession(
    sid: string,
    format?: "json" | "markdown",
    opts?: {
      recordTypes?: RecordKind[];
      timeRange?: { from?: number; to?: number };
      limit?: number;
    },
  ): void;

  // ── Worktree management ──
  requestWorktreeList(): void;
  createWorktree(branch: string, baseBranch?: string, path?: string): void;
  removeWorktree(path: string, force?: boolean): void;

  // ── Diagnostics ──
  ping(): void;
  getRtt(): Rtt;

  // ── Export callback (setter) ──
  set onSessionExported(handler:
    | ((sid: string, format: string, content: string) => void)
    | undefined,);
}
