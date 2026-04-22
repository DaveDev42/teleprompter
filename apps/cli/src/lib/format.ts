/**
 * Format an error message with actionable hints.
 *
 *   errorWithHints("Connection timed out.", [
 *     "Check if daemon is running: tp status",
 *     "Diagnose: tp doctor",
 *   ])
 *
 * Produces:
 *   Connection timed out.
 *     → Check if daemon is running: tp status
 *     → Diagnose: tp doctor
 */
export function errorWithHints(message: string, hints: string[]): string {
  return [message, ...hints.map((h) => `  → ${h}`)].join("\n");
}

/**
 * Render an age in milliseconds as a human-readable "N unit ago" string.
 * Rolls up seconds → minutes → hours → days, and falls back to an ISO date
 * (YYYY-MM-DD) for ages ≥ 7 days to avoid unreadable "43d ago" spam.
 */
export function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(Date.now() - ms).toISOString().slice(0, 10);
}
