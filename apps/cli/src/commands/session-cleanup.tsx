/**
 * tp session cleanup — interactive multi-select bulk delete for stopped sessions.
 *
 * Rendered with Ink (React for CLI). Raw mode is activated by Ink when the App
 * mounts and restored on unmount — `app.unmount()` is called on every exit path
 * to guarantee the user's shell does not get stuck in raw mode.
 *
 * Keyboard bindings inside the selection UI:
 *   Space / k / ↑ / j / ↓  — navigate + toggle / scroll
 *   Space                   — toggle selection on current row
 *   a                       — select / deselect all
 *   Enter                   — confirm (proceed to delete)
 *   Esc / Ctrl+C            — cancel (exit 130)
 */

import { basename } from "node:path";
import { Store } from "@teleprompter/daemon";
import type {
  IpcSessionDelete,
  IpcSessionDeleteErr,
  IpcSessionDeleteOk,
} from "@teleprompter/protocol";
import { getSocketPath } from "@teleprompter/protocol";
import { Box, render, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import { fail, ok } from "../lib/colors";
import { isDaemonRunning } from "../lib/ensure-daemon";
import { formatAge } from "../lib/format";
import { connectIpcAsClient } from "../lib/ipc-client";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SessionRow {
  sid: string;
  cwd: string;
  updatedAt: number;
}

// ─── Ink UI Components ────────────────────────────────────────────────────────

interface MultiSelectProps {
  sessions: SessionRow[];
  preselectAll: boolean;
  onConfirm: (selected: string[]) => void;
  onCancel: () => void;
}

function MultiSelectApp({
  sessions,
  preselectAll,
  onConfirm,
  onCancel,
}: MultiSelectProps): React.ReactElement {
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(
    preselectAll ? new Set(sessions.map((s) => s.sid)) : new Set(),
  );

  const now = Date.now();

  useInput((input, key) => {
    // Cancel
    if (key.escape || (key.ctrl && input === "c")) {
      onCancel();
      return;
    }

    // Move up
    if (key.upArrow || input === "k") {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }

    // Move down
    if (key.downArrow || input === "j") {
      setCursor((c) => Math.min(sessions.length - 1, c + 1));
      return;
    }

    // Toggle current
    if (input === " ") {
      const sid = sessions[cursor]?.sid;
      if (!sid) return;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(sid)) {
          next.delete(sid);
        } else {
          next.add(sid);
        }
        return next;
      });
      return;
    }

    // Toggle all
    if (input === "a") {
      setSelected((prev) => {
        if (prev.size === sessions.length) {
          return new Set();
        }
        return new Set(sessions.map((s) => s.sid));
      });
      return;
    }

    // Confirm
    if (key.return) {
      onConfirm(Array.from(selected));
      return;
    }
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>
          Select stopped sessions to delete (space toggle, a toggle all, Enter
          confirm, Esc cancel)
        </Text>
      </Box>

      {sessions.map((session, index) => {
        const isCursor = index === cursor;
        const isSelected = selected.has(session.sid);
        const age = formatAge(now - session.updatedAt);
        const cwdBase = basename(session.cwd) || session.cwd;

        return (
          <Box key={session.sid} flexDirection="row" gap={1}>
            {/* Cursor indicator */}
            <Text color={isCursor ? "cyan" : undefined}>
              {isCursor ? ">" : " "}
            </Text>

            {/* Checkbox */}
            <Text color={isSelected ? "green" : "gray"}>
              {isSelected ? "[x]" : "[ ]"}
            </Text>

            {/* SID (short: first 12 chars) */}
            <Text color={isCursor ? "cyan" : undefined} bold={isCursor}>
              {session.sid.slice(0, 20).padEnd(20)}
            </Text>

            {/* CWD basename */}
            <Text color={isCursor ? "cyan" : "gray"} dimColor={!isCursor}>
              {cwdBase.slice(0, 24).padEnd(24)}
            </Text>

            {/* Updated */}
            <Text color="gray">{age}</Text>
          </Box>
        );
      })}

      <Box marginTop={1}>
        <Text color="gray">
          {selected.size} selected / {sessions.length} total
        </Text>
      </Box>
    </Box>
  );
}

// ─── IPC helper (mirrors the pattern in session.ts) ────────────────────────

const SESSION_OP_TIMEOUT_MS = 30_000;

async function deleteSessionViaIpc(sid: string): Promise<void> {
  const ipc = await connectIpcAsClient(getSocketPath());
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Daemon did not reply within ${SESSION_OP_TIMEOUT_MS / 1000}s`,
          ),
        );
      }, SESSION_OP_TIMEOUT_MS);
      const done = (settle: () => void): void => {
        clearTimeout(timer);
        settle();
      };
      ipc.onMessage((raw) => {
        const r = raw as IpcSessionDeleteOk | IpcSessionDeleteErr;
        if (r.t === "session.delete.ok" || r.t === "session.delete.err") {
          if (r.t === "session.delete.err") {
            done(() =>
              reject(
                new Error(
                  `Delete failed: ${r.reason}${r.message ? ` — ${r.message}` : ""}`,
                ),
              ),
            );
          } else {
            done(() => resolve());
          }
        }
      });
      ipc.onClose(() =>
        done(() => reject(new Error("Daemon disconnected before replying"))),
      );
      const msg: IpcSessionDelete = { t: "session.delete", sid };
      ipc.send(msg);
    });
  } finally {
    try {
      ipc.close();
    } catch {
      /* best effort */
    }
  }
}

// ─── Readline prompt helper ────────────────────────────────────────────────

async function readlinePrompt(question: string): Promise<string> {
  const readline = await import("node:readline");
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ─── Main export ───────────────────────────────────────────────────────────

export async function runSessionCleanup(opts: {
  yes: boolean;
  preselectAll: boolean;
}): Promise<number> {
  // Non-TTY guard: this command is interactive-only.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      `${fail(
        "tp session cleanup is interactive; use 'tp session prune' for non-interactive bulk delete",
      )}\n`,
    );
    return 1;
  }

  // Fetch stopped sessions from Store directly (same as session list).
  // We don't need IPC here — the store is the source of truth for listing.
  const store = new Store();
  let sessions: SessionRow[];
  try {
    const rows = store.listSessions();
    sessions = rows
      .filter((s) => s.state === "stopped")
      .sort((a, b) => b.updated_at - a.updated_at) // newest first
      .map((s) => ({
        sid: s.sid,
        cwd: s.worktree_path ?? s.cwd,
        updatedAt: s.updated_at,
      }));
  } finally {
    store.close();
  }

  if (sessions.length === 0) {
    console.log("No stopped sessions to clean up.");
    return 0;
  }

  // Run the Ink multi-select UI.
  let selectedSids: string[] = [];
  let cancelled = false;

  await new Promise<void>((resolve) => {
    // Ink sets stdin to raw mode on mount and restores on unmount.
    // We MUST call app.unmount() on every exit path.
    const { unmount } = render(
      <MultiSelectApp
        sessions={sessions}
        preselectAll={opts.preselectAll}
        onConfirm={(sids) => {
          selectedSids = sids;
          unmount();
          resolve();
        }}
        onCancel={() => {
          cancelled = true;
          unmount();
          resolve();
        }}
      />,
      { exitOnCtrlC: false },
    );
  });

  if (cancelled) {
    console.log("Aborted.");
    return 130;
  }

  if (selectedSids.length === 0) {
    console.log("No sessions selected.");
    return 0;
  }

  // Confirm unless --yes.
  if (!opts.yes) {
    const answer = await readlinePrompt(
      `Delete ${selectedSids.length} session(s)? [y/N] `,
    );
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log("Aborted.");
      return 0;
    }
  }

  // Delete each selected sid via IPC (if daemon is running) or direct Store.
  const daemonUp = await isDaemonRunning();
  const deleted: string[] = [];
  const failed: Array<{ sid: string; error: string }> = [];

  for (const sid of selectedSids) {
    try {
      if (daemonUp) {
        await deleteSessionViaIpc(sid);
      } else {
        // Daemon-less: open a fresh Store per delete (mirrors session.ts pattern).
        // Without a live daemon no Runner is attached, so a direct Store write
        // is safe.
        const s = new Store();
        try {
          s.deleteSession(sid);
        } finally {
          s.close();
        }
      }
      deleted.push(sid);
    } catch (err) {
      failed.push({
        sid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (deleted.length > 0) {
    console.log(ok(`Deleted ${deleted.length} session(s):`));
    for (const sid of deleted) console.log(`  ${sid}`);
  }

  if (failed.length > 0) {
    console.error(fail(`Failed to delete ${failed.length} session(s):`));
    for (const { sid, error } of failed) {
      console.error(`  ${sid}: ${error}`);
    }
    return 1;
  }

  return 0;
}
