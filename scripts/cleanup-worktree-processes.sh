#!/usr/bin/env bash
# cleanup-worktree-processes.sh — Pre-delete hook for cw worktrees
# Kills dev server processes running in this worktree.
set -euo pipefail

WORKTREE_DIR="${PWD}"

# Kill any bun/node processes running from this worktree
pids=$(pgrep -f "${WORKTREE_DIR}" 2>/dev/null || true)
if [ -n "$pids" ]; then
  echo "🧹 Killing processes running in ${WORKTREE_DIR}..."
  echo "$pids" | xargs kill 2>/dev/null || true
  echo "✅ Processes cleaned up."
else
  echo "✅ No processes to clean up."
fi
