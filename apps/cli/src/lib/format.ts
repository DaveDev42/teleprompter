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
