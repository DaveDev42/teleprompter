/**
 * Unified transport interface for frontend ↔ daemon communication.
 *
 * Both DaemonWsClient (direct WS, dev) and FrontendRelayClient (E2EE relay, prod)
 * implement this interface so the app can be transport-agnostic.
 */

import type {
  RecordKind,
  WsClientMessage,
  WsRec,
  WsSessionMeta,
  WsWorktreeInfo,
} from "@teleprompter/protocol/client";

export type TransportEventHandler = {
  onSessionList?: (sessions: WsSessionMeta[]) => void;
  onRec?: (rec: WsRec) => void;
  onState?: (sid: string, meta: WsSessionMeta) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: string) => void;
  onWorktreeList?: (worktrees: WsWorktreeInfo[]) => void;
  onWorktreeCreated?: (info: WsWorktreeInfo, sid?: string) => void;
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
  send(msg: WsClientMessage): void;

  // ── Session management ──
  createSession(cwd: string, sid?: string): void;
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
  getRtt(): number;

  // ── Export callback (setter) ──
  set onSessionExported(
    handler:
      | ((sid: string, format: string, content: string) => void)
      | undefined,
  );
}
